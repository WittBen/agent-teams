const fs = require('fs');
const path = require('path');

const MEMORY_FILE_FORMAT = 'agent-teams-memory';
const LEGACY_MEMORY_FILE_FORMATS = new Set(['whatsapp-agents-memory']);
const MEMORY_FILE_VERSION = 1;

function validateMemoryFilePath(filePath) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new Error('Es wurde keine Memory-Datei ausgewählt.');
  }

  const resolved = path.resolve(filePath.trim());
  if (path.extname(resolved).toLowerCase() !== '.json') {
    throw new Error('Die Memory-Datei muss die Endung .json haben.');
  }
  return resolved;
}

function validateNamespace(namespace) {
  if (typeof namespace !== 'string' || !namespace.trim()) {
    throw new Error('Der Memory-Namespace fehlt.');
  }
  return namespace.trim();
}

function emptyMemoryDocument() {
  return {
    format: MEMORY_FILE_FORMAT,
    version: MEMORY_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    namespaces: {},
  };
}

function normalizeMemoryDocument(value, legacyNamespace) {
  if (Array.isArray(value)) {
    const namespace = validateNamespace(legacyNamespace);
    const document = emptyMemoryDocument();
    document.namespaces[namespace] = value;
    return { document, migrated: true };
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Die ausgewählte Datei enthält kein gültiges Memory-JSON.');
  }
  const legacyFormat = LEGACY_MEMORY_FILE_FORMATS.has(value.format);
  if ((!legacyFormat && value.format !== MEMORY_FILE_FORMAT) || value.version !== MEMORY_FILE_VERSION) {
    throw new Error(`Nicht unterstütztes Memory-Format. Erwartet wird ${MEMORY_FILE_FORMAT} Version ${MEMORY_FILE_VERSION}.`);
  }
  if (!value.namespaces || typeof value.namespaces !== 'object' || Array.isArray(value.namespaces)) {
    throw new Error('Die Memory-Datei enthält keine gültigen Namespaces.');
  }

  for (const [namespace, entries] of Object.entries(value.namespaces)) {
    if (!Array.isArray(entries)) {
      throw new Error(`Der Namespace "${namespace}" enthält keine gültige Eintragsliste.`);
    }
  }

  return {
    document: {
      ...value,
      format: MEMORY_FILE_FORMAT,
      version: MEMORY_FILE_VERSION,
      namespaces: { ...value.namespaces },
    },
    migrated: legacyFormat,
  };
}

function readMemoryDocument(filePath, legacyNamespace, { allowMissing = false } = {}) {
  const resolved = validateMemoryFilePath(filePath);
  if (!fs.existsSync(resolved)) {
    if (allowMissing) return { document: emptyMemoryDocument(), migrated: false, created: true };
    throw new Error(`Memory-Datei nicht gefunden: ${resolved}`);
  }

  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    throw new Error(`Memory-Datei konnte nicht gelesen werden: ${error.message}`);
  }
  if (!raw.trim()) {
    throw new Error('Die ausgewählte Memory-Datei ist leer und enthält kein gültiges JSON.');
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Ungültiges JSON in der Memory-Datei: ${error.message}`);
  }
  return { ...normalizeMemoryDocument(parsed, legacyNamespace), created: false };
}

function writeMemoryDocument(filePath, document) {
  const resolved = validateMemoryFilePath(filePath);
  const parent = path.dirname(resolved);
  if (!fs.existsSync(parent)) {
    throw new Error(`Der Ordner der Memory-Datei existiert nicht: ${parent}`);
  }

  const nextDocument = {
    ...document,
    format: MEMORY_FILE_FORMAT,
    version: MEMORY_FILE_VERSION,
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = path.join(
    parent,
    `.${path.basename(resolved)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(nextDocument, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, resolved);
  } catch (error) {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch {}
    throw new Error(`Memory-Datei konnte nicht gespeichert werden: ${error.message}`);
  }
  return nextDocument;
}

function ensureMemoryFile(filePath, namespace) {
  const loaded = readMemoryDocument(filePath, namespace, { allowMissing: true });
  if (loaded.created || loaded.migrated) {
    writeMemoryDocument(filePath, loaded.document);
  }
  return validateMemoryFilePath(filePath);
}

function scoreEntry(entry, terms) {
  const content = typeof entry?.content === 'string' ? entry.content : JSON.stringify(entry?.content ?? '');
  const text = `${content} ${(entry?.tags || []).join(' ')}`.toLowerCase();
  return terms.reduce((score, term) => score + (text.split(term).length - 1), 0);
}

function operateMemoryFile({ filePath, action, namespace, query = '', limit = 5, id, entry, updates }) {
  const normalizedNamespace = validateNamespace(namespace);
  const { document, migrated } = readMemoryDocument(filePath, normalizedNamespace);
  const entries = document.namespaces[normalizedNamespace] || [];

  if (action === 'search') {
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const activeEntries = entries.filter(item => item?.status !== 'archived');
    if (!terms.length) return activeEntries.slice(-limit);
    return activeEntries
      .map(item => ({ item, score: scoreEntry(item, terms) }))
      .filter(result => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(result => result.item);
  }
  if (action === 'read') {
    return entries.find(item => item?.id === id) || null;
  }
  if (action === 'list') {
    return entries;
  }

  if (action === 'write') {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Der neue Memory-Eintrag ist ungültig.');
    }
    document.namespaces[normalizedNamespace] = [...entries, entry];
    writeMemoryDocument(filePath, document);
    return entry;
  }
  if (action === 'update') {
    const index = entries.findIndex(item => item?.id === id);
    if (index === -1) return null;
    const updatedEntry = { ...entries[index], ...updates, updated: new Date().toISOString() };
    document.namespaces[normalizedNamespace] = [
      ...entries.slice(0, index),
      updatedEntry,
      ...entries.slice(index + 1),
    ];
    writeMemoryDocument(filePath, document);
    return updatedEntry;
  }
  if (action === 'delete') {
    const nextEntries = entries.filter(item => item?.id !== id);
    if (nextEntries.length === entries.length) return { ok: false, deleted: false };
    document.namespaces[normalizedNamespace] = nextEntries;
    writeMemoryDocument(filePath, document);
    return { ok: true, deleted: true };
  }
  if (action === 'clear') {
    document.namespaces[normalizedNamespace] = [];
    writeMemoryDocument(filePath, document);
    return { ok: true };
  }

  if (migrated) writeMemoryDocument(filePath, document);
  throw new Error(`Unbekannte Memory-Dateiaktion: ${action}`);
}

module.exports = {
  MEMORY_FILE_FORMAT,
  MEMORY_FILE_VERSION,
  emptyMemoryDocument,
  ensureMemoryFile,
  normalizeMemoryDocument,
  operateMemoryFile,
  readMemoryDocument,
  validateMemoryFilePath,
};
