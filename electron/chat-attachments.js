const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAX_ATTACHMENTS = 8;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_INLINE_TEXT_BYTES = 2 * 1024 * 1024;
const IMAGE_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const TEXT_BASENAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', '.gitignore', '.gitattributes', '.editorconfig', '.env']);
const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.log', '.csv', '.tsv', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.scss', '.sass', '.less', '.html', '.htm', '.svg',
  '.py', '.pyw', '.java', '.kt', '.kts', '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.cs', '.go', '.rs', '.rb', '.php',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd', '.sql', '.graphql', '.gql', '.vue', '.svelte', '.astro',
  '.gitignore', '.gitattributes', '.editorconfig', '.env', '.properties', '.gradle', '.dockerfile', '.makefile', '.rst', '.tex',
]);
const MIME_TYPES = {
  '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar', '.gz': 'application/gzip',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.avi': 'video/x-msvideo',
  '.json': 'application/json', '.xml': 'application/xml', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
};

function safeChatDirectory(chatId) {
  return crypto.createHash('sha256').update(String(chatId || 'chat')).digest('hex').slice(0, 24);
}

function ensureInsideRoot(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Ungültiger Anhangspfad.');
  }
  return resolvedCandidate;
}

function classifyFile(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (IMAGE_TYPES[extension]) return { kind: 'image', mimeType: IMAGE_TYPES[extension], extension };
  if (MARKDOWN_EXTENSIONS.has(extension)) return { kind: 'markdown', mimeType: 'text/markdown', extension };
  if (extension === '.pdf') return { kind: 'pdf', mimeType: 'application/pdf', extension };
  if (TEXT_EXTENSIONS.has(extension) || TEXT_BASENAMES.has(basename)) {
    return { kind: 'text', mimeType: MIME_TYPES[extension] || 'text/plain', extension };
  }
  return { kind: 'file', mimeType: MIME_TYPES[extension] || 'application/octet-stream', extension };
}

function savePickedAttachments({ sourcePaths, root, chatId }) {
  const selected = Array.isArray(sourcePaths) ? sourcePaths.slice(0, MAX_ATTACHMENTS) : [];
  const targetDirectory = path.join(path.resolve(root), safeChatDirectory(chatId));
  fs.mkdirSync(targetDirectory, { recursive: true });
  const attachments = [];
  const errors = [];
  let totalBytes = 0;

  for (const sourcePath of selected) {
    try {
      const source = path.resolve(String(sourcePath || ''));
      const stat = fs.statSync(source);
      if (!stat.isFile()) throw new Error('Die Auswahl ist keine Datei.');
      const type = classifyFile(source);
      if (stat.size > MAX_FILE_BYTES) throw new Error('Die Datei ist größer als 25 MB.');
      if (totalBytes + stat.size > MAX_TOTAL_BYTES) throw new Error('Die Anhänge überschreiten zusammen 50 MB.');

      const id = crypto.randomUUID();
      const targetPath = path.join(targetDirectory, `${id}${type.extension}`);
      fs.copyFileSync(source, targetPath);
      totalBytes += stat.size;
      const attachment = {
        id,
        name: path.basename(source),
        kind: type.kind,
        mimeType: type.mimeType,
        size: stat.size,
        path: targetPath,
      };
      if ((type.kind === 'markdown' || type.kind === 'text') && stat.size <= MAX_INLINE_TEXT_BYTES) {
        attachment.content = fs.readFileSync(targetPath, 'utf8').replace(/^\uFEFF/, '');
      }
      attachments.push(attachment);
    } catch (error) {
      errors.push({ name: path.basename(String(sourcePath || 'Datei')), message: error.message });
    }
  }
  return { attachments, errors };
}

function validateStoredAttachment(attachment, root) {
  if (!attachment?.path) throw new Error('Der Anhang hat keinen gespeicherten Pfad.');
  const storedPath = ensureInsideRoot(root, attachment.path);
  const storedType = classifyFile(storedPath);
  const type = !path.extname(storedPath) && TEXT_BASENAMES.has(path.basename(attachment.name || '').toLowerCase())
    ? classifyFile(attachment.name)
    : storedType;
  const stat = fs.statSync(storedPath);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('Der gespeicherte Anhang ist ungültig oder zu groß.');
  return { ...attachment, path: storedPath, kind: type.kind, mimeType: type.mimeType, size: stat.size };
}

function resolveAttachmentBundle(attachments, root) {
  const resolved = [];
  const errors = [];
  for (const attachment of (Array.isArray(attachments) ? attachments.slice(0, MAX_ATTACHMENTS) : [])) {
    try {
      const item = validateStoredAttachment(attachment, root);
      if ((item.kind === 'markdown' || item.kind === 'text') && item.size <= MAX_INLINE_TEXT_BYTES) {
        item.content = fs.readFileSync(item.path, 'utf8').replace(/^\uFEFF/, '');
      }
      resolved.push(item);
    } catch (error) {
      errors.push({ name: attachment?.name || 'Anhang', message: error.message });
    }
  }
  const textContext = resolved
    .filter(item => (item.kind === 'markdown' || item.kind === 'text') && typeof item.content === 'string')
    .map(item => `## ${item.kind === 'markdown' ? 'Markdown-Anhang' : 'Text-Anhang'}: ${item.name}\n\n${item.content}`)
    .join('\n\n---\n\n');
  const fileContext = resolved
    .filter(item => !['markdown', 'text', 'image'].includes(item.kind))
    .map(item => `- ${item.name} (${item.mimeType}, ${item.size} Bytes)${item.path ? ` · lokale Arbeitskopie: ${item.path}` : ''}`)
    .join('\n');
  return {
    attachments: resolved,
    images: resolved.filter(item => item.kind === 'image'),
    documents: resolved.filter(item => item.kind === 'pdf'),
    files: resolved.filter(item => !['image', 'markdown', 'text'].includes(item.kind)),
    textContext,
    fileContext,
    markdownContext: textContext,
    errors,
  };
}

function attachmentData(attachment, root) {
  const item = validateStoredAttachment(attachment, root);
  if (item.kind !== 'image') return { ...item, dataUrl: null };
  return {
    ...item,
    dataUrl: `data:${item.mimeType};base64,${fs.readFileSync(item.path).toString('base64')}`,
  };
}

function deleteAttachment(attachment, root) {
  const item = validateStoredAttachment(attachment, root);
  fs.unlinkSync(item.path);
  return { ok: true };
}

function clearChatAttachments(chatId, root) {
  const resolvedRoot = path.resolve(root);
  const target = ensureInsideRoot(resolvedRoot, path.join(resolvedRoot, safeChatDirectory(chatId)));
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  return { ok: true };
}

function appendAttachmentContext(messages, textContext, fileContext = '') {
  const next = (messages || []).map(message => ({ ...message }));
  const sections = [
    textContext ? `[ANGEHÄNGTE TEXTDATEIEN]\n${textContext}` : '',
    fileContext ? `[WEITERE ANGEHÄNGTE DATEIEN]\n${fileContext}` : '',
  ].filter(Boolean);
  if (!sections.length) return next;
  let index = -1;
  for (let current = next.length - 1; current >= 0; current -= 1) {
    if (next[current].role === 'user') { index = current; break; }
  }
  if (index < 0) {
    next.push({ role: 'user', content: sections.join('\n\n') });
    return next;
  }
  const content = next[index].content;
  const suffix = `\n\n${sections.join('\n\n')}`;
  if (typeof content === 'string') next[index].content = `${content}${suffix}`;
  else if (Array.isArray(content)) next[index].content = [...content, { type: 'text', text: suffix }];
  return next;
}

function appendMarkdownContext(messages, markdownContext) {
  return appendAttachmentContext(messages, markdownContext);
}

function withApiAttachments(messages, attachments, provider) {
  if (!attachments.length) return messages;
  const next = messages.map(message => ({ ...message }));
  let index = -1;
  for (let current = next.length - 1; current >= 0; current -= 1) {
    if (next[current].role === 'user') { index = current; break; }
  }
  if (index < 0) {
    next.push({ role: 'user', content: 'Bitte analysiere die angehängten Dateien.' });
    index = next.length - 1;
  }
  const text = typeof next[index].content === 'string'
    ? next[index].content
    : (next[index].content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const nativeParts = attachments.flatMap(item => {
    if (item.kind === 'text' || item.kind === 'markdown') return [];
    const data = fs.readFileSync(item.path).toString('base64');
    if (provider === 'openai') {
      if (item.kind === 'image') {
        return [{ type: 'image_url', image_url: { url: `data:${item.mimeType};base64,${data}`, detail: 'auto' } }];
      }
      return [{ type: 'file', file: { filename: item.name, file_data: data } }];
    }
    if (item.kind === 'image') {
      return [{ type: 'image', source: { type: 'base64', media_type: item.mimeType, data } }];
    }
    if (item.kind === 'pdf') {
      return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: item.name }];
    }
    return [];
  });
  next[index].content = provider === 'anthropic'
    ? [...nativeParts, { type: 'text', text: text || 'Bitte analysiere die angehängten Dateien.' }]
    : [{ type: 'text', text: text || 'Bitte analysiere die angehängten Dateien.' }, ...nativeParts];
  return next;
}

function prepareApiMessages({ messages, attachments, root, provider }) {
  const bundle = resolveAttachmentBundle(attachments, root);
  const withContext = appendAttachmentContext(messages, bundle.textContext, bundle.fileContext);
  return { messages: withApiAttachments(withContext, bundle.attachments, provider), bundle };
}

module.exports = {
  IMAGE_TYPES,
  MARKDOWN_EXTENSIONS,
  TEXT_EXTENSIONS,
  MAX_ATTACHMENTS,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  appendAttachmentContext,
  appendMarkdownContext,
  attachmentData,
  classifyFile,
  clearChatAttachments,
  deleteAttachment,
  prepareApiMessages,
  resolveAttachmentBundle,
  savePickedAttachments,
  validateStoredAttachment,
  withApiAttachments,
};
