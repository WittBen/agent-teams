const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_TEST_TIMEOUT_MS = 120000;
const SHELL_META_PATTERN = /[&|<>^%!\r\n]/;

function normalizeArguments(value) {
  const args = Array.isArray(value) ? value : [];
  return args.slice(0, 50).map(argument => {
    const normalized = String(argument || '');
    if (normalized.length > 2000 || normalized.includes('\0')) throw new Error('Ungültiges Befehlsargument.');
    return normalized;
  });
}

function normalizeCommandConfig(raw) {
  const command = String(raw?.command || '').trim();
  if (!command) return null;
  if (command.length > 500 || command.includes('\0') || /[\r\n]/.test(command)) throw new Error('Ungültiger Prüfbefehl.');
  return { command, args: normalizeArguments(raw?.args) };
}

function normalizePreviewUrl(value) {
  const raw = String(value || '').trim().slice(0, 2048);
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('Vorschau-URL ist ungültig.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Vorschau-URL muss mit http:// oder https:// beginnen.');
  }
  if (parsed.username || parsed.password) throw new Error('Vorschau-URL darf keine Zugangsdaten enthalten.');
  return parsed.toString();
}

function normalizeReviewEnvironment(raw) {
  return {
    test: normalizeCommandConfig(raw?.test),
    preview: normalizeCommandConfig(raw?.preview),
    previewUrl: normalizePreviewUrl(raw?.previewUrl),
    testTimeoutMs: Math.min(300000, Math.max(5000, Number(raw?.testTimeoutMs) || DEFAULT_TEST_TIMEOUT_MS)),
  };
}

function commandFingerprint(projectPath, action, config) {
  return crypto.createHash('sha256').update(JSON.stringify({
    projectPath: path.resolve(projectPath).toLowerCase(), action, command: config.command, args: config.args,
  })).digest('hex');
}

function safeChildEnvironment() {
  const allowedNames = new Set([
    'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'ProgramFiles',
    'PROGRAMFILES(X86)', 'ProgramFiles(x86)', 'COMMONPROGRAMFILES', 'CommonProgramFiles',
    'COMSPEC', 'ComSpec', 'LANG', 'LC_ALL', 'TERM', 'HOME',
  ]);
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => allowedNames.has(name)));
}

function spawnConfig(config, cwd) {
  const extension = path.extname(config.command).toLowerCase();
  if (process.platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    if (SHELL_META_PATTERN.test(config.command) || config.args.some(argument => SHELL_META_PATTERN.test(argument))) {
      throw new Error('Shell-Sonderzeichen sind für CMD/BAT-Prüfbefehle gesperrt.');
    }
    const quote = value => `"${String(value).replace(/"/g, '""')}"`;
    // cmd.exe /S removes the first and last quote around the /C payload. The
    // additional outer pair keeps a quoted executable path intact.
    const commandLine = `"${[quote(config.command), ...config.args.map(quote)].join(' ')}"`;
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', commandLine],
      options: {
        cwd, windowsHide: true, shell: false, windowsVerbatimArguments: true, env: safeChildEnvironment(),
      },
    };
  }
  return {
    command: config.command,
    args: config.args,
    options: { cwd, windowsHide: true, shell: false, env: safeChildEnvironment() },
  };
}

function appendBounded(current, chunk) {
  const next = current + String(chunk || '');
  if (Buffer.byteLength(next, 'utf8') <= MAX_OUTPUT_BYTES) return next;
  const marker = '[Ausgabe auf 1 MB gekürzt]\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const encoded = Buffer.from(next, 'utf8');
  let start = Math.max(0, encoded.length - (MAX_OUTPUT_BYTES - markerBytes));
  while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start += 1;
  return marker + encoded.subarray(start).toString('utf8');
}

function terminateChild(child) {
  if (!child || child.killed || !child.pid) return;
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }
  const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
    windowsHide: true, shell: false, stdio: 'ignore', env: safeChildEnvironment(),
  });
  killer.once('error', () => child.kill());
  killer.once('close', code => {
    if (code !== 0 && !child.killed) child.kill();
  });
}

class ReviewRunner {
  constructor({ onOutput = null } = {}) {
    this.onOutput = onOutput;
    this.active = new Map();
  }

  _key(chatId, action) {
    return `${String(chatId)}:${String(action)}`;
  }

  status(chatId) {
    return [...this.active.values()].filter(run => run.chatId === chatId).map(run => ({
      action: run.action,
      startedAt: run.startedAt,
      command: run.displayCommand,
      running: !run.finished,
      output: run.output,
    }));
  }

  hasActiveRuns() {
    return this.active.size > 0;
  }

  async runTest({ chatId, cwd, config, timeoutMs = DEFAULT_TEST_TIMEOUT_MS }) {
    const key = this._key(chatId, 'test');
    if (this.active.has(key)) throw new Error('Für diese Gruppe läuft bereits eine Prüfung.');
    const launch = spawnConfig(config, cwd);
    return new Promise((resolve, reject) => {
      const child = spawn(launch.command, launch.args, launch.options);
      const run = {
        chatId, action: 'test', child, output: '', finished: false,
        startedAt: new Date().toISOString(), displayCommand: [config.command, ...config.args].join(' '),
      };
      this.active.set(key, run);
      const timer = setTimeout(() => {
        run.timedOut = true;
        terminateChild(child);
      }, Math.min(300000, Math.max(5000, Number(timeoutMs) || DEFAULT_TEST_TIMEOUT_MS)));
      const onChunk = (stream, chunk) => {
        run.output = appendBounded(run.output, chunk);
        this.onOutput?.({ chatId, action: 'test', stream, chunk: String(chunk), output: run.output });
      };
      child.stdout?.on('data', chunk => onChunk('stdout', chunk));
      child.stderr?.on('data', chunk => onChunk('stderr', chunk));
      child.once('error', error => {
        clearTimeout(timer);
        run.finished = true;
        this.active.delete(key);
        reject(error);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        run.finished = true;
        this.active.delete(key);
        resolve({
          ok: code === 0 && !run.timedOut,
          code,
          signal,
          timedOut: Boolean(run.timedOut),
          output: run.output,
          command: run.displayCommand,
          startedAt: run.startedAt,
          finishedAt: new Date().toISOString(),
        });
      });
    });
  }

  async startPreview({ chatId, cwd, config }) {
    const key = this._key(chatId, 'preview');
    if (this.active.has(key)) return { ok: true, alreadyRunning: true, ...this.status(chatId).find(run => run.action === 'preview') };
    const launch = spawnConfig(config, cwd);
    const child = spawn(launch.command, launch.args, launch.options);
    const run = {
      chatId, action: 'preview', child, output: '', finished: false,
      startedAt: new Date().toISOString(), displayCommand: [config.command, ...config.args].join(' '),
    };
    this.active.set(key, run);
    const onChunk = (stream, chunk) => {
      run.output = appendBounded(run.output, chunk);
      this.onOutput?.({ chatId, action: 'preview', stream, chunk: String(chunk), output: run.output });
    };
    child.stdout?.on('data', chunk => onChunk('stdout', chunk));
    child.stderr?.on('data', chunk => onChunk('stderr', chunk));
    child.once('error', error => {
      run.output = appendBounded(run.output, `\n${error.message}`);
      run.finished = true;
      this.active.delete(key);
      this.onOutput?.({ chatId, action: 'preview', stream: 'error', chunk: error.message, output: run.output, finished: true });
    });
    child.once('close', (code, signal) => {
      run.finished = true;
      this.active.delete(key);
      this.onOutput?.({ chatId, action: 'preview', stream: 'close', chunk: '', output: run.output, finished: true, code, signal });
    });
    await new Promise(resolve => setTimeout(resolve, 800));
    if (run.finished) throw new Error(run.output || 'Vorschauprozess wurde sofort beendet.');
    return { ok: true, running: true, startedAt: run.startedAt, command: run.displayCommand, output: run.output };
  }

  async stop({ chatId, action = 'preview' }) {
    const key = this._key(chatId, action);
    const run = this.active.get(key);
    if (!run) return { ok: false, message: 'Kein passender Prüfprozess läuft.' };
    if (run.finished) return { ok: true, alreadyFinished: true };
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve({ ok: true });
      };
      run.child.once('close', finish);
      terminateChild(run.child);
      setTimeout(finish, 2000).unref?.();
    });
  }

  stopAll() {
    const pending = [...this.active.values()].map(run => this.stop({ chatId: run.chatId, action: run.action }));
    return Promise.all(pending);
  }
}

module.exports = {
  DEFAULT_TEST_TIMEOUT_MS,
  ReviewRunner,
  appendBounded,
  commandFingerprint,
  normalizeReviewEnvironment,
  normalizePreviewUrl,
  spawnConfig,
};
