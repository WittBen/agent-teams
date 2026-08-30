const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const CODEX_IDLE_TIMEOUT_MS = 120000;
const CODEX_HARD_TIMEOUT_MS = 15 * 60 * 1000;
const activeCodexRuns = new Map();

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

function cleanProgressText(value, maxLength = 180) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
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
    if (item.type === 'agent_message') return { phase: 'finalizing', message: 'Formuliert das konkrete Arbeitsergebnis.' };
  }

  return null;
}

function cancelCodexRun(requestId) {
  const active = requestId ? activeCodexRuns.get(requestId) : null;
  if (!active) return { ok: false, message: 'Kein aktiver Codex-Lauf gefunden.' };
  active.cancelled = true;
  active.child.kill();
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
    let lastActivityEventAt = 0;

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

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
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

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(new Error('Codex-Ausgabe überschreitet das Sicherheitslimit.')));
        return current;
      }
      return next;
    };

    if (requestId) activeCodexRuns.set(requestId, { child, cancelled: false });

    child.stdout.on('data', chunk => {
      resetIdleTimer();
      emitActivity();
      if (!parseJsonEvents) {
        stdout = append(stdout, chunk);
        return;
      }
      jsonLineBuffer += chunk.toString('utf8');
      const lines = jsonLineBuffer.split(/\r?\n/);
      jsonLineBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          emitProgress(describeCodexEvent(JSON.parse(line)));
        } catch {
          // Ignore non-JSON diagnostics; the final answer is read separately.
        }
      }
    });
    child.stderr.on('data', chunk => {
      resetIdleTimer();
      emitActivity();
      stderr = append(stderr, chunk);
    });
    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => {
      const active = requestId ? activeCodexRuns.get(requestId) : null;
      const wasCancelled = !!active?.cancelled;
      finish(() => {
        if (wasCancelled) reject(Object.assign(new Error('Codex-Lauf durch den User abgebrochen.'), { code: 'CODEX_CANCELLED' }));
        else resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
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

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

async function getCodexStatus() {
  try {
    const version = await runCodex(['--version'], { timeoutMs: 8000 });
    if (version.code !== 0) {
      return { installed: false, connected: false, error: version.stderr || 'Codex CLI nicht ausführbar.' };
    }
    const status = await runCodex(['login', 'status'], { timeoutMs: 10000 });
    return {
      installed: true,
      connected: status.code === 0,
      version: version.stdout || 'Codex CLI',
      status: status.stdout || status.stderr || (status.code === 0 ? 'Angemeldet' : 'Nicht angemeldet'),
    };
  } catch (error) {
    return {
      installed: false,
      connected: false,
      error: error.code === 'ENOENT' ? 'Codex CLI nicht gefunden.' : error.message,
    };
  }
}

function startCodexLogin() {
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
      child.once('error', error => resolve({ ok: false, error: error.message }));
      child.once('spawn', () => {
        child.unref();
        resolve({ ok: true, message: 'Codex-Anmeldung im Browser gestartet.' });
      });
    } catch (error) {
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

function codexImageArgs(attachments = []) {
  return attachments
    .filter(attachment => attachment?.kind === 'image' && attachment.path)
    .flatMap(attachment => ['--image', attachment.path]);
}

async function callCodexCLI({ systemContent, merged, model, cwd, attachments = [], requestId = '', onProgress = null }) {
  try {
    const login = await runCodex(['login', 'status'], { timeoutMs: 10000 });
    if (login.code !== 0) {
      return { error: 'Codex ist nicht angemeldet. Bitte in Einstellungen → API-Zugang anmelden.', status: 401 };
    }
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'Codex CLI nicht gefunden.' : error.message };
  }

  const args = [
    'exec',
    '--ephemeral',
    '--sandbox', cwd ? 'workspace-write' : 'read-only',
    '--skip-git-repo-check',
    '--ignore-rules',
    '--color', 'never',
    '--json',
    ...codexImageArgs(attachments),
  ];
  if (model && model !== 'codex-default') args.push('--model', model);
  const safeRequestId = String(requestId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
  const outputPath = path.join(os.tmpdir(), `agent-teams-codex-${safeRequestId}-${Math.random().toString(36).slice(2, 8)}.txt`);
  args.push('--output-last-message', outputPath);
  args.push('-');

  try {
    onProgress?.({ phase: 'starting', message: 'Bereitet die Arbeitsumgebung für den Task vor.', ts: Date.now() });
    const result = await runCodex(args, {
      input: buildCodexPrompt({ systemContent, merged, attachments }),
      cwd: cwd || process.cwd(),
      timeoutMs: CODEX_HARD_TIMEOUT_MS,
      idleTimeoutMs: CODEX_IDLE_TIMEOUT_MS,
      requestId,
      parseJsonEvents: true,
      onProgress,
    });
    if (result.code !== 0) {
      return { error: result.stderr || result.stdout || `Codex wurde mit Code ${result.code} beendet.`, status: result.code };
    }
    const finalText = await fs.promises.readFile(outputPath, 'utf8').catch(() => '');
    if (!finalText.trim()) return { error: 'Codex hat keine Antwort geliefert.' };
    return { text: finalText.trim() };
  } catch (error) {
    const timedOut = error.code === 'CODEX_IDLE_TIMEOUT' || error.code === 'CODEX_HARD_TIMEOUT';
    return {
      error: error.code === 'ENOENT' ? 'Codex CLI nicht gefunden.' : error.message,
      status: error.code === 'CODEX_CANCELLED' ? 499 : timedOut ? 408 : undefined,
      cancelled: error.code === 'CODEX_CANCELLED',
      timedOut,
      timeoutKind: error.code === 'CODEX_IDLE_TIMEOUT' ? 'idle' : error.code === 'CODEX_HARD_TIMEOUT' ? 'hard' : undefined,
    };
  } finally {
    await fs.promises.unlink(outputPath).catch(() => {});
  }
}

  module.exports = {
    buildCodexPrompt,
    callCodexCLI,
  cancelCodexRun,
  codexImageArgs,
  describeCodexEvent,
  getCodexStatus,
  resolveCodexCommand,
  startCodexLogin,
  runCodex,
};
