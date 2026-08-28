const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function buildClaudeArgs({ model, attachments = [], cwd = '' }) {
  const fallbackModel = fallbackModelFor(model);
  const readableDirectories = [...new Set([
    ...(cwd ? [path.resolve(cwd)] : []),
    ...attachments
    .filter(attachment => attachment?.path)
    .map(attachment => path.dirname(attachment.path)),
  ])];
  const args = ['--print', '--output-format', 'json'];
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
  return { args, fallbackModel };
}

function fallbackModelFor(model) {
  return /opus/i.test(String(model || '')) ? 'sonnet' : null;
}

function isClaudeRateLimitMessage(value) {
  return /(?:rate.?limit|usage.?limit|quota|too many requests|hit your limit|resets? at)/i.test(String(value || ''));
}

function runClaude(args, {
  input = '',
  cwd = process.cwd(),
  timeoutMs = CLAUDE_TIMEOUT_MS,
  requestId = '',
  onProgress = null,
} = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    let timer;

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
      if (requestId && activeClaudeRuns.get(requestId)?.child === child) activeClaudeRuns.delete(requestId);
      callback();
    };

    const append = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (Buffer.byteLength(next, 'utf8') > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(() => reject(new Error('Claude-Ausgabe überschreitet das Sicherheitslimit.')));
        return current;
      }
      return next;
    };

    if (requestId) activeClaudeRuns.set(requestId, { child, cancelled: false });
    onProgress?.({ phase: 'starting', message: 'Claude Code startet den zugewiesenen Task.', ts: Date.now() });

    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => finish(() => reject(error)));
    child.on('close', code => {
      const wasCancelled = !!(requestId && activeClaudeRuns.get(requestId)?.cancelled);
      finish(() => {
        if (wasCancelled) {
          reject(Object.assign(new Error('Claude-Lauf durch den User abgebrochen.'), { code: 'CLAUDE_CANCELLED' }));
        } else {
          resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
        }
      });
    });

    timer = setTimeout(() => {
      child.kill();
      onProgress?.({ phase: 'timeout', message: 'Claude-Task wurde nach 120s abgebrochen.', ts: Date.now() });
      finish(() => reject(Object.assign(new Error('Claude-Aufruf nach 120s abgebrochen.'), { code: 'CLAUDE_TIMEOUT' })));
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

async function getClaudeStatus() {
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

async function callClaudeCLI({ systemContent, merged, model, cwd, attachments = [], requestId = '', onProgress = null }) {
  const { args, fallbackModel } = buildClaudeArgs({ model, attachments, cwd });

  try {
    const result = await runClaude(args, {
      input: buildClaudePrompt({ systemContent, merged, attachments }),
      cwd: cwd || process.cwd(),
      requestId,
      onProgress,
    });
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
    return { text: text.trim(), fallbackModel };
  } catch (error) {
    const timedOut = error.code === 'CLAUDE_TIMEOUT';
    const cancelled = error.code === 'CLAUDE_CANCELLED';
    return {
      error: error.code === 'ENOENT' ? 'Claude Code CLI nicht gefunden.' : error.message,
      status: cancelled ? 499 : timedOut ? 408 : undefined,
      cancelled,
      timedOut,
      timeoutKind: timedOut ? 'hard' : undefined,
    };
  }
}

module.exports = {
  buildClaudeArgs,
  buildClaudePrompt,
  callClaudeCLI,
  cancelClaudeRun,
  fallbackModelFor,
  getClaudeStatus,
  isClaudeRateLimitMessage,
  parseClaudeResult,
  resolveClaudeCommand,
  runClaude,
};
