/**
 * Memory Provider Interface + persistent implementations
 *
 * Architecture:
 *   Agent → Memory API → Provider (app-local | selected JSON file)
 *
 * Memory Space: logical identifier like "wes-hmi"
 * Resolved by provider config to actual storage location.
 */

// ── Entry Types ───────────────────────────────────────────────────────────────
export const ENTRY_TYPES = ['fact', 'decision', 'constraint', 'finding', 'task_state', 'handoff'];

/**
 * Create a structured memory entry.
 */
export function createEntry({ type = 'fact', namespace, content, tags = [], author = 'user', confidence = 'medium' }) {
  if (!ENTRY_TYPES.includes(type)) throw new Error(`Unbekannter Memory-Typ: ${type}`);
  if (!namespace?.trim()) throw new Error('Memory-Namespace fehlt.');
  return {
    id: `${namespace}-${type.toUpperCase().slice(0, 3)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    namespace,
    content,
    tags: tags.map(t => t.toLowerCase()),
    author,
    confidence,
    status: 'active',
    created: new Date().toISOString(),
  };
}

// ── Memory API (thin wrapper around provider) ─────────────────────────────────

export class MemoryAPI {
  constructor(provider) {
    this.provider = provider;
  }

  /** Search by keyword relevance. Returns top-N entries. */
  async search(namespace, query, limit = 5) {
    return this.provider.search(namespace, query, limit);
  }

  /** Read a single entry by id. */
  async read(namespace, id) {
    return this.provider.read(namespace, id);
  }

  /** Write a new entry. Returns the created entry. */
  async write(namespace, entry) {
    return this.provider.write(namespace, entry);
  }

  /** Update an existing entry. */
  async update(namespace, id, updates) {
    return this.provider.update(namespace, id, updates);
  }

  /** Permanently remove one entry from a namespace. */
  async delete(namespace, id) {
    return this.provider.delete(namespace, id);
  }

  /** Create and store a structured handoff. */
  async handoff({ from, to, taskId, summary, relevantMemory = [], findings = [], openQuestions = [] }) {
    const entry = createEntry({
      type: 'handoff', namespace: `_handoff_${to}`,
      content: { from, to, taskId, summary, relevantMemory, findings, openQuestions },
      tags: ['handoff', to.toLowerCase(), from.toLowerCase()],
      author: from,
    });
    return this.write(`_handoff_${to}`, entry);
  }

  /** List all entries in namespace. */
  async list(namespace) {
    return this.provider.list(namespace);
  }

  /** Remove all entries from one namespace. */
  async clear(namespace) {
    return this.provider.clear(namespace);
  }

  /** Format top-N search results for LLM injection. */
  async getContextForAgent(namespace, query, agentName, limit = 5) {
    const results = await this.search(namespace, query, limit);
    if (!results.length) return '';
    const lines = results.map(e => {
      const tags = e.tags?.length ? ` [${e.tags.join(', ')}]` : '';
      const type = e.type ? `[${e.type}]` : '';
      return `${type}${tags} ${typeof e.content === 'string' ? e.content : JSON.stringify(e.content)}`;
    });
    return `\n\n[Shared Memory — ${namespace} — für ${agentName}]:\n${lines.join('\n')}`;
  }
}

// ── IPC-backed Electron Provider ──────────────────────────────────────────────
// Uses the electron-store via IPC for persistence (survives restarts)

export class ElectronStoreProvider {
  _key(namespace) { return `memspace:${namespace}`; }

  async _load(namespace) {
    if (window.electronAPI?.appStateGet) {
      return await window.electronAPI.appStateGet(this._key(namespace)) || [];
    }
    return JSON.parse(localStorage.getItem(this._key(namespace)) || '[]');
  }

  async _save(namespace, entries) {
    if (window.electronAPI?.appStateSet) {
      await window.electronAPI.appStateSet(this._key(namespace), entries);
    } else {
      localStorage.setItem(this._key(namespace), JSON.stringify(entries));
    }
  }

  _score(entry, terms) {
    const text = (typeof entry.content === 'string' ? entry.content : JSON.stringify(entry.content)).toLowerCase()
      + ' ' + (entry.tags || []).join(' ');
    return terms.reduce((s, t) => s + (text.split(t.toLowerCase()).length - 1), 0);
  }

  async search(namespace, query, limit = 5) {
    const entries = (await this._load(namespace)).filter(e => e.status !== 'archived');
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return entries.slice(-limit);
    return entries
      .map(e => ({ ...e, _score: this._score(e, terms) }))
      .filter(e => e._score > 0)
      .sort((a, b) => b._score - a._score)
      .slice(0, limit)
      .map(({ _score, ...e }) => e);
  }

  async read(namespace, id) {
    return (await this._load(namespace)).find(e => e.id === id) || null;
  }

  async write(namespace, entry) {
    const entries = await this._load(namespace);
    entries.push(entry);
    await this._save(namespace, entries);
    return entry;
  }

  async update(namespace, id, updates) {
    const entries = await this._load(namespace);
    const idx = entries.findIndex(e => e.id === id);
    if (idx === -1) return null;
    entries[idx] = { ...entries[idx], ...updates, updated: new Date().toISOString() };
    await this._save(namespace, entries);
    return entries[idx];
  }

  async delete(namespace, id) {
    const entries = await this._load(namespace);
    const nextEntries = entries.filter(entry => entry.id !== id);
    if (nextEntries.length === entries.length) return { ok: false, deleted: false };
    await this._save(namespace, nextEntries);
    return { ok: true, deleted: true };
  }

  async list(namespace) {
    return this._load(namespace);
  }

  async clear(namespace) {
    await this._save(namespace, []);
  }
}

// ── User-selected JSON file provider ─────────────────────────────────────────
// File access stays in Electron's main process. This renderer-side provider
// only forwards structured operations through the isolated preload bridge.
export class JsonFileProvider {
  constructor(filePath) {
    this.filePath = filePath;
  }

  _call(action, namespace, params = {}) {
    if (!this.filePath?.trim()) {
      throw new Error('Für diesen Memory Space wurde keine JSON-Datei ausgewählt.');
    }
    const operation = window.electronAPI?.memoryFileOperation;
    if (!operation) {
      throw new Error('Dateibasierter Shared Memory ist nur in der Desktop-App verfügbar.');
    }
    return operation({ filePath: this.filePath, action, namespace, ...params });
  }

  search(namespace, query, limit) { return this._call('search', namespace, { query, limit }); }
  read(namespace, id) { return this._call('read', namespace, { id }); }
  write(namespace, entry) { return this._call('write', namespace, { entry }); }
  update(namespace, id, updates) { return this._call('update', namespace, { id, updates }); }
  delete(namespace, id) { return this._call('delete', namespace, { id }); }
  list(namespace) { return this._call('list', namespace); }
  clear(namespace) { return this._call('clear', namespace); }
}

// ── Provider factory ──────────────────────────────────────────────────────────
const apiCache = new Map();
export function getMemoryAPI(config = {}) {
  const providerName = config.provider || 'local';
  const cacheKey = providerName === 'file' ? `file:${config.filePath || ''}` : 'local';
  if (!apiCache.has(cacheKey)) {
    const provider = providerName === 'file'
      ? new JsonFileProvider(config.filePath)
      : new ElectronStoreProvider();
    apiCache.set(cacheKey, new MemoryAPI(provider));
  }
  return apiCache.get(cacheKey);
}
