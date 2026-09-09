const { createCliStatusCache, createOutputBudget } = require('./cli-performance');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { createTextProgress } = require('./llm-stream');
const { CodexAppServerClient } = require('./codex-app-server');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const CODEX_IDLE_TIMEOUT_MS = 120000;
const CODEX_HARD_TIMEOUT_MS = 15 * 60 * 1000;
const CODEX_NETWORK_FAILURE_TIMEOUT_MS = 25000;
const activeCodexRuns = new Map();
const codexStatusCache = createCliStatusCache(probeCodexStatus);
let activeCodexLogin = null;
let lastCodexLoginError = '';
let codexAppServer = null;

function resolveCodexCommand({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return 'codex';

  // A packaged app started through Explorer does not always inherit the same
  // PATH as the user's terminal. Check the standard desktop and local install
  // locations explicitly before falling back to PATH lookup.
  const candidates = [
    env.CODEX_CLI_PATH,
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe'),
    homeDir && path.win32.join(homeDir, '.local', 'bin', 'codex.exe'),
    env.APPDATA && path.win32.join(env.APPDATA, 'npm', 'codex.exe'),
  ].filter(Boolean);
  return candidates.find(candidate => {
    try { return existsSync(candidate); } catch { return false; }
  }) || 'codex.exe';
}

function codexCommand() {
  return resolveCodexCommand();
}

function getCodexAppServer() {
  if (!codexAppServer) codexAppServer = new CodexAppServerClient({ command: codexCommand() });
  return codexAppServer;
}

function stopCodexAppServer() {
  codexAppServer?.stop();
  codexAppServer = null;
}

function cleanProgressText(value, maxLength = 180) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function normalizeCodexReasoningEffort(value, fallback = 'medium') {
  const normalized = String(value || '').trim().toLowerCase();
  return ['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(normalized)
    ? normalized
    : fallback;
}

function sessionIdFromCodexEvent(event) {
  if (!event || typeof event !== 'object' || event.type !== 'thread.started') return '';
  return String(event.thread_id || event.threadId || event.thread?.id || event.id || '').trim();
}

function describeCodexEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = event.type || 'event';
  const item = event.item || {};

  if (type === 'thread.started') return { phase: 'start', message: 'Arbeitsumgebung ist bereit.' };
  if (type === 'turn.started') return { phase: 'analysis', message: 'Prüft Anforderungen und plant die nächsten Schritte.' };
  if (type === 'turn.completed') return { phase: 'finalizing', message: 'Schließt den aktuellen Arbeitsschritt ab.' };
  if (type === 'error' || type === 'turn.failed') {
    return { phase: 'error', message: cleanProgressText(event.message || event.error?.message || 'Codex meldet einen Fehler.') };
  }

  if (type === 'item.started') {
    if (item.type === 'command_execution') {
      const command = cleanProgressText(Array.isArray(item.command) ? item.command.join(' ') : item.command);
      return { phase: 'command', message: command ? `Befehl läuft: ${command}` : 'Ein Befehl wird ausgeführt …' };
    }
    if (item.type === 'mcp_tool_call') {
      const tool = cleanProgressText(item.tool || item.name || item.server);
      return { phase: 'tool', message: tool ? `Werkzeug läuft: ${tool}` : 'Ein Werkzeug wird ausgeführt …' };
    }
    if (item.type === 'web_search') return { phase: 'search', message: 'Recherchiert benötigte Informationen.' };
    if (item.type === 'file_change') return { phase: 'files', message: 'Bereitet die benötigten Dateiänderungen vor.' };
    if (item.type === 'reasoning') return { phase: 'analysis', message: 'Prüft Lösungsweg und nächsten Arbeitsschritt.' };
  }

  if (type === 'item.completed') {
    if (item.type === 'command_execution') {
      const exitCode = item.exit_code ?? item.exitCode;
      return exitCode === 0
        ? { phase: 'command', message: 'Befehl erfolgreich abgeschlossen.' }
        : { phase: 'command-error', message: `Befehl mit Exit-Code ${exitCode ?? 'unbekannt'} beendet.` };
    }
    if (item.type === 'mcp_tool_call') return { phase: 'tool', message: 'Werkzeug-Aufruf abgeschlossen.' };
    if (item.type === 'file_change') return { phase: 'files', message: 'Dateiänderungen wurden vorbereitet.' };
    if (item.type === 'error') {
      return { phase: 'error', message: cleanProgressText(item.message || 'Codex meldet einen Verbindungsfehler.') };
    }
    if (item.type === 'agent_message') {
      const text = String(item.text || item.content || '');
      return text
        ? { phase: 'streaming', message: 'Antwort wird angezeigt.', delta: text }
        : { phase: 'finalizing', message: 'Formuliert das konkrete Arbeitsergebnis.' };
    }
  }

  return null;
}

function cancelCodexRun(requestId) {
  const active = requestId ? activeCodexRuns.get(requestId) : null;
  if (!active) return { ok: false, message: 'Kein aktiver Codex-Lauf gefunden.' };
  active.cancelled = true;
  if (typeof active.cancel === 'function') active.cancel();
  else active.child?.kill();
  return { ok: true, message: 'Codex-Lauf wird abgebrochen.' };
}

function runCodex(args, {
  input = '',
  cwd = process.cwd(),
  timeoutMs = 15000,
  idleTimeoutMs = 0,
  requestId = '',
  parseJsonEvents = false,
  onProgress = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let jsonLineBuffer = '';
    let settled = false;
    let child;
    let hardTimer = null;
    let idleTimer = null;
    let networkFailureTimer = null;
    let lastActivityEventAt = 0;
    let heartbeatTimer = null;
    let sessionId = '';
    const startedAt = Date.now();
    let firstEventAt = 0;
    let firstTextAt = 0;
    const textProgress = createTextProgress(onProgress, 'codex');

    try {
      child = spawn(codexCommand(), args, {
        cwd,
        env: process.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    const emitProgress = (progress) => {
      if (!progress || typeof onProgress !== 'function') return;
      onProgress({ ...progress, ts: Date.now() });
    };

    const emitActivity = () => {
      const now = Date.now();
      if (now - lastActivityEventAt < 2000) return;
      lastActivityEventAt = now;
      emitProgress({ phase: 'activity', message: '' });
    };

    const consumeJsonLine = (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (!firstEventAt) firstEventAt = Date.now();
        const discoveredSessionId = sessionIdFromCodexEvent(event);
        if (discoveredSessionId) sessionId = discoveredSessionId;
        const progress = describeCodexEvent(event);
        const eventDiagnostic = cleanProgressText(event.message || event.item?.message || '', 500).toLowerCase();
        const isNetworkFailure = /reconnecting|connection failed|stream disconnected|socket|network/.test(eventDiagnostic);
        if (isNetworkFailure && !networkFailureTimer) {
          networkFailureTimer = setTimeout(() => {
            abortForTimeout(
              'Codex kann den OpenAI-Dienst nicht erreichen. Bitte Netzwerk, Firewall oder Proxy prüfen.',
              'network-error',
              'CODEX_NETWORK_UNAVAILABLE',
            );
          }, CODEX_NETWORK_FAILURE_TIMEOUT_MS);
        } else if (!isNetworkFailure && ['item.started', 'item.completed', 'turn.completed'].includes(event.type)) {
          if (networkFailureTimer) clearTimeout(networkFailureTimer);
          networkFailureTimer = null;
        }
        if (progress?.delta) {
          if (!firstTextAt) firstTextAt = Date.now();
          textProgress.push(progress.delta);
        }
        else emitProgress(discoveredSessionId && progress ? { ...progress, sessionId: discoveredSessionId } : progress);
      } catch {
        // Ignore non-JSON diagnostics; the final answer is read separately.
      }
    };

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (networkFailureTimer) clearTimeout(networkFailureTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (requestId && activeCodexRuns.get(requestId)?.child === child) activeCodexRuns.delete(requestId);
      callback();
    };

    const abortForTimeout = (message, phase, code) => {
      child.kill();
      emitProgress({ phase, message });
      finish(() => reject(Object.assign(new Error(message), { code })));
    };

    const resetIdleTimer = () => {
      if (!idleTimeoutMs || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortForTimeout(
          `Codex-Aufruf nach ${Math.round(idleTimeoutMs / 1000)}s ohne Aktivität abgebrochen.`,
          'idle-timeout',
          'CODEX_IDLE_TIMEOUT',
        );
      }, idleTimeoutMs);
    };

    const outputBudgets = new Map();
    const append = (current, chunk, stream) => {
      if (!outputBudgets.has(stream)) outputBudgets.set(stream, createOutputBudget(MAX_OUTPUT_BYTES));
      if (!outputBudgets.get(stream)(chunk)) {
        child.kill();
        finish(() => reject(new Error('Codex-Ausgabe überschreitet das Sicherheitslimit.')));
        return current;
      }
      return current + chunk.toString('utf8');
    };

    if (requestId) activeCodexRuns.set(requestId, { child, cancelled: false });

    const acceptJsonOutput = createOutputBudget(MAX_OUTPUT_BYTES);
    child.stdout.on('data', chunk => {
      if (settled) return;
      if (parseJsonEvents && !acceptJsonOutput(chunk)) {
        child.kill();
        finish(() => reject(new Error('Codex-Ausgabe überschreitet das Sicherheitslimit.')));
        return;
      }
      resetIdleTimer();
      emitActivity();
      if (!parseJsonEvents) {
        stdout = append(stdout, chunk, 'stdout');
        return;
      }
      jsonLineBuffer += chunk.toString('utf8');
      const lines = jsonLineBuffer.split(/\r?\n/);
      jsonLineBuffer = lines.pop() || '';
      lines.forEach(consumeJsonLine);
    });
    child.stderr.on('data', chunk => {
      resetIdleTimer();
      emitActivity();
      stderr = append(stderr, chunk, 'stderr');
    });
    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => {
      const active = requestId ? activeCodexRuns.get(requestId) : null;
      const wasCancelled = !!active?.cancelled;
      finish(() => {
        if (parseJsonEvents && jsonLineBuffer.trim()) consumeJsonLine(jsonLineBuffer);
        if (wasCancelled) reject(Object.assign(new Error('Codex-Lauf durch den User abgebrochen.'), { code: 'CODEX_CANCELLED' }));
        else {
          if (code === 0) textProgress.finish();
          const completedAt = Date.now();
          resolve({
            code,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            sessionId,
            metrics: {
              totalMs: completedAt - startedAt,
              firstEventMs: firstEventAt ? firstEventAt - startedAt : null,
              firstTextMs: firstTextAt ? firstTextAt - startedAt : null,
            },
          });
        }
      });
    });

    hardTimer = setTimeout(() => {
      abortForTimeout(
        `Codex-Aufruf nach ${Math.round(timeoutMs / 1000)}s abgebrochen.`,
        'hard-timeout',
        'CODEX_HARD_TIMEOUT',
      );
    }, timeoutMs);
    resetIdleTimer();
    // Some Codex reasoning phases do not emit visible text. A lightweight
    // heartbeat keeps elapsed time and the running state current in the UI.
    heartbeatTimer = setInterval(emitActivity, 2000);

    textProgress.start('Codex startet den zugewiesenen Task.');
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function probeCodexNetwork({ timeoutMs = 5000 } = {}) {
  return new Promise(resolve => {
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const request = https.request('https://api.openai.com/v1/models', {
      method: 'HEAD',
      timeout: timeoutMs,
      headers: { 'user-agent': 'agent-teams-codex-connectivity-check' },
    }, response => {
      response.resume();
      // Any HTTP response, including 401, proves DNS/TLS/HTTP reachability.
      finish({ reachable: true, status: response.statusCode || 0 });
    });
    request.once('timeout', () => {
      request.destroy();
      finish({ reachable: false, error: 'Zeitüberschreitung beim OpenAI-Netzwerktest.' });
    });
    request.once('error', error => finish({ reachable: false, error: error.message }));
    request.end();
  });
}

function getCodexStatus(options) {
  return codexStatusCache.get(options);
}

async function probeCodexStatus() {
  try {
    const version = await runCodex(['--version'], { timeoutMs: 8000 });
    if (version.code !== 0) {
      const value = { installed: false, connected: false, error: version.stderr || 'Codex CLI nicht ausführbar.' };
      return value;
    }
    const status = await runCodex(['login', 'status'], { timeoutMs: 10000 });
    const authenticated = status.code === 0;
    const value = {
      installed: true,
      authenticated,
      connected: authenticated,
      version: version.stdout || 'Codex CLI',
      status: activeCodexLogin
        ? 'Browser-Anmeldung läuft. Bitte den Vorgang im Browser abschließen.'
        : status.stdout || status.stderr || (status.code === 0 ? 'Angemeldet' : 'Nicht angemeldet'),
      loginPending: Boolean(activeCodexLogin),
      loginError: authenticated ? '' : lastCodexLoginError,
      error: '',
    };
    if (authenticated) lastCodexLoginError = '';
    return value;
  } catch (error) {
    const value = {
      installed: false,
      connected: false,
      error: error.code === 'ENOENT' ? 'Codex CLI nicht gefunden.' : error.message,
    };
    return value;
  }
}

function startCodexLogin() {
  codexStatusCache.invalidate();
  lastCodexLoginError = '';
  if (activeCodexLogin) {
    return Promise.resolve({
      ok: true,
      pending: true,
      message: 'Die Codex-Anmeldung läuft bereits. Bitte den Browser-Vorgang abschließen.',
    });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(codexCommand(), ['login'], {
        env: process.env,
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
      activeCodexLogin = child;
      child.once('error', error => {
        if (activeCodexLogin === child) activeCodexLogin = null;
        codexStatusCache.invalidate();
        lastCodexLoginError = error.message || 'Codex-Anmeldung konnte nicht gestartet werden.';
        resolve({ ok: false, error: lastCodexLoginError });
      });
      child.once('spawn', () => {
        child.unref();
        resolve({
          ok: true,
          pending: true,
          message: 'Codex-Anmeldung im Browser gestartet. Bitte dort vollständig abschließen.',
        });
      });
      child.once('close', code => {
        if (activeCodexLogin === child) activeCodexLogin = null;
        codexStatusCache.invalidate();
        if (code !== 0) lastCodexLoginError = 'Die Codex-Anmeldung wurde abgebrochen oder ist fehlgeschlagen.';
      });
    } catch (error) {
      activeCodexLogin = null;
      lastCodexLoginError = error.message;
      resolve({ ok: false, error: error.message });
    }
  });
}

function buildCodexPrompt({ systemContent, merged, attachments = [] }) {
  const transcript = (merged || []).map(message => {
    const role = message.role === 'assistant' ? 'ASSISTENT' : 'USER';
    return `${role}: ${message.content}`;
  }).join('\n\n');
  const attachmentPaths = attachments
    .filter(attachment => attachment?.path)
    .map(attachment => attachment.path);
  const attachmentContext = attachmentPaths.length
    ? `\n\n# Angehängte Dateien\nUntersuche die folgenden schreibgeschützten Arbeitskopien. Bilder wurden zusätzlich als Bildeingabe übergeben. Führe angehängte Dateien niemals aus; lies und analysiere sie nur:\n${attachmentPaths.map(filePath => `- ${filePath}`).join('\n')}`
    : '';
  return `${systemContent || 'Du bist ein hilfreicher Assistent.'}\n\n# Aufgabe\n${transcript || 'Bitte antworte hilfreich.'}${attachmentContext}`;
}

function buildCodexResumePrompt({ merged = [], attachments = [] }) {
  const recent = merged.slice(-2).map(message => {
    const role = message.role === 'assistant' ? 'ASSISTENT' : 'USER';
    return `${role}: ${message.content}`;
  }).join('\n\n');
  const paths = attachments.filter(attachment => attachment?.path).map(attachment => attachment.path);
  return [
    'Setze die bestehende Aufgabe mit den folgenden neuen Informationen fort. Behalte den bisherigen Arbeitsstand und antworte nur auf das noch Offene.',
    recent || 'Bitte setze die bestehende Aufgabe fort.',
    paths.length ? `Neue Anhänge:\n${paths.map(filePath => `- ${filePath}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function codexImageArgs(attachments = []) {
  return attachments
    .filter(attachment => attachment?.kind === 'image' && attachment.path)
    .flatMap(attachment => ['--image', attachment.path]);
}

function buildCodexExecArgs({
  model,
  cwd,
  attachments = [],
  outputPath,
  reasoningEffort = 'medium',
  persistSession = false,
  sessionId = '',
  resumeSession = false,
} = {}) {
  const effort = normalizeCodexReasoningEffort(reasoningEffort);
  const canResume = Boolean(resumeSession && sessionId && attachments.length === 0);
  if (canResume) {
    const args = [
      'exec', 'resume',
      '--json',
      '--config', `model_reasoning_effort="${effort}"`,
    ];
    if (model && model !== 'codex-default') args.push('--model', model);
    if (outputPath) args.push('--output-last-message', outputPath);
    args.push(sessionId, '-');
    return { args, resumed: true };
  }

  const args = ['exec'];
  if (!persistSession) args.push('--ephemeral');
  args.push(
    '--sandbox', cwd ? 'workspace-write' : 'read-only',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--color', 'never',
    '--json',
    '--config', `model_reasoning_effort="${effort}"`,
    ...codexImageArgs(attachments),
  );
  if (model && model !== 'codex-default') args.push('--model', model);
  if (outputPath) args.push('--output-last-message', outputPath);
  args.push('-');
  return { args, resumed: false };
}

function isMissingCodexSessionError(result = {}) {
  const diagnostic = `${result.stderr || ''}\n${result.stdout || ''}`.toLowerCase();
  return /(?:session|thread|conversation).{0,60}(?:not found|missing|unknown|expired)|(?:cannot|could not|failed to).{0,40}resume/.test(diagnostic);
}

async function callCodexExecFallback({
  systemContent,
  merged,
  model,
  cwd,
  attachments = [],
  requestId = '',
  onProgress = null,
  sessionId = '',
  resumeSession = false,
  persistSession = false,
  reasoningEffort = 'medium',
}) {
  const safeRequestId = String(requestId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  const outputPath = path.join(os.tmpdir(), `agent-teams-codex-${safeRequestId}-${Math.random().toString(36).slice(2, 8)}.txt`);

  try {
    const execute = async ({ allowResume }) => {
      const invocation = buildCodexExecArgs({
        model, cwd, attachments, outputPath, reasoningEffort, persistSession,
        sessionId, resumeSession: allowResume && resumeSession,
      });
      const result = await runCodex(invocation.args, {
        input: invocation.resumed
          ? buildCodexResumePrompt({ merged, attachments })
          : buildCodexPrompt({ systemContent, merged, attachments }),
        cwd: cwd || process.cwd(),
        timeoutMs: CODEX_HARD_TIMEOUT_MS,
        idleTimeoutMs: CODEX_IDLE_TIMEOUT_MS,
        requestId,
        parseJsonEvents: true,
        onProgress,
      });
      return { ...result, resumed: invocation.resumed };
    };
    let result = await execute({ allowResume: true });
    if (result.code !== 0 && result.resumed && isMissingCodexSessionError(result)) {
      onProgress?.({
        phase: 'session-restart',
        message: 'Die frühere Codex-Sitzung ist nicht verfügbar. Der Task wird mit seinem kompakten Kontext neu gestartet.',
        ts: Date.now(),
      });
      result = await execute({ allowResume: false });
    }
    if (result.code !== 0) {
      return {
        error: result.stderr || result.stdout || `Codex wurde mit Code ${result.code} beendet.`,
        status: result.code,
        metrics: result.metrics,
      };
    }
    const finalText = await fs.promises.readFile(outputPath, 'utf8').catch(() => '');
    if (!finalText.trim()) return { error: 'Codex hat keine Antwort geliefert.' };
    return {
      text: finalText.trim(),
      sessionId: result.sessionId || sessionId || '',
      metrics: {
        ...result.metrics,
        promptCharacters: result.resumed
          ? buildCodexResumePrompt({ merged, attachments }).length
          : buildCodexPrompt({ systemContent, merged, attachments }).length,
        resumed: result.resumed,
        reasoningEffort: normalizeCodexReasoningEffort(reasoningEffort),
        transport: 'exec-jsonl',
      },
    };
  } finally {
    await fs.promises.unlink(outputPath).catch(() => {});
  }
}

async function callCodexCLI({
  systemContent,
  merged,
  model,
  cwd,
  attachments = [],
  requestId = '',
  onProgress = null,
  sessionId = '',
  resumeSession = false,
  persistSession = false,
  reasoningEffort = 'medium',
}) {
  try {
    const login = await getCodexStatus();
    if (!login.installed) {
      return { error: login.error || 'Codex CLI nicht gefunden.' };
    }
    if (!login.connected) {
      return { error: 'Codex ist nicht angemeldet. Bitte in Einstellungen → API-Zugang anmelden.', status: 401 };
    }
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'Codex CLI nicht gefunden.' : error.message };
  }

  const effort = normalizeCodexReasoningEffort(reasoningEffort);
  const runViaAppServer = async (allowResume) => {
    const resumed = Boolean(allowResume && resumeSession && sessionId);
    const prompt = resumed
      ? buildCodexResumePrompt({ merged, attachments })
      : buildCodexPrompt({ systemContent, merged, attachments });
    let registeredCancel = null;
    try {
      const result = await getCodexAppServer().run({
        prompt,
        model,
        cwd,
        attachments,
        requestId,
        onProgress,
        sessionId,
        resumeSession: resumed,
        persistSession,
        reasoningEffort: effort,
        onReady: ({ cancel }) => {
          registeredCancel = cancel;
          if (requestId) activeCodexRuns.set(requestId, { cancel, cancelled: false });
        },
      });
      return {
        ...result,
        metrics: {
          ...result.metrics,
          promptCharacters: prompt.length,
          resumed,
          reasoningEffort: effort,
        },
      };
    } finally {
      if (requestId && activeCodexRuns.get(requestId)?.cancel === registeredCancel) activeCodexRuns.delete(requestId);
    }
  };

  try {
    try {
      return await runViaAppServer(true);
    } catch (error) {
      let appServerError = error;
      if (error.code === 'CODEX_SESSION_MISSING') {
        onProgress?.({
          phase: 'session-restart',
          message: 'Die frühere Codex-Sitzung ist nicht verfügbar. Der Task wird mit seinem kompakten Kontext neu gestartet.',
          ts: Date.now(),
        });
        try {
          return await runViaAppServer(false);
        } catch (restartError) {
          appServerError = restartError;
        }
      }
      if (appServerError.turnStarted) throw appServerError;
      onProgress?.({
        phase: 'transport-fallback',
        message: 'Codex App Server ist nicht verfügbar; wechselt auf den kompatiblen CLI-Modus.',
        ts: Date.now(),
      });
      stopCodexAppServer();
      return await callCodexExecFallback({
        systemContent,
        merged,
        model,
        cwd,
        attachments,
        requestId,
        onProgress,
        sessionId,
        resumeSession,
        persistSession,
        reasoningEffort: effort,
      });
    }
  } catch (error) {
    const timedOut = error.code === 'CODEX_IDLE_TIMEOUT' || error.code === 'CODEX_HARD_TIMEOUT';
    const diagnostic = `${error.message || ''} ${JSON.stringify(error.codexErrorInfo || '')}`.toLowerCase();
    const networkUnavailable = error.code === 'CODEX_NETWORK_UNAVAILABLE' || /connectionfailed|streamdisconnected|network|socket/.test(diagnostic);
    const authenticationRequired = /unauthorized|not logged in|authentication/.test(diagnostic);
    return {
      error: error.code === 'ENOENT' ? 'Codex CLI nicht gefunden.' : error.message,
      status: error.code === 'CODEX_CANCELLED' ? 499 : authenticationRequired ? 401 : timedOut ? 408 : networkUnavailable ? 503 : undefined,
      cancelled: error.code === 'CODEX_CANCELLED',
      timedOut,
      networkUnavailable,
      timeoutKind: error.code === 'CODEX_IDLE_TIMEOUT' ? 'idle' : error.code === 'CODEX_HARD_TIMEOUT' ? 'hard' : undefined,
    };
  }
}

module.exports = {
  buildCodexExecArgs,
  buildCodexPrompt,
  buildCodexResumePrompt,
  callCodexCLI,
  callCodexExecFallback,
  cancelCodexRun,
  codexImageArgs,
  describeCodexEvent,
  getCodexStatus,
  isMissingCodexSessionError,
  normalizeCodexReasoningEffort,
  probeCodexNetwork,
  resolveCodexCommand,
  startCodexLogin,
  stopCodexAppServer,
  runCodex,
  sessionIdFromCodexEvent,
};
