import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useStore } from './store';
import { callLLM } from './llm';
import { callLLMWithMcp, createMcpToolSignature, getEffectiveMcpServers, getMcpToolPermissionDecision } from './mcp';
import {
  assessTaskComplexity,
  buildEscalationHistory,
  estimateTokens,
  evaluateResponseQuality,
  resolveQualityPolicy,
} from './quality-cascade';
import {
  addTaskEdge,
  approveAgentDoneTasks,
  createTaskGraph,
  findSafeAutoParallelTaskIds,
  inferHandoffDependency,
  inferTaskNodeType,
  isTaskNodeReady,
  materializeTaskPlan,
  orderTasksForParallelSelection,
  runTaskBatch,
  updateTaskNodeStatus,
  upsertTaskNode,
  validateParallelSelection,
} from './task-graph';
import {
  extractKnowledgeFromReply,
  extractMemoryCommands,
  isMemoryCommandOnly,
} from './memory';
import { createEntry, getMemoryAPI } from './memory-provider';
import { createExcalidrawDocument, excalidrawElementBounds, parseExcalidrawElements } from './excalidraw';
import { useI18n } from './i18n';
import { buildQueuedRequestHistory } from './user-request-queue';
import { getProviderEmoji } from './provider-catalog';
import {
  AgentTaskQueue,
  buildAgentSession,
  buildIsolatedSystemPrompt,
  buildProjectReviewEvidence,
  buildRelevantConversationHistory,
  buildTaskCapsule,
  buildTurnLimitReviewTask,
  buildTimeoutRecoveryReviewTask,
  buildTimeoutRecoveryTask,
  buildUserAnswerTask,
  cleanAgentReply,
  createHandoff,
  distributeTaskPlanAcrossAgentPools,
  extractHandoffsFromReply,
  extractProjectFiles,
  extractTaskPlan,
  extractUserQuestions,
  getGroupPMAgent,
  hasDirectedMention,
  isAgentTimeoutError,
  normalizeAgentMentionLayout,
  orchestrate,
  shouldCompleteProject,
  shouldDeferHandoffToPM,
  shouldRequestPMFinalReview,
  summarizeTaskActivity,
} from './orchestrator';

// In-flight conversations are intentionally short-lived runtime state. Keeping
// them by chat id lets users switch chats while an @user pause is active.
const conversationContinuations = new Map();
const FINISHED_PLAN_STATUSES = new Set(['agent_done', 'completed']);
const CLAIMABLE_PLAN_STATUSES = new Set(['planned', 'queued', 'interrupted']);

function planTaskMatchScore(node, summary) {
  const tokens = value => new Set(String(value || '').toLowerCase().match(/[a-zäöüß0-9_.-]{3,}/g) || []);
  const nodeTokens = tokens(`${node.title} ${node.objective}`);
  const summaryTokens = tokens(summary);
  return [...summaryTokens].filter(token => nodeTokens.has(token)).length;
}

function rewritePlanHandoffAssignments(reply, planTasks) {
  if (!planTasks.length) return reply;
  const usedPlanTaskIds = new Set();
  return String(reply || '').split(/\r?\n/).map(line => {
    const match = line.match(/^@([^:]+):\s*(.*)$/);
    if (!match) return line;
    const requestedName = match[1].trim().toLowerCase();
    const candidates = planTasks
      .filter(planTask =>
        planTask.type !== 'review' &&
        String(planTask.requestedAgentName || planTask.agentName || planTask.agent).toLowerCase() === requestedName &&
        !usedPlanTaskIds.has(planTask.id)
      )
      .map(planTask => ({ planTask, score: planTaskMatchScore(planTask, match[2]) }))
      .sort((left, right) => right.score - left.score || left.planTask.order - right.planTask.order);
    const selected = candidates[0]?.planTask;
    if (!selected) return line;
    usedPlanTaskIds.add(selected.id);
    return `@${selected.agentName || selected.agent}: ${match[2].trim()}`;
  }).join('\n');
}

// ── @-mention autocomplete ────────────────────────────────────────────────────
function MentionDropdown({ items, onSelect, filterText }) {
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
          <span style={{ fontSize: 16 }}>{item.emoji}</span>
          <span style={{ fontWeight: 500 }}>{item.label}</span>
          {item.role && <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 'auto' }}>{item.role}</span>}
        </div>
      ))}
    </div>
  );
}

function formatTime(ts, language) {
  return new Date(ts).toLocaleTimeString(language === 'en' ? 'en-US' : 'de-DE', { hour: '2-digit', minute: '2-digit' });
}

function Avatar({ agent, size = 46 }) {
  if (!agent) return <div className="avatar color-0" style={{ width: size, height: size, fontSize: size * 0.42 }}>?</div>;
  return (
    <div className={`avatar color-${agent.color ?? 0}`} style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {agent.emoji || agent.name?.[0] || '?'}
    </div>
  );
}

function formatFileSize(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}

function attachmentIcon(attachment) {
  if (attachment?.kind === 'image') return '🖼️';
  if (attachment?.kind === 'markdown') return 'Ⓜ️';
  if (attachment?.kind === 'text') return '📄';
  if (attachment?.kind === 'pdf') return '📕';
  if (attachment?.mimeType?.startsWith('audio/')) return '🎵';
  if (attachment?.mimeType?.startsWith('video/')) return '🎬';
  if (/zip|rar|7z|gzip/.test(attachment?.mimeType || '')) return '🗜️';
  return '📎';
}

function AttachmentImage({ attachment, compact = false }) {
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

function openAttachment(attachment) {
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

function MessageAttachments({ attachments = [] }) {
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

const BROWSER_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const BROWSER_TEXT_EXTENSIONS = new Set([
  'md', 'markdown', 'txt', 'text', 'log', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'css', 'scss', 'html', 'htm', 'svg', 'py', 'java', 'kt', 'c', 'h', 'cpp', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'sh', 'ps1', 'bat', 'cmd', 'sql', 'graphql', 'vue', 'svelte', 'rst', 'tex',
]);

function classifyBrowserFile(file) {
  const extension = String(file?.name || '').split('.').pop()?.toLowerCase() || '';
  if (file?.type?.startsWith('image/') && BROWSER_IMAGE_EXTENSIONS.has(extension)) return 'image';
  if (extension === 'md' || extension === 'markdown') return 'markdown';
  if (file?.type === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (file?.type?.startsWith('text/') || BROWSER_TEXT_EXTENSIONS.has(extension)) return 'text';
  return 'file';
}

function readBrowserFile(file, mode = 'data-url') {
  if (mode === 'text') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Datei konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
}

function TypingBubble({ agent }) {
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
        <div className="typing-indicator" aria-label={agent?.name || 'Agent'}>
          <span className="typing-dot" />
          <span className="typing-dot" />
          <span className="typing-dot" />
        </div>
      </div>
    </div>
  );
}

// Inline error bubble with optional retry
function ErrorBubble({ text, onRetry, isError = true }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      background: isError ? 'rgba(192,57,43,0.15)' : 'rgba(0,168,132,0.12)',
      border: isError ? '1px solid rgba(192,57,43,0.4)' : '1px solid rgba(0,168,132,0.35)',
      borderRadius: 8, padding: '8px 12px', margin: '4px 0',
      fontSize: 13, color: isError ? '#e88' : 'var(--text-primary)',
    }}>
      <span style={{ flex: 1, lineHeight: 1.5 }}>{text}</span>
      {onRetry && (
        <button onClick={onRetry} style={{
          background: 'rgba(192,57,43,0.3)', border: '1px solid rgba(192,57,43,0.5)',
          borderRadius: 6, color: '#faa', padding: '3px 10px', cursor: 'pointer',
          fontSize: 12, flexShrink: 0, whiteSpace: 'nowrap',
        }}>↺ Retry</button>
      )}
    </div>
  );
}

function downloadExcalidrawDiagram(diagram) {
  const documentContent = createExcalidrawDocument(diagram?.elements || []);
  const blob = new Blob([JSON.stringify(documentContent, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = diagram?.name || 'diagram.excalidraw';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ExcalidrawDiagram({ diagram }) {
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

function mcpArgumentPreview(value) {
  const redacted = JSON.stringify(value || {}, (key, item) => (
    /(?:token|secret|password|authorization|api.?key)/i.test(key) ? '••••' : item
  ), 2);
  return redacted.length > 5000 ? `${redacted.slice(0, 5000)}\n…` : redacted;
}

function createMcpPlannerAgent(agent) {
  if (agent?.provider === 'anthropic' && /opus/i.test(String(agent.model || ''))) {
    return { ...agent, model: 'claude-sonnet-4-5' };
  }
  return agent;
}

function McpPermissionDialog({ request, onDecision }) {
  const { t } = useI18n();
  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onDecision('deny');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onDecision]);

  const riskLabels = {
    'read-only': t('Nur lesend'),
    write: t('Kann Daten verändern'),
    destructive: t('Kann Daten löschen oder überschreiben'),
    external: t('Greift auf externe Dienste zu'),
  };
  return (
    <div className="modal-overlay mcp-permission-overlay">
      <div className="modal mcp-permission-modal" role="alertdialog" aria-modal="true" aria-label={t('Werkzeug-Erlaubnis erforderlich')}>
        <div className="modal-body">
          <div className="mcp-permission-title">🔐 {t('Werkzeug-Erlaubnis erforderlich')}</div>
          <p className="mcp-permission-intro">
            {t('{agent} möchte ein externes Werkzeug verwenden. Der Agentenlauf wartet auf deine Entscheidung.', { agent: request.agent?.name || t('Ein Agent') })}
          </p>
          <div className="mcp-permission-summary">
            <div><span>{t('Agent')}</span><strong>{request.agent?.emoji} {request.agent?.name}</strong></div>
            <div><span>{t('MCP-Server')}</span><strong>{request.server?.name}</strong></div>
            <div><span>{t('Werkzeug')}</span><strong>{request.tool?.name}</strong></div>
            <div><span>{t('Einstufung')}</span><strong className={`mcp-risk ${request.risk}`}>{riskLabels[request.risk] || request.risk}</strong></div>
          </div>
          {request.tool?.description && <div className="mcp-permission-description">{request.tool.description}</div>}
          {request.pendingArguments ? (
            <div className="mcp-permission-description">
              {t('Die konkreten Werkzeugparameter werden nach deiner Freigabe erzeugt.')}
            </div>
          ) : (
            <details className="mcp-permission-arguments">
              <summary>{t('Übergebene Parameter anzeigen')}</summary>
              <pre>{mcpArgumentPreview(request.arguments)}</pre>
            </details>
          )}
          <div className="mcp-permission-note">
            {request.server?.transport === 'http'
              ? t('Die Daten werden an {url} übertragen.', { url: request.server.url })
              : t('Das Werkzeug läuft über den lokalen Prozess „{command}“.', { command: request.server?.command })}
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn btn-secondary" type="button" onClick={() => onDecision('deny')}>{t('Ablehnen')}</button>
          <button className="btn btn-secondary" type="button" onClick={() => onDecision('allow-chat')}>{t('Dieses Werkzeug für diesen Chat erlauben')}</button>
          <button className="btn btn-primary" type="button" onClick={() => onDecision('allow-once')}>{t('Einmal erlauben')}</button>
        </div>
      </div>
    </div>
  );
}

function MemoryBadge({ count, onOpen }) {
  const { t } = useI18n();
  return (
    <button
      className="icon-btn memory-open-btn"
      title={t('Gruppen-Memory öffnen ({count} Einträge)', { count })}
      aria-label={t('Gruppen-Memory öffnen ({count} Einträge)', { count })}
      onClick={onOpen}
    >
      🧠{count > 0 ? ` ${count}` : ''}
    </button>
  );
}

function MemoryViewer({ entries, error, loading, busy, namespace, provider, filePath, language, onClose, onCreateEntry, onDeleteEntry, onClearAll }) {
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
                      >🗑️</button>
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
          <button className="btn memory-delete-all-btn" onClick={onClearAll} disabled={entries.length === 0 || !!busy}>
            {t('Alle Memory-Einträge löschen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>{t('Schließen')}</button>
        </div>
      </div>
    </div>
  );
}

export default function ChatView({ chat }) {
  const { language, t } = useI18n();
  const {
    agents,
    messages,
    conversationStates,
    userRequestQueues,
    taskGraphs,
    addMessage,
    apiKeys,
    providerConnections,
    kbPath,
    clearMessages,
    saveConversationState,
    clearConversationState,
    enqueueUserRequest,
    removeUserRequest,
    clearUserRequestQueue,
    saveTaskGraph,
    clearTaskGraph,
    mcpServers,
    mcpPermissions,
    grantMcpPermission,
    consumeMcpPermission,
    clearMcpPermissions,
    conversationLimits,
    qualityRouting,
    recordQualityEvent,
  } = useStore();
  // Use group-specific projectPath, fall back to nothing
  const projectPath = chat.projectPath || '';
  const [input, setInput] = useState('');
  const [messageQualityMode, setMessageQualityMode] = useState('auto');
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [running, setRunning] = useState(false);
  const [autoRun, setAutoRun] = useState(chat.type === 'group'); // default ON for groups
  const [typingAgents, setTypingAgents] = useState([]);
  const [lastRunContext, setLastRunContext] = useState(null);
  const [stoppedForUser, setStoppedForUser] = useState(false);
  const [memoryCount, setMemoryCount] = useState(0);
  const [memoryViewer, setMemoryViewer] = useState({ open: false, loading: false, busy: false, entries: [], error: '' });
  const [mcpApproval, setMcpApproval] = useState(null);
  const [agentProgress, setAgentProgress] = useState({});
  const [retryClock, setRetryClock] = useState(Date.now());
  const [queuePump, setQueuePump] = useState(0);
  const messagesEndRef = useRef(null);
  const autoRunRef = useRef(chat.type === 'group');
  const textareaRef = useRef(null);
  const browserFileInputRef = useRef(null);
  const pendingAttachmentsRef = useRef([]);
  const chatMessagesRef = useRef(messages[chat.id] || []);
  const queueProcessingRef = useRef(null);
  const queueDrainPausedRef = useRef(false);
  const runIdRef = useRef(0); // cancellation token — incremented on each new run
  const activeAgentRunRef = useRef(new Map());
  const taskGraphRef = useRef(taskGraphs?.[chat.id] || createTaskGraph(chat.id, chat.name));
  const mcpApprovalQueueRef = useRef([]);
  const activeMcpApprovalRef = useRef(null);
  const excalidrawCheckpointsRef = useRef(new Map());
  const reportedMcpErrorsRef = useRef(new Set());

  const focusComposer = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || textarea.disabled || document.activeElement === textarea) return;
    textarea.focus({ preventScroll: true });
    const end = textarea.value.length;
    textarea.setSelectionRange(end, end);
  }, []);

  const activateNextMcpApproval = useCallback(() => {
    if (activeMcpApprovalRef.current || mcpApprovalQueueRef.current.length === 0) return;
    const next = mcpApprovalQueueRef.current.shift();
    activeMcpApprovalRef.current = next;
    setMcpApproval(next);
  }, []);

  const requestMcpPermission = useCallback((request) => {
    const toolSignature = createMcpToolSignature(request.tool);
    const grantKey = `${request.server?.id || request.server?.name}:${request.tool?.name}:${toolSignature}`;
    const globalDecision = getMcpToolPermissionDecision(request.server, request.tool);
    if (globalDecision === 'allow') {
      return Promise.resolve({ allowed: true, scope: 'global', restored: true });
    }
    if (globalDecision === 'deny') {
      addMessage(chat.id, {
        id: Date.now() + Math.random(),
        agentId: 'system',
        senderName: 'System',
        text: `MCP|${t('Werkzeug durch globale Einstellung blockiert: {server} · {tool}', {
          server: request.server?.name || 'MCP',
          tool: request.tool?.name || '',
        })}`,
        ts: Date.now(),
        isError: true,
      });
      return Promise.resolve({ allowed: false, scope: 'global-deny', restored: true });
    }
    const savedGrant = mcpPermissions?.[chat.id]?.[grantKey];
    const isActiveChatGrant = savedGrant?.scope === 'chat';
    const isActiveOnceGrant = savedGrant?.scope === 'once' && Number(savedGrant.expiresAt || 0) > Date.now();
    if (isActiveChatGrant || isActiveOnceGrant) {
      return Promise.resolve({ allowed: true, scope: savedGrant.scope, restored: true });
    }
    if (savedGrant) {
      consumeMcpPermission(chat.id, grantKey);
    }
    return new Promise(resolve => {
      mcpApprovalQueueRef.current.push({
        ...request,
        id: `mcp-approval-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        grantKey,
        resolve,
      });
      activateNextMcpApproval();
    });
  }, [activateNextMcpApproval, addMessage, chat.id, consumeMcpPermission, mcpPermissions, t]);

  const resolveMcpApproval = useCallback((decision) => {
    const current = activeMcpApprovalRef.current;
    if (!current) return;
    const allowed = decision !== 'deny';
    const scope = decision === 'allow-chat' ? 'chat' : 'once';
    if (allowed) {
      grantMcpPermission(chat.id, current.grantKey, {
        scope,
        grantedAt: Date.now(),
        ...(scope === 'once' ? { expiresAt: Date.now() + 30 * 60 * 1000 } : {}),
        serverId: current.server?.id || '',
        serverName: current.server?.name || '',
        toolName: current.tool?.name || '',
        toolSignature: createMcpToolSignature(current.tool),
      });
    }
    addMessage(chat.id, {
      id: Date.now() + Math.random(),
      agentId: 'system',
      senderName: 'System',
      text: `MCP|${allowed
        ? t('Werkzeugfreigabe erteilt: {server} · {tool}', { server: current.server?.name || 'MCP', tool: current.tool?.name || '' })
        : t('Werkzeugzugriff abgelehnt: {server} · {tool}', { server: current.server?.name || 'MCP', tool: current.tool?.name || '' })}`,
      ts: Date.now(),
      isError: !allowed,
    });
    current.resolve({ allowed, scope });
    activeMcpApprovalRef.current = null;
    setMcpApproval(null);
    queueMicrotask(activateNextMcpApproval);
  }, [activateNextMcpApproval, addMessage, chat.id, grantMcpPermission, t]);

  const handleMcpPermissionConsumed = useCallback(({ server, tool, permission }) => {
    if (permission?.scope === 'chat' || permission?.scope === 'global') return;
    const grantKey = `${server?.id || server?.name}:${tool?.name}:${createMcpToolSignature(tool)}`;
    consumeMcpPermission(chat.id, grantKey);
  }, [chat.id, consumeMcpPermission]);

  const cancelAllMcpApprovals = useCallback(() => {
    const current = activeMcpApprovalRef.current;
    if (current) current.resolve({ allowed: false, scope: 'cancelled' });
    for (const pending of mcpApprovalQueueRef.current) {
      pending.resolve({ allowed: false, scope: 'cancelled' });
    }
    activeMcpApprovalRef.current = null;
    mcpApprovalQueueRef.current = [];
    setMcpApproval(null);
  }, []);

  const handleMcpToolResult = useCallback(({ agent, server, tool, arguments: toolArguments, result }) => {
    if (server?.id !== 'mcp-official-excalidraw' || tool?.name !== 'create_view') return;
    try {
      const requestedElements = parseExcalidrawElements(toolArguments?.elements || '[]');
      let elements = [];
      for (const requested of requestedElements) {
        if (requested.type === 'restoreCheckpoint') {
          elements = [...(excalidrawCheckpointsRef.current.get(requested.id) || [])];
        } else if (requested.type === 'delete') {
          const deletedIds = new Set(String(requested.ids || '').split(',').map(value => value.trim()).filter(Boolean));
          elements = elements.filter(element => !deletedIds.has(element.id));
        } else {
          const existingIndex = elements.findIndex(element => element.id && element.id === requested.id);
          if (existingIndex >= 0) elements[existingIndex] = requested;
          else elements.push(requested);
        }
      }
      const checkpointId = result?.structuredContent?.checkpointId || '';
      if (checkpointId) excalidrawCheckpointsRef.current.set(checkpointId, elements);
      addMessage(chat.id, {
        id: Date.now() + Math.random(),
        agentId: agent.id,
        senderName: agent.name,
        text: `🎨 ${t('{agent} hat ein Excalidraw-Diagramm erstellt.', { agent: agent.name })}`,
        ts: Date.now(),
        provider: agent.provider,
        model: agent.model,
        diagram: {
          id: checkpointId || `diagram-${Date.now().toString(36)}`,
          name: `diagram-${Date.now().toString(36)}.excalidraw`,
          elements,
          checkpointId,
        },
      });
      return t('Das Excalidraw-Diagramm wurde erstellt.');
    } catch (error) {
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `Excalidraw|${t('Das Diagramm konnte nicht angezeigt werden: {error}', { error: error.message })}`,
        ts: Date.now(), isError: true,
      });
      return '';
    }
  }, [addMessage, chat.id, t]);

  useEffect(() => () => cancelAllMcpApprovals(), [chat.id, cancelAllMcpApprovals]);

  const openTaskGraphWindow = useCallback((overrides = {}) => {
    if (chat.type !== 'group' || !window.electronAPI?.openTaskWindow) return;
    window.electronAPI.openTaskWindow({
      chatId: chat.id,
      chatName: chat.name,
      windowTitle: `${t('Aufgabenbaum')} – ${chat.name}`,
      graph: taskGraphRef.current || createTaskGraph(chat.id, chat.name),
      running,
      awaitingSchedule: conversationStates?.[chat.id]?.status === 'awaiting-schedule',
      ...overrides,
    }).catch(() => null);
  }, [chat.id, chat.name, chat.type, conversationStates, running, t]);

  // Mention autocomplete state
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);

  const chatMessages = messages[chat.id] || [];
  const queuedUserRequests = userRequestQueues?.[chat.id] || [];
  const memoryConfig = chat.type === 'group' ? (chat.memory || { enabled: true, provider: 'local', namespace: chat.id }) : null;
  const memoryEnabled = !!memoryConfig?.enabled && !!memoryConfig?.namespace;
  const memoryAPI = memoryEnabled ? getMemoryAPI(memoryConfig) : null;
  const activeMcpServers = getEffectiveMcpServers(
    mcpServers,
    chat.type === 'group' ? chat.mcpServers : [],
  );
  const activeMcpPermissionCount = Object.values(mcpPermissions?.[chat.id] || {}).filter(grant => (
    grant?.scope === 'chat' || (grant?.scope === 'once' && Number(grant.expiresAt || 0) > Date.now())
  )).length;

  const chatAgents = chat.type === 'group'
    ? agents.filter(a => chat.agentIds?.includes(a.id))
    : agents.filter(a => a.id === chat.id);

  // Build mention items: @everyone + group members (after chatAgents is defined)
  const mentionItems = chat.type === 'group' ? [
    { id: 'everyone', label: 'everyone', emoji: '📢', role: t('Alle Agenten') },
    { id: 'user', label: 'user', emoji: '👤', role: t('Du') },
    ...chatAgents.map(a => ({ id: a.id, label: a.name, emoji: a.emoji || '🤖', role: a.role })),
  ] : [];

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages, typingAgents, agentProgress]);
  useEffect(() => { chatMessagesRef.current = chatMessages; }, [chatMessages]);
  useEffect(() => { autoRunRef.current = autoRun; }, [autoRun]);
  useEffect(() => { pendingAttachmentsRef.current = pendingAttachments; }, [pendingAttachments]);
  useEffect(() => () => {
    const unsent = pendingAttachmentsRef.current;
    pendingAttachmentsRef.current = [];
    for (const attachment of unsent) {
      if (attachment?.path && window.electronAPI?.deleteChatAttachment) {
        window.electronAPI.deleteChatAttachment(attachment).catch(() => null);
      }
    }
  }, [chat.id]);
  useEffect(() => {
    taskGraphRef.current = taskGraphs?.[chat.id] || createTaskGraph(chat.id, chat.name);
  }, [chat.id, chat.name, taskGraphs]);
  useEffect(() => {
    if (!window.electronAPI?.onCodexProgress) return undefined;
    return window.electronAPI.onCodexProgress((progress) => {
      const active = [...activeAgentRunRef.current.values()]
        .find(candidate => progress?.requestId === candidate.requestId);
      if (!active) return;
      setAgentProgress(previous => ({ ...previous, [active.agentId]: {
        agentId: active.agentId,
        taskSummary: previous?.[active.agentId]?.taskSummary || active.taskSummary || t('Bearbeitet den aktuellen Task.'),
        detail: progress.phase === 'activity'
          ? previous?.[active.agentId]?.detail
          : (progress.message || previous?.[active.agentId]?.detail || ''),
        phase: progress.phase === 'activity' ? (previous?.[active.agentId]?.phase || 'working') : (progress.phase || 'working'),
        startedAt: previous?.[active.agentId]?.startedAt || active.startedAt,
        updatedAt: progress.ts || Date.now(),
      }}));
    });
  }, [t]);
  useEffect(() => {
    if (!window.electronAPI?.onClaudeProgress) return undefined;
    return window.electronAPI.onClaudeProgress((progress) => {
      const active = [...activeAgentRunRef.current.values()]
        .find(candidate => progress?.requestId === candidate.requestId);
      if (!active) return;
      setAgentProgress(previous => ({ ...previous, [active.agentId]: {
        agentId: active.agentId,
        taskSummary: previous?.[active.agentId]?.taskSummary || active.taskSummary || t('Bearbeitet den aktuellen Task.'),
        detail: progress.message || previous?.[active.agentId]?.detail || '',
        phase: progress.phase || previous?.[active.agentId]?.phase || 'working',
        startedAt: previous?.[active.agentId]?.startedAt || active.startedAt,
        updatedAt: progress.ts || Date.now(),
      }}));
    });
  }, [t]);
  useEffect(() => {
    const persisted = conversationStates?.[chat.id];
    if (persisted) conversationContinuations.set(chat.id, persisted);
    else conversationContinuations.delete(chat.id);
    setStoppedForUser(persisted?.status === 'awaiting-user');
  }, [chat.id, conversationStates]);
  useEffect(() => {
    const retryNotBefore = conversationStates?.[chat.id]?.retryNotBefore || 0;
    if (retryNotBefore <= Date.now()) return undefined;
    setRetryClock(Date.now());
    const timer = setInterval(() => {
      const now = Date.now();
      setRetryClock(now);
      if (now >= retryNotBefore) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [chat.id, conversationStates]);

  const refreshMemoryCount = useCallback(async () => {
    if (!memoryAPI) { setMemoryCount(0); return; }
    try {
      const entries = await memoryAPI.list(memoryConfig.namespace);
      setMemoryCount(entries.length);
    } catch {
      setMemoryCount(0);
    }
  }, [memoryAPI, memoryConfig?.namespace]);

  useEffect(() => { refreshMemoryCount(); }, [refreshMemoryCount]);

  const closeMemoryViewer = useCallback(() => {
    setMemoryViewer(current => ({ ...current, open: false }));
  }, []);

  const handleOpenMemory = useCallback(async () => {
    setMemoryViewer(current => ({ ...current, open: true, loading: true, busy: false, error: '' }));
    try {
      const entries = await memoryAPI.list(memoryConfig.namespace);
      setMemoryViewer({ open: true, loading: false, busy: false, entries, error: '' });
      setMemoryCount(entries.length);
    } catch (error) {
      setMemoryViewer({
        open: true,
        loading: false,
        busy: false,
        entries: [],
        error: error?.message || t('Memory konnte nicht geladen werden.'),
      });
    }
  }, [memoryAPI, memoryConfig?.namespace, t]);

  const handleDeleteMemoryEntry = useCallback(async (entry) => {
    if (!entry?.id || !window.confirm(t('Diesen Memory-Eintrag wirklich löschen?'))) return;
    setMemoryViewer(current => ({ ...current, busy: true, error: '' }));
    try {
      const result = await memoryAPI.delete(memoryConfig.namespace, entry.id);
      if (result?.deleted === false) throw new Error(t('Der Memory-Eintrag wurde nicht gefunden.'));
      const entries = await memoryAPI.list(memoryConfig.namespace);
      setMemoryViewer(current => ({ ...current, busy: false, entries, error: '' }));
      setMemoryCount(entries.length);
    } catch (error) {
      setMemoryViewer(current => ({
        ...current,
        busy: false,
        error: error?.message || t('Memory-Eintrag konnte nicht gelöscht werden.'),
      }));
    }
  }, [memoryAPI, memoryConfig?.namespace, t]);

  const handleCreateMemoryEntry = useCallback(async ({ content, type }) => {
    if (!content?.trim()) return false;
    setMemoryViewer(current => ({ ...current, busy: true, error: '' }));
    try {
      await memoryAPI.write(memoryConfig.namespace, createEntry({
        type: type || 'fact',
        namespace: memoryConfig.namespace,
        content: content.trim(),
        tags: ['manual'],
        author: 'user',
        confidence: 'high',
      }));
      const entries = await memoryAPI.list(memoryConfig.namespace);
      setMemoryViewer(current => ({ ...current, busy: false, entries, error: '' }));
      setMemoryCount(entries.length);
      return true;
    } catch (error) {
      setMemoryViewer(current => ({
        ...current,
        busy: false,
        error: error?.message || t('Memory-Eintrag konnte nicht gespeichert werden.'),
      }));
      return false;
    }
  }, [memoryAPI, memoryConfig?.namespace, t]);

  const handleClearMemory = useCallback(async () => {
    if (memoryViewer.entries.length === 0 || !window.confirm(t('Alle Einträge dieses Gruppen-Memorys wirklich löschen?'))) return;
    setMemoryViewer(current => ({ ...current, busy: true, error: '' }));
    try {
      await memoryAPI.clear(memoryConfig.namespace);
      setMemoryViewer(current => ({ ...current, busy: false, entries: [], error: '' }));
      setMemoryCount(0);
    } catch (error) {
      setMemoryViewer(current => ({
        ...current,
        open: true,
        loading: false,
        busy: false,
        error: error?.message || t('Memory konnte nicht gelöscht werden.'),
      }));
    }
  }, [memoryAPI, memoryConfig?.namespace, memoryViewer.entries.length, t]);

  const persistConversationCheckpoint = useCallback((state) => {
    const checkpoint = { version: 1, ...state, updatedAt: Date.now() };
    conversationContinuations.set(chat.id, checkpoint);
    saveConversationState(chat.id, checkpoint);
  }, [chat.id, saveConversationState]);

  const discardConversationCheckpoint = useCallback(() => {
    conversationContinuations.delete(chat.id);
    clearConversationState(chat.id);
  }, [chat.id, clearConversationState]);

  const commitTaskGraph = useCallback((updater) => {
    const current = taskGraphRef.current || createTaskGraph(chat.id, chat.name);
    const next = typeof updater === 'function' ? updater(current) : updater;
    taskGraphRef.current = next;
    saveTaskGraph(chat.id, next);
    return next;
  }, [chat.id, chat.name, saveTaskGraph]);

  const registerGraphTask = useCallback((task, { status = 'queued', parentNodeId = null } = {}) => {
    if (!task?.agent) return task;
    const graphNodeId = task.graphNodeId || task.handoff?.id || `graph-task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    task.graphNodeId = graphNodeId;
    const graphNode = {
      id: graphNodeId,
      title: summarizeTaskActivity({ objective: task.objective, source: task.source, handoff: task.handoff })
        .replace(/^(?:Arbeitet an|Bearbeitet die Übergabe):\s*/i, ''),
      objective: task.handoff?.summary || task.objective,
      agentId: task.agent.id,
      agentName: task.agent.name,
      status,
      source: task.source || 'user',
      nodeType: inferTaskNodeType({ source: task.source || 'user', parentNodeId }),
    };
    // Do not overwrite a persisted primary parent when an existing task is
    // restored without fresh hierarchy information.
    if (parentNodeId) graphNode.parentNodeId = parentNodeId;
    let nextGraph = upsertTaskNode(taskGraphRef.current || createTaskGraph(chat.id, chat.name), graphNode);
    if (parentNodeId) nextGraph = addTaskEdge(nextGraph, { from: parentNodeId, to: graphNodeId, kind: 'delegation' });
    commitTaskGraph(nextGraph);
    return task;
  }, [chat.id, chat.name, commitTaskGraph]);

  const setGraphTaskStatus = useCallback((task, status, extra = {}) => {
    if (!task?.graphNodeId) return;
    commitTaskGraph(graph => updateTaskNodeStatus(graph, task.graphNodeId, status, extra));
  }, [commitTaskGraph]);

  const reportAttachmentErrors = useCallback((errors = []) => {
    for (const error of errors) {
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `📎|${error.name ? `${error.name}: ` : ''}${error.message || t('Datei konnte nicht angehängt werden.')}`,
        ts: Date.now(), isError: true,
      });
    }
  }, [addMessage, chat.id, t]);

  const handlePickAttachments = useCallback(async () => {
    if (!window.electronAPI?.pickChatAttachments) {
      browserFileInputRef.current?.click();
      return;
    }
    try {
      const result = await window.electronAPI.pickChatAttachments(chat.id);
      const available = Math.max(0, 8 - pendingAttachmentsRef.current.length);
      const accepted = (result?.attachments || []).slice(0, available);
      const rejected = (result?.attachments || []).slice(available);
      for (const attachment of rejected) {
        window.electronAPI.deleteChatAttachment?.(attachment).catch(() => null);
      }
      const next = [...pendingAttachmentsRef.current, ...accepted];
      pendingAttachmentsRef.current = next;
      setPendingAttachments(next);
      reportAttachmentErrors([
        ...(result?.errors || []),
        ...(rejected.length ? [{ message: t('Pro Nachricht sind höchstens 8 Anhänge möglich.') }] : []),
      ]);
    } catch (error) {
      reportAttachmentErrors([{ message: error.message }]);
    } finally {
      window.requestAnimationFrame(focusComposer);
    }
  }, [chat.id, focusComposer, reportAttachmentErrors, t]);

  const handleBrowserAttachments = useCallback(async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = '';
    const available = Math.max(0, 8 - pendingAttachmentsRef.current.length);
    const errors = [];
    const accepted = [];
    let totalBytes = pendingAttachmentsRef.current.reduce((sum, attachment) => sum + (attachment.size || 0), 0);
    for (const file of files.slice(0, available)) {
      try {
        if (file.size > 25 * 1024 * 1024) throw new Error(t('Die Datei ist größer als 25 MB.'));
        if (totalBytes + file.size > 50 * 1024 * 1024) throw new Error(t('Die Anhänge überschreiten zusammen 50 MB.'));
        let kind = classifyBrowserFile(file);
        const attachment = {
          id: globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`,
          name: file.name,
          kind,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
        };
        if ((kind === 'markdown' || kind === 'text') && file.size <= 2 * 1024 * 1024) {
          attachment.content = await readBrowserFile(file, 'text');
          attachment.dataUrl = `data:${attachment.mimeType || 'text/plain'};charset=utf-8,${encodeURIComponent(attachment.content)}`;
        } else {
          attachment.dataUrl = await readBrowserFile(file);
          if (kind === 'markdown' || kind === 'text') attachment.kind = 'file';
        }
        accepted.push(attachment);
        totalBytes += file.size;
      } catch (error) {
        errors.push({ name: file.name, message: error.message });
      }
    }
    if (files.length > available) errors.push({ message: t('Pro Nachricht sind höchstens 8 Anhänge möglich.') });
    const next = [...pendingAttachmentsRef.current, ...accepted];
    pendingAttachmentsRef.current = next;
    setPendingAttachments(next);
    reportAttachmentErrors(errors);
    window.requestAnimationFrame(focusComposer);
  }, [focusComposer, reportAttachmentErrors, t]);

  const handleRemovePendingAttachment = useCallback((attachment) => {
    const next = pendingAttachmentsRef.current.filter(item => item.id !== attachment.id);
    pendingAttachmentsRef.current = next;
    setPendingAttachments(next);
    if (attachment?.path && window.electronAPI?.deleteChatAttachment) {
      window.electronAPI.deleteChatAttachment(attachment).catch(() => null);
    }
    window.requestAnimationFrame(focusComposer);
  }, [focusComposer]);

  const sendUserMessage = useCallback(async (text, attachments = [], qualityMode = 'auto') => {
    const normalizedText = String(text || '').trim();
    if (!normalizedText && !attachments.length) return null;

    const memoryCommands = chat.type === 'group' ? extractMemoryCommands(normalizedText) : [];
    const onlyMemoryCommands = attachments.length === 0 && chat.type === 'group'
      && isMemoryCommandOnly(normalizedText);

    const msg = {
      id: Date.now() + Math.random(),
      agentId: 'user',
      senderName: t('Du'),
      text: normalizedText,
      ts: Date.now(),
      memoryOnly: onlyMemoryCommands,
      qualityMode,
      ...(attachments.length ? { attachments } : {}),
    };
    addMessage(chat.id, msg);

    // Only explicit commands such as #fact or #decision are persisted. Normal
    // headings/hashtags remain ordinary chat content.
    let memorySaved = !onlyMemoryCommands;
    if (memoryAPI && memoryCommands.length > 0) {
      try {
        for (const command of memoryCommands) {
          const requestedType = command.tags.find(tag => ['fact', 'decision', 'constraint', 'finding', 'task_state'].includes(tag));
          await memoryAPI.write(memoryConfig.namespace, createEntry({
            type: requestedType || 'fact', namespace: memoryConfig.namespace, content: command.text, tags: command.tags, author: 'user', confidence: 'high',
          }));
        }
        memorySaved = true;
        await refreshMemoryCount();
      } catch (error) {
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `Memory|${error.message}`, ts: Date.now(), isError: true,
        });
      }
    }

    return { ...msg, memorySaved };
  }, [chat.id, chat.type, addMessage, memoryAPI, memoryConfig?.namespace, refreshMemoryCount, t]);

  const runAgents = useCallback(async (history, triggerText) => {
    // Validate keys
    const neededProviders = new Set(chatAgents.map(a => a.provider || 'openai'));
    const missingProviders = [...neededProviders].filter(p => {
      if (p === 'codex') return false;
      if (p === 'anthropic') return (
        !apiKeys?.anthropic?.trim() &&
        !apiKeys?.anthropicConfigured &&
        !apiKeys?.claudeCli &&
        !(typeof process !== 'undefined' && process.env?.ANTHROPIC_API_KEY)
      );
      if (p === 'openai') return (
        !apiKeys?.openai?.trim() &&
        !apiKeys?.openaiConfigured &&
        !(typeof process !== 'undefined' && process.env?.OPENAI_API_KEY)
      );
      const connection = providerConnections.find(item => item.id === p);
      if (!connection) return true;
      return connection.requiresApiKey !== false && !apiKeys?.providerConfigured?.[p];
    });

    if (missingProviders.length === neededProviders.size) {
      addMessage(chat.id, {
        id: Date.now(), agentId: 'system', senderName: 'System',
        text: `⚠️|${t('Kein API-Key konfiguriert. Bitte in ⚙️ Einstellungen eintragen.')}`,
        ts: Date.now(), isError: true,
      });
      return;
    }

    if (chatAgents.length === 0) return;

    const savedContinuation = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || null;
    const latestUserMessage = [...(history || [])].reverse().find(message => message?.agentId === 'user');
    const latestUserAttachments = latestUserMessage?.attachments || [];
    const activeQualityMode = triggerText
      ? (latestUserMessage?.qualityMode || 'auto')
      : (savedContinuation?.qualityMode || latestUserMessage?.qualityMode || 'auto');
    const attachmentKeys = new Set();
    const activeAttachments = [...latestUserAttachments, ...(savedContinuation?.attachments || [])]
      .filter(attachment => {
        const key = attachment?.id || attachment?.path || attachment?.name;
        if (!key || attachmentKeys.has(key)) return false;
        attachmentKeys.add(key);
        return true;
      })
      .slice(0, 8);
    const persistRunCheckpoint = state => persistConversationCheckpoint({
      ...state,
      attachments: activeAttachments,
      qualityMode: activeQualityMode,
    });
    if (savedContinuation?.status === 'provider-limited' && savedContinuation.retryNotBefore > Date.now()) {
      const retrySeconds = Math.max(1, Math.ceil((savedContinuation.retryNotBefore - Date.now()) / 1000));
      if (triggerText && savedContinuation.pendingTasks?.length) {
        const pendingTasks = savedContinuation.pendingTasks.map((pendingTask, index) => index === 0
          ? {
            ...pendingTask,
            objective: `${pendingTask.objective || 'Setze die offene Aufgabe fort.'}\n\nZusätzliche Nachricht des Users: ${triggerText}`,
          }
          : pendingTask);
        persistRunCheckpoint({ ...savedContinuation, pendingTasks });
      }
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `⏳|${t('Claude ist noch begrenzt. Deine Nachricht wurde gespeichert; Fortsetzen ist in etwa {seconds}s möglich.', { seconds: retrySeconds })}`,
        ts: Date.now(), isError: false,
      });
      return;
    }

    setLastRunContext({ history, triggerText });
    setStoppedForUser(false);
    setRunning(true);

    // Cancel token: if a new run starts, the old one aborts after its current LLM call
    runIdRef.current += 1;
    const myRunId = runIdRef.current;

    // PM orchestration is a group-only concern. In direct chats even the PM
    // agent behaves like a normal one-to-one conversation partner.
    const isDirectChat = chat.type !== 'group';
    const pm = getGroupPMAgent(chat.type, chatAgents);

    // Helper: all explicitly mentioned group agents. The queue de-duplicates
    // them, so the orchestrator can activate exactly the needed specialists.
    const getMentionedAgents = (text) => {
      if (!text) return [];
      return chatAgents.filter(agent => hasDirectedMention(text, agent.name));
    };

    // KB search + Shared Memory retrieval
    let kbContext = '';
    if (kbPath && triggerText && window.electronAPI?.kbSearch) {
      const kbResult = await window.electronAPI.kbSearch({ query: triggerText, kbPath, maxResults: 3 });
      if (kbResult?.results?.length > 0) {
        kbContext = '\n\n[Wissensbasis-Kontext]:\n' +
          kbResult.results.map(r => `**${r.title}**:\n${r.snippet}`).join('\n\n---\n');
      }
    }

    let projectContext = '';
    if (projectPath && window.electronAPI?.projectList) {
      const projectResult = await window.electronAPI.projectList({ projectPath });
      if (projectResult?.files?.length) {
        projectContext = '\n\n[Vorhandene Projektdateien]:\n' +
          projectResult.files.slice(0, 100).map(file => `- ${file.name}`).join('\n');
      } else {
        projectContext = '\n\n[Projektordner ist derzeit leer.]';
      }
    }

    // Load shared memory for this group (lazy — only top-N relevant entries)
    const memoryNamespace = memoryEnabled ? memoryConfig.namespace : null;
    const memAPI = memoryEnabled ? memoryAPI : null;

    // ── Chain-conversation engine ──────────────────────────────────────────
    const isEveryoneCall = hasDirectedMention(triggerText || '', 'everyone');
    let pendingAgents = [];

    const explicitMentions = chatAgents.filter(agent =>
      hasDirectedMention(triggerText || '', agent.name)
    );
    const route = chat.type === 'group'
      ? orchestrate({ request: triggerText || '', chatAgents, isEveryone: isEveryoneCall, explicitMentions })
      : { agents: chatAgents.slice(0, 1), mode: 'direct-chat' };
    pendingAgents = route.agents;

    if (chat.type === 'group' && !isEveryoneCall && explicitMentions.length === 0 && pm) {
        // No mention → PM responds (but only if PM hasn't responded since last user message)
        const lastUserMsgIdx = [...history].reverse().findIndex(m => m.agentId === 'user');
        const msgsSinceUser = lastUserMsgIdx >= 0 ? history.slice(history.length - lastUserMsgIdx) : [];
        const pmAlreadyResponded = msgsSinceUser.some(m => m.agentId === pm.id);
        if (!pmAlreadyResponded) {
          pendingAgents = [pm];
        }
        // If PM already responded, check if there's a pending agent from last PM message
        else {
          const lastPMMsg = [...msgsSinceUser].reverse().find(m => m.agentId === pm.id);
          if (lastPMMsg?.text) {
            const pendingFromPM = getMentionedAgents(lastPMMsg.text).filter(a => {
              // Only trigger agents that haven't responded since last user message
              return !msgsSinceUser.some(m => m.agentId === a.id);
            });
          if (pendingFromPM.length) pendingAgents = pendingFromPM;
        }
    }
    }

    const initialObjective = savedContinuation?.initialObjective || triggerText ||
      [...history].reverse().find(message => message.agentId === 'user')?.text ||
      'Bearbeite die aktuelle Aufgabe.';
    const initialRunComplexity = assessTaskComplexity({
      objective: initialObjective,
      attachmentCount: activeAttachments.length,
    });
    const useLeanFastPath = chat.type === 'group' &&
      activeQualityMode === 'fast' &&
      initialRunComplexity.level === 'low' &&
      activeAttachments.length === 0 &&
      !projectPath &&
      activeMcpServers.length === 0 &&
      pendingAgents.length <= 1;
    const taskQueue = new AgentTaskQueue({
      maxTurns: conversationLimits.maxTurns,
      maxTurnsPerAgent: conversationLimits.maxTurnsPerAgent,
      guardState: savedContinuation?.queueGuard,
    });
    const requestedParallelTaskIds = new Set(savedContinuation?.parallelTaskIds || []);
    let needsSynthesis = savedContinuation?.needsSynthesis || false;
    let synthesisCount = savedContinuation?.synthesisCount || 0;
    const delegatedResults = [...(savedContinuation?.delegatedResults || [])];
    const loopGuardRejections = [];
    let activePlanRootNodeId = savedContinuation?.planRootGraphNodeId || null;

    if (savedContinuation) {
      const restoreTask = (pendingTask) => {
        const restoredAgent = chatAgents.find(candidate =>
          candidate.id === pendingTask?.agent?.id || candidate.name === pendingTask?.agent?.name
        );
        return restoredAgent ? { ...pendingTask, agent: restoredAgent } : null;
      };
      const restoredPendingTasks = orderTasksForParallelSelection((savedContinuation.pendingTasks || [])
        .map(restoreTask)
        .filter(Boolean), requestedParallelTaskIds);
      const awaitsUserAnswer = savedContinuation.status === 'awaiting-user' ||
        (!savedContinuation.status && savedContinuation.askingAgent);

      if (awaitsUserAnswer) {
        if (!triggerText) {
          setStoppedForUser(true);
          setRunning(false);
          return;
        }
        const restoredAskingAgent = chatAgents.find(candidate =>
          candidate.id === savedContinuation.askingAgent?.id || candidate.name === savedContinuation.askingAgent?.name
        );
        if (restoredAskingAgent) {
          const answerTask = buildUserAnswerTask({
            askingAgent: restoredAskingAgent,
            question: savedContinuation.question,
            answer: triggerText,
          });
          registerGraphTask(answerTask, {
            status: 'queued',
            parentNodeId: savedContinuation.askingGraphNodeId || null,
          });
          taskQueue.enqueue(answerTask);
          if (savedContinuation.askingGraphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(
              graph,
              savedContinuation.askingGraphNodeId,
              'agent_done',
              { answeredAt: Date.now() },
            ));
          }
        }
      } else if (triggerText && restoredPendingTasks.length > 0) {
        restoredPendingTasks[0] = {
          ...restoredPendingTasks[0],
          objective: `${restoredPendingTasks[0].objective || 'Setze die offene Aufgabe fort.'}\n\nZusätzliche Nachricht des Users beim Fortsetzen: ${triggerText}`,
        };
      }
      for (const pendingTask of restoredPendingTasks) {
        registerGraphTask(pendingTask, { status: pendingTask.graphNodeId ? undefined : 'queued' });
        taskQueue.enqueue(pendingTask);
      }
    } else {
      for (const agent of pendingAgents) {
        const initialTask = registerGraphTask({ agent, objective: initialObjective, source: 'user' }, { status: 'queued' });
        taskQueue.enqueue(initialTask);
      }
    }

    if (chat.type === 'group' && autoRunRef.current && requestedParallelTaskIds.size === 0) {
      const safeParallelIds = findSafeAutoParallelTaskIds(taskGraphRef.current, taskQueue.pendingTasks());
      safeParallelIds.forEach(nodeId => requestedParallelTaskIds.add(nodeId));
      taskQueue.prioritize(safeParallelIds);
    }

    let task;
    let successfulTasks = savedContinuation?.successfulTasks || 0;
    let projectCompleted = false;
    let resumableFailure = false;

    const executeAgentTask = async (task) => {
      if (runIdRef.current !== myRunId) {
        return null;
      }

      const { agent } = task;
      registerGraphTask(task, { status: 'running' });
      setGraphTaskStatus(task, 'running', { startedAt: Date.now() });
      const activeHandoff = task.handoff || null;
      const objective = activeHandoff?.summary || task.objective || initialObjective;
      let pauseRequested = false;
      let pauseQuestion = '';
      let scheduleDecisionRequested = false;
      let providerPauseRequested = false;
      let providerRetryAfterMs = 0;
      const isOrchestrator = chat.type === 'group' && agent.id === pm?.id;
      const taskComplexity = assessTaskComplexity({
        objective,
        source: task.source,
        attachmentCount: activeAttachments.length,
        recovery: task.source === 'timeout-recovery' || task.source === 'timeout-recovery-step',
      });
      const qualityPolicy = resolveQualityPolicy({
        globalConfig: qualityRouting,
        groupConfig: chat.qualityRouting,
        agentConfig: agent.qualityRouting,
        messageMode: activeQualityMode,
        complexity: taskComplexity,
        agent,
        providerModelsById: Object.fromEntries(providerConnections.map(connection => [connection.id, connection.models || []])),
      });
      let selectedModelAgent = qualityPolicy.directStrong ? qualityPolicy.escalationAgent : agent;
      const agentRequestId = `${chat.id}-${agent.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const taskSummary = summarizeTaskActivity({ objective, source: task.source, handoff: activeHandoff });
      const activeAgentRun = {
        requestId: agentRequestId,
        agentId: agent.id,
        agentName: agent.name,
        provider: selectedModelAgent.provider || 'openai',
        runtime: selectedModelAgent.provider === 'anthropic' && !apiKeys?.anthropic?.trim() && !apiKeys?.anthropicConfigured && apiKeys?.claudeCli
          ? 'claude'
          : (selectedModelAgent.provider || 'openai'),
        graphNodeId: task.graphNodeId,
        taskSummary,
        startedAt: Date.now(),
      };
      activeAgentRunRef.current.set(agentRequestId, activeAgentRun);
      setAgentProgress(previous => ({ ...previous, [agent.id]: {
        agentId: agent.id,
        taskSummary,
        detail: selectedModelAgent.provider === 'codex'
          ? 'Bereitet die Arbeitsumgebung für diesen Task vor.'
          : qualityPolicy.directStrong
            ? 'Bearbeitet die Aufgabe direkt mit der stärkeren Modellstufe.'
            : 'Bearbeitet die Aufgabe und formuliert das konkrete Ergebnis.',
        phase: 'working',
        startedAt: activeAgentRun.startedAt,
        updatedAt: Date.now(),
      }}));
      setTypingAgents(prev => [...prev, agent.id]);
      if (runIdRef.current !== myRunId) return;

      try {
        const memoryContext = memAPI ? await memAPI.getContextForAgent(
          memoryNamespace, objective || agent.name, agent.name, 5
        ) : '';
        let isolatedSystemPrompt = buildIsolatedSystemPrompt({
          agent,
          groupName: chat.name,
          groupAgentNames: chatAgents.map(a => a.name),
          groupAgents: chatAgents,
          memoryNamespace,
          projectPath,
          isOrchestrator,
          isDirectChat,
        });
        if (qualityPolicy.acceptanceCriteria) {
          isolatedSystemPrompt += `\n\nZusätzliche Akzeptanzkriterien für diesen Agenten:\n${qualityPolicy.acceptanceCriteria}`;
        }
        const currentPlanNodes = activePlanRootNodeId
          ? (taskGraphRef.current?.nodes || [])
            .filter(node => node.planRootId === activePlanRootNodeId)
            .sort((left, right) => (left.planOrder || 0) - (right.planOrder || 0))
          : [];
        const currentPlanContext = currentPlanNodes.length
          ? `Aktueller PM-Plan:\n${currentPlanNodes.map(node =>
            `- ${node.planTaskId}: ${node.title} | Agent: ${node.agentName} | Status: ${node.status}`
          ).join('\n')}`
          : '';
        const taskCapsule = buildTaskCapsule({
          agentName: agent.name,
          agentRole: agent.role || 'Agent',
          objective,
          constraints: [
            ...(isDirectChat ? [
              'Dies ist ein Einzelchat: Antworte direkt selbst auf die User-Anfrage.',
              'Keine PM-Planung, keine Agenten-Handoffs und keine Abschlussprüfung durch einen anderen Agenten.',
            ] : [
              'Keinen vollständigen Gruppenverlauf anfordern.',
              'Nur die zugewiesene Aufgabe bearbeiten.',
              'Weitere Arbeit mit einer klaren @Name-Aufgabe übergeben.',
            ]),
            ...(isOrchestrator && task.source === 'user' && !useLeanFastPath ? [
              'Erstelle vor den Handoffs jetzt den vollständigen initialen [[TASK_PLAN]] einschließlich aller absehbaren Aufgaben, Abhängigkeiten und der finalen PM-Abnahme.',
            ] : []),
            ...(isOrchestrator && task.source === 'user' && useLeanFastPath ? [
              'Schnellmodus für eine einfache Aufgabe: Halte die Koordination minimal und delegiere höchstens an einen Spezialisten.',
              'Ein TASK_PLAN ist für diesen Lauf nicht erforderlich.',
            ] : []),
            ...(isOrchestrator && task.source === 'team-synthesis' && currentPlanContext ? [
              'Nutze den aktuellen PM-Plan: Delegiere nur startbereite offene Aufgaben. Schließe nicht ab, solange geplante Fachaufgaben offen sind.',
            ] : []),
            ...(task.source === 'timeout-recovery' ? [
              `Dies ist eine Timeout-Recovery für ${task.recovery?.originalAgentName || 'den ursprünglichen Agenten'}.`,
              `Untersuche die zu große oder festgefahrene Aufgabe und delegiere höchstens EINEN deutlich kleineren, konkret prüfbaren Schritt an @${task.recovery?.originalAgentName || 'den ursprünglichen Agenten'}.`,
              'Delegiere während der Recovery nicht mehrere Schritte gleichzeitig und verwende noch kein [[PROJECT_DONE]].',
              'Wenn der letzte Teilschritt die festgefahrene Aufgabe vollständig löst, antworte ohne Agenten-Handoff; danach läuft die normale Konversation weiter.',
            ] : []),
            ...(task.source === 'timeout-recovery-step' ? [
              'Dies ist ein verkleinerter Recovery-Teilschritt. Bearbeite ausschließlich diesen Schritt und erweitere seinen Umfang nicht.',
              'Dein Ergebnis wird danach sofort vom PM geprüft.',
            ] : []),
            ...(isOrchestrator && task.source === 'turn-limit-review' ? [
              'Dies ist die einmalige PM-Prüfung am Ende eines begrenzten Laufsegments.',
              'Wenn die User-Anforderung vollständig erfüllt ist, gib den finalen Abschluss mit [[PROJECT_DONE]].',
              'Wenn Arbeit offen ist, übergib höchstens EINEN priorisierten, kleinen und konkret prüfbaren nächsten Schritt.',
              'Erstelle keinen neuen Gesamtplan und wiederhole keine bereits erledigte Aufgabe.',
            ] : []),
          ],
          context: [
            kbContext ? 'Relevante Wissensbasis-Auszüge stehen im Systemkontext.' : '',
            memoryContext ? `Relevantes Shared Memory: memory://${memoryNamespace}` : '',
            projectPath ? `Projektdateien müssen in ${projectPath} als vollständige file:-Artefakte geliefert werden.` : '',
            !isDirectChat ? currentPlanContext : '',
          ].filter(Boolean),
          handoff: activeHandoff,
          requestedOutput: isDirectChat
            ? ['Direkte Antwort an den User', 'Offene Rückfrage, falls wirklich nötig']
            : ['Konkretes Ergebnis', 'Offene Fragen oder nächster Handoff, falls nötig'],
        });
        const agentSession = buildAgentSession({
          agent, taskCapsule, memoryContext, handoff: activeHandoff,
          lastUserMessage: (isOrchestrator || isDirectChat) && task.source === 'user' ? objective : '',
        });
        const isolatedSession = { ...agentSession, systemPrompt: isolatedSystemPrompt };
        const capsuleHistory = agentSession.messages.map((message, index) => ({
          id: `${agentSession.sessionId}-${index}`,
          agentId: message.role === 'assistant' ? agent.id : 'user',
          senderName: message.role === 'assistant' ? agent.name : 'Task Capsule',
          text: message.content,
          ts: Date.now(),
        }));
        const relevantConversationHistory = buildRelevantConversationHistory({
          history,
          agent,
          chatType: chat.type,
          includeGroupContext: !isDirectChat && task.source === 'user',
        });
        const agentHistory = isDirectChat && relevantConversationHistory.length > 0
          ? [...relevantConversationHistory]
          : relevantConversationHistory.length > 0
            ? [...relevantConversationHistory, ...capsuleHistory.slice(-1)]
            : capsuleHistory;
        if (activeAttachments.length > 0) {
          let attachmentMessageIndex = -1;
          for (let index = agentHistory.length - 1; index >= 0; index -= 1) {
            if (agentHistory[index].agentId === 'user') { attachmentMessageIndex = index; break; }
          }
          if (attachmentMessageIndex >= 0) {
            agentHistory[attachmentMessageIndex] = {
              ...agentHistory[attachmentMessageIndex],
              attachments: activeAttachments,
            };
          }
        }

        let usedMcp = false;
        const callWithModel = (modelAgent, modelHistory) => callLLMWithMcp({
          servers: activeMcpServers,
          history: modelHistory,
          agent: modelAgent,
          requestPermission: requestMcpPermission,
          onPermissionConsumed: handleMcpPermissionConsumed,
          onToolResult: handleMcpToolResult,
          onConnectionError: error => {
            const key = `${error?.serverId || error?.serverName}:${error?.message}`;
            if (reportedMcpErrorsRef.current.has(key)) return;
            reportedMcpErrorsRef.current.add(key);
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `MCP|${t('Verbindung zu „{server}“ fehlgeschlagen: {error}', {
                server: error?.serverName || 'MCP',
                error: error?.message || t('Unbekannter Fehler'),
              })}`,
              ts: Date.now(), isError: true,
            });
          },
          call: ({ history: nextHistory, extraContext }) => callLLM({
            apiKeys, providerConnections, agent: modelAgent,
            history: nextHistory,
            userMessage: null,
            groupContext: isOrchestrator ? chatAgents.map(a => a.name).join(', ') : null,
            kbContext: kbContext + memoryContext + projectContext + extraContext,
            isolatedSession,
            projectPath,
            requestId: agentRequestId,
          }),
          callRecovery: ({ history: nextHistory }) => callLLM({
            apiKeys, providerConnections,
            agent: createMcpPlannerAgent(modelAgent),
            history: nextHistory,
            userMessage: null,
            groupContext: null,
            kbContext: '',
            isolatedSession: {
              systemPrompt: 'Du bist ein reiner JSON-Datengenerator. Verwende keine Werkzeuge. Antworte ausschließlich mit genau einem gültigen JSON-Objekt, ohne Markdown, Erklärung oder Rückfrage.',
            },
            projectPath,
            requestId: agentRequestId,
          }),
          onActivity: ({ serverName, toolName }) => {
            usedMcp = true;
            setAgentProgress(previous => ({ ...previous, [agent.id]: {
              ...(previous[agent.id] || {}),
              agentId: agent.id,
              taskSummary,
              detail: `MCP: ${serverName} · ${toolName}`,
              phase: 'tool',
              startedAt: previous[agent.id]?.startedAt || activeAgentRun.startedAt,
              updatedAt: Date.now(),
            }}));
          },
        });

        let estimatedInputTokens = estimateTokens(isolatedSystemPrompt) + estimateTokens(agentHistory.map(message => message.text).join('\n'));
        let reply = await callWithModel(selectedModelAgent, agentHistory);
        if (runIdRef.current !== myRunId) return;
        if (!reply || typeof reply !== 'string' || !reply.trim()) {
          throw new Error('Der Agent hat keine verwertbare Antwort geliefert.');
        }
        let estimatedOutputTokens = estimateTokens(reply);

        const assessCandidate = candidateReply => {
          const normalized = normalizeAgentMentionLayout(candidateReply, agent, chatAgents);
          const candidatePlan = isOrchestrator && !(useLeanFastPath && task.source === 'user')
            ? extractTaskPlan(normalized)
            : null;
          const candidateFiles = extractProjectFiles(normalized);
          return {
            normalized,
            evaluation: evaluateResponseQuality({
              reply: normalized,
              objective,
              complexity: taskComplexity,
              isOrchestrator,
              requiresInitialPlan: isOrchestrator && task.source === 'user' && !useLeanFastPath,
              parsedTaskPlan: candidatePlan,
              projectFiles: candidateFiles,
              projectPath,
              usedMcp,
            }),
          };
        };

        let qualityResult = assessCandidate(reply);
        let qualityOutcome = qualityPolicy.directStrong ? 'direct-strong' : 'baseline-accepted';
        let escalationFailed = false;
        let didEscalate = false;
        if (
          !qualityPolicy.directStrong &&
          qualityPolicy.enabled &&
          qualityPolicy.maxEscalations > 0 &&
          !qualityResult.evaluation.accepted &&
          !usedMcp
        ) {
          didEscalate = true;
          const escalationAgent = qualityPolicy.escalationAgent;
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🧠|${t('{agent}: Die Qualitätsprüfung fordert eine stärkere Modellstufe ({from} → {to}).', {
              agent: agent.name,
              from: selectedModelAgent.model,
              to: escalationAgent.model,
            })}`,
            ts: Date.now(), isError: false,
          });
          setAgentProgress(previous => ({ ...previous, [agent.id]: {
            ...(previous[agent.id] || {}),
            detail: t('Verbessert das Ergebnis mit der stärkeren Modellstufe.'),
            phase: 'quality-escalation',
            updatedAt: Date.now(),
          }}));
          selectedModelAgent = escalationAgent;
          activeAgentRun.provider = selectedModelAgent.provider || 'openai';
          activeAgentRun.runtime = selectedModelAgent.provider === 'anthropic' && !apiKeys?.anthropic?.trim() && !apiKeys?.anthropicConfigured && apiKeys?.claudeCli
            ? 'claude'
            : (selectedModelAgent.provider || 'openai');
          activeAgentRunRef.current.set(agentRequestId, activeAgentRun);
          const escalationHistory = buildEscalationHistory(agentHistory, {
            previousReply: reply,
            reasons: qualityResult.evaluation.reasons,
            acceptanceCriteria: qualityPolicy.acceptanceCriteria,
          });
          estimatedInputTokens += estimateTokens(isolatedSystemPrompt) + estimateTokens(escalationHistory.map(message => message.text).join('\n'));
          try {
            reply = await callWithModel(selectedModelAgent, escalationHistory);
            if (runIdRef.current !== myRunId) return;
            if (!reply || typeof reply !== 'string' || !reply.trim()) throw new Error(t('Leere Antwort der stärkeren Modellstufe.'));
            estimatedOutputTokens += estimateTokens(reply);
            qualityResult = assessCandidate(reply);
            qualityOutcome = 'escalated';
          } catch (qualityError) {
            escalationFailed = true;
            selectedModelAgent = agent;
            reply = qualityResult.normalized;
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `⚠️|${t('{agent}: Die stärkere Modellstufe war nicht verfügbar. Das erste Ergebnis wird beibehalten: {error}', {
                agent: agent.name,
                error: qualityError?.message || t('unbekannter Fehler'),
              })}`,
              ts: Date.now(), isError: false,
            });
          }
        }

        const qualityUnresolved = qualityPolicy.enabled && (
          escalationFailed || !qualityResult.evaluation.accepted
        );
        recordQualityEvent({
          outcome: qualityOutcome,
          unresolved: qualityUnresolved,
          estimatedInputTokens,
          estimatedOutputTokens,
        });
        if (qualityUnresolved && didEscalate && !escalationFailed) {
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `⚠️|${t('{agent}: Auch die stärkere Modellstufe erfüllt nicht alle automatisch prüfbaren Kriterien. Das Ergebnis wird ohne weitere Eskalation weitergegeben.', { agent: agent.name })}`,
            ts: Date.now(), isError: false,
          });
        }

        let rawReply = normalizeAgentMentionLayout(reply, agent, chatAgents);
        const parsedTaskPlan = isOrchestrator && !(useLeanFastPath && task.source === 'user')
          ? extractTaskPlan(rawReply)
          : null;
        let normalizedPlanTasks = [];
        if (parsedTaskPlan?.tasks?.length) {
          const currentGraphNode = taskGraphRef.current?.nodes?.find(node => node.id === task.graphNodeId);
          const planRootNodeId = activePlanRootNodeId || currentGraphNode?.planRootId || task.graphNodeId;
          const distributedPlanTasks = distributeTaskPlanAcrossAgentPools(parsedTaskPlan.tasks, chatAgents);
          normalizedPlanTasks = distributedPlanTasks.map(planTask => {
            const plannedAgent = chatAgents.find(candidate =>
              candidate.name.toLowerCase() === planTask.agent.toLowerCase()
            );
            return plannedAgent ? {
              ...planTask,
              agentId: plannedAgent.id,
              agentName: plannedAgent.name,
            } : null;
          }).filter(Boolean);
          if (normalizedPlanTasks.length) {
            activePlanRootNodeId = planRootNodeId;
            commitTaskGraph(graph => materializeTaskPlan(graph, {
              rootNodeId: planRootNodeId,
              tasks: normalizedPlanTasks,
            }));
            openTaskGraphWindow();
          }
        }
        rawReply = rewritePlanHandoffAssignments(rawReply, normalizedPlanTasks);
        const projectFiles = extractProjectFiles(rawReply);
        const savedProjectFiles = [];
        if (projectPath && window.electronAPI?.projectWrite) {
          for (const file of projectFiles) {
            const writeResult = await window.electronAPI.projectWrite({
              projectPath,
              filename: file.filename,
              content: file.content,
            });
            if (writeResult?.success) {
              savedProjectFiles.push(writeResult.relativePath || file.filename);
            } else {
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `📁|${t('{agent}: {file} konnte nicht gespeichert werden — {error}', {
                  agent: agent.name,
                  file: file.filename,
                  error: writeResult?.error || t('unbekannter Fehler'),
                })}`,
                ts: Date.now(), isError: true,
              });
            }
          }
        }

        const displayReply = cleanAgentReply(rawReply) ||
          (savedProjectFiles.length
            ? t('Dateien gespeichert: {files}', { files: savedProjectFiles.join(', ') })
            : t('Aufgabe abgeschlossen.'));
        const reviewEvidence = buildProjectReviewEvidence({
          displayReply,
          projectFiles,
          savedProjectFiles,
        });
        if (projectPath && window.electronAPI?.projectWrite) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const safeAgentName = agent.name.replace(/[^a-zA-Z0-9_-]/g, '-');
          const progressPath = `.agent-teams/progress/${timestamp}-${safeAgentName}-${agentSession.sessionId}.md`;
          const progressContent = [
            `# ${t('Zwischenstand: {agent}', { agent: agent.name })}`,
            '',
            `- ${t('Session: {session}', { session: agentSession.sessionId })}`,
            `- ${t('Aufgabe: {task}', { task: objective })}`,
            `- ${t('Zeitpunkt: {time}', { time: new Date().toISOString() })}`,
            savedProjectFiles.length
              ? `- ${t('Geschriebene Dateien: {files}', { files: savedProjectFiles.join(', ') })}`
              : `- ${t('Geschriebene Dateien: keine expliziten Datei-Artefakte')}`,
            '',
            `## ${t('Ergebnis')}`,
            '',
            displayReply.slice(0, 100000),
            '',
          ].join('\n');
          const progressResult = await window.electronAPI.projectWrite({
            projectPath, filename: progressPath, content: progressContent,
          });
          if (!progressResult?.success) {
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `📁|${t('Zwischenstand konnte nicht gespeichert werden — {error}', { error: progressResult?.error || t('unbekannter Fehler') })}`,
              ts: Date.now(), isError: true,
            });
          }
        }
        if (savedProjectFiles.length) {
          projectContext += '\n' + savedProjectFiles.map(filename => `- ${filename}`).join('\n');
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `📁|${t(
              savedProjectFiles.length === 1
                ? '{agent} hat {count} Datei gespeichert: {files}'
                : '{agent} hat {count} Dateien gespeichert: {files}',
              { agent: agent.name, count: savedProjectFiles.length, files: savedProjectFiles.join(', ') },
            )}`,
            ts: Date.now(), isError: false,
          });
        }

        const agentMsg = {
          id: Date.now() + Math.random(),
          agentId: agent.id, senderName: agent.name,
          text: displayReply, ts: Date.now(),
          provider: selectedModelAgent.provider,
          model: selectedModelAgent.model,
        };
        addMessage(chat.id, agentMsg);
        history = [...history, agentMsg];
        successfulTasks += 1;
        taskQueue.markSuccessful(task);
        setGraphTaskStatus(task, 'agent_done', { completedAt: Date.now() });

        const knowledgeEntries = extractKnowledgeFromReply(displayReply, agent.id, agent.name);
        if (memAPI && knowledgeEntries.length > 0) {
          for (const entry of knowledgeEntries) {
            const requestedType = entry.tags.find(tag => ['fact', 'decision', 'constraint', 'finding', 'task_state'].includes(tag));
            await memAPI.write(memoryNamespace, createEntry({
              type: requestedType || 'finding', namespace: memoryNamespace, content: entry.text,
              tags: entry.tags, author: agent.name, confidence: 'medium',
            }));
          }
          await refreshMemoryCount();
        }

        const handoffs = extractHandoffsFromReply(rawReply, agent, chatAgents);
        const asksUser = hasDirectedMention(rawReply, 'user');
        const immediateHandoffTasks = [];
        const claimedPlanNodeIds = new Set();
        const canDrivePlan = isOrchestrator &&
          activePlanRootNodeId &&
          ['user', 'team-synthesis', 'turn-limit-review'].includes(task.source);
        const findPlannedNode = (target, summary) => {
          if (!canDrivePlan) return null;
          const newPlanIds = new Set(normalizedPlanTasks.map(planTask => planTask.id));
          const candidates = (taskGraphRef.current?.nodes || [])
            .filter(node =>
              node.planRootId === activePlanRootNodeId &&
              node.agentId === target.id &&
              node.nodeType !== 'review' &&
              CLAIMABLE_PLAN_STATUSES.has(node.status) &&
              !claimedPlanNodeIds.has(node.id)
            )
            .map(node => ({
              node,
              score: planTaskMatchScore(node, summary),
              ready: isTaskNodeReady(taskGraphRef.current, node.id),
              isNew: newPlanIds.has(node.planTaskId),
            }))
            .sort((left, right) =>
              right.score - left.score ||
              Number(right.isNew) - Number(left.isNew) ||
              Number(right.ready) - Number(left.ready) ||
              (left.node.planOrder || 0) - (right.node.planOrder || 0)
            );
          const best = candidates[0];
          return best && (best.score > 0 || best.isNew) ? best.node : null;
        };

        for (const handoff of handoffs) {
          const target = chatAgents.find(candidate => candidate.name.toLowerCase() === handoff.to.toLowerCase());
          if (!target || target.id === agent.id) continue;
          if (memAPI) await memAPI.handoff(handoff);
          if (shouldDeferHandoffToPM({ fromAgent: agent, targetAgent: target, pm })) {
            needsSynthesis = true;
            continue;
          }
          const isRecoveryDelegation = task.source === 'timeout-recovery' &&
            task.recovery &&
            agent.id === pm?.id &&
            target.id === task.recovery.originalAgentId;
          const recovery = isRecoveryDelegation
            ? {
              ...task.recovery,
              attempt: task.recovery.mode === 'review'
                ? (task.recovery.attempt || 0) + 1
                : task.recovery.attempt,
              mode: 'step',
              currentStep: handoff.summary,
            }
            : null;
          const plannedNode = findPlannedNode(target, handoff.summary);
          if (plannedNode) {
            claimedPlanNodeIds.add(plannedNode.id);
            // Future plan steps are visible in the tree but must not enter the
            // executable queue before all of their dependencies are complete.
            if (!isTaskNodeReady(taskGraphRef.current, plannedNode.id)) continue;
          }
          const dependencyNodeId = plannedNode
            ? null
            : inferHandoffDependency(handoff.summary, immediateHandoffTasks);
          const nextTask = registerGraphTask({
            agent: target,
            objective: handoff.summary,
            handoff,
            source: recovery ? 'timeout-recovery-step' : agent.name,
            ...(plannedNode ? {
              graphNodeId: plannedNode.id,
              planRootId: activePlanRootNodeId,
              planTaskId: plannedNode.planTaskId,
            } : {}),
            ...(recovery ? { recovery } : {}),
          }, { status: 'planned', parentNodeId: plannedNode ? null : task.graphNodeId });
          if (dependencyNodeId) {
            commitTaskGraph(graph => addTaskEdge(graph, {
              from: dependencyNodeId,
              to: nextTask.graphNodeId,
              kind: 'dependency',
            }));
          }
          immediateHandoffTasks.push(nextTask);
        }

        // The structured PM plan is authoritative. Queue every currently
        // reachable planned task even if the PM forgot its matching @line;
        // future nodes remain disabled until a later review unlocks them.
        if (canDrivePlan && !asksUser) {
          const readyPlanNodes = (taskGraphRef.current?.nodes || [])
            .filter(node =>
              node.planRootId === activePlanRootNodeId &&
              node.nodeType !== 'review' &&
              CLAIMABLE_PLAN_STATUSES.has(node.status) &&
              !claimedPlanNodeIds.has(node.id) &&
              isTaskNodeReady(taskGraphRef.current, node.id)
            )
            .sort((left, right) => (left.planOrder || 0) - (right.planOrder || 0));
          for (const plannedNode of readyPlanNodes) {
            const target = chatAgents.find(candidate => candidate.id === plannedNode.agentId);
            if (!target) continue;
            const plannedHandoff = createHandoff({
              from: agent.name,
              to: target.name,
              taskId: `plan-${plannedNode.planTaskId}`,
              summary: plannedNode.objective || plannedNode.title,
            });
            const nextTask = registerGraphTask({
              agent: target,
              objective: plannedHandoff.summary,
              handoff: plannedHandoff,
              source: agent.name,
              graphNodeId: plannedNode.id,
              planRootId: activePlanRootNodeId,
              planTaskId: plannedNode.planTaskId,
            }, { status: 'planned' });
            immediateHandoffTasks.push(nextTask);
            claimedPlanNodeIds.add(plannedNode.id);
          }
        }
        const queuedHandoffs = taskQueue.prepend(immediateHandoffTasks);
        const prependResult = taskQueue.getLastPrependResult();
        if (prependResult.rejected.length > 0) {
          loopGuardRejections.push(...prependResult.rejected);
          for (const rejection of prependResult.rejected) {
            setGraphTaskStatus(rejection.task, 'blocked', {
              blockedReason: rejection.reason === 'repeat-limit'
                ? 'repeat-limit'
                : 'duplicate-handoff',
            });
          }
        }
        const parallelHandoffTasks = prependResult.accepted.filter(acceptedTask => {
          const graphNode = taskGraphRef.current?.nodes?.find(node => node.id === acceptedTask.graphNodeId);
          return graphNode?.executionMode !== 'sequential';
        });
        if (agent.id === pm?.id && parallelHandoffTasks.length >= 2 && task.source !== 'timeout-recovery') {
          if (autoRunRef.current) {
            const safeParallelIds = findSafeAutoParallelTaskIds(taskGraphRef.current, parallelHandoffTasks);
            safeParallelIds.forEach(nodeId => requestedParallelTaskIds.add(nodeId));
            taskQueue.prioritize(safeParallelIds);
            if (safeParallelIds.length >= 2) {
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `⚡|${t('{count} unabhängige Aufgaben werden automatisch parallel ausgeführt.', { count: safeParallelIds.length })}`,
                ts: Date.now(), isError: false,
              });
            }
          } else {
            scheduleDecisionRequested = true;
          }
        }

        if (agent.id === pm?.id && queuedHandoffs > 0) {
          const skipFastFinalReview = useLeanFastPath &&
            task.source === 'user' &&
            queuedHandoffs === 1 &&
            !activePlanRootNodeId;
          needsSynthesis = !skipFastFinalReview;
          if (task.source === 'timeout-recovery') {
            delegatedResults.push({
              agent: agent.name,
              objective: `Timeout-Recovery für ${task.recovery?.originalAgentName || 'Agent'}`,
              result: reviewEvidence,
              graphNodeId: task.graphNodeId,
            });
          }
        } else if (agent.id !== pm?.id) {
          delegatedResults.push({ agent: agent.name, objective, result: reviewEvidence, graphNodeId: task.graphNodeId });
          // A single specialist explicitly addressed by the user remains a
          // direct conversation. Multi-agent/delegated work still returns to
          // the PM for the final synthesis.
          if (shouldRequestPMFinalReview({
            pm,
            agent,
            taskSource: task.source,
            routeMode: route.mode,
            explicitMentionCount: explicitMentions.length,
            explicitlyAddressedAgentId: explicitMentions[0]?.id,
            handoffCount: handoffs.length,
            hasActivePlan: !!activePlanRootNodeId,
            useLeanFastPath,
            asksUser,
          })) needsSynthesis = true;
        }

        if (task.source === 'timeout-recovery-step' && task.recovery && pm) {
          const recoveryReviewTask = buildTimeoutRecoveryReviewTask({
            pm,
            recovery: task.recovery,
            stepObjective: objective,
            result: reviewEvidence,
          });
          if (recoveryReviewTask) {
            registerGraphTask(recoveryReviewTask, { status: 'planned', parentNodeId: task.graphNodeId });
            taskQueue.prepend([recoveryReviewTask]);
          }
        }

        if (asksUser) {
          pauseRequested = true;
          const userQuestions = extractUserQuestions(displayReply);
          pauseQuestion = userQuestions.length
            ? userQuestions.join('\n')
            : displayReply.slice(-700);
        }

        const openPlanTaskCount = activePlanRootNodeId
          ? (taskGraphRef.current?.nodes || []).filter(node =>
            node.planRootId === activePlanRootNodeId &&
            node.id !== task.graphNodeId &&
            !FINISHED_PLAN_STATUSES.has(node.status)
          ).length
          : 0;
        if (shouldCompleteProject({
          isOrchestrator,
          source: task.source,
          reply: rawReply,
          handoffCount: handoffs.length,
          pendingTaskCount: taskQueue.length + openPlanTaskCount,
          asksUser,
        })) {
          projectCompleted = true;
          needsSynthesis = false;
          taskQueue.clear();
          discardConversationCheckpoint();
          commitTaskGraph(graph => approveAgentDoneTasks(
            updateTaskNodeStatus(graph, task.graphNodeId, 'completed', { pmApprovedAt: Date.now() })
          ));
          if (projectPath && window.electronAPI?.projectWrite) {
            const completionContent = [
              `# ${t('Projekt abgeschlossen')}`,
              '',
              `- ${t('Gruppe: {group}', { group: chat.name })}`,
              `- ${t('Abschluss durch: {agent}', { agent: agent.name })}`,
              `- ${t('Zeitpunkt: {time}', { time: new Date().toISOString() })}`,
              `- ${t('Bearbeitete Agenten-Tasks: {count}', { count: successfulTasks })}`,
              '',
              `## ${t('Abschlussbericht')}`,
              '',
              displayReply,
              '',
            ].join('\n');
            const completionResult = await window.electronAPI.projectWrite({
              projectPath, filename: '.agent-teams/PROJECT_DONE.md', content: completionContent,
            });
            if (!completionResult?.success) {
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `📁|${t('Abschlussbericht konnte nicht gespeichert werden — {error}', { error: completionResult?.error || t('unbekannter Fehler') })}`,
                ts: Date.now(), isError: true,
              });
            }
          }
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: projectPath
              ? `✅|${t('Projekt abgeschlossen. Dateien und Abschlussbericht liegen in {path}.', { path: projectPath })}`
              : `✅|${t('Projekt abgeschlossen. Es war kein Projektordner konfiguriert.')}`,
            ts: Date.now(), isError: false,
          });
        }
      } catch (e) {
        if (runIdRef.current !== myRunId) return;
        const rateLimited = e.rateLimited || e.status === 429;
        const timedOut = isAgentTimeoutError(e);
        setGraphTaskStatus(task, rateLimited ? 'blocked' : timedOut ? 'timed_out' : 'failed', { error: e.message });
        addMessage(chat.id, {
          id: Date.now() + Math.random(),
          agentId: 'system', senderName: 'System',
          text: `${agent.name}|${e.message}`,
          ts: Date.now(), isError: true,
        });
        if (rateLimited) {
          taskQueue.retry(task);
          providerPauseRequested = true;
          providerRetryAfterMs = e.retryAfterMs || 60000;
          resumableFailure = true;
        } else if (agent.id === pm?.id) {
          resumableFailure = true;
        } else if (pm) {
          delegatedResults.push({
            agent: agent.name,
            objective,
            result: `${timedOut ? 'TIMEOUT' : 'FEHLER'}: ${e.message}`,
            graphNodeId: task.graphNodeId,
          });
          needsSynthesis = true;
          if (timedOut) {
            const originalAgent = task.recovery
              ? chatAgents.find(candidate => candidate.id === task.recovery.originalAgentId) || agent
              : agent;
            const recoveryTask = buildTimeoutRecoveryTask({
              pm,
              originalAgent,
              objective,
              errorMessage: e.message,
              previousRecovery: task.recovery,
            });
            if (recoveryTask) {
              registerGraphTask(recoveryTask, { status: 'planned', parentNodeId: task.graphNodeId });
              taskQueue.prepend([recoveryTask]);
            }
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `🧭|${t('PM übernimmt sofort die Timeout-Recovery für {agent}: Aufgabe untersuchen, verkleinern und schrittweise neu vergeben.', { agent: originalAgent.name })}`,
              ts: Date.now(), isError: false,
            });
          }
        }
      } finally {
        setTypingAgents(prev => prev.filter(id => id !== agent.id));
        if (activeAgentRunRef.current.has(agentRequestId)) {
          activeAgentRunRef.current.delete(agentRequestId);
          setAgentProgress(previous => {
            const next = { ...previous };
            delete next[agent.id];
            return next;
          });
        }
      }

      return {
        task,
        agent,
        pauseRequested,
        pauseQuestion,
        scheduleDecisionRequested,
        providerPauseRequested,
        providerRetryAfterMs,
      };
    };

    while ((task = taskQueue.next())) {
      const taskBatch = [task];
      const startsSelectedParallelBatch = requestedParallelTaskIds.has(task.graphNodeId);
      if (startsSelectedParallelBatch) {
        requestedParallelTaskIds.delete(task.graphNodeId);
        // Selected tasks were stably sorted to the front while restoring the
        // checkpoint. Peek before next() so unrelated sequential work is never
        // accidentally pulled into this batch.
        while (requestedParallelTaskIds.size > 0 && taskQueue.length > 0) {
          const nextPendingTask = taskQueue.pendingTasks()[0];
          if (!requestedParallelTaskIds.has(nextPendingTask?.graphNodeId)) break;
          const parallelTask = taskQueue.next();
          if (!parallelTask) break;
          requestedParallelTaskIds.delete(parallelTask.graphNodeId);
          taskBatch.push(parallelTask);
        }
      }

      const remainingBatchTasks = new Map(taskBatch.map(batchTask => [batchTask.graphNodeId, batchTask]));
      persistRunCheckpoint({
        status: 'running',
        pendingTasks: [...taskBatch, ...taskQueue.pendingTasks()],
        parallelTaskIds: startsSelectedParallelBatch ? taskBatch.map(batchTask => batchTask.graphNodeId) : [],
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
      });

      const executions = await runTaskBatch(taskBatch, async batchTask => {
        const execution = await executeAgentTask(batchTask);
        if (execution && runIdRef.current === myRunId) {
          remainingBatchTasks.delete(batchTask.graphNodeId);
          // Persist after every settled task. If another parallel agent is
          // interrupted, already completed siblings are not repeated later.
          const unfinishedBatch = [...remainingBatchTasks.values()];
          persistRunCheckpoint({
            status: 'running',
            pendingTasks: [...unfinishedBatch, ...taskQueue.pendingTasks()],
            parallelTaskIds: startsSelectedParallelBatch
              ? unfinishedBatch.map(pendingTask => pendingTask.graphNodeId)
              : [],
            initialObjective,
            needsSynthesis,
            synthesisCount,
            delegatedResults: [...delegatedResults],
            successfulTasks,
            queueGuard: taskQueue.guardState(),
            planRootGraphNodeId: activePlanRootNodeId,
          });
        }
        return execution;
      });
      if (executions.some(execution => !execution)) {
        setRunning(false);
        return;
      }
      const pauseExecution = executions.find(execution => execution.pauseRequested);
      const scheduleExecution = executions.find(execution => execution.scheduleDecisionRequested);
      const providerPauseExecution = executions.find(execution => execution.providerPauseRequested);
      const lastExecution = executions.at(-1);
      const { agent } = providerPauseExecution || pauseExecution || scheduleExecution || lastExecution;
      task = (providerPauseExecution || pauseExecution || scheduleExecution || lastExecution).task;

      if (projectCompleted) {
        setRunning(false);
        return;
      }

      if (providerPauseExecution) {
        const retrySeconds = Math.max(1, Math.ceil(providerPauseExecution.providerRetryAfterMs / 1000));
        persistRunCheckpoint({
          status: 'provider-limited',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
          limitedProvider: agent.provider,
          limitedAgentId: agent.id,
          retryAfterMs: providerPauseExecution.providerRetryAfterMs,
          retryNotBefore: Date.now() + providerPauseExecution.providerRetryAfterMs,
        });
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `⏳|${t('{agent}s Task bleibt in der Warteschlange. Frühestens in etwa {seconds}s fortsetzen; bereits fertige Parallel-Tasks werden nicht wiederholt.', { agent: agent.name, seconds: retrySeconds })}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (pauseExecution) {
        const { pauseQuestion } = pauseExecution;
        setGraphTaskStatus(task, 'waiting_user');
        const questionList = pauseQuestion
          .split('\n')
          .map(question => question.trim())
          .filter(Boolean)
          .map(question => `• ${question}`)
          .join('\n');
        persistRunCheckpoint({
          status: 'awaiting-user',
          askingAgent: agent,
          askingGraphNodeId: task.graphNodeId,
          question: pauseQuestion,
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setStoppedForUser(true);
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `💬|${t('{agent} wartet auf deine Antwort:', { agent: agent.name })}\n\n${questionList || `• ${t('Bitte beantworte die Rückfrage des Agenten.')}`}\n\n${t('Antworte einfach im Eingabefeld – danach läuft die Agenten-Konversation weiter.')}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (scheduleExecution) {
        persistRunCheckpoint({
          status: 'awaiting-schedule',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        openTaskGraphWindow({ awaitingSchedule: true, running: false });
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🗺️|${t('Der PM hat mehrere Aufgaben geplant. Wähle im Aufgabenplan eine parallele Gruppe oder fahre sequenziell fort.')}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      // After all delegated specialists finish, give the PM a fresh isolated
      // synthesis task. This is another task/session, not reused chat context.
      if (taskQueue.length === 0 && needsSynthesis && pm && delegatedResults.length > 0) {
        synthesisCount += 1;
        const reviewDependencyIds = [...new Set(delegatedResults.map(item => item.graphNodeId).filter(Boolean))];
        const synthesisHandoff = createHandoff({
          from: `Team-Runde-${synthesisCount}`,
          to: pm.name,
          taskId: `synthesis-${Date.now().toString(36)}`,
          summary: `Final-Review: Prüfe alle Ergebnisse gegen die ursprüngliche User-Anforderung "${initialObjective}". Falls etwas offen ist, delegiere es konkret an den zuständigen Agenten. Falls alles erfüllt ist, gib den Abschluss an den User und beende mit [[PROJECT_DONE]].`,
          findings: delegatedResults.map(item => `${item.agent} | Aufgabe: ${item.objective} | Ergebnis: ${item.result}`),
        });
        const currentPlanNodes = activePlanRootNodeId
          ? (taskGraphRef.current?.nodes || []).filter(node => node.planRootId === activePlanRootNodeId)
          : [];
        const hasRemainingPlannedWork = currentPlanNodes.some(node =>
          node.nodeType !== 'review' && !FINISHED_PLAN_STATUSES.has(node.status)
        );
        const plannedFinalReviewNode = hasRemainingPlannedWork
          ? null
          : currentPlanNodes.find(node =>
            node.nodeType === 'review' && CLAIMABLE_PLAN_STATUSES.has(node.status)
          );
        const synthesisTask = registerGraphTask({
          agent: pm,
          objective: synthesisHandoff.summary,
          handoff: synthesisHandoff,
          source: 'team-synthesis',
          ...(plannedFinalReviewNode ? {
            graphNodeId: plannedFinalReviewNode.id,
            planRootId: activePlanRootNodeId,
            planTaskId: plannedFinalReviewNode.planTaskId,
          } : {}),
        }, {
          status: 'planned',
          parentNodeId: (plannedFinalReviewNode || reviewDependencyIds.length) ? null : task.graphNodeId,
        });
        if (reviewDependencyIds.length > 0) {
          commitTaskGraph(graph => reviewDependencyIds.reduce((nextGraph, dependencyNodeId) =>
            addTaskEdge(nextGraph, { from: dependencyNodeId, to: synthesisTask.graphNodeId, kind: 'review' }),
          graph));
        }
        taskQueue.enqueue(synthesisTask);
        delegatedResults.length = 0;
        needsSynthesis = false;
      }

      if (taskQueue.length > 0) {
        persistRunCheckpoint({
          status: 'running',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
      } else if (!resumableFailure) {
        // Mark the just-finished task as consumed before the final cleanup, so
        // an app shutdown in this small window cannot execute it a second time.
        persistRunCheckpoint({
          status: 'running',
          pendingTasks: [],
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
      }
    }

    // A bounded run segment never ends without PM supervision. The PM gets
    // one extra review task outside the normal queue budget and may either
    // approve completion or define one smaller next step. Remaining work is
    // checkpointed for an explicit resume, which keeps the loop guard intact.
    if (taskQueue.reachedLimit && chat.type === 'group' && pm && conversationLimits.pmReviewOnLimit) {
      const pendingAtLimit = taskQueue.pendingTasks();
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🧭|${t('Laufgrenze nach {count} Agenten-Tasks erreicht. Der PM prüft jetzt Abschluss und offene Arbeit.', { count: conversationLimits.maxTurns })}`,
        ts: Date.now(), isError: false,
      });
      const limitReviewDraft = buildTurnLimitReviewTask({
        pm,
        initialObjective,
        maxTurns: conversationLimits.maxTurns,
        pendingTasks: pendingAtLimit,
        delegatedResults,
      });
      const limitReviewTask = registerGraphTask(limitReviewDraft, { status: 'planned' });
      const reviewExecution = await executeAgentTask(limitReviewTask);
      if (!reviewExecution || runIdRef.current !== myRunId) {
        setRunning(false);
        return;
      }
      if (projectCompleted) {
        setRunning(false);
        return;
      }

      if (reviewExecution.providerPauseRequested) {
        const retrySeconds = Math.max(1, Math.ceil(reviewExecution.providerRetryAfterMs / 1000));
        persistRunCheckpoint({
          status: 'provider-limited',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
          limitedProvider: pm.provider,
          limitedAgentId: pm.id,
          retryAfterMs: reviewExecution.providerRetryAfterMs,
          retryNotBefore: Date.now() + reviewExecution.providerRetryAfterMs,
        });
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `⏳|${t('Die PM-Grenzprüfung wurde gespeichert und kann in etwa {seconds}s fortgesetzt werden.', { seconds: retrySeconds })}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (reviewExecution.pauseRequested) {
        const pauseQuestion = reviewExecution.pauseQuestion || '';
        const questionList = pauseQuestion
          .split('\n')
          .map(question => question.trim())
          .filter(Boolean)
          .map(question => `• ${question}`)
          .join('\n');
        setGraphTaskStatus(limitReviewTask, 'waiting_user');
        persistRunCheckpoint({
          status: 'awaiting-user',
          askingAgent: pm,
          askingGraphNodeId: limitReviewTask.graphNodeId,
          question: pauseQuestion,
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setStoppedForUser(true);
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `💬|${t('{agent} wartet auf deine Antwort:', { agent: pm.name })}\n\n${questionList || `• ${t('Bitte beantworte die Rückfrage des Agenten.')}`}\n\n${t('Antworte einfach im Eingabefeld – danach läuft die Agenten-Konversation weiter.')}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (reviewExecution.scheduleDecisionRequested) {
        persistRunCheckpoint({
          status: 'awaiting-schedule',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        openTaskGraphWindow({ awaitingSchedule: true, running: false });
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🗺️|${t('Der PM hat mehrere Aufgaben geplant. Wähle im Aufgabenplan eine parallele Gruppe oder fahre sequenziell fort.')}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      const pendingAfterReview = taskQueue.pendingTasks();
      persistRunCheckpoint({
        status: 'limit-reached',
        pendingTasks: pendingAfterReview,
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
        completedSegmentTurns: conversationLimits.maxTurns,
      });
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `💾|${t('Laufgrenze nach {count} Agenten-Tasks erreicht. Der Arbeitsstand und {pending} offene Aufgabe(n) wurden gespeichert. Mit „Fortsetzen“ beginnt das nächste Laufsegment.', {
          count: conversationLimits.maxTurns,
          pending: pendingAfterReview.length,
        })}`,
        ts: Date.now(), isError: false,
      });
      setRunning(false);
      return;
    }

    if (loopGuardRejections.length > 0) {
      discardConversationCheckpoint();
      const affectedAgents = [...new Set(loopGuardRejections
        .map(rejection => rejection.task?.agent?.name)
        .filter(Boolean))];
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🛑|${t('Wiederholungsschleife gestoppt: {agents} sollte eine bereits erledigte Dateiaufgabe erneut erhalten. Die doppelte Übergabe wurde blockiert; vorhandene Dateien und Zwischenstände bleiben erhalten.', { agents: affectedAgents.join(', ') || t('Ein Agent') })}`,
        ts: Date.now(), isError: false,
      });
    } else if (taskQueue.reachedLimit) {
      const pendingTasks = taskQueue.pendingTasks();
      persistRunCheckpoint({
        status: 'limit-reached',
        pendingTasks,
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
        completedSegmentTurns: conversationLimits.maxTurns,
      });
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `💾|${t('Laufgrenze nach {count} Agenten-Tasks erreicht. Der Arbeitsstand wurde gespeichert. Mit „Fortsetzen“ kann der PM die offene Arbeit prüfen.', { count: conversationLimits.maxTurns })}`,
        ts: Date.now(), isError: false,
      });
    } else if (resumableFailure) {
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `⏸|${t('Der Arbeitsstand wurde gespeichert. Du kannst den Lauf mit „Fortsetzen“ an derselben Stelle erneut starten.')}`,
        ts: Date.now(), isError: false,
      });
    } else if (successfulTasks > 0) {
      discardConversationCheckpoint();
      if (chat.type === 'group') {
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `✅|${t(
            projectPath
              ? (successfulTasks === 1
                ? 'Agentenlauf beendet. {count} Task abgeschlossen; Zwischenstände wurden in {path} gespeichert.'
                : 'Agentenlauf beendet. {count} Tasks abgeschlossen; Zwischenstände wurden in {path} gespeichert.')
              : (successfulTasks === 1
                ? 'Agentenlauf beendet. {count} Task abgeschlossen.'
                : 'Agentenlauf beendet. {count} Tasks abgeschlossen.'),
            { count: successfulTasks, path: projectPath },
          )}`,
          ts: Date.now(), isError: false,
        });
      }
    } else {
      discardConversationCheckpoint();
    }
    setRunning(false);
  }, [apiKeys, providerConnections, chatAgents, conversationStates, kbPath, projectPath, memoryEnabled, memoryConfig?.namespace, memoryAPI, mcpServers, chat.mcpServers, chat.qualityRouting, qualityRouting, conversationLimits, recordQualityEvent, refreshMemoryCount, chat.id, chat.name, chat.type, addMessage, requestMcpPermission, handleMcpPermissionConsumed, handleMcpToolResult, persistConversationCheckpoint, discardConversationCheckpoint, commitTaskGraph, registerGraphTask, setGraphTaskStatus, openTaskGraphWindow, t]);

  const handleCancelRun = useCallback(async () => {
    if (!running) return;
    queueDrainPausedRef.current = true;
    cancelAllMcpApprovals();
    const activeRuns = [...activeAgentRunRef.current.values()];
    const currentCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];

    // Stop the local queue immediately. A pending remote API response may still
    // arrive in the background, but its result is discarded by runId.
    runIdRef.current += 1;
    activeAgentRunRef.current.clear();
    if (activeRuns.length > 0) {
      commitTaskGraph(graph => activeRuns.reduce((nextGraph, activeRun) =>
        activeRun.graphNodeId
          ? updateTaskNodeStatus(nextGraph, activeRun.graphNodeId, 'interrupted', { interruptedAt: Date.now() })
          : nextGraph,
      graph));
    }
    if (currentCheckpoint) {
      persistConversationCheckpoint({
        ...currentCheckpoint,
        status: 'interrupted',
        interruptedAgentId: activeRuns[0]?.agentId || null,
        interruptedAgentName: activeRuns.map(run => run.agentName).join(', ') || null,
      });
    }
    setTypingAgents([]);
    setAgentProgress({});
    setStoppedForUser(false);
    setRunning(false);

    if (window.electronAPI?.codexCancel) {
      await Promise.all(activeRuns
        .filter(run => run.provider === 'codex')
        .map(run => window.electronAPI.codexCancel(run.requestId).catch(() => null)));
    }
    if (window.electronAPI?.claudeCancel) {
      await Promise.all(activeRuns
        .filter(run => run.runtime === 'claude')
        .map(run => window.electronAPI.claudeCancel(run.requestId).catch(() => null)));
    }

    addMessage(chat.id, {
      id: Date.now() + Math.random(),
      agentId: 'system',
      senderName: 'System',
      text: `⏹|${t('{agents} wurde unterbrochen. Der Arbeitsstand und alle offenen Übergaben wurden gespeichert; du kannst mit „Fortsetzen“ weitermachen.', {
        agents: activeRuns.map(run => run.agentName).join(', ') || t('Der Agentenlauf'),
      })}`,
      ts: Date.now(),
      isError: false,
    });
  }, [running, chat.id, conversationStates, addMessage, cancelAllMcpApprovals, persistConversationCheckpoint, commitTaskGraph, t]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const attachments = [...pendingAttachmentsRef.current];
    if (!text && !attachments.length) return;
    const queueBehindActiveRun = running || queueProcessingRef.current !== null;
    setInput('');
    pendingAttachmentsRef.current = [];
    setPendingAttachments([]);
    window.requestAnimationFrame(focusComposer);
    const userMsg = await sendUserMessage(text, attachments, messageQualityMode);
    if (!userMsg) return;
    if (userMsg.memoryOnly) {
      // Memory-only message (just #tags) — show confirmation, don't run agents
      addMessage(chat.id, {
        id: Date.now(), agentId: 'system', senderName: 'System',
        text: userMsg.memorySaved
          ? `🧠|${t('Info gespeichert in memory://{namespace}. Kein Agent wurde benachrichtigt.', { namespace: memoryConfig?.namespace })}`
          : `Memory|${t('Info konnte nicht gespeichert werden. Kein Agent wurde benachrichtigt.')}`,
        ts: Date.now(), isError: !userMsg.memorySaved,
      });
      return;
    }
    if (queueBehindActiveRun) {
      enqueueUserRequest(chat.id, {
        id: `user-request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        messageId: userMsg.id,
        createdAt: Date.now(),
      });
      return;
    }
    const history = [...chatMessages, userMsg];
    const resumesPausedConversation = conversationContinuations.has(chat.id);
    if (chat.type === 'group' && !autoRunRef.current && !resumesPausedConversation) return;
    await runAgents(history, text || t('Bitte analysiere die angehängten Dateien.'));
  }, [input, running, focusComposer, sendUserMessage, chatMessages, runAgents, addMessage, enqueueUserRequest, chat.id, chat.type, messageQualityMode, t]);

  const handleKeyDown = (e) => {
    if (mentionOpen) {
      if (e.key === 'Escape') { setMentionOpen(false); return; }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); return; } // handled by click
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleInputChange = (e) => {
    const val = e.target.value;
    setInput(val);
    const cursor = e.target.selectionStart;
    // Find last @ before cursor
    const before = val.slice(0, cursor);
    const atIdx = before.lastIndexOf('@');
    if (atIdx !== -1 && (atIdx === 0 || /\s/.test(before[atIdx - 1]))) {
      const fragment = before.slice(atIdx + 1);
      if (!fragment.includes(' ')) {
        setMentionOpen(true);
        setMentionFilter(fragment);
        setMentionStart(atIdx);
        return;
      }
    }
    setMentionOpen(false);
  };

  const handleMentionSelect = (item) => {
    const before = input.slice(0, mentionStart);
    const after = input.slice(textareaRef.current?.selectionStart ?? input.length);
    const newVal = `${before}@${item.label} ${after}`;
    setInput(newVal);
    setMentionOpen(false);
    setMentionFilter('');
    setTimeout(() => {
      if (textareaRef.current) {
        const pos = before.length + item.label.length + 2;
        textareaRef.current.setSelectionRange(pos, pos);
        textareaRef.current.focus();
      }
    }, 0);
  };

  const handleRunNow = () => {
    queueDrainPausedRef.current = false;
    // A saved checkpoint takes precedence; otherwise the PM starts a new run.
    const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
    if (!checkpoint && queuedUserRequests.length > 0) {
      setQueuePump(current => current + 1);
      return;
    }
    runAgents(chatMessages, null);
  };

  const handleScheduleChoice = (parallelTaskIds = []) => {
    queueDrainPausedRef.current = false;
    const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
    if (!checkpoint || checkpoint.status !== 'awaiting-schedule') return;
    if (parallelTaskIds.length > 0) {
      const validation = validateParallelSelection(taskGraphRef.current, parallelTaskIds);
      if (!validation.ok) {
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🗺️|${t('Paralleler Start nicht möglich: {reason}', {
            reason: t(validation.messageKey || validation.reason, validation.messageValues),
          })}`,
          ts: Date.now(), isError: true,
        });
        return;
      }
    }
    const parallelBatchId = parallelTaskIds.length > 0
      ? `parallel-${Date.now().toString(36)}`
      : null;
    const selectedIds = new Set(parallelTaskIds);
    commitTaskGraph(graph => (checkpoint.pendingTasks || []).reduce((nextGraph, pendingTask) => {
      if (!pendingTask.graphNodeId) return nextGraph;
      return updateTaskNodeStatus(nextGraph, pendingTask.graphNodeId, 'queued', {
        executionMode: selectedIds.has(pendingTask.graphNodeId) ? 'parallel' : 'sequential',
        parallelBatchId: selectedIds.has(pendingTask.graphNodeId) ? parallelBatchId : null,
      });
    }, graph));
    persistConversationCheckpoint({
      ...checkpoint,
      status: 'interrupted',
      parallelTaskIds,
    });
    addMessage(chat.id, {
      id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
      text: parallelTaskIds.length > 0
        ? `⚡|${t('{count} unabhängige Aufgaben starten jetzt parallel. Die übrigen Aufgaben folgen danach.', { count: parallelTaskIds.length })}`
        : `▶|${t('Der Aufgabenplan wird sequenziell fortgesetzt.')}`,
      ts: Date.now(), isError: false,
    });
    runAgents(chatMessages, null);
  };

  const handleRetry = () => {
    queueDrainPausedRef.current = false;
    if (lastRunContext) runAgents(lastRunContext.history, lastRunContext.triggerText);
  };

  const handleClearChat = () => {
    discardConversationCheckpoint();
    clearTaskGraph(chat.id);
    taskGraphRef.current = createTaskGraph(chat.id, chat.name);
    setStoppedForUser(false);
    queueDrainPausedRef.current = false;
    clearUserRequestQueue(chat.id);
    pendingAttachmentsRef.current = [];
    setPendingAttachments([]);
    window.electronAPI?.clearChatAttachments?.(chat.id).catch(() => null);
    clearMessages(chat.id);
  };

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // Keep every direct and group chat ready for immediate typing. Modal inputs
  // temporarily own the focus; closing the modal restores the chat composer.
  useEffect(() => {
    if (memoryViewer.open || mcpApproval) return undefined;
    const frame = window.requestAnimationFrame(focusComposer);
    return () => window.cancelAnimationFrame(frame);
  }, [chat.id, running, memoryViewer.open, mcpApproval, focusComposer]);

  useEffect(() => {
    const restoreComposerFocus = () => {
      if (!memoryViewer.open && !mcpApproval) window.requestAnimationFrame(focusComposer);
    };
    window.addEventListener('focus', restoreComposerFocus);
    return () => window.removeEventListener('focus', restoreComposerFocus);
  }, [memoryViewer.open, mcpApproval, focusComposer]);

  const groupedMessages = [];
  let lastSender = null;
  for (const msg of chatMessages) {
    if (msg.agentId !== lastSender) {
      groupedMessages.push({ senderId: msg.agentId, msgs: [msg] });
      lastSender = msg.agentId;
    } else {
      groupedMessages[groupedMessages.length - 1].msgs.push(msg);
    }
  }

  const getAgent = (id) => agents.find(a => a.id === id);

  // Check if last messages contain retryable error
  const hasRecentError = chatMessages.slice(-3).some(m => m.isError);
  const lastUserMessageIndex = chatMessages.findLastIndex(m => m.agentId === 'user');
  const hasAgentResponseAfterLastUser = lastUserMessageIndex >= 0 && chatMessages
    .slice(lastUserMessageIndex + 1)
    .some(m => m.agentId !== 'user' && m.agentId !== 'system');
  const canStartAgentsManually = lastUserMessageIndex >= 0 && !hasAgentResponseAfterLastUser;
  const conversationCheckpoint = conversationStates?.[chat.id] || conversationContinuations.get(chat.id);
  const providerRetryRemainingMs = conversationCheckpoint?.status === 'provider-limited'
    ? Math.max(0, (conversationCheckpoint.retryNotBefore || 0) - retryClock)
    : 0;
  const providerCooldownActive = providerRetryRemainingMs > 0;
  const canResumeConversation = ['running', 'interrupted', 'provider-limited', 'limit-reached'].includes(conversationCheckpoint?.status)
    && !providerCooldownActive;
  const awaitingSchedule = conversationCheckpoint?.status === 'awaiting-schedule';
  const activeTaskGraph = taskGraphs?.[chat.id] || taskGraphRef.current || createTaskGraph(chat.id, chat.name);
  const queuedUserMessageIds = new Set(queuedUserRequests.map(request => String(request.messageId)));

  useEffect(() => {
    if (running || providerCooldownActive || awaitingSchedule || queueDrainPausedRef.current || queueProcessingRef.current) {
      return;
    }
    const request = queuedUserRequests[0];
    if (!request) return;
    const queuedMessage = chatMessagesRef.current.find(message => String(message?.id) === String(request.messageId));
    if (!queuedMessage) {
      removeUserRequest(chat.id, request.id);
      return;
    }

    queueProcessingRef.current = request.id;
    const history = buildQueuedRequestHistory(
      chatMessagesRef.current,
      queuedUserRequests,
      request.id,
    );
    const triggerText = queuedMessage.text || t('Bitte analysiere die angehängten Dateien.');

    void (async () => {
      try {
        await runAgents(history, triggerText);
      } finally {
        removeUserRequest(chat.id, request.id);
        queueProcessingRef.current = null;
        setQueuePump(current => current + 1);
      }
    })();
  }, [awaitingSchedule, chat.id, providerCooldownActive, queuePump, queuedUserRequests, removeUserRequest, runAgents, running, t]);

  useEffect(() => {
    if (chat.type !== 'group' || !window.electronAPI?.updateTaskWindow) return;
    window.electronAPI.updateTaskWindow({
      chatId: chat.id,
      chatName: chat.name,
      windowTitle: `${t('Aufgabenbaum')} – ${chat.name}`,
      graph: activeTaskGraph,
      running,
      awaitingSchedule,
    });
  }, [activeTaskGraph, awaitingSchedule, chat.id, chat.name, chat.type, running, t]);

  useEffect(() => {
    if (!window.electronAPI?.onTaskWindowAction) return undefined;
    return window.electronAPI.onTaskWindowAction(action => {
      if (action?.chatId !== chat.id) return;
      if (action.type === 'run-parallel') handleScheduleChoice(action.taskIds || []);
      if (action.type === 'continue-sequential') handleScheduleChoice([]);
    });
  }, [chat.id, handleScheduleChoice]);

  return (
    <>
      {/* Chat Header */}
      <div className="chat-header">
        {chat.type === 'group' ? (
          <div className="avatar group" style={{ width: 40, height: 40, fontSize: 18 }}>{chat.emoji || '💬'}</div>
        ) : (
          <Avatar agent={getAgent(chat.id)} size={40} />
        )}
        <div className="chat-header-info">
          <div className="chat-header-name">{chat.name}</div>
          <div className="chat-header-sub">
            {chat.type === 'group'
              ? chatAgents.map(a => `${a.emoji} ${a.name}`).join('  ·  ')
              : getAgent(chat.id)?.role || 'Agent'}
            {projectPath && <span style={{ color: 'var(--accent)', marginLeft: 8, fontSize: 11 }}>📁 {projectPath.split(/[\\/]/).pop()}</span>}
          </div>
        </div>
        <button className="icon-btn" title={t('Chat leeren')} onClick={handleClearChat} style={{ fontSize: 14 }}>🗑️</button>
        {activeMcpPermissionCount > 0 && (
          <button
            className="icon-btn"
            title={t('MCP-Freigaben löschen ({count})', { count: activeMcpPermissionCount })}
            aria-label={t('MCP-Freigaben löschen ({count})', { count: activeMcpPermissionCount })}
            onClick={() => {
              if (window.confirm(t('Alle MCP-Freigaben für diesen Chat wirklich löschen?'))) {
                clearMcpPermissions(chat.id);
              }
            }}
            style={{ fontSize: 14 }}
          >🔓</button>
        )}
        {chat.type === 'group' && (
          <button className="icon-btn" title={t('Aufgabenplan')} onClick={() => openTaskGraphWindow()} style={{ fontSize: 14 }}>🗺️</button>
        )}
        {chat.type === 'group' && memoryEnabled && (
          <MemoryBadge count={memoryCount} onOpen={handleOpenMemory} />
        )}
      </div>

      {/* Messages */}
      <div className="messages-container">
        {chatMessages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13, padding: '32px 0' }}>
            {t('Schreibe eine Nachricht und starte das Gespräch!')}
          </div>
        )}
        {groupedMessages.map((group, gi) => {
          const isUser = group.senderId === 'user';
          const isSystem = group.senderId === 'system';
          const agent = getAgent(group.senderId);
          return (
            <div key={gi} className="message-group">
              {group.msgs.map((msg, mi) => {
                if (isSystem) {
                  const rawText = msg?.text || '';
                  const parts = rawText.split('|');
                  const label = parts.length > 1 ? parts[0] : null;
                  const errorText = parts.length > 1 ? parts.slice(1).join('|') : rawText;
                  return (
                    <ErrorBubble
                      key={msg.id || mi}
                      text={label ? `${label}: ${errorText}` : errorText}
                      isError={msg.isError !== false}
                      onRetry={msg.isError && lastRunContext ? handleRetry : null}
                    />
                  );
                }
                const msgText = msg?.text ?? '';
                return (
                  <div key={msg.id || mi} className={`message-wrapper ${isUser ? 'out' : ''}`}>
                    {!isUser && mi === group.msgs.length - 1 && (
                      <div className="message-avatar"><Avatar agent={agent} size={28} /></div>
                    )}
                    {!isUser && mi < group.msgs.length - 1 && <div style={{ width: 28 }} />}
                    <div>
                      {!isUser && mi === 0 && (
                        <div className="message-sender" style={{ fontSize: 12, color: '#8696a0', marginBottom: 2, marginLeft: 10 }}>
                          {msg.senderName}
                          <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 6 }}>
                            {getProviderEmoji(msg.provider || agent?.provider, providerConnections)} {msg.model || agent?.model}
                          </span>
                        </div>
                      )}
                      <div className={`message-bubble ${isUser ? 'out' : 'in'}`}>
                        <MessageAttachments attachments={msg.attachments || []} />
                        {msgText && <div className="message-text">{msgText}</div>}
                        {msg.diagram && <ExcalidrawDiagram diagram={msg.diagram} />}
                        <div className="message-meta">
                          {queuedUserMessageIds.has(String(msg.id)) && <span className="message-queued-label">⏳ {t('Eingereiht')} · </span>}
                          {formatTime(msg.ts, language)}
                        </div>
                      </div>
                    </div>
                    {isUser && <div style={{ width: 28 }} />}
                  </div>
                );
              })}
            </div>
          );
        })}

        {typingAgents.map(id => (
          <TypingBubble
            key={id}
            agent={getAgent(id)}
          />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Controls row (group only) */}
      {chat.type === 'group' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 16px', background: 'var(--bg-secondary)', borderTop: '1px solid var(--border)' }}>
          <div className={`toggle-switch ${autoRun ? 'on' : ''}`} onClick={() => { setAutoRun(!autoRun); autoRunRef.current = !autoRun; }}>
            <div className="toggle-knob" />
          </div>
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {autoRun ? t('Auto-Mode AN') : t('Auto-Mode AUS')}
          </span>
          {stoppedForUser && !running && (
            <span style={{ fontSize: 12, color: 'var(--accent)', marginLeft: 4 }}>⏸ {t('Wartet auf dich')}</span>
          )}
          {canResumeConversation && !running && (
            <span style={{ fontSize: 12, color: '#e6a23c', marginLeft: 4 }}>💾 {t('Arbeitsstand gespeichert')}</span>
          )}
          {providerCooldownActive && !running && (
            <span style={{ fontSize: 12, color: '#e6a23c', marginLeft: 4 }}>
              ⏳ {t('Provider-Limit · Fortsetzen in {seconds}s', { seconds: Math.ceil(providerRetryRemainingMs / 1000) })}
            </span>
          )}
          {queuedUserRequests.length > 0 && (
            <span className="user-queue-status">⏳ {t('Warteschlange: {count}', { count: queuedUserRequests.length })}</span>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            {hasRecentError && !running && (
              <button className="run-btn" style={{ background: 'rgba(192,57,43,0.5)' }} onClick={handleRetry}>
                ↺ Retry
              </button>
            )}
            {/* "Agenten laufen lassen" only makes sense when conversation is paused or no agents responded yet */}
            {!running && !stoppedForUser && (canStartAgentsManually || canResumeConversation || queuedUserRequests.length > 0) && (
              <button className="run-btn" onClick={handleRunNow}>
                {canResumeConversation
                  ? `▶ ${t('Fortsetzen')}`
                  : queuedUserRequests.length > 0
                    ? `▶ ${t('Warteschlange starten')}`
                    : `▶ ${t('Agenten starten')}`}
              </button>
            )}
            {running && (
              <button
                className="run-btn"
                style={{ background: 'rgba(192,57,43,0.75)' }}
                onClick={handleCancelRun}
              >■ {t('Abbrechen')}</button>
            )}
          </div>
        </div>
      )}

      {/* Input */}
      <div className="composer-area">
        {chat.type !== 'group' && queuedUserRequests.length > 0 && (
          <div className="direct-user-queue-status">⏳ {t('Warteschlange: {count}', { count: queuedUserRequests.length })}</div>
        )}
        {pendingAttachments.length > 0 && (
          <div className="pending-attachments" aria-label={t('Ausgewählte Anhänge')}>
            {pendingAttachments.map(attachment => (
              <div className="pending-attachment" key={attachment.id || attachment.name}>
                {attachment.kind === 'image'
                  ? <AttachmentImage attachment={attachment} compact />
                  : <span className="pending-attachment-icon">{attachmentIcon(attachment)}</span>}
                <span className="pending-attachment-details">
                  <span className="pending-attachment-name">{attachment.name}</span>
                  <span className="pending-attachment-size">{formatFileSize(attachment.size)}</span>
                </span>
                <button
                  type="button"
                  className="attachment-remove-btn"
                  title={t('Anhang entfernen')}
                  aria-label={t('Anhang entfernen')}
                  onClick={() => handleRemovePendingAttachment(attachment)}
                >×</button>
              </div>
            ))}
          </div>
        )}
        <div className="input-area" style={{ position: 'relative' }}>
          {chat.type !== 'group' && !running && (canResumeConversation || queuedUserRequests.length > 0) && (
            <button className="run-btn" onClick={handleRunNow} style={{ flexShrink: 0 }}>
              ▶ {canResumeConversation ? t('Fortsetzen') : t('Warteschlange starten')}
            </button>
          )}
          {mentionOpen && mentionItems.length > 0 && (
            <MentionDropdown
              items={mentionItems}
              filterText={mentionFilter}
              onSelect={handleMentionSelect}
            />
          )}
          <input
            ref={browserFileInputRef}
            type="file"
            multiple
            className="attachment-file-input"
            onChange={handleBrowserAttachments}
          />
          <select
            className="quality-mode-select"
            value={messageQualityMode}
            onChange={event => {
              setMessageQualityMode(event.target.value);
              window.requestAnimationFrame(focusComposer);
            }}
            title={t('Qualitätsmodus für diese Nachricht')}
            aria-label={t('Qualitätsmodus für diese Nachricht')}
          >
            <option value="fast">⚡ {t('Schnell')}</option>
            <option value="auto">⚖️ {t('Automatisch')}</option>
            <option value="deep">🧠 {t('Gründlich')}</option>
          </select>
          <button
            type="button"
            className="attach-btn"
            title={t('Dateien anhängen')}
            aria-label={t('Dateien anhängen')}
            onClick={handlePickAttachments}
            disabled={pendingAttachments.length >= 8}
          >📎</button>
          <textarea
            ref={textareaRef}
            className="message-input"
            autoFocus
            rows={1}
            placeholder={t('Nachricht eingeben… (@Name für Mentions)')}
            value={input}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
          />
          {running && chat.type !== 'group' && (
            <button
              className="run-btn"
              style={{ background: 'rgba(192,57,43,0.75)', flexShrink: 0 }}
              onClick={handleCancelRun}
            >■ {t('Abbrechen')}</button>
          )}
          <button
            className="send-btn"
            onClick={handleSend}
            disabled={!input.trim() && !pendingAttachments.length}
            title={running ? t('Nachricht einreihen') : t('Nachricht senden')}
            aria-label={running ? t('Nachricht einreihen') : t('Nachricht senden')}
          >➤</button>
        </div>
      </div>
      {memoryViewer.open && (
        <MemoryViewer
          entries={memoryViewer.entries}
          error={memoryViewer.error}
          loading={memoryViewer.loading}
          busy={memoryViewer.busy}
          namespace={memoryConfig.namespace}
          provider={memoryConfig.provider}
          filePath={memoryConfig.filePath}
          language={language}
          onClose={closeMemoryViewer}
          onCreateEntry={handleCreateMemoryEntry}
          onDeleteEntry={handleDeleteMemoryEntry}
          onClearAll={handleClearMemory}
        />
      )}
      {mcpApproval && (
        <McpPermissionDialog request={mcpApproval} onDecision={resolveMcpApproval} />
      )}
    </>
  );
}
