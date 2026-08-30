const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const mammoth = require('mammoth');

const MAX_FILES = 500;
const MAX_DEPTH = 10;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const MAX_DOCX_ENTRIES = 5000;
const MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  '.git', '.svn', '.hg', '.agent-teams', 'node_modules', 'dist', 'build', 'release', 'coverage',
]);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonc', '.xml', '.yaml', '.yml',
  '.html', '.htm', '.css', '.scss', '.less', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  '.py', '.java', '.cs', '.cpp', '.c', '.h', '.hpp', '.go', '.rs', '.php', '.rb', '.sql',
  '.sh', '.ps1', '.bat', '.cmd', '.ini', '.toml', '.properties', '.log', '.svg',
]);
const IMAGE_MIME_TYPES = Object.freeze({
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
});
const SENSITIVE_FILE_PATTERN = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|.*\.(?:pem|key|pfx|p12|kdbx))$/i;

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function normalizeRelativePath(relativePath) {
  const value = String(relativePath || '').trim();
  if (!value || value.includes('\0') || path.isAbsolute(value)) throw new Error('Ungültiger Projektpfad.');
  const segments = value.split(/[\\/]+/).filter(Boolean);
  if (!segments.length || segments.some(segment => segment === '..' || segment === '.')) {
    throw new Error('Ungültiger Projektpfad.');
  }
  if (segments.some(segment => IGNORED_DIRECTORIES.has(segment.toLowerCase()))) {
    throw new Error('Geschützter Projektpfad.');
  }
  if (segments.some(segment => SENSITIVE_FILE_PATTERN.test(segment))) {
    throw new Error('Sensible Dateien sind in der Prüfumgebung gesperrt.');
  }
  return segments.join(path.sep);
}

function resolveProjectRoot(projectPath) {
  const resolved = path.resolve(String(projectPath || ''));
  if (!projectPath || !fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('Projektordner wurde nicht gefunden.');
  }
  return fs.realpathSync(resolved);
}

function assertNoSymlinkTraversal(projectRoot, relativePath) {
  let current = projectRoot;
  for (const segment of relativePath.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Symbolische Links sind in der Prüfumgebung gesperrt.');
  }
}

function resolveArtifactPath(projectPath, relativePath, { mustExist = true } = {}) {
  const projectRoot = resolveProjectRoot(projectPath);
  const normalized = normalizeRelativePath(relativePath);
  assertNoSymlinkTraversal(projectRoot, normalized);
  const targetPath = path.resolve(projectRoot, normalized);
  if (!isPathInside(projectRoot, targetPath) || targetPath === projectRoot) {
    throw new Error('Datei muss innerhalb des Projektordners liegen.');
  }
  if (mustExist) {
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) throw new Error('Projektdatei wurde nicht gefunden.');
    const realTarget = fs.realpathSync(targetPath);
    if (!isPathInside(projectRoot, realTarget)) throw new Error('Datei verweist außerhalb des Projektordners.');
    return { projectRoot, targetPath: realTarget, relativePath: normalized };
  }
  return { projectRoot, targetPath, relativePath: normalized };
}

function artifactKind(extension) {
  if (extension === '.docx') return 'word';
  if (extension === '.pdf') return 'pdf';
  if (IMAGE_MIME_TYPES[extension]) return 'image';
  if (TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'binary';
}

function artifactMetadata(projectRoot, fullPath) {
  const stats = fs.statSync(fullPath);
  const extension = path.extname(fullPath).toLowerCase();
  const kind = artifactKind(extension);
  return {
    name: path.basename(fullPath),
    relativePath: path.relative(projectRoot, fullPath),
    extension,
    kind,
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
    mtimeMs: stats.mtimeMs,
    editable: kind === 'text' || kind === 'word',
  };
}

function listArtifacts({ projectPath }) {
  const projectRoot = resolveProjectRoot(projectPath);
  const files = [];
  function walk(directory, depth = 0) {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return;
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) break;
      if (entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name.toLowerCase())) walk(fullPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || SENSITIVE_FILE_PATTERN.test(entry.name)) continue;
      try { files.push(artifactMetadata(projectRoot, fullPath)); } catch {}
    }
  }
  walk(projectRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'de', { sensitivity: 'base' }));
  return { files, truncated: files.length >= MAX_FILES, projectName: path.basename(projectRoot) };
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function encodeXmlText(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function loadBoundedDocx(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files);
  if (entries.length > MAX_DOCX_ENTRIES) throw new Error('Die DOCX-Datei enthält zu viele Bestandteile.');
  const uncompressedBytes = entries.reduce((total, entry) => (
    total + Math.max(0, Number(entry?._data?.uncompressedSize) || 0)
  ), 0);
  if (uncompressedBytes > MAX_DOCX_UNCOMPRESSED_BYTES) {
    throw new Error('Die entpackte DOCX-Datei ist für die sichere Prüfung zu groß.');
  }
  return zip;
}

async function inspectWord(buffer) {
  const zip = await loadBoundedDocx(buffer);
  const documentXml = await zip.file('word/document.xml')?.async('string');
  if (!documentXml) throw new Error('Die DOCX-Datei enthält kein Word-Dokument.');
  const extracted = await mammoth.extractRawText({ buffer });
  return {
    text: String(extracted.value || '').slice(0, 500000),
    warnings: (extracted.messages || []).map(message => String(message.message || message)).slice(0, 20),
    details: {
      paragraphs: (documentXml.match(/<w:p(?:\s|>)/g) || []).length,
      tables: (documentXml.match(/<w:tbl(?:\s|>)/g) || []).length,
      images: Object.keys(zip.files).filter(name => /^word\/media\//i.test(name) && !zip.files[name].dir).length,
      visualLayoutChecked: false,
    },
  };
}

async function inspectArtifact({ projectPath, relativePath }) {
  const resolved = resolveArtifactPath(projectPath, relativePath);
  const metadata = artifactMetadata(resolved.projectRoot, resolved.targetPath);
  if (metadata.size > MAX_PREVIEW_BYTES) return { ...metadata, error: 'Datei ist für die Vorschau zu groß.' };
  if (metadata.kind === 'text') {
    if (metadata.size > MAX_TEXT_BYTES) return { ...metadata, error: 'Textdatei ist für die Bearbeitung zu groß.' };
    return { ...metadata, content: fs.readFileSync(resolved.targetPath, 'utf8') };
  }
  const buffer = fs.readFileSync(resolved.targetPath);
  if (metadata.kind === 'image') {
    return { ...metadata, dataUrl: `data:${IMAGE_MIME_TYPES[metadata.extension]};base64,${buffer.toString('base64')}` };
  }
  if (metadata.kind === 'word') {
    return { ...metadata, ...(await inspectWord(buffer)) };
  }
  return { ...metadata };
}

function projectSnapshotDirectory(snapshotRoot, projectRoot) {
  const key = crypto.createHash('sha256').update(projectRoot.toLowerCase()).digest('hex').slice(0, 24);
  return path.join(snapshotRoot, key);
}

function pruneSnapshots(directory) {
  if (!fs.existsSync(directory)) return;
  const metadataFiles = fs.readdirSync(directory).filter(name => name.endsWith('.json'));
  const records = metadataFiles.flatMap(name => {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      return [{ name, createdAt: metadata.createdAt || '' }];
    } catch { return []; }
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const stale of records.slice(50)) {
    const id = stale.name.slice(0, -5);
    fs.rmSync(path.join(directory, `${id}.bin`), { force: true });
    fs.rmSync(path.join(directory, stale.name), { force: true });
  }
}

function createSnapshot({ snapshotRoot, projectRoot, targetPath, relativePath, reason }) {
  const directory = projectSnapshotDirectory(snapshotRoot, projectRoot);
  fs.mkdirSync(directory, { recursive: true });
  const id = `${Date.now().toString(36)}-${crypto.randomUUID()}`;
  const content = fs.readFileSync(targetPath);
  const metadata = {
    id,
    projectRoot,
    relativePath,
    reason: String(reason || 'Bearbeitung').slice(0, 200),
    createdAt: new Date().toISOString(),
    bytes: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'),
  };
  fs.writeFileSync(path.join(directory, `${id}.bin`), content, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, `${id}.json`), JSON.stringify(metadata, null, 2), { flag: 'wx' });
  pruneSnapshots(directory);
  return metadata;
}

function assertExpectedVersion(targetPath, expectedMtimeMs) {
  if (!Number.isFinite(Number(expectedMtimeMs))) return;
  const actual = fs.statSync(targetPath).mtimeMs;
  if (Math.abs(actual - Number(expectedMtimeMs)) > 1) {
    throw new Error('Die Datei wurde zwischenzeitlich verändert. Lade die Vorschau neu.');
  }
}

async function saveTextArtifact({ snapshotRoot, projectPath, relativePath, content, expectedMtimeMs }) {
  const resolved = resolveArtifactPath(projectPath, relativePath);
  const extension = path.extname(resolved.targetPath).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) throw new Error('Dieses Dateiformat kann nicht als Text gespeichert werden.');
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) {
    throw new Error('Textinhalt ist ungültig oder größer als 2 MB.');
  }
  assertExpectedVersion(resolved.targetPath, expectedMtimeMs);
  const snapshot = createSnapshot({ ...resolved, snapshotRoot, reason: 'Vor Textbearbeitung' });
  fs.writeFileSync(resolved.targetPath, content, 'utf8');
  return { ok: true, snapshot, artifact: await inspectArtifact({ projectPath, relativePath }) };
}

async function replaceWordText({ snapshotRoot, projectPath, relativePath, findText, replaceText, replaceAll = false, expectedMtimeMs }) {
  const resolved = resolveArtifactPath(projectPath, relativePath);
  if (path.extname(resolved.targetPath).toLowerCase() !== '.docx') throw new Error('Nur DOCX-Dateien werden unterstützt.');
  const find = String(findText || '');
  const replacement = String(replaceText || '');
  if (!find || find.length > 5000 || replacement.length > 10000) throw new Error('Such- oder Ersetzungstext ist ungültig.');
  assertExpectedVersion(resolved.targetPath, expectedMtimeMs);
  const original = fs.readFileSync(resolved.targetPath);
  const zip = await loadBoundedDocx(original);
  const documentPart = zip.file('word/document.xml');
  if (!documentPart) throw new Error('Die DOCX-Datei enthält kein Word-Dokument.');
  const xml = await documentPart.async('string');
  let replacements = 0;
  const updatedXml = xml.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (match, start, encoded, end) => {
    if (!replaceAll && replacements > 0) return match;
    const decoded = decodeXmlText(encoded);
    if (!decoded.includes(find)) return match;
    const occurrences = replaceAll ? decoded.split(find).length - 1 : 1;
    const updated = replaceAll ? decoded.split(find).join(replacement) : decoded.replace(find, replacement);
    replacements += occurrences;
    const needsSpacePreservation = /^\s|\s$/.test(updated);
    const normalizedStart = needsSpacePreservation && !/\bxml:space=/.test(start)
      ? start.replace(/>$/, ' xml:space="preserve">')
      : start;
    return `${normalizedStart}${encodeXmlText(updated)}${end}`;
  });
  if (!replacements) {
    throw new Error('Text wurde nicht in einem einzelnen Word-Textabschnitt gefunden. Formübergreifende Ersetzungen sind aus Layoutschutzgründen gesperrt.');
  }
  const snapshot = createSnapshot({ ...resolved, snapshotRoot, reason: 'Vor Word-Ersetzung' });
  zip.file('word/document.xml', updatedXml);
  const updatedBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  try {
    fs.writeFileSync(resolved.targetPath, updatedBuffer);
    await inspectWord(updatedBuffer);
  } catch (error) {
    fs.writeFileSync(resolved.targetPath, original);
    throw new Error(`Word-Datei wurde wiederhergestellt: ${error.message}`);
  }
  return {
    ok: true,
    replacements,
    snapshot,
    artifact: await inspectArtifact({ projectPath, relativePath }),
  };
}

function listSnapshots({ snapshotRoot, projectPath, relativePath = '' }) {
  const projectRoot = resolveProjectRoot(projectPath);
  const directory = projectSnapshotDirectory(snapshotRoot, projectRoot);
  if (!fs.existsSync(directory)) return { snapshots: [] };
  const normalizedFilter = relativePath ? normalizeRelativePath(relativePath) : '';
  const snapshots = fs.readdirSync(directory).filter(name => name.endsWith('.json')).flatMap(name => {
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (metadata.projectRoot !== projectRoot || (normalizedFilter && metadata.relativePath !== normalizedFilter)) return [];
      return [metadata];
    } catch { return []; }
  }).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return { snapshots: snapshots.slice(0, 50) };
}

async function restoreSnapshot({ snapshotRoot, projectPath, snapshotId }) {
  const projectRoot = resolveProjectRoot(projectPath);
  const id = String(snapshotId || '');
  if (!/^[a-z0-9-]{20,80}$/i.test(id)) throw new Error('Ungültiger Snapshot.');
  const directory = projectSnapshotDirectory(snapshotRoot, projectRoot);
  const metadataPath = path.join(directory, `${id}.json`);
  const contentPath = path.join(directory, `${id}.bin`);
  if (!fs.existsSync(metadataPath) || !fs.existsSync(contentPath)) throw new Error('Snapshot wurde nicht gefunden.');
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  if (metadata.projectRoot !== projectRoot) throw new Error('Snapshot gehört zu einem anderen Projekt.');
  const resolved = resolveArtifactPath(projectRoot, metadata.relativePath);
  const content = fs.readFileSync(contentPath);
  const hash = crypto.createHash('sha256').update(content).digest('hex');
  if (hash !== metadata.sha256) throw new Error('Snapshot ist beschädigt.');
  const rollbackSnapshot = createSnapshot({ ...resolved, snapshotRoot, reason: 'Vor Wiederherstellung' });
  fs.writeFileSync(resolved.targetPath, content);
  return {
    ok: true,
    restoredSnapshot: metadata,
    rollbackSnapshot,
    artifact: await inspectArtifact({ projectPath, relativePath: metadata.relativePath }),
  };
}

function createArtifactSandbox({ snapshotRoot }) {
  const root = path.resolve(String(snapshotRoot || ''));
  if (!snapshotRoot) throw new Error('Snapshot-Speicher fehlt.');
  fs.mkdirSync(root, { recursive: true });
  return {
    list: params => listArtifacts(params),
    inspect: params => inspectArtifact(params),
    saveText: params => saveTextArtifact({ ...params, snapshotRoot: root }),
    replaceWordText: params => replaceWordText({ ...params, snapshotRoot: root }),
    listSnapshots: params => listSnapshots({ ...params, snapshotRoot: root }),
    restoreSnapshot: params => restoreSnapshot({ ...params, snapshotRoot: root }),
    resolveArtifactPath,
  };
}

module.exports = {
  MAX_FILES,
  TEXT_EXTENSIONS,
  createArtifactSandbox,
  decodeXmlText,
  encodeXmlText,
  listArtifacts,
  normalizeRelativePath,
  resolveArtifactPath,
};
