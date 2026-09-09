import EntityIcon from './EntityIcon.jsx';
import Icon from './Icon.jsx';
import useStreamingText from './useStreamingText.js';
import { useState, useRef, useEffect } from 'react';
import { createExcalidrawDocument, excalidrawElementBounds } from './excalidraw.js';
import { useI18n } from './i18n.jsx';
import MarkdownMessage from './MarkdownMessage.jsx';


export function MentionDropdown({ items, onSelect, filterText }) {
  const filtered = items.filter(i =>
    i.label.toLowerCase().includes(filterText.toLowerCase())
  );
  if (!filtered.length) return null;
  return (
    <div style={{
      position: 'absolute', bottom: '100%', left: 0, right: 0,
      background: 'var(--bg-secondary)', border: '1px solid var(--border)',
      borderRadius: 8, overflow: 'hidden', zIndex: 100,
      boxShadow: '0 -4px 20px rgba(0,0,0,0.4)', maxHeight: 220, overflowY: 'auto',
      marginBottom: 4,
    }}>
      {filtered.map((item, idx) => (
        <div key={item.id || idx}
          onMouseDown={e => { e.preventDefault(); onSelect(item); }}
          style={{
            padding: '8px 14px', cursor: 'pointer', display: 'flex',
            alignItems: 'center', gap: 10, fontSize: 14,
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
        >
          <EntityIcon value={item.emoji} group={item.kind === 'group'} size={18} />
          <span style={{ fontWeight: 500 }}>{item.label}</span>
          {item.role && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{item.role}</span>}
        </div>
      ))}
    </div>
  );
}

export function formatTime(ts, language) {
  return new Date(ts).toLocaleTimeString(language === 'en' ? 'en-US' : 'de-DE', { hour: '2-digit', minute: '2-digit' });
}

export function Avatar({ agent, size = 46 }) {
  if (!agent) return <div className="avatar color-0" style={{ width: size, height: size, fontSize: size * 0.42 }}>?</div>;
  return (
    <div className={`avatar color-${agent.color ?? 0}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      <EntityIcon value={agent.emoji} size={size * 0.52} />
    </div>
  );
}

export function formatFileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

export function attachmentIcon(attachment) {
  if (attachment?.kind === 'image') return '🖼️';
  if (attachment?.kind === 'markdown') return 'Ⓜ️';
  if (attachment?.kind === 'text') return '📄';
  if (attachment?.kind === 'pdf') return '📕';
  if (attachment?.mimeType?.startsWith('audio/')) return '🎵';
  if (attachment?.mimeType?.startsWith('video/')) return '🎬';
  if (/zip|rar|7z|gzip/.test(attachment?.mimeType || '')) return '🗜️';
  return '📎';
}

export function AttachmentImage({ attachment, compact = false }) {
  const { t } = useI18n();
  const [source, setSource] = useState(attachment?.dataUrl || '');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setSource(attachment?.dataUrl || '');
    setFailed(false);
    if (!attachment?.dataUrl && attachment?.path && window.electronAPI?.chatAttachmentData) {
      window.electronAPI.chatAttachmentData(attachment).then(result => {
        if (!active) return;
        if (result?.dataUrl) setSource(result.dataUrl);
        else setFailed(true);
      }).catch(() => active && setFailed(true));
    }
    return () => { active = false; };
  }, [attachment?.id, attachment?.path, attachment?.dataUrl]);

  if (!source || failed) {
    return <span className={`attachment-image-placeholder ${compact ? 'compact' : ''}`} title={t('Bildvorschau konnte nicht geladen werden.')}>🖼️</span>;
  }
  return <img className={compact ? 'attachment-thumbnail' : 'message-attachment-image'} src={source} alt={attachment?.name || t('Bildanhang')} />;
}

export function openAttachment(attachment) {
  if (attachment?.path && window.electronAPI?.openChatAttachment) {
    return window.electronAPI.openChatAttachment(attachment);
  }
  if (attachment?.dataUrl) {
    const link = document.createElement('a');
    link.href = attachment.dataUrl;
    link.download = attachment.name || 'attachment';
    link.click();
  }
  return Promise.resolve({ ok: true });
}

export function MessageAttachments({ attachments = [] }) {
  if (!attachments.length) return null;
  return (
    <div className="message-attachments">
      {attachments.map(attachment => (
        <button
          key={attachment.id || attachment.name}
          type="button"
          className="message-attachment"
          title={attachment.name}
          aria-label={attachment.name}
          onClick={() => openAttachment(attachment)}
        >
          <span className="message-attachment-icon">{attachmentIcon(attachment)}</span>
        </button>
      ))}
    </div>
  );
}

export function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

export async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Electron/file pages can deny the asynchronous clipboard API. The
      // selection-based fallback still works for a user-initiated click.
    }
  }
  try {
    return fallbackCopyText(value);
  } catch {
    return false;
  }
}

export function MessageCopyButton({ text }) {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState('idle');
  const resetTimerRef = useRef(null);

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), []);

  const handleCopy = async event => {
    event.stopPropagation();
    const copied = await copyText(text);
    setCopyState(copied ? 'copied' : 'failed');
    window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1800);
  };

  const label = copyState === 'copied'
    ? t('Nachricht kopiert')
    : copyState === 'failed'
      ? t('Kopieren fehlgeschlagen')
      : t('Nachricht kopieren');

  return (
    <button
      type="button"
      className={`message-copy-button ${copyState}`}
      onClick={handleCopy}
      title={label}
      aria-label={label}
    >
      {copyState === 'copied' ? '✓' : copyState === 'failed' ? '!' : '📋'}
    </button>
  );
}

export const BROWSER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

export const BROWSER_TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'html', 'htm', 'svg', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'sh', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'vue', 'svelte', 'rst', 'tex',
]);

export function classifyBrowserFile(file) {
  const extension = String(file?.name || '').split('.').pop()?.toLowerCase() || '';
  if (file?.type?.startsWith('image/') && BROWSER_IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (file?.type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (file?.type?.startsWith('text/') || BROWSER_TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'file';
}

export function readBrowserFile(file, mode = 'data-url') {
  if (mode === 'text') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

export function TypingBubble({ agent, progress = null }) {
  const { t } = useI18n();
  const preview = useStreamingText(String(progress?.partialText || '').trim());
  const [activities, setActivities] = useState([]);
  useEffect(() => {
    const detail = String(progress?.detail || '').trim();
    if (detail) setActivities(previous => previous.at(-1) === detail ? previous : [...previous.slice(-11), detail]);
  }, [progress?.detail]);
  const firstTextSeconds = progress?.firstTokenMs > 0 ? (progress.firstTokenMs / 1000).toFixed(1) : '';
  return (
    <div className="message-wrapper">
      <div className="message-avatar" style={{ width: 28, height: 28 }}>
        <Avatar agent={agent} size={28} />
      </div>
      <div className="typing-agent-block">
        <div className="typing-agent-heading">
          <span className="typing-agent-name">{agent?.name || 'Agent'}</span>
          <span className="typing-agent-role">{agent?.role || 'Agent'}</span>
        </div>
        <details className="agent-activity-disclosure">
          <summary className="typing-indicator" aria-label={t('Aktivität anzeigen')} title={t('Aktivität anzeigen')}>
            <span className="typing-dot" /><span className="typing-dot" /><span className="typing-dot" />
          </summary>
          <div className="agent-activity-details">
            <strong>{t('Aktuelle Aufgabe')}</strong>
            <p>{progress?.taskSummary || t('Bereitet die Antwort vor …')}</p>
            <strong>{t('Gemeldete Aktivitäten')}</strong>
            {activities.length ? <ul>{activities.map((detail, index) => <li key={index}>{detail}</li>)}</ul>
              : <p>{t('Noch keine weiteren Statusmeldungen verfügbar.')}</p>}
          </div>
        </details>
        {preview && (
          <div className="typing-stream-preview" aria-live="polite">
            <MarkdownMessage className="typing-stream-text" onCopy={copyText} streaming>{preview}</MarkdownMessage>
            <div className="typing-stream-meta">
              <span className="typing-stream-cursor" aria-hidden="true" />
              {firstTextSeconds && <span>{t('Erster Text nach {seconds}s', { seconds: firstTextSeconds })}</span>}
            </div>
          </div>
        )}
        {!preview && <div className="typing-progress-status" role="status">{progress?.detail || t('Bereitet die Antwort vor …')}</div>}
      </div>
    </div>
  );
}

export function ErrorBubble({ text, onRetry, action = null, isError = true, rewindAction = null }) {
  return (
    <div className="system-message-bubble" style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      background: isError ? 'rgba(192,57,43,0.15)' : 'rgba(0,168,132,0.12)',
      border: isError ? '1px solid rgba(192,57,43,0.4)' : '1px solid rgba(0,168,132,0.35)',
      borderRadius: 8, padding: '8px 40px 8px 12px', margin: '4px 0',
      fontSize: 13, color: isError ? '#e88' : 'var(--text-primary)',
    }}>
      {rewindAction}
      <MarkdownMessage className="system-message-text" onCopy={copyText}>{text}</MarkdownMessage>
      {onRetry && (
        <button onClick={onRetry} style={{
          background: 'rgba(192,57,43,0.3)', border: '1px solid rgba(192,57,43,0.5)',
          borderRadius: 6, color: '#faa', padding: '3px 10px', cursor: 'pointer',
          fontSize: 12, flexShrink: 0, whiteSpace: 'nowrap',
        }}>↺ Retry</button>
      )}
      {action && (
        <button
          type="button"
          className={`system-message-action ${action.tone || ''}`}
          onClick={action.onClick}
          disabled={action.disabled}
          title={action.title}
          aria-label={action.title || action.label}
        >{action.icon || '✓'} {action.label}</button>
      )}
      <MessageCopyButton text={text} />
    </div>
  );
}

export function downloadExcalidrawDiagram(diagram) {
  const documentContent = createExcalidrawDocument(diagram?.elements || []);
  const blob = new Blob([JSON.stringify(documentContent, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = diagram?.name || 'diagram.excalidraw';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExcalidrawDiagram({ diagram }) {
  const { t } = useI18n();
  const elements = Array.isArray(diagram?.elements) ? diagram.elements : [];
  if (!elements.length) return null;
  const bounds = excalidrawElementBounds(elements);
  const markerId = `excalidraw-arrow-${String(diagram.id || 'diagram').replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const renderElement = (element, index) => {
    const key = element.id || `${element.type}-${index}`;
    const x = Number(element.x) || 0;
    const y = Number(element.y) || 0;
    const width = Math.max(0, Number(element.width) || 0);
    const height = Math.max(0, Number(element.height) || 0);
    const stroke = element.strokeColor || '#1e1e1e';
    const fill = !element.backgroundColor || element.backgroundColor === 'transparent'
      ? 'transparent'
      : element.backgroundColor;
    const opacity = Math.max(0, Math.min(1, (Number(element.opacity) || 100) / 100));
    const common = { stroke, strokeWidth: Number(element.strokeWidth) || 2, opacity };

    if (element.type === 'rectangle') {
      return <rect key={key} x={x} y={y} width={width} height={height} rx={element.roundness ? 10 : 0} fill={fill} {...common} />;
    }
    if (element.type === 'ellipse') {
      return <ellipse key={key} cx={x + width / 2} cy={y + height / 2} rx={width / 2} ry={height / 2} fill={fill} {...common} />;
    }
    if (element.type === 'diamond') {
      return <polygon key={key} points={`${x + width / 2},${y} ${x + width},${y + height / 2} ${x + width / 2},${y + height} ${x},${y + height / 2}`} fill={fill} {...common} />;
    }
    if (['line', 'arrow', 'freedraw'].includes(element.type) && Array.isArray(element.points)) {
      const points = element.points.map(point => `${x + (Number(point?.[0]) || 0)},${y + (Number(point?.[1]) || 0)}`).join(' ');
      return <polyline key={key} points={points} fill="none" markerEnd={element.type === 'arrow' ? `url(#${markerId})` : undefined} {...common} />;
    }
    if (element.type === 'text') {
      const fontSize = Number(element.fontSize) || 20;
      const lines = String(element.text || element.originalText || '').split('\n');
      const anchor = element.textAlign === 'center' ? 'middle' : element.textAlign === 'right' ? 'end' : 'start';
      const textX = anchor === 'middle' ? x + width / 2 : anchor === 'end' ? x + width : x;
      return (
        <text key={key} x={textX} y={y + fontSize} fill={stroke} fontSize={fontSize} textAnchor={anchor} opacity={opacity} fontFamily="Segoe UI, sans-serif">
          {lines.map((line, lineIndex) => <tspan key={lineIndex} x={textX} dy={lineIndex === 0 ? 0 : fontSize * 1.25}>{line}</tspan>)}
        </text>
      );
    }
    return null;
  };

  return (
    <div className="excalidraw-diagram">
      <div className="excalidraw-diagram-head">
        <span>🎨 {t('Excalidraw-Diagramm')}</span>
        <button type="button" onClick={() => downloadExcalidrawDiagram(diagram)}>{t('Herunterladen')}</button>
      </div>
      <svg viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`} role="img" aria-label={t('Von einem Agenten erstelltes Excalidraw-Diagramm')}>
        <defs>
          <marker id={markerId} markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L0,6 L9,3 z" fill="#1e1e1e" />
          </marker>
        </defs>
        {elements.map(renderElement)}
      </svg>
    </div>
  );
}

export function mcpArgumentPreview(value) {
  const redacted = JSON.stringify(value || {}, (key, item) => (
    /(?:token|secret|password|authorization|api.?key)/i.test(key) ? '••••' : item
  ), 2);
  return redacted.length > 5000 ? `${redacted.slice(0, 5000)}\n…` : redacted;
}

export function McpPermissionPrompt({ request, onDecision }) {
  const { t } = useI18n();
  const riskLabels = {
    'read-only': t('Nur lesend'),
    write: t('Kann Daten verändern'),
    destructive: t('Kann Daten löschen oder überschreiben'),
    external: t('Greift auf externe Dienste zu'),
  };
  return (
    <div className="mcp-inline-permission" role="alert" aria-label={t('Werkzeug-Erlaubnis erforderlich')}>
      <div className="mcp-inline-permission-icon" aria-hidden="true">🔐</div>
      <div className="mcp-inline-permission-content">
        <strong>{t('{agent} benötigt deine Erlaubnis für „{tool}“.', {
          agent: request.agent?.name || t('Ein Agent'),
          tool: request.tool?.name || t('Werkzeug'),
        })}</strong>
        <span className="mcp-inline-permission-meta">
          {request.server?.name || 'MCP'} · <span className={`mcp-risk ${request.risk}`}>{riskLabels[request.risk] || request.risk}</span>
        </span>
        {request.tool?.description && <span className="mcp-inline-permission-description">{request.tool.description}</span>}
        {request.pendingArguments ? (
          <span className="mcp-inline-permission-description">{t('Die konkreten Werkzeugparameter werden nach deiner Freigabe erzeugt.')}</span>
        ) : (
          <details className="mcp-permission-arguments">
            <summary>{t('Übergebene Parameter anzeigen')}</summary>
            <pre>{mcpArgumentPreview(request.arguments)}</pre>
          </details>
        )}
        <span className="mcp-inline-permission-note">
          {request.server?.transport === 'http'
            ? t('Die Daten werden an {url} übertragen.', { url: request.server.url })
            : t('Das Werkzeug läuft über den lokalen Prozess „{command}“.', { command: request.server?.command })}
        </span>
      </div>
      <div className="mcp-inline-permission-actions">
        <button className="btn btn-secondary" type="button" onClick={() => onDecision('deny')}>{t('Verweigern')}</button>
        <button className="btn btn-primary" type="button" onClick={() => onDecision('allow-once')} title={t('Nur diesen Werkzeugaufruf zulassen')}>{t('Zulassen')}</button>
      </div>
    </div>
  );
}

export function MemoryBadge({ count, onOpen }) {
  const { t } = useI18n();
  return (
    <button
      className="icon-btn memory-open-btn"
      data-memory-count={count}
      title={t('Gruppen-Memory öffnen ({count} Einträge)', { count })}
      aria-label={t('Gruppen-Memory öffnen ({count} Einträge)', { count })}
      aria-live="polite"
      onClick={onOpen}
    >
      🧠{count > 0 ? ` ${count}` : ''}
    </button>
  );
}

export function MemoryViewer({ entries, error, loading, busy, namespace, provider, filePath, language, onClose, onCreateEntry, onDeleteEntry, onClearAll }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState('');
  const [entryType, setEntryType] = useState('fact');

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const formatContent = entry => typeof entry.content === 'string'
    ? entry.content
    : JSON.stringify(entry.content, null, 2);
  const sortedEntries = [...entries].sort((left, right) => {
    const leftDate = new Date(left.created || left.ts || 0).getTime();
    const rightDate = new Date(right.created || right.ts || 0).getTime();
    return rightDate - leftDate;
  });
  const handleCreate = async event => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || busy) return;
    const created = await onCreateEntry({ content, type: entryType });
    if (created) setDraft('');
  };

  return (
    <div className="modal-overlay" onClick={event => event.target === event.currentTarget && onClose()}>
      <div className="modal memory-viewer-modal" role="dialog" aria-modal="true" aria-label={t('Shared Memory anzeigen')}>
        <div className="modal-body">
          <div className="memory-viewer-title-row">
            <div>
              <div className="modal-title">🧠 {t('Shared Memory anzeigen')}</div>
              <div className="memory-viewer-meta">
                <code>memory://{namespace}</code>
                <span>·</span>
                <span>{provider === 'file' ? t('JSON-Datei') : t('App-Speicher')}</span>
              </div>
              {provider === 'file' && filePath && <div className="memory-viewer-path" title={filePath}>{filePath}</div>}
            </div>
            <span className="memory-entry-count">{t('{count} Einträge', { count: entries.length })}</span>
          </div>

          <form className="memory-entry-compose" onSubmit={handleCreate}>
            <select className="form-select" value={entryType} onChange={event => setEntryType(event.target.value)} aria-label={t('Memory-Typ')}>
              <option value="fact">{t('Fakt')}</option>
              <option value="decision">{t('Entscheidung')}</option>
              <option value="constraint">{t('Vorgabe')}</option>
              <option value="finding">{t('Erkenntnis')}</option>
              <option value="task_state">{t('Aufgabenstand')}</option>
            </select>
            <textarea
              className="form-textarea"
              value={draft}
              onChange={event => setDraft(event.target.value)}
              placeholder={t('Wissen manuell zum Gruppen-Memory hinzufügen…')}
              rows={2}
            />
            <button className="btn btn-primary" type="submit" disabled={!draft.trim() || !!busy}>{t('Speichern')}</button>
          </form>

          {loading && <div className="memory-viewer-state">{t('Memory wird geladen…')}</div>}
          {!loading && error && <div className="memory-viewer-state error">{error}</div>}
          {!loading && !error && sortedEntries.length === 0 && (
            <div className="memory-viewer-state">{t('Noch keine Memory-Einträge vorhanden.')}</div>
          )}
          {!loading && !error && sortedEntries.length > 0 && (
            <div className="memory-entry-list">
              {sortedEntries.map(entry => {
                const rawDate = entry.created || entry.ts;
                const date = rawDate ? new Date(rawDate) : null;
                const validDate = date && !Number.isNaN(date.getTime());
                return (
                  <article className="memory-entry-card" key={entry.id}>
                    <div className="memory-entry-head">
                      <span className="memory-entry-type">{entry.type || t('Eintrag')}</span>
                      <span>{entry.author || entry.authorName || t('Unbekannt')}</span>
                      {validDate && <time>{date.toLocaleString(language === 'en' ? 'en-US' : 'de-DE')}</time>}
                      <button
                        type="button"
                        className="memory-entry-delete"
                        title={t('Memory-Eintrag löschen')}
                        aria-label={t('Memory-Eintrag löschen')}
                        disabled={!!busy}
                        onClick={() => onDeleteEntry(entry)}
                      ><Icon name="trash" /></button>
                    </div>
                    <div className="memory-entry-content">{formatContent(entry)}</div>
                    {!!entry.tags?.length && (
                      <div className="memory-entry-tags">{entry.tags.map(tag => <span key={tag}>#{tag}</span>)}</div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <div className="modal-actions">

          <button className="btn btn-secondary" onClick={onClose}>{t('Schließen')}</button>
          <button className="btn memory-delete-all-btn" onClick={onClearAll} disabled={entries.length === 0 || !!busy}>
            {t('Alle Memory-Einträge löschen')}
          </button>
        </div>
      </div>
    </div>
  );
}
