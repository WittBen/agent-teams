const { createCliStatusCache, createOutputBudget } = require('./cli-performance');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTextProgress } = require('./llm-stream');

const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const CLAUDE_TIMEOUT_MS = 120000;
const activeClaudeRuns = new Map();

function resolveClaudeCommand({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  if (platform !== 'win32') return 'claude';

  // Apps launched through Explorer inherit a smaller/stale PATH surprisingly
  // often. Claude's native Windows installer uses ~/.local/bin, so resolve the
  // executable there explicitly before falling back to PATH lookup.
  const candidates = [
    env.CLAUDE_CODE_CLI_PATH,
    homeDir && path.win32.join(homeDir, '.local', 'bin', 'claude.exe'),
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Programs', 'Claude', 'claude.exe'),
  ].filter(Boolean);
  return candidates.find(candidate => {
    try { return existsSync(candidate); } catch { return false; }
  }) || 'claude.exe';
}

function buildClaudePrompt({ systemContent, merged, attachments = [] }) {
  const transcript = (merged || []).map(message => {
    const role = message.role === 'assistant' ? 'ASSISTENT' : 'USER';
    return `${role}: ${message.content}`;
  }).join('\n\n');
  const attachmentPaths = attachments
    .filter(attachment => attachment?.path)
    .map(attachment => attachment.path);
  const attachmentContext = attachmentPaths.length
    ? `\n\n# Angehängte Dateien\nNutze das Read-Werkzeug, um diese vom User angehängten Dateien zu untersuchen. Falls ein Format nicht direkt lesbar ist, erkläre das konkret und arbeite mit den verfügbaren Metadaten weiter:\n${attachmentPaths.map(filePath => `- ${filePath}`).join('\n')}`
    : '';
  return `${systemContent || 'Du bist ein hilfreicher Assistent.'}\n\n# Aufgabe\n${transcript || 'Bitte antworte hilfreich.'}${attachmentContext}`;
}

function buildClaudeResumePrompt({ merged, attachments = [] }) {
  const latest = [...(merged || [])].reverse().find(message => message?.role === 'user') || (merged || []).at(-1);
  const attachmentPaths = attachments.filter(attachment => attachment?.path).map(attachment => attachment.path);
  return [
    latest?.content || 'Setze die aktuelle Aufgabe fort.',
    attachmentPaths.length
      ? `Angehängte Dateien:\n${attachmentPaths.map(filePath => `- ${filePath}`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
}

function buildClaudeArgs({ model, attachments = [], cwd = '', sessionId = '', resumeSession = false }) {
  const fallbackModel = fallbackModelFor(model);
  const readableDirectories = [...new Set([
    ...(cwd ? [path.resolve(cwd)] : []),
    ...attachments
    .filter(attachment => attachment?.path)
    .map(attachment => path.dirname(attachment.path)),
  ])];
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  if (readableDirectories.length) {
    const projectTools = cwd ? 'Read,Write,Edit' : 'Read';
    const allowedTools = cwd ? 'Read,Edit(/**),Write(/**)' : 'Read';
    args.push(
      '--add-dir', ...readableDirectories,
      '--tools', projectTools,
      '--allowedTools', allowedTools,
      ...(cwd ? [
        '--permission-mode', 'dontAsk',
        '--settings', JSON.stringify({
          permissions: {
            deny: ['.git', '.svn', 'node_modules'].flatMap(directory => [
              `Read(/${directory}/**)`,
              `Edit(/${directory}/**)`,
              `Write(/${directory}/**)`,
            ]),
          },
        }),
      ] : []),
    );
  } else {
    args.push('--tools', '');
  }
  if (model) args.push('--model', model);
  if (fallbackModel) args.push('--fallback-model', fallbackModel);
  if (sessionId) args.push(resumeSession ? '--resume' : '--session-id', sessionId);
  return { args, fallbackModel };
}

function fallbackModelFor(model) {
  return /opus/i.test(String(model || '')) ? 'sonnet' : null;
}

function isClaudeRateLimitMessage(value) {
  return /(?:rate.?limit|usage.?limit|session.?limit|quota|too many requests|hit your(?:\s+\w+){0,3}\s+limit|resets?(?:\s+at)?\s+\d)/i.test(String(value || ''));
}

function parseClaudeStreamEvent(event) {
  if (!event || typeof event !== 'object') return null;
  if (event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event?.delta?.type === 'text_delta') {
    return { delta: String(event.event.delta.text || '') };
  }
  if (event.type === 'system' && event.subtype === 'init') {
    return { phase: 'ready', message: 'Claude-Arbeitsumgebung ist bereit.', sessionId: event.session_id || '' };
  }
  if (event.type === 'result') {
    return { phase: event.is_error ? 'error' : 'finalizing', message: event.is_error ? 'Claude meldet einen Fehler.' : 'Claude schließt den Task ab.' };
  }
  return null;
}

function runClaude(args, {
  input = '',
  cwd = process.cwd(),
  timeoutMs = CLAUDE_TIMEOUT_MS,
  idleTimeoutMs = 0,
  requestId = '',
  onProgress = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    let timer;
    let idleTimer;
    let jsonLineBuffer = '';
    const startedAt = Date.now();
    let firstEventAt = null;
    let firstTextAt = null;
    const textProgress = createTextProgress(onProgress, 'anthropic');

    const consumeJsonLine = (line) => {
      if (!line.trim()) return;
      try {
        const progress = parseClaudeStreamEvent(JSON.parse(line));
        firstEventAt ??= Date.now();
        if (progress?.delta) {
          firstTextAt ??= Date.now();
          textProgress.push(progress.delta);
        }
        else if (progress) onProgress?.({ ...progress, ts: Date.now() });
      } catch {
        // Non-JSON diagnostics remain available in the final error output.
      }
    };

    try {
      child = spawn(resolveClaudeCommand(), args, {
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

    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      if (requestId && activeClaudeRuns.get(requestId)?.child === child) activeClaudeRuns.delete(requestId);
      callback();
    };

    const outputBudgets = new Map();
    const append = (current, chunk, stream) => {
      if (!outputBudgets.has(stream)) outputBudgets.set(stream, createOutputBudget(MAX_OUTPUT_BYTES));
      if (!outputBudgets.get(stream)(chunk)) {
        child.kill();
        finish(() => reject(new Error('Claude-Ausgabe überschreitet das Sicherheitslimit.')));
        return current;
      }
      return current + chunk.toString('utf8');
    };

    if (requestId) activeClaudeRuns.set(requestId, { child, cancelled: false });
    const touch = () => {
      if (!idleTimeoutMs || settled) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        child.kill();
        const message = `Claude-Aufruf nach ${Math.round(idleTimeoutMs / 1000)}s ohne Aktivität abgebrochen.`;
        onProgress?.({ phase: 'idle-timeout', message, ts: Date.now() });
        finish(() => reject(Object.assign(new Error(message), { code: 'CLAUDE_IDLE_TIMEOUT' })));
      }, idleTimeoutMs);
    };
    touch();
    textProgress.start('Claude Code startet den zugewiesenen Task.');

    child.stdout.on('data', chunk => {
      if (settled) return;
      touch();
      stdout = append(stdout, chunk, 'stdout');
      if (settled) return;
      jsonLineBuffer += chunk.toString('utf8');
      const lines = jsonLineBuffer.split(/\r?\n/);
      jsonLineBuffer = lines.pop() || '';
      lines.forEach(consumeJsonLine);
    });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk, 'stderr'); });
    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => {
      const wasCancelled = !!(requestId && activeClaudeRuns.get(requestId)?.cancelled);
      finish(() => {
        if (jsonLineBuffer.trim()) consumeJsonLine(jsonLineBuffer);
        if (wasCancelled) {
          reject(Object.assign(new Error('Claude-Lauf durch den User abgebrochen.'), { code: 'CLAUDE_CANCELLED' }));
        } else {
          if (code === 0) textProgress.finish();
          resolve({ code, stdout: stdout.trim(), stderr: stderr.trim(), metrics: {
            totalMs: Date.now() - startedAt,
            firstEventMs: firstEventAt === null ? null : firstEventAt - startedAt,
            firstTextMs: firstTextAt === null ? null : firstTextAt - startedAt,
            transport: 'exec-jsonl',
          } });
        }
      });
    });

    timer = setTimeout(() => {
      child.kill();
      const message = `Claude-Aufruf nach ${Math.round(timeoutMs / 1000)}s abgebrochen.`;
      onProgress?.({ phase: 'hard-timeout', message, ts: Date.now() });
      finish(() => reject(Object.assign(new Error(message), { code: 'CLAUDE_TIMEOUT' })));
    }, timeoutMs);

    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function parseClaudeResult(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    const lines = String(stdout || '').split(/\r?\n/).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try { return JSON.parse(lines[index]); } catch {}
    }
  }
  return null;
}

const claudeStatusCache = createCliStatusCache(probeClaudeStatus);

function getClaudeStatus(options) {
  return claudeStatusCache.get(options);
}

async function probeClaudeStatus() {
  try {
    const version = await runClaude(['--version'], { timeoutMs: 8000 });
    if (version.code !== 0) {
      return { installed: false, connected: false, error: version.stderr || 'Claude Code CLI nicht ausführbar.' };
    }
    const status = await runClaude(['auth', 'status'], { timeoutMs: 10000 });
    const parsed = parseClaudeResult(status.stdout) || {};
    return {
      installed: true,
      connected: status.code === 0 && parsed.loggedIn === true,
      version: version.stdout || 'Claude Code CLI',
      authMethod: parsed.authMethod || null,
      apiProvider: parsed.apiProvider || null,
      status: status.code === 0 && parsed.loggedIn ? 'Angemeldet' : (status.stderr || 'Nicht angemeldet'),
    };
  } catch (error) {
    return {
      installed: false,
      connected: false,
      error: error.code === 'ENOENT' ? 'Claude Code CLI nicht gefunden.' : error.message,
    };
  }
}

function cancelClaudeRun(requestId) {
  const active = requestId ? activeClaudeRuns.get(requestId) : null;
  if (!active) return { ok: false, message: 'Kein aktiver Claude-Lauf gefunden.' };
  active.cancelled = true;
  active.child.kill();
  return { ok: true, message: 'Claude-Lauf wird abgebrochen.' };
}

async function callClaudeCLI({ systemContent, merged, model, cwd, attachments = [], requestId = '', onProgress = null, sessionId = '', resumeSession = false }) {
  const { fallbackModel } = buildClaudeArgs({ model, attachments, cwd, sessionId, resumeSession });

  try {
    const execute = continuing => {
      const { args } = buildClaudeArgs({ model, attachments, cwd, sessionId, resumeSession: continuing });
      return runClaude(args, {
        timeoutMs: 15 * 60 * 1000,
        idleTimeoutMs: CLAUDE_TIMEOUT_MS,
        input: continuing
          ? buildClaudeResumePrompt({ merged, attachments })
          : buildClaudePrompt({ systemContent, merged, attachments }),
        cwd: cwd || process.cwd(),
        requestId,
        onProgress,
      });
    };
    let result = await execute(resumeSession);
    if (resumeSession && result.code !== 0 && /(?:conversation|session).{0,40}(?:not found|unknown|invalid|expired)/i.test(`${result.stderr}\n${result.stdout}`)) {
      onProgress?.({ phase: 'restarting', message: 'Gespeicherte Sitzung ist nicht mehr verfügbar; der Task wird isoliert neu gestartet.', ts: Date.now() });
      result = await execute(false);
    }
    const parsed = parseClaudeResult(result.stdout);
    const errorText = parsed?.error || parsed?.result || result.stderr || result.stdout;
    if (result.code !== 0 || parsed?.is_error) {
      const rateLimited = isClaudeRateLimitMessage(errorText);
      return {
        error: rateLimited
          ? 'Claude-Nutzungslimit erreicht. Der Task bleibt zum späteren Fortsetzen gespeichert.'
          : (errorText || `Claude wurde mit Code ${result.code} beendet.`),
        status: rateLimited ? 429 : result.code,
        rateLimited,
        retryable: rateLimited,
        retryAfterMs: rateLimited ? 60000 : 0,
        fallbackModel,
      };
    }
    const text = typeof parsed?.result === 'string' ? parsed.result : '';
    if (!text.trim()) return { error: 'Claude hat keine Antwort geliefert.' };
    onProgress?.({ phase: 'finalizing', message: 'Claude schließt den Task ab.', ts: Date.now() });
    return { text: text.trim(), fallbackModel, sessionId: parsed?.session_id || sessionId, metrics: result.metrics };
  } catch (error) {
    const timedOut = ['CLAUDE_TIMEOUT', 'CLAUDE_IDLE_TIMEOUT'].includes(error.code);
    const cancelled = error.code === 'CLAUDE_CANCELLED';
    return {
      error: error.code === 'ENOENT' ? 'Claude Code CLI nicht gefunden.' : error.message,
      status: cancelled ? 499 : timedOut ? 408 : undefined,
      cancelled,
      timedOut,
      timeoutKind: timedOut ? (error.code === 'CLAUDE_IDLE_TIMEOUT' ? 'idle' : 'hard') : undefined,
    };
  }
}

module.exports = {
  buildClaudeArgs,
  buildClaudePrompt,
  buildClaudeResumePrompt,
  callClaudeCLI,
  cancelClaudeRun,
  fallbackModelFor,
  getClaudeStatus,
  isClaudeRateLimitMessage,
  parseClaudeResult,
  parseClaudeStreamEvent,
  resolveClaudeCommand,
  runClaude,
};
