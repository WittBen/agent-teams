const { spawn } = require('child_process');
const { createTextProgress } = require('./llm-stream');

const APP_SERVER_REQUEST_TIMEOUT_MS = 15000;
const APP_SERVER_IDLE_TIMEOUT_MS = 120000;
const APP_SERVER_HARD_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_PROTOCOL_BUFFER_BYTES = 4 * 1024 * 1024;

function cleanText(value, maxLength = 220) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function appServerItemProgress(item, completed = false) {
  if (!item || typeof item !== 'object') return null;
  if (item.type === 'commandExecution') {
    if (completed) {
      return item.exitCode === 0
        ? { phase: 'command', message: 'Befehl erfolgreich abgeschlossen.' }
        : { phase: 'command-error', message: `Befehl mit Exit-Code ${item.exitCode ?? 'unbekannt'} beendet.` };
    }
    const command = cleanText(item.command);
    return { phase: 'command', message: command ? `Befehl läuft: ${command}` : 'Ein Befehl wird ausgeführt …' };
  }
  if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
    const tool = cleanText(item.tool || item.server);
    return completed
      ? { phase: 'tool', message: 'Werkzeug-Aufruf abgeschlossen.' }
      : { phase: 'tool', message: tool ? `Werkzeug läuft: ${tool}` : 'Ein Werkzeug wird ausgeführt …' };
  }
  if (item.type === 'webSearch') return { phase: 'search', message: 'Recherchiert benötigte Informationen.' };
  if (item.type === 'fileChange') {
    return completed
      ? { phase: 'files', message: 'Dateiänderungen wurden vorbereitet.' }
      : { phase: 'files', message: 'Bereitet die benötigten Dateiänderungen vor.' };
  }
  if (item.type === 'reasoning') return { phase: 'analysis', message: 'Prüft Lösungsweg und nächsten Arbeitsschritt.' };
  if (item.type === 'agentMessage') return { phase: completed ? 'finalizing' : 'streaming', message: completed ? 'Formuliert das konkrete Arbeitsergebnis.' : 'Antwort wird live erstellt.' };
  return null;
}

function buildAppServerInput(prompt, attachments = []) {
  return [
    { type: 'text', text: String(prompt || '') },
    ...attachments
      .filter(attachment => attachment?.kind === 'image' && attachment.path)
      .map(attachment => ({ type: 'localImage', path: attachment.path })),
  ];
}

function appServerError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

class CodexAppServerClient {
  constructor({ command, args = ['app-server', '--listen', 'stdio://'], cwd = process.cwd(), env = process.env } = {}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.startPromise = null;
    this.nextId = 1;
    this.pending = new Map();
    this.runsByThread = new Map();
    this.runsByTurn = new Map();
    this.stdoutBuffer = '';
    this.stderr = '';
    this.intentionalStop = false;
  }

  async ensureStarted() {
    if (this.child && !this.child.killed && this.startPromise) return this.startPromise;
    this.intentionalStop = false;
    this.stdoutBuffer = '';
    this.stderr = '';
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const child = this.child;
    child.stdout.on('data', chunk => this.consumeStdout(chunk));
    child.stderr.on('data', chunk => {
      this.stderr = `${this.stderr}${chunk.toString('utf8')}`.slice(-16000);
    });
    child.on('error', error => {
      if (this.child === child) this.handleExit(error);
    });
    child.stdin.on('error', error => {
      if (this.child === child) this.handleExit(error);
    });
    child.on('close', code => {
      if (this.child === child) this.handleExit(appServerError(
        this.intentionalStop ? 'Codex App Server wurde beendet.' : `Codex App Server wurde mit Code ${code} beendet.`,
        'CODEX_APP_SERVER_EXIT',
        { exitCode: code },
      ));
    });
    this.startPromise = (async () => {
      try {
        await this.request('initialize', {
          clientInfo: { name: 'agent_teams_desktop', title: 'Agent Teams', version: '1.1.0' },
          capabilities: {},
        }, APP_SERVER_REQUEST_TIMEOUT_MS, { skipStart: true });
        this.notify('initialized', {});
        return this;
      } catch (error) {
        if (this.child === child) child.kill();
        throw appServerError(
          `${error.message}${this.stderr.trim() ? ` (${cleanText(this.stderr, 500)})` : ''}`,
          'CODEX_APP_SERVER_UNAVAILABLE',
          { cause: error },
        );
      }
    })();
    return this.startPromise;
  }

  consumeStdout(chunk) {
    this.stdoutBuffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > MAX_PROTOCOL_BUFFER_BYTES) {
      const child = this.child;
      this.handleExit(appServerError('Codex App Server hat das Protokoll-Limit überschritten.', 'CODEX_APP_SERVER_PROTOCOL'));
      child?.kill();
      return;
    }
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try { this.handleMessage(JSON.parse(line)); } catch {
        // Diagnostics on stdout are ignored; JSON-RPC messages are one line each.
      }
    }
  }

  handleMessage(message) {
    if (Object.hasOwn(message || {}, 'id') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(appServerError(message.error.message || 'Codex App Server request failed.', 'CODEX_APP_SERVER_REQUEST', {
          rpcCode: message.error.code,
          rpcData: message.error.data,
        }));
      } else pending.resolve(message.result);
      return;
    }

    if (Object.hasOwn(message || {}, 'id') && message.method) {
      this.write({ id: message.id, error: { code: -32601, message: `Unsupported server request: ${message.method}` } });
      return;
    }

    const method = message?.method;
    const params = message?.params || {};
    let run = params.turnId ? this.runsByTurn.get(params.turnId) : null;
    if (!run && params.threadId) run = this.runsByThread.get(params.threadId);
    if (!run) return;
    run.touch();
    if (!run.firstEventAt) run.firstEventAt = Date.now();

    if (method === 'turn/started') {
      const turnId = params.turn?.id || params.turnId || '';
      if (turnId) {
        run.turnId = turnId;
        this.runsByTurn.set(turnId, run);
      }
      run.emit({ phase: 'analysis', message: 'Prüft Anforderungen und plant die nächsten Schritte.' });
      return;
    }
    if (method === 'item/agentMessage/delta') {
      const delta = String(params.delta || '');
      if (!delta) return;
      if (!run.firstTextAt) run.firstTextAt = Date.now();
      run.streamedItemIds.add(String(params.itemId || ''));
      run.textProgress.push(delta);
      return;
    }
    if (method === 'item/started') {
      const progress = appServerItemProgress(params.item, false);
      if (progress) run.emit(progress);
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage') {
        const text = String(item.text || '');
        if (text) {
          run.lastMessage = text;
          if (item.phase === 'final_answer' || !run.finalText) run.finalText = text;
          if (!run.streamedItemIds.has(String(item.id || ''))) {
            if (!run.firstTextAt) run.firstTextAt = Date.now();
            run.textProgress.push(text);
          }
        }
      } else {
        const progress = appServerItemProgress(item, true);
        if (progress) run.emit(progress);
      }
      return;
    }
    if (method === 'error') {
      const messageText = cleanText(params.error?.message || params.message || 'Codex meldet einen Fehler.', 500);
      run.emit({ phase: 'error', message: messageText });
      return;
    }
    if (method === 'turn/completed') {
      const turn = params.turn || {};
      if (turn.status === 'failed') {
        run.reject(appServerError(turn.error?.message || 'Codex-Turn ist fehlgeschlagen.', 'CODEX_TURN_FAILED', {
          turnStarted: true,
          codexErrorInfo: turn.error?.codexErrorInfo,
        }));
      } else if (turn.status === 'interrupted') {
        run.reject(appServerError('Codex-Lauf durch den User abgebrochen.', 'CODEX_CANCELLED', { turnStarted: true }));
      } else run.resolve();
    }
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw appServerError('Codex App Server ist nicht verbunden.', 'CODEX_APP_SERVER_UNAVAILABLE');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  notify(method, params) {
    this.write({ method, params });
  }

  async request(method, params, timeoutMs = APP_SERVER_REQUEST_TIMEOUT_MS, { skipStart = false } = {}) {
    if (!skipStart) await this.ensureStarted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(appServerError(`Codex App Server antwortet nicht auf ${method}.`, 'CODEX_APP_SERVER_TIMEOUT'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ method, id, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async run({
    prompt,
    model,
    cwd,
    attachments = [],
    requestId = '',
    onProgress = null,
    sessionId = '',
    resumeSession = false,
    persistSession = false,
    reasoningEffort = 'low',
    onReady = null,
    hardTimeoutMs = APP_SERVER_HARD_TIMEOUT_MS,
    idleTimeoutMs = APP_SERVER_IDLE_TIMEOUT_MS,
  }) {
    const startedAt = Date.now();
    await this.ensureStarted();
    let threadResult;
    try {
      const common = {
        model: model && model !== 'codex-default' ? model : null,
        cwd: cwd || process.cwd(),
        approvalPolicy: 'never',
        sandbox: cwd ? 'workspace-write' : 'read-only',
      };
      threadResult = resumeSession && sessionId
        ? await this.request('thread/resume', { ...common, threadId: sessionId })
        : await this.request('thread/start', { ...common, ephemeral: !persistSession });
    } catch (error) {
      if (resumeSession && sessionId) {
        throw appServerError(error.message, 'CODEX_SESSION_MISSING', { cause: error, turnStarted: false });
      }
      throw Object.assign(error, { turnStarted: false });
    }

    const threadId = String(threadResult?.thread?.id || sessionId || '');
    if (!threadId) throw appServerError('Codex App Server lieferte keine Thread-ID.', 'CODEX_APP_SERVER_PROTOCOL', { turnStarted: false });
    const textProgress = createTextProgress(onProgress, 'codex');
    let hardTimer = null;
    let idleTimer = null;
    let heartbeatTimer = null;
    let settled = false;
    let completionResolve;
    let completionReject;
    const completion = new Promise((resolve, reject) => {
      completionResolve = resolve;
      completionReject = reject;
    });
    // A turn may fail or be cancelled before the turn/start reply arrives.
    // Observe rejection immediately, including while setup is still pending.
    completion.catch(() => {});
    const run = {
      threadId,
      turnId: '',
      finalText: '',
      lastMessage: '',
      cancelled: false,
      firstEventAt: 0,
      firstTextAt: 0,
      streamedItemIds: new Set(),
      textProgress,
      emit: progress => onProgress?.({ ...progress, sessionId: threadId, ts: Date.now() }),
      touch: () => {
        if (!idleTimeoutMs || settled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => run.reject(appServerError(
          `Codex-Aufruf nach ${Math.round(idleTimeoutMs / 1000)}s ohne Aktivität abgebrochen.`,
          'CODEX_IDLE_TIMEOUT',
          { turnStarted: true },
        )), idleTimeoutMs);
      },
      resolve: () => {
        if (settled) return;
        settled = true;
        completionResolve();
      },
      reject: error => {
        if (settled) return;
        settled = true;
        completionReject(error);
      },
    };
    this.runsByThread.set(threadId, run);
    run.cancel = async () => {
      run.cancelled = true;
      run.reject(appServerError('Codex-Lauf durch den User abgebrochen.', 'CODEX_CANCELLED', { turnStarted: true }));
      if (run.turnId) this.request('turn/interrupt', { threadId, turnId: run.turnId }).catch(() => {});
    };
    onReady?.({ threadId, cancel: run.cancel });

    const cleanup = () => {
      if (hardTimer) clearTimeout(hardTimer);
      if (idleTimer) clearTimeout(idleTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (this.runsByThread.get(threadId) === run) this.runsByThread.delete(threadId);
      if (run.turnId && this.runsByTurn.get(run.turnId) === run) this.runsByTurn.delete(run.turnId);
    };

    try {
      textProgress.start('Codex App Server startet den zugewiesenen Task.');
      run.emit({ phase: 'start', message: 'Arbeitsumgebung ist bereit.' });
      run.touch();
      hardTimer = setTimeout(() => run.reject(appServerError(
        `Codex-Aufruf nach ${Math.round(hardTimeoutMs / 1000)}s abgebrochen.`,
        'CODEX_HARD_TIMEOUT',
        { turnStarted: true },
      )), hardTimeoutMs);
      heartbeatTimer = setInterval(() => run.emit({ phase: 'activity', message: '' }), 2000);
      const startRequest = this.request('turn/start', {
        threadId,
        input: buildAppServerInput(prompt, attachments),
        model: model && model !== 'codex-default' ? model : null,
        cwd: cwd || process.cwd(),
        effort: reasoningEffort,
        approvalPolicy: 'never',
      });
      startRequest.then(result => {
        const lateTurnId = result?.turn?.id;
        if (run.cancelled && lateTurnId) {
          this.request('turn/interrupt', { threadId, turnId: lateTurnId }).catch(() => {});
        }
      }).catch(() => {});
      // Do not let a missing start acknowledgement hold up cancellation/exit.
      const turnResult = await Promise.race([
        startRequest,
        completion.then(() => new Promise(() => {})),
      ]);
      run.turnId = String(turnResult?.turn?.id || run.turnId || '');
      if (run.turnId) this.runsByTurn.set(run.turnId, run);
      if (run.cancelled) {
        if (run.turnId) await this.request('turn/interrupt', { threadId, turnId: run.turnId }).catch(() => {});
        throw appServerError('Codex-Lauf durch den User abgebrochen.', 'CODEX_CANCELLED', { turnStarted: Boolean(run.turnId) });
      }
      await completion;
      textProgress.finish();
      const text = String(run.finalText || run.lastMessage || '').trim();
      if (!text) throw appServerError('Codex hat keine Antwort geliefert.', 'CODEX_EMPTY_RESPONSE', { turnStarted: true });
      return {
        text,
        sessionId: threadId,
        requestId,
        metrics: {
          totalMs: Date.now() - startedAt,
          firstEventMs: run.firstEventAt ? run.firstEventAt - startedAt : null,
          firstTextMs: run.firstTextAt ? run.firstTextAt - startedAt : null,
          transport: 'app-server',
        },
      };
    } catch (error) {
      if (run.turnId && ['CODEX_IDLE_TIMEOUT', 'CODEX_HARD_TIMEOUT'].includes(error.code)) {
        this.request('turn/interrupt', { threadId, turnId: run.turnId }).catch(() => {});
      }
      // Once turn/start was sent, execution may have begun even without an ACK.
      // Retrying through exec could duplicate edits and commands.
      throw Object.assign(error, { turnStarted: true });
    } finally {
      cleanup();
    }
  }

  handleExit(error) {
    const child = this.child;
    this.child = null;
    this.startPromise = null;
    if (child?.stdin?.writable) child.stdin.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const run of new Set(this.runsByThread.values())) {
      run.reject(Object.assign(error, { turnStarted: Boolean(run.turnId) }));
    }
    this.runsByThread.clear();
    this.runsByTurn.clear();
  }

  stop() {
    this.intentionalStop = true;
    const child = this.child;
    this.handleExit(appServerError('Codex App Server wurde beendet.', 'CODEX_APP_SERVER_EXIT'));
    child?.kill();
  }
}

module.exports = {
  APP_SERVER_HARD_TIMEOUT_MS,
  APP_SERVER_IDLE_TIMEOUT_MS,
  CodexAppServerClient,
  appServerItemProgress,
  buildAppServerInput,
};
