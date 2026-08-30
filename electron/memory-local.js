const ALLOWED_ACTIONS = new Set(['search', 'read', 'write', 'update', 'delete', 'list', 'clear']);
const NAMESPACE_PATTERN = /^[a-zA-Z0-9äöüÄÖÜß_.:-]{1,120}$/;
const MAX_ENTRY_BYTES = 1024 * 1024;

function validateLocalMemoryNamespace(namespace) {
  const value = String(namespace || '').trim();
  if (!NAMESPACE_PATTERN.test(value)) throw new Error('Der Memory-Namespace ist ungültig.');
  return value;
}

function memoryKey(namespace) {
  return `memspace:${validateLocalMemoryNamespace(namespace)}`;
}

function loadEntries(store, namespace) {
  const value = store.get(memoryKey(namespace));
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Der lokale Memory Space enthält ungültige Daten.');
  return value;
}

function saveEntries(store, namespace, entries) {
  store.set(memoryKey(namespace), entries);
}

function scoreEntry(entry, terms) {
  const content = typeof entry?.content === 'string' ? entry.content : JSON.stringify(entry?.content ?? '');
  const tags = Array.isArray(entry?.tags) ? entry.tags.join(' ') : '';
  const text = `${content} ${tags}`.toLowerCase();
  return terms.reduce((score, term) => score + (text.split(term).length - 1), 0);
}

function validateEntry(entry, namespace) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Der neue Memory-Eintrag ist ungültig.');
  if (Buffer.byteLength(JSON.stringify(entry), 'utf8') > MAX_ENTRY_BYTES) throw new Error('Der Memory-Eintrag ist größer als 1 MB.');
  return { ...entry, namespace };
}

function operateLocalMemory(store, { action, namespace, query = '', limit = 5, id, entry, updates } = {}) {
  if (!ALLOWED_ACTIONS.has(action)) throw new Error('Unbekannte lokale Memory-Aktion.');
  const normalizedNamespace = validateLocalMemoryNamespace(namespace);
  const entries = loadEntries(store, normalizedNamespace);

  if (action === 'search') {
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 5));
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const activeEntries = entries.filter(item => item?.status !== 'archived');
    if (!terms.length) return activeEntries.slice(-safeLimit);
    return activeEntries
      .map(item => ({ item, score: scoreEntry(item, terms) }))
      .filter(result => result.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, safeLimit)
      .map(result => result.item);
  }
  if (action === 'read') return entries.find(item => item?.id === id) || null;
  if (action === 'list') return entries;

  if (action === 'write') {
    const normalizedEntry = validateEntry(entry, normalizedNamespace);
    saveEntries(store, normalizedNamespace, [...entries, normalizedEntry]);
    return normalizedEntry;
  }
  if (action === 'update') {
    const index = entries.findIndex(item => item?.id === id);
    if (index === -1) return null;
    const safeUpdates = updates && typeof updates === 'object' && !Array.isArray(updates) ? { ...updates } : {};
    delete safeUpdates.id;
    delete safeUpdates.namespace;
    const updatedEntry = validateEntry({
      ...entries[index], ...safeUpdates, id: entries[index].id, namespace: normalizedNamespace,
      updated: new Date().toISOString(),
    }, normalizedNamespace);
    const nextEntries = [...entries];
    nextEntries[index] = updatedEntry;
    saveEntries(store, normalizedNamespace, nextEntries);
    return updatedEntry;
  }
  if (action === 'delete') {
    const nextEntries = entries.filter(item => item?.id !== id);
    if (nextEntries.length === entries.length) return { ok: false, deleted: false };
    saveEntries(store, normalizedNamespace, nextEntries);
    return { ok: true, deleted: true };
  }
  saveEntries(store, normalizedNamespace, []);
  return { ok: true };
}

function createLocalMemoryOperationQueue(store) {
  const queues = new Map();
  return function queueLocalMemoryOperation(params = {}) {
    const namespace = validateLocalMemoryNamespace(params.namespace);
    const previous = queues.get(namespace) || Promise.resolve();
    const current = previous.catch(() => undefined).then(() => operateLocalMemory(store, { ...params, namespace }));
    queues.set(namespace, current);
    return current.finally(() => {
      if (queues.get(namespace) === current) queues.delete(namespace);
    });
  };
}

module.exports = {
  createLocalMemoryOperationQueue,
  operateLocalMemory,
  validateLocalMemoryNamespace,
};
