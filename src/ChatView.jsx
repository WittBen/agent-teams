import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useStore } from './store';
import { callLLM, PROVIDER_MODELS } from './llm';
import { callLLMWithMcp, createMcpToolSignature, getEffectiveMcpServers, getMcpToolPermissionDecision } from './mcp';
import {
  assessTaskComplexity,
  buildEscalationHistory,
  estimateTokens,
  evaluateResponseQuality,
  resolveQualityPolicy,
} from './quality-cascade';
import {
  addPlanningTask,
  addWorkflowConnection,
  addWorkflowPoint,
  addTaskEdge,
  applyAcceptanceDecisions,
  approveAgentDoneTasks,
  beginUserPlanEdit,
  createTaskGraph,
  findDependencyPreparationCandidateIds,
  findSafeAutoParallelTaskIds,
  inferHandoffDependency,
  inferTaskNodeType,
  isTaskNodeReady,
  lockTaskGraphPlan,
  markTaskGraphUserOwned,
  materializeTaskPlan,
  movePlanningTask,
  normalizeAcceptanceCriteria,
  orderTasksForParallelSelection,
  recordTaskExecutionEvent,
  resetWorkflowViewState,
  retryTaskNode,
  restoreTaskGraphSnapshot,
  removePlanningTask,
  removeWorkflowConnection,
  removeWorkflowPoint,
  removeTaskDependency,
  runTaskBatch,
  submitTaskEvidence,
  summarizeAcceptance,
  splitPlanningTask,
  updateTaskNodeStatus,
  updatePlanningTask,
  updateWorkflowViewPosition,
  upsertTaskNode,
  validateParallelSelection,
  validateApprovedTaskExecution,
  validateWorkflowConnection,
  validateWorkflowPlan,
  workflowDependencyAncestorIds,
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
import { getProviderEmoji, getProviderModels } from './provider-catalog';
import { acquireAgentLease } from './agent-runtime';
import {
  createCrossGroupRequest,
  extractGroupMentions,
  finishRequestRuntimePlan,
  isCrossGroupRequestTerminal,
  requestsForChat,
} from './cross-group';
import { evaluateTaskDelegation, normalizeCrossGroupTargetIds, normalizeDelegationPolicy } from './delegation';
import WorkflowProblemDialog from './WorkflowProblemDialog';
import {
  createImportedTaskGraph,
  createWorkflowExportDocument,
  suggestWorkflowAgentMappings,
} from './workflow-portability';
import {
  AgentTaskQueue,
  buildAgentSession,
  buildIsolatedSystemPrompt,
  buildProjectReviewEvidence,
  buildRelevantConversationHistory,
  buildRelevantProjectInventoryContext,
  buildTaskCapsule,
  buildTurnLimitReviewTask,
  buildTimeoutRecoveryReviewTask,
  buildTimeoutRecoveryTask,
  buildUserAnswerTask,
  cleanAgentReply,
  createHandoff,
  distributeTaskPlanAcrossAgentPools,
  extractAcceptanceReview,
  extractHandoffsFromReply,
  extractProjectFiles,
  extractTaskPlan,
  extractTaskEvidence,
  extractUserQuestions,
  getGroupPMAgent,
  hasDirectedMention,
  hasUserDirectedMention,
  isAgentTimeoutError,
  normalizeAgentMentionLayout,
  orchestrate,
  shouldCompleteProject,
  shouldDeferHandoffToPM,
  shouldMaterializeTaskPlan,
  shouldRequestPMFinalReview,
  shouldRunAsWorkflowSideConversation,
  summarizeTaskActivity,
} from './orchestrator';

// In-flight conversations are intentionally short-lived runtime state. Keeping
// them by chat id lets users switch chats while an @user pause is active.
const conversationContinuations = new Map();
const FINISHED_PLAN_STATUSES = new Set(['agent_done', 'completed']);
const CLAIMABLE_PLAN_STATUSES = new Set(['planned', 'queued', 'prepared', 'interrupted', 'retryable']);
const RESUMABLE_CHECKPOINT_STATUSES = new Set(['running', 'interrupted', 'provider-limited', 'limit-reached']);
const CLEARED_PREPARATION_STATE = {
  preparationAttemptedAt: undefined,
  preparationCompletedAt: undefined,
  preparationFailedAt: undefined,
  preparationError: undefined,
  interimResult: undefined,
  interimSavedAt: undefined,
  interimConsumedAt: undefined,
  preparedFiles: undefined,
};

function buildRecoveryUserQuestion({ recovery, errorMessage = '', pmReply = '' } = {}) {
  const trigger = recovery?.trigger === 'quality'
    ? 'Qualitätsproblem'
    : recovery?.trigger === 'error' ? 'Ausführungsproblem' : 'Timeout';
  const originalTask = String(recovery?.originalObjective || 'Die ursprüngliche Aufgabe').slice(0, 1200);
  const diagnosis = String(errorMessage || pmReply || 'Der PM konnte innerhalb des freigegebenen Plans keine sichere Lösung bestätigen.')
    .replace(/\s+/g, ' ').trim().slice(0, 1200);
  return [
    `Der PM konnte das ${trigger} nicht sicher innerhalb des freigegebenen Plans lösen.`,
    `Aufgabe: ${originalTask}`,
    `Diagnose: ${diagnosis}`,
    'Wie soll weitergegangen werden?',
    '1. Dieselbe Aufgabe mit dem vorhandenen Plan erneut versuchen.',
    '2. Den Planungsmodus öffnen und die Aufgabe, Abhängigkeiten oder Agentenzuordnung anpassen.',
    'Du kannst auch eine eigene Entscheidung oder zusätzliche Information eingeben.',
  ].join('\n');
}

function buildDelegatedTaskQuestion(node, policy) {
  const criteria = (node?.acceptanceCriteria || [])
    .filter(criterion => criterion?.text)
    .map(criterion => `- ${criterion.text}`)
    .join('\n');
  return [
    `Aufgabe: ${node?.objective || node?.title || 'Delegierte Aufgabe'}`,
    `Benötigte Fähigkeiten: ${policy.requiredCapabilities.join(', ')}`,
    criteria ? `Abnahmekriterien:\n${criteria}` : '',
    'Liefere ein eigenständiges Ergebnis und nenne die konkrete Evidenz, anhand derer die Ursprungsgruppe es prüfen kann.',
  ].filter(Boolean).join('\n\n');
}

function buildWorkflowModelOptions(graph, agents, providerConnections) {
  return Object.fromEntries((graph?.nodes || []).flatMap(node => {
    const agent = agents.find(candidate => candidate.id === node.agentId);
    if (!agent?.provider || !agent?.model) return [];
    const models = getProviderModels(
      agent.provider,
      providerConnections,
      PROVIDER_MODELS,
      node.modelOverride || agent.model,
    );
    return [[node.id, {
      provider: agent.provider,
      defaultModel: agent.model,
      currentModel: node.modelOverride || agent.model,
      models,
    }]];
  }));
}

function isAgentProviderConfigured(agent, apiKeys, providerConnections) {
  const provider = agent?.provider || 'openai';
  if (provider === 'codex') return apiKeys?.codexCli !== false;
  if (provider === 'anthropic') return Boolean(
    apiKeys?.anthropic?.trim() || apiKeys?.anthropicConfigured || apiKeys?.claudeCli ||
    (typeof process !== 'undefined' && process.env?.ANTHROPIC_API_KEY)
  );
  if (provider === 'openai') return Boolean(
    apiKeys?.openai?.trim() || apiKeys?.openaiConfigured ||
    (typeof process !== 'undefined' && process.env?.OPENAI_API_KEY)
  );
  const connection = providerConnections.find(item => item.id === provider);
  return Boolean(connection && (connection.requiresApiKey === false || apiKeys?.providerConfigured?.[provider]));
}

/** Create task-specific, actionable preflight problems for workflow and chat UIs. */
function collectWorkflowProblems({ graph, sourceGroup, groups, agents, chatAgents, apiKeys, providerConnections, t }) {
  const nodes = graph?.nodes || [];
  const problems = new Map();
  const addProblem = problem => {
    if (!problem?.taskId || problems.has(problem.taskId)) return;
    problems.set(problem.taskId, problem);
  };
  const validation = validateWorkflowPlan(graph);
  if (!validation.ok) {
    for (const taskId of validation.taskIds || []) {
      const node = nodes.find(candidate => candidate.id === taskId);
      addProblem({
        taskId,
        taskTitle: node?.title || taskId,
        kind: 'validation',
        message: t(validation.messageKey || validation.reason, validation.messageValues),
        suggestion: t('Prüfe die markierte Aufgabenangabe und ihre Verbindungen. Der PM kann den Plan anhand deiner Vorgabe korrigieren.'),
      });
    }
  }
  for (const node of nodes.filter(candidate => inferTaskNodeType(candidate) !== 'request')) {
    const agent = chatAgents.find(candidate => candidate.id === node.agentId);
    if (!agent || isAgentProviderConfigured(agent, apiKeys, providerConnections)) continue;
    addProblem({
      taskId: node.id,
      taskTitle: node.title,
      kind: 'provider',
      message: t('Der Provider für {agent} ist nicht verbunden.', { agent: agent.name }),
      suggestion: t('Verbinde den Provider oder weise die Aufgabe einem verfügbaren Agenten zu.'),
    });
  }
  for (const node of nodes.filter(candidate => inferTaskNodeType(candidate) === 'task')) {
    const decision = evaluateTaskDelegation({ taskNode: node, sourceGroup, groups, agents });
    if (decision.action !== 'unavailable') continue;
    const requiredCapabilities = decision.policy.requiredCapabilities.join(', ');
    addProblem({
      taskId: node.id,
      taskTitle: node.title,
      kind: 'delegation',
      message: t('Für „{task}“ ist keine erreichbare Gruppe mit ausreichender Kompetenzabdeckung verfügbar.', { task: node.title }),
      suggestion: t('Ergänze die fehlenden Agentenfähigkeiten oder passe die benötigten Fähigkeiten der Aufgabe an: {capabilities}', { capabilities: requiredCapabilities }),
      requiredCapabilities: decision.policy.requiredCapabilities,
    });
  }
  return [...problems.values()];
}

function buildPlanningPendingTasks(graph, checkpoint, agents) {
  const existingByNodeId = new Map((checkpoint?.pendingTasks || [])
    .filter(task => task?.graphNodeId)
    .map(task => [task.graphNodeId, task]));
  const planRootId = checkpoint?.planRootGraphNodeId;
  if (!planRootId) return checkpoint?.pendingTasks || [];

  // Rebuild pending work from the graph instead of trusting a stale
  // checkpoint. Finished or dependency-blocked tasks must never be replayed.
  return (graph?.nodes || [])
    .filter(node =>
      node.planRootId === planRootId &&
      inferTaskNodeType(node) !== 'request' &&
      CLAIMABLE_PLAN_STATUSES.has(node.status) &&
      isTaskNodeReady(graph, node.id)
    )
    .sort((left, right) => (left.planOrder || 0) - (right.planOrder || 0))
    .flatMap(node => {
      const agent = agents.find(candidate => candidate.id === node.agentId);
      if (!agent) return [];
      const existing = existingByNodeId.get(node.id);
      return [{
        ...existing,
        agent,
        objective: node.objective || node.title,
        source: existing?.source || node.source || 'PM-Plan',
        runtimeRecovery: existing?.runtimeRecovery || node.runtimeRecovery || false,
        recovery: existing?.recovery || node.recovery,
        graphNodeId: node.id,
        planRootId: node.planRootId,
        planTaskId: node.planTaskId,
        modelOverride: node.modelOverride,
      }];
    });
}

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

function formatAcceptanceContext(nodes = []) {
  const lines = [];
  for (const node of nodes) {
    for (const criterion of node.acceptanceCriteria || []) {
      const evidence = (criterion.evidence || []).at(-1);
      lines.push(
        `  - Kriterium ${criterion.id}: ${criterion.text} | erforderlich: ${criterion.required !== false ? 'ja' : 'nein'} | Prüfung: ${criterion.verification || 'reviewer'} | Status: ${criterion.status || 'open'}${evidence ? ` | Letzter Nachweis von ${evidence.author || 'Agent'}: ${evidence.summary}` : ''}`,
      );
    }
  }
  return lines.length ? `\nAbnahmestand:\n${lines.join('\n')}` : '';
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

function fallbackCopyText(text) {
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

async function copyText(text) {
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

function MessageCopyButton({ text }) {
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

// Inline system bubble with optional contextual action such as retry or approval.
function ErrorBubble({ text, onRetry, action = null, isError = true }) {
  return (
    <div className="system-message-bubble" style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      background: isError ? 'rgba(192,57,43,0.15)' : 'rgba(0,168,132,0.12)',
      border: isError ? '1px solid rgba(192,57,43,0.4)' : '1px solid rgba(0,168,132,0.35)',
      borderRadius: 8, padding: '8px 40px 8px 12px', margin: '4px 0',
      fontSize: 13, color: isError ? '#e88' : 'var(--text-primary)',
    }}>
      <span className="system-message-text" style={{ flex: 1, lineHeight: 1.5 }}>{text}</span>
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

function McpPermissionPrompt({ request, onDecision }) {
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

function MemoryBadge({ count, onOpen }) {
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

export default function ChatView({ chat, onEditGroup, active = true }) {
  const { language, t } = useI18n();
  const {
    agents,
    groups,
    messages,
    conversationStates,
    userRequestQueues,
    taskGraphs,
    crossGroupRequests,
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
    enqueueCrossGroupRequest,
    updateCrossGroupRequest,
    retryCrossGroupRequest,
    removeCrossGroupRequests,
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
  const chatAgents = chat.type === 'group'
    ? agents.filter(agent => chat.agentIds?.includes(agent.id))
    : agents.filter(agent => agent.id === chat.id);
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
  const [workflowImportDraft, setWorkflowImportDraft] = useState(null);
  const [workflowFileStatus, setWorkflowFileStatus] = useState({ busy: '', message: '', error: '' });
  const [openWorkflowProblem, setOpenWorkflowProblem] = useState(null);
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
  const workflowUndoStackRef = useRef([]);
  const workflowQuestionAnswerPendingRef = useRef(false);
  const workflowProblemAnswerPendingRef = useRef(false);
  const announcedWorkflowProblemKeysRef = useRef(new Set());
  const workflowDeletePendingRef = useRef(false);
  const mcpApprovalQueueRef = useRef([]);
  const activeMcpApprovalRef = useRef(null);
  const excalidrawCheckpointsRef = useRef(new Map());
  const reportedMcpErrorsRef = useRef(new Set());
  const memoryRefreshRequestRef = useRef(0);
  const workflowImportWindowState = useMemo(() => workflowImportDraft ? {
    fileName: workflowImportDraft.fileName,
    title: workflowImportDraft.document.title,
    description: workflowImportDraft.document.description,
    slots: workflowImportDraft.slots,
    mappings: workflowImportDraft.mappings,
    replacesExistingWorkflow: workflowImportDraft.replacesExistingWorkflow,
  } : null, [workflowImportDraft]);

  const focusComposer = useCallback(() => {
    if (!active) return;
    const textarea = textareaRef.current;
    if (!textarea || textarea.disabled || document.activeElement === textarea) return;
    const selectionStart = textarea.selectionStart;
    const selectionEnd = textarea.selectionEnd;
    textarea.focus({ preventScroll: true });
    if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) {
      textarea.setSelectionRange(selectionStart, selectionEnd);
    }
  }, [active]);

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

  const getActiveWorkflowTaskIds = useCallback((graph = taskGraphRef.current) => {
    const activeTaskIds = new Set(
      [...activeAgentRunRef.current.values()]
        .map(activeRun => activeRun.graphNodeId)
        .filter(Boolean),
    );
    (graph?.nodes || []).forEach(node => {
      if (node.status === 'running') activeTaskIds.add(node.id);
    });
    return [...activeTaskIds];
  }, []);

  const getPendingWorkflowQuestions = useCallback((checkpoint) => {
    if (checkpoint?.status !== 'awaiting-user' || !checkpoint.askingGraphNodeId) return [];
    const storedQuestion = String(checkpoint.question || '').trim();
    const containsUserDirective = /^@user\b/im.test(storedQuestion);
    const directedQuestions = containsUserDirective ? extractUserQuestions(storedQuestion) : [];
    // Older checkpoints may contain the whole agent response followed by a
    // bare @user marker. Never expose that report as if it were the question.
    const question = directedQuestions.length
      ? directedQuestions.join('\n')
      : containsUserDirective
        ? t('Der Agent hat keine konkrete Rückfrage formuliert. Wie soll die Aufgabe fortgesetzt werden?')
        : storedQuestion;
    if (!question) return [];
    return [{
      taskId: checkpoint.askingGraphNodeId,
      agentId: checkpoint.askingAgent?.id || '',
      agentName: checkpoint.askingAgent?.name || '',
      question,
    }];
  }, [t]);

  const openTaskGraphWindow = useCallback((overrides = {}) => {
    if (chat.type !== 'group' || !window.electronAPI?.openTaskWindow) return;
    const graph = taskGraphRef.current || createTaskGraph(chat.id, chat.name);
    const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
    const resumeRemainingMs = checkpoint?.status === 'provider-limited'
      ? Math.max(0, (checkpoint.retryNotBefore || 0) - Date.now())
      : 0;
    const resumeMode = RESUMABLE_CHECKPOINT_STATUSES.has(checkpoint?.status);
    const windowGroupRequests = requestsForChat(crossGroupRequests, chat.id);
    const graphValidation = validateWorkflowPlan(graph);
    const workflowProblems = collectWorkflowProblems({
      graph,
      sourceGroup: chat,
      groups,
      agents,
      chatAgents,
      apiKeys,
      providerConnections,
      t,
    });
    const preflightError = workflowProblems[0]?.message || (!graphValidation.ok
      ? t(graphValidation.messageKey || graphValidation.reason, graphValidation.messageValues)
      : '');
    const preflightTaskIds = workflowProblems.map(problem => problem.taskId);
    window.electronAPI.openTaskWindow({
      chatId: chat.id,
      chatName: chat.name,
      windowTitle: `${t('Workflow')} – ${chat.name}`,
      graph,
      running,
      activeTaskIds: getActiveWorkflowTaskIds(graph),
      pendingQuestions: getPendingWorkflowQuestions(checkpoint),
      workflowProblems,
      groupRequests: windowGroupRequests,
      resumeMode,
      canResumeWorkflow: resumeMode && resumeRemainingMs === 0,
      resumeRetrySeconds: Math.ceil(resumeRemainingMs / 1000),
      canUndo: workflowUndoStackRef.current.length > 0,
      canDeleteWorkflow: Boolean(checkpoint || graph.nodes.length > 0 || windowGroupRequests.length > 0),
      workflowImport: workflowImportWindowState,
      workflowFileStatus,
      awaitingSchedule: checkpoint?.mode === 'planning' || checkpoint?.status === 'awaiting-schedule',
      structureEditable: checkpoint?.mode === 'planning' && !running,
      canEditWorkflow: checkpoint?.mode !== 'planning' && graph.nodes.length > 0,
      modelOptionsByTask: buildWorkflowModelOptions(graph, chatAgents, providerConnections),
      agentOptions: chatAgents.map(({ id, name, emoji, role, provider, model }) => ({ id, name, emoji, role, provider, model })),
      preflightError,
      preflightTaskIds,
      ...overrides,
    }).catch(() => null);
  }, [agents, apiKeys, chat, chatAgents, conversationStates, crossGroupRequests, getActiveWorkflowTaskIds, getPendingWorkflowQuestions, groups, providerConnections, running, t, workflowFileStatus, workflowImportWindowState]);

  const openReviewWindow = useCallback(() => {
    if (chat.type !== 'group' || !projectPath || !window.electronAPI?.openReviewWindow) return;
    window.electronAPI.openReviewWindow({
      chatId: chat.id,
      windowTitle: `${t('Prüfumgebung')} – ${chat.name}`,
    }).catch(error => {
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🧪|${error.message || t('Prüfumgebung konnte nicht geöffnet werden.')}`,
        ts: Date.now(), isError: true,
      });
    });
  }, [addMessage, chat.id, chat.name, chat.type, projectPath, t]);

  // Mention autocomplete state
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionFilter, setMentionFilter] = useState('');
  const [mentionStart, setMentionStart] = useState(-1);

  const chatMessages = messages[chat.id] || [];
  const chatGroupRequests = useMemo(
    () => requestsForChat(crossGroupRequests, chat.id),
    [chat.id, crossGroupRequests],
  );
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
  const reachableCrossGroupIds = useMemo(
    () => normalizeCrossGroupTargetIds(chat.crossGroupTargetGroupIds, chat.crossGroupTargetGroupId),
    [chat.crossGroupTargetGroupId, chat.crossGroupTargetGroupIds],
  );

  // Group names are first-class @targets. Their stable ids disambiguate them
  // from equally named agents after the visible mention has been inserted.
  const mentionItems = chat.type === 'group' ? [
    { id: 'everyone', label: 'everyone', emoji: '📢', role: t('Alle Agenten') },
    { id: 'user', label: 'user', emoji: '👤', role: t('Du') },
    ...groups
      .filter(group => (
        chat.crossGroupCollaborationEnabled &&
        group.id !== chat.id &&
        reachableCrossGroupIds.includes(group.id)
      ))
      .map(group => ({ id: `group:${group.id}`, label: group.name, emoji: group.emoji || '💬', role: t('Gruppe'), kind: 'group' })),
    ...chatAgents.map(a => ({ id: a.id, label: a.name, emoji: a.emoji || '🤖', role: a.role })),
  ] : [];

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages, typingAgents, agentProgress, mcpApproval]);
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

  const refreshMemoryState = useCallback(async ({ updateOpenViewer = false } = {}) => {
    const requestId = ++memoryRefreshRequestRef.current;
    if (!memoryAPI) {
      setMemoryCount(0);
      return [];
    }
    try {
      const entries = await memoryAPI.list(memoryConfig.namespace);
      if (requestId !== memoryRefreshRequestRef.current) return entries;
      setMemoryCount(entries.length);
      if (updateOpenViewer) {
        setMemoryViewer(current => current.open
          ? { ...current, loading: false, entries, error: '' }
          : current);
      }
      return entries;
    } catch {
      if (requestId !== memoryRefreshRequestRef.current) return [];
      setMemoryCount(0);
      return [];
    }
  }, [memoryAPI, memoryConfig?.namespace]);

  const refreshMemoryCount = useCallback(() => refreshMemoryState(), [refreshMemoryState]);

  useEffect(() => { refreshMemoryCount(); }, [refreshMemoryCount]);

  useEffect(() => {
    if (!memoryAPI?.subscribe || !memoryConfig?.namespace) return undefined;
    return memoryAPI.subscribe(change => {
      if (change?.namespace !== memoryConfig.namespace) return;
      void refreshMemoryState({ updateOpenViewer: true });
    });
  }, [memoryAPI, memoryConfig?.namespace, refreshMemoryState]);

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
    const currentGraph = taskGraphRef.current || createTaskGraph(chat.id, chat.name);
    const existingNode = currentGraph.nodes.find(node => node.id === graphNodeId);
    const parentNode = parentNodeId ? currentGraph.nodes.find(node => node.id === parentNodeId) : null;
    const nodeType = inferTaskNodeType({ source: task.source || 'user', parentNodeId });
    const planRootId = task.planRootId || existingNode?.planRootId || parentNode?.planRootId ||
      (parentNode?.nodeType === 'request' ? parentNode.id : null);
    const title = summarizeTaskActivity({ objective: task.objective, source: task.source, handoff: task.handoff })
      .replace(/^(?:Arbeitet an|Bearbeitet die Übergabe):\s*/i, '');
    const acceptanceCriteria = existingNode?.acceptanceCriteria?.length
      ? existingNode.acceptanceCriteria
      : normalizeAcceptanceCriteria(task.acceptanceCriteria, {
        taskId: task.planTaskId || graphNodeId,
        fallbackText: nodeType === 'task' && task.source !== 'user'
          ? `Das Ergebnis erfüllt die Aufgabe „${title}“ vollständig und überprüfbar.`
          : '',
      });
    if (planRootId) task.planRootId = planRootId;
    const graphNode = {
      id: graphNodeId,
      // A preparation pass is runtime metadata on the approved task. Keep the
      // user-authored identity visible and immutable while that pass runs.
      title: task.preparationOnly && existingNode ? existingNode.title : title,
      objective: task.preparationOnly && existingNode
        ? existingNode.objective
        : task.handoff?.summary || task.objective,
      agentId: task.agent.id,
      agentName: task.agent.name,
      status,
      source: task.preparationOnly && existingNode ? existingNode.source : task.source || 'user',
      nodeType: task.preparationOnly && existingNode ? existingNode.nodeType : nodeType,
      acceptanceCriteria,
      provider: task.agent.provider || existingNode?.provider,
      model: task.agent.model || existingNode?.model,
      ...(task.modelOverride || existingNode?.modelOverride
        ? { modelOverride: task.modelOverride || existingNode?.modelOverride }
        : {}),
      ...(task.runtimeRecovery || existingNode?.runtimeRecovery ? {
        runtimeRecovery: true,
        recovery: task.recovery || existingNode?.recovery,
      } : {}),
    };
    if (planRootId) graphNode.planRootId = planRootId;
    if (task.planTaskId) graphNode.planTaskId = task.planTaskId;
    // Do not overwrite a persisted primary parent when an existing task is
    // restored without fresh hierarchy information.
    if (parentNodeId) graphNode.parentNodeId = parentNodeId;
    let nextGraph = upsertTaskNode(currentGraph, graphNode);
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

  const runAgents = useCallback(async (history, triggerText, options = {}) => {
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

    const persistedContinuation = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || null;
    const explicitMentions = chatAgents.filter(agent =>
      hasUserDirectedMention(triggerText || '', agent.name)
    );
    const sideConversation = shouldRunAsWorkflowSideConversation({
      chatType: chat.type,
      triggerText,
      chatAgents,
      continuation: persistedContinuation,
    });
    const savedContinuation = sideConversation ? null : persistedContinuation;
    const planningOnly = options.planningOnly === true || savedContinuation?.mode === 'planning';
    const restartPlanningFromScratch = planningOnly && taskGraphRef.current?.workflowResetRequired === true;
    const latestUserMessage = [...(history || [])].reverse().find(message => message?.agentId === 'user');
    const latestUserAttachments = latestUserMessage?.attachments || [];
    const activeQualityMode = triggerText
      ? (latestUserMessage?.qualityMode || 'auto')
      : (savedContinuation?.qualityMode || latestUserMessage?.qualityMode || 'auto');
    const attachmentKeys = new Set();
    let retainedGroupWaits = Array.isArray(savedContinuation?.waitingGroupTasks)
      ? [...savedContinuation.waitingGroupTasks]
      : [];
    let retainedDelegationWaits = Array.isArray(savedContinuation?.waitingDelegationTasks)
      ? [...savedContinuation.waitingDelegationTasks]
      : [];
    const activeAttachments = [...latestUserAttachments, ...(savedContinuation?.attachments || [])]
      .filter(attachment => {
        const key = attachment?.id || attachment?.path || attachment?.name;
        if (!key || attachmentKeys.has(key)) return false;
        attachmentKeys.add(key);
        return true;
      })
      .slice(0, 8);
    const persistRunCheckpoint = state => {
      if (sideConversation) return;
      persistConversationCheckpoint({
        ...state,
        ...(retainedGroupWaits.length > 0 ? { waitingGroupTasks: retainedGroupWaits } : { waitingGroupTasks: undefined }),
        ...(retainedDelegationWaits.length > 0
          ? { waitingDelegationTasks: retainedDelegationWaits }
          : { waitingDelegationTasks: undefined }),
        ...(planningOnly ? { mode: 'planning' } : {}),
        attachments: activeAttachments,
        qualityMode: activeQualityMode,
      });
    };
    const finishRunCheckpoint = () => {
      if (!sideConversation) discardConversationCheckpoint();
    };
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

    // Keep only a lightweight inventory here. KB and project context are
    // selected separately for each task, including parallel agent runs.
    let projectInventory = [];
    if (projectPath && window.electronAPI?.projectList) {
      const projectResult = await window.electronAPI.projectList({ projectPath });
      projectInventory = Array.isArray(projectResult?.files) ? projectResult.files : [];
    }

    // Load shared memory for this group (lazy — only top-N relevant entries)
    const memoryNamespace = memoryEnabled ? memoryConfig.namespace : null;
    const memAPI = memoryEnabled ? memoryAPI : null;

    // ── Chain-conversation engine ──────────────────────────────────────────
    const isEveryoneCall = hasUserDirectedMention(triggerText || '', 'everyone');
    let pendingAgents = [];

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

    if (planningOnly && pm) pendingAgents = [pm];

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
    let planningDraftTasks = [...(savedContinuation?.pendingTasks || [])];

    if (planningOnly && pm) {
      const planningTask = registerGraphTask({
        agent: pm,
        objective: triggerText || initialObjective || 'Besprich und aktualisiere den Workflow mit dem User.',
        source: 'user',
        ...(activePlanRootNodeId ? { graphNodeId: activePlanRootNodeId } : {}),
      }, { status: 'queued' });
      activePlanRootNodeId = planningTask.graphNodeId;
      taskQueue.enqueue(planningTask);
    } else if (savedContinuation) {
      const restoreTask = (pendingTask) => {
        const restoredAgent = chatAgents.find(candidate =>
          candidate.id === pendingTask?.agent?.id || candidate.name === pendingTask?.agent?.name
        );
        return restoredAgent ? {
          ...pendingTask,
          agent: pendingTask.modelOverride
            ? { ...restoredAgent, model: pendingTask.modelOverride }
            : restoredAgent,
        } : null;
      };
      const restoredPendingTasks = orderTasksForParallelSelection((savedContinuation.pendingTasks || [])
        .map(restoreTask)
        .filter(Boolean), requestedParallelTaskIds);
      const awaitsUserAnswer = savedContinuation.status === 'awaiting-user' ||
        (!savedContinuation.status && savedContinuation.askingAgent);
      const awaitsGroupAnswer = Boolean(options.crossGroupBatchId) &&
        (savedContinuation.waitingGroupTasks || []).some(wait => wait.batchId === options.crossGroupBatchId);

      if (awaitsGroupAnswer) {
        const waitingGroupTasks = Array.isArray(savedContinuation.waitingGroupTasks)
          ? savedContinuation.waitingGroupTasks
          : [];
        const answeredBatchId = String(options.crossGroupBatchId || '');
        const answeredWaits = waitingGroupTasks.filter(wait => wait.batchId === answeredBatchId);
        retainedGroupWaits = waitingGroupTasks.filter(wait => wait.batchId !== answeredBatchId);
        if (!triggerText || !answeredBatchId || answeredWaits.length === 0) {
          setRunning(false);
          return;
        }
        for (const wait of answeredWaits) {
          const waitingTask = restoreTask(wait.task);
          if (!waitingTask) continue;
          const delegatedTaskResult = wait.kind === 'task_delegation';
          const savedInterim = String(wait.interimResult || '').trim();
          const answerTask = {
            ...waitingTask,
            objective: [
              waitingTask.objective || 'Setze die wartende Aufgabe fort.',
              savedInterim ? `Zwischengespeicherter Arbeitsstand vor der Rückfrage:\n${savedInterim.slice(0, 12000)}` : '',
              `${delegatedTaskResult ? 'Ergebnis der delegierten Ausführung' : 'Antwort der angefragten Gruppe(n)'}:\n${triggerText}`,
              'Setze auf diesem Arbeitsstand auf und wiederhole bereits erledigte Schritte nicht.',
            ].filter(Boolean).join('\n\n'),
            source: 'group-answer',
            approvedContinuation: true,
            delegatedTaskResult,
            crossGroupBatchId: answeredBatchId,
            crossGroupRequestIds: wait.requestIds || [],
          };
          registerGraphTask(answerTask, { status: 'queued' });
          taskQueue.enqueue(answerTask);
          if (answerTask.graphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(graph, answerTask.graphNodeId, 'queued', {
              groupAnsweredAt: Date.now(),
              waitingGroupNames: [],
              ...(savedInterim ? { interimResult: savedInterim, interimResumedAt: Date.now() } : {}),
              ...(delegatedTaskResult ? { delegationCompletedAt: Date.now() } : {}),
            }));
          }
        }
      } else if (awaitsUserAnswer) {
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
          const askingNode = savedContinuation.askingGraphNodeId
            ? taskGraphRef.current?.nodes?.find(node => node.id === savedContinuation.askingGraphNodeId)
            : null;
          if (taskGraphRef.current?.approvedPlan && askingNode) {
            answerTask.graphNodeId = askingNode.id;
            answerTask.planRootId = askingNode.planRootId;
            answerTask.planTaskId = askingNode.planTaskId;
            answerTask.approvedContinuation = true;
            if (askingNode.modelOverride || askingNode.model) answerTask.modelOverride = askingNode.modelOverride || askingNode.model;
            if (askingNode.runtimeRecovery && askingNode.recovery) {
              answerTask.source = 'timeout-recovery';
              answerTask.runtimeRecovery = true;
              answerTask.recovery = askingNode.recovery;
              // Runtime recovery nodes are intentionally outside the approved
              // contract but remain authorized through their original task.
              answerTask.modelOverride = undefined;
            }
          }
          registerGraphTask(answerTask, {
            status: 'queued',
            parentNodeId: answerTask.graphNodeId === savedContinuation.askingGraphNodeId
              ? null
              : savedContinuation.askingGraphNodeId || null,
          });
          taskQueue.enqueue(answerTask);
          if (savedContinuation.askingGraphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(
              graph,
              savedContinuation.askingGraphNodeId,
              answerTask.graphNodeId === savedContinuation.askingGraphNodeId ? 'queued' : 'agent_done',
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
        const taskDraft = {
          agent,
          objective: initialObjective,
          source: 'user',
          routeMode: route.mode,
          explicitMentionCount: explicitMentions.length,
          explicitlyAddressedAgentId: explicitMentions.length === 1 ? explicitMentions[0].id : null,
          outOfBand: sideConversation,
        };
        const initialTask = sideConversation
          ? taskDraft
          : registerGraphTask(taskDraft, { status: 'queued' });
        if (chat.type === 'group' && agent.id === pm?.id && !activePlanRootNodeId) {
          activePlanRootNodeId = initialTask.graphNodeId;
        }
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
      const liveTaskNode = task.graphNodeId
        ? taskGraphRef.current?.nodes?.find(node => node.id === task.graphNodeId)
        : null;
      const mayRouteDelegation = Boolean(
        chat.type === 'group' &&
        taskGraphRef.current?.approvedPlan &&
        liveTaskNode &&
        inferTaskNodeType(liveTaskNode) === 'task' &&
        !task.outOfBand &&
        !task.runtimeRecovery &&
        !task.preparationOnly &&
        task.source !== 'group-answer'
      );
      if (mayRouteDelegation) {
        const delegationDecision = evaluateTaskDelegation({
          taskNode: liveTaskNode,
          sourceGroup: chat,
          groups,
          agents,
        });
        if (delegationDecision.action === 'delegate') {
          const candidate = delegationDecision.candidate;
          const targetGroup = groups.find(group => group.id === candidate.groupId);
          const targetAgent = agents.find(candidateAgent => candidateAgent.id === candidate.agentId);
          const targetAgents = (candidate.agentIds || [candidate.agentId])
            .map(agentId => agents.find(candidateAgent => candidateAgent.id === agentId))
            .filter(Boolean);
          const batchId = `task-delegation-batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const request = createCrossGroupRequest({
            sourceGroup: chat,
            sourceTask: task,
            sourceAgent: agent,
            targetGroup,
            targetAgent,
            targetAgents,
            question: buildDelegatedTaskQuestion(liveTaskNode, delegationDecision.policy),
            attachments: activeAttachments,
            batchId,
            origin: 'agent',
            kind: 'task_delegation',
            requiredCapabilities: delegationDecision.policy.requiredCapabilities,
            delegationReason: delegationDecision.reason,
            qualityMode: activeQualityMode,
          });
          if (request) {
            enqueueCrossGroupRequest(request);
            setGraphTaskStatus(task, 'waiting_group', {
              delegationKind: 'task',
              delegatedToGroupId: request.targetGroupId,
              delegatedToGroupName: request.targetGroupName,
              delegatedToAgentId: request.targetAgentId,
              delegatedToAgentName: request.targetAgentName,
              waitingGroupRequestIds: [request.id],
              groupWaitStartedAt: Date.now(),
            });
            commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'delegated', {
              requestId: request.id,
              targetGroupId: request.targetGroupId,
              targetAgentId: request.targetAgentId,
            }));
            addMessage(chat.id, {
              id: `task-delegation-${request.id}`,
              agentId: 'system',
              senderName: 'System',
              text: `⇄|${t('„{task}“ wird von {agent} in {group} ausgeführt. Unabhängige Aufgaben laufen parallel weiter.', {
                task: liveTaskNode.title,
                agent: request.targetAgentName,
                group: request.targetGroupName,
              })}`,
              ts: Date.now(),
              isError: false,
            });
            return {
              task,
              agent,
              groupPauseRequested: true,
              groupPauseRequests: [request],
              delegatedTask: true,
            };
          }
        }
        if (delegationDecision.action === 'ask') {
          const proposal = {
            id: `delegation-proposal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            taskId: liveTaskNode.id,
            taskTitle: liveTaskNode.title,
            requiredCapabilities: delegationDecision.policy.requiredCapabilities,
            candidate: delegationDecision.candidate,
            candidates: delegationDecision.candidates,
            createdAt: Date.now(),
          };
          setGraphTaskStatus(task, 'delegation_pending', { delegationProposal: proposal });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'delegation-proposed', {
            targetGroupId: proposal.candidate.groupId,
            targetAgentId: proposal.candidate.agentId,
          }));
          addMessage(chat.id, {
            id: proposal.id,
            agentId: 'system',
            senderName: 'System',
            text: `⇄|${t('Für „{task}“ gibt es lokal keinen passenden Experten. Delegation an {agent} in {group} hier oder im Workflow freigeben oder lokal ausführen.', {
              task: liveTaskNode.title,
              agent: proposal.candidate.agentName,
              group: proposal.candidate.groupName,
            })}`,
            ts: Date.now(),
            isError: false,
            delegationTaskId: liveTaskNode.id,
          });
          return { task, agent, delegationApprovalRequested: true, delegationProposal: proposal };
        }
        if (delegationDecision.action === 'unavailable') {
          setGraphTaskStatus(task, 'blocked', {
            blockedReason: 'delegation-no-target-expert',
            error: 'Keine freigeschaltete Zielgruppe deckt die benötigten Fähigkeiten semantisch ab.',
          });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'delegation-unavailable'));
          addMessage(chat.id, {
            id: `delegation-unavailable-${liveTaskNode.id}-${Date.now()}`,
            agentId: 'system',
            senderName: 'System',
            text: `⇄|${t('Für „{task}“ wurde in den erreichbaren Zielgruppen keine ausreichende Kompetenzabdeckung gefunden. Der Plan blieb unverändert.', { task: liveTaskNode.title })}`,
            ts: Date.now(),
            isError: true,
          });
          return { task, agent, delegationUnavailable: true };
        }
      }
      const configuredAgent = task.modelOverride
        ? { ...agent, model: task.modelOverride }
        : agent;
      if (!task.outOfBand) {
        const executionStatus = task.preparationOnly ? 'preparing' : 'running';
        commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, task.preparationOnly ? 'preparation-started' : 'started'));
        registerGraphTask(task, { status: executionStatus });
        setGraphTaskStatus(task, executionStatus, {
          startedAt: Date.now(),
          ...(task.preparationOnly ? { preparationAttemptedAt: Date.now(), preparationError: undefined } : {}),
        });
        if (task.runtimeRecovery && task.recovery?.originalGraphNodeId) {
          commitTaskGraph(graph => updateTaskNodeStatus(graph, task.recovery.originalGraphNodeId, task.recovery.originalStatus || 'timed_out', {
            recoveryStatus: task.source === 'timeout-recovery-step' ? 'step' : 'pm',
            recoveryTaskId: task.graphNodeId,
          }));
        }
      }
      const activeHandoff = task.handoff || null;
      const objective = activeHandoff?.summary || task.objective || initialObjective;
      let pauseRequested = false;
      let pauseQuestion = '';
      let scheduleDecisionRequested = false;
      let providerPauseRequested = false;
      let providerRetryAfterMs = 0;
      let groupPauseRequested = false;
      let groupPauseRequests = [];
      let savedInterimResult = '';
      let releaseAgentLease = () => {};
      const isOrchestrator = chat.type === 'group' && agent.id === pm?.id;
      let taskKbContext = '';
      if (kbPath && objective && window.electronAPI?.kbSearch) {
        try {
          const kbResult = await window.electronAPI.kbSearch({ query: objective, kbPath, maxResults: 3 });
          if (kbResult?.results?.length > 0) {
            taskKbContext = '\n\n[Für diese Aufgabe relevante Wissensbasis-Auszüge]:\n' +
              kbResult.results.map(result => `**${result.title}**:\n${result.snippet}`).join('\n\n---\n');
          }
        } catch {
          taskKbContext = '';
        }
      }
      const taskProjectContext = projectPath
        ? buildRelevantProjectInventoryContext({
          files: projectInventory,
          objective,
          maxFiles: isOrchestrator || isDirectChat ? 20 : 12,
          includeFallback: isOrchestrator || isDirectChat,
        })
        : '';
      const taskComplexity = assessTaskComplexity({
        objective,
        source: task.source,
        attachmentCount: activeAttachments.length,
        recovery: task.source === 'timeout-recovery' || task.source === 'timeout-recovery-step',
      });
      const qualityPolicy = resolveQualityPolicy({
        globalConfig: qualityRouting,
        groupConfig: chat.qualityRouting,
        agentConfig: configuredAgent.qualityRouting,
        messageMode: activeQualityMode,
        complexity: taskComplexity,
        agent: configuredAgent,
        providerModelsById: Object.fromEntries(providerConnections.map(connection => [connection.id, connection.models || []])),
      });
      let selectedModelAgent = task.modelOverride
        ? configuredAgent
        : qualityPolicy.directStrong ? qualityPolicy.escalationAgent : configuredAgent;
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
        releaseAgentLease = await acquireAgentLease(agent.id);
        if (runIdRef.current !== myRunId) return null;
        let taskReviewContext = '';
        const shouldRunConfiguredReview = !task.outOfBand
          && chat.type === 'group'
          && Boolean(projectPath)
          && Boolean(chat.reviewEnvironment?.test?.command)
          && /(?:test|prüf|validier|kontrollier|abnahme|quality|qa|lektori)/i.test(objective)
          && /(?:test|qa|quality|prüf|review|lektor|analyst)/i.test(`${agent.role || ''} ${agent.name || ''}`)
          && Boolean(window.electronAPI?.reviewRun);
        if (shouldRunConfiguredReview) {
          setAgentProgress(previous => ({ ...previous, [agent.id]: {
            ...(previous[agent.id] || {}),
            detail: t('Führt den konfigurierten Prüfbefehl aus.'),
            phase: 'review', updatedAt: Date.now(),
          }}));
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🧪|${t('{agent} startet den konfigurierten Prüfbefehl.', { agent: agent.name })}`,
            ts: Date.now(), isError: false,
          });
          try {
            const reviewResult = await window.electronAPI.reviewRun(chat.id, 'test');
            if (runIdRef.current !== myRunId) return;
            taskReviewContext = `\n\n[AUTOMATISCHER PRÜFLAUF]\nBefehl: ${reviewResult.command || ''}\nStatus: ${reviewResult.ok ? 'ERFOLGREICH' : 'FEHLGESCHLAGEN'}\nExit-Code: ${reviewResult.code ?? 'unbekannt'}\nAusgabe:\n${String(reviewResult.output || '(keine Ausgabe)').slice(-30000)}\n`;
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `🧪|${reviewResult.ok
                ? t('{agent}: Prüfbefehl erfolgreich abgeschlossen.', { agent: agent.name })
                : t('{agent}: Prüfbefehl fehlgeschlagen. Die Ausgabe wurde an den Agenten übergeben.', { agent: agent.name })}`,
              ts: Date.now(), isError: !reviewResult.ok,
            });
          } catch (reviewError) {
            if (runIdRef.current !== myRunId) return;
            taskReviewContext = `\n\n[AUTOMATISCHER PRÜFLAUF NICHT AUSGEFÜHRT]\n${reviewError.message}\n`;
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `🧪|${t('{agent}: Prüfbefehl konnte nicht gestartet werden — {error}', { agent: agent.name, error: reviewError.message })}`,
              ts: Date.now(), isError: true,
            });
          }
        }
        const memoryContext = memAPI ? await memAPI.getContextForAgent(
          memoryNamespace, objective || agent.name, agent.name, 5
        ) : '';
        let isolatedSystemPrompt = buildIsolatedSystemPrompt({
          agent,
          groupName: chat.name,
          groupAgentNames: chatAgents.map(a => a.name),
          groupAgents: chatAgents,
          availableGroups: chat.crossGroupCollaborationEnabled
            ? groups
              .filter(group => reachableCrossGroupIds.includes(group.id))
              .map(group => ({
                ...group,
                capabilities: [...new Set([
                  ...(group.capabilityIndex?.explicitCapabilities || []),
                  ...(group.capabilityIndex?.derivedCapabilities || []),
                ])].slice(0, 24),
              }))
            : [],
          memoryNamespace,
          projectPath: task.outOfBand ? '' : projectPath,
          reviewEnvironment: chat.reviewEnvironment,
          isOrchestrator,
          isDirectChat,
          planningMode: planningOnly,
          recoveryMode: task.source === 'timeout-recovery',
          userOwnedWorkflow: Boolean(
            taskGraphRef.current?.planOwner === 'user' ||
            taskGraphRef.current?.approvedPlan ||
            taskGraphRef.current?.previousApprovedPlan
          ),
        });
        if (qualityPolicy.acceptanceCriteria) {
          isolatedSystemPrompt += `\n\nZusätzliche Akzeptanzkriterien für diesen Agenten:\n${qualityPolicy.acceptanceCriteria}`;
        }
        const recoveryOriginalGraphNodeId = task.runtimeRecovery ? task.recovery?.originalGraphNodeId : '';
        const evidenceGraphNodeId = task.source === 'timeout-recovery-step' && recoveryOriginalGraphNodeId
          ? recoveryOriginalGraphNodeId
          : task.graphNodeId;
        const taskCapsuleGraphNodeId = recoveryOriginalGraphNodeId || task.graphNodeId;
        const allCurrentPlanNodes = activePlanRootNodeId
          ? (taskGraphRef.current?.nodes || [])
            .filter(node => node.planRootId === activePlanRootNodeId)
            .sort((left, right) => (left.planOrder || 0) - (right.planOrder || 0))
          : [];
        const needsCompletePlanContext = planningOnly || (
          isOrchestrator && ['user', 'team-synthesis', 'turn-limit-review'].includes(task.source)
        );
        const relevantPlanNodeIds = needsCompletePlanContext
          ? null
          : new Set([
            taskCapsuleGraphNodeId,
            ...workflowDependencyAncestorIds(taskGraphRef.current, taskCapsuleGraphNodeId),
          ].filter(Boolean));
        const currentPlanNodes = relevantPlanNodeIds
          ? allCurrentPlanNodes.filter(node => relevantPlanNodeIds.has(node.id))
          : allCurrentPlanNodes;
        const currentPlanContext = currentPlanNodes.length
          ? `${needsCompletePlanContext ? 'Aktueller Workflow-Plan' : 'Für diese Aufgabe relevanter Workflow-Ausschnitt'}:\n${currentPlanNodes.map(node =>
            `- ${node.planTaskId || node.id}: ${node.title} | Typ: ${node.nodeType === 'review' ? 'review' : 'task'} | Ziel: ${node.objective || node.title} | Agent: ${node.agentName} | Übergeordnet: ${taskGraphRef.current?.nodes?.find(candidate => candidate.id === node.parentNodeId)?.planTaskId || 'keine'} | Abhängig von: ${(taskGraphRef.current?.edges || []).filter(edge => edge.to === node.id && ['dependency', 'review'].includes(edge.kind)).map(edge => taskGraphRef.current?.nodes?.find(candidate => candidate.id === edge.from)?.planTaskId || edge.from).join(', ') || 'keiner'} | Delegation: ${JSON.stringify(node.delegation || { mode: 'never', requiredCapabilities: [], allowedTargetGroupIds: [] })} | Status: ${node.status}`
          ).join('\n')}${formatAcceptanceContext(currentPlanNodes)}`
          : '';
        const currentGraphTaskNode = taskGraphRef.current?.nodes?.find(node => node.id === taskCapsuleGraphNodeId);
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
              taskGraphRef.current?.planOwner === 'user'
                ? (task.runtimeRecovery
                  ? 'Dies ist eine systemseitige Recovery-Unteraufgabe. Der freigegebene Plan bleibt unverändert; nur die technische Ausführung der festgefahrenen Originalaufgabe wird kleinteilig fortgesetzt.'
                  : 'Bei einem unlösbaren Problem den PM oder User um Entscheidung bitten; keine neue Aufgabe anlegen und den Plan nicht verändern.')
                : 'Weitere Arbeit mit einer klaren @Name-Aufgabe übergeben.',
            ]),
            ...(isOrchestrator && task.source === 'user' && !useLeanFastPath && !planningOnly ? [
              'Erstelle vor den Handoffs jetzt den vollständigen initialen [[TASK_PLAN]] mit allen absehbaren Aufgaben und echten Abhängigkeiten. Eine Prüfaufgabe ist optional.',
            ] : []),
            ...(isOrchestrator && task.source === 'user' && useLeanFastPath && !planningOnly ? [
              'Schnellmodus für eine einfache Aufgabe: Halte die Koordination minimal und delegiere höchstens an einen Spezialisten.',
              'Ein TASK_PLAN ist für diesen Lauf nicht erforderlich.',
            ] : []),
            ...(isOrchestrator && task.source === 'team-synthesis' && currentPlanContext ? [
              'Nutze den aktuellen PM-Plan: Delegiere nur startbereite offene Aufgaben. Schließe nicht ab, solange geplante Fachaufgaben offen sind.',
            ] : []),
            ...(planningOnly ? [
              ...(restartPlanningFromScratch ? [
                'Achtung: Der vorherige Workflow wurde ausdrücklich gelöscht. Beginne die Planung vollständig neu.',
                'Übernimm keine Aufgaben, IDs, Abhängigkeiten, Status oder Annahmen aus früheren TASK_PLAN-Blöcken. Maßgeblich ist ausschließlich die neue User-Anforderung.',
              ] : []),
              'Bleibe im Planungsmodus: keine Agenten aktivieren, keine Werkzeuge zur Umsetzung verwenden und keine Dateien erzeugen.',
              'Wenn du für die Planung eine Antwort des Users benötigst, beginne jede Rückfrage ganz links auf einer eigenen Zeile mit @user.',
              'Gib bei jeder Antwort den vollständigen aktuellen TASK_PLAN-Entwurf aus; er ersetzt den Entwurf im Workflowfenster.',
              'In der Planungsphase darfst du nicht mehr benötigte oder fehlerhafte Aufgaben entfernen, indem du ihre IDs im vollständigen neuen TASK_PLAN weglässt.',
              'Bewahre alle nicht von der gewünschten Änderung betroffenen IDs, Ziele, Agenten, Kriterien und Abhängigkeiten.',
            ] : []),
            ...(task.outOfBand ? [
              'Dies ist eine direkte Fachfrage außerhalb des pausierten Workflows. Antworte selbst und verändere den gespeicherten Plan nicht.',
              'Keine Agenten-Handoffs, keine TASK_PLAN-Ausgabe, keine Werkzeuge und keine Dateiänderungen.',
            ] : []),
            ...(task.source === 'timeout-recovery' ? [
              `Dies ist eine ${task.recovery?.trigger === 'quality' ? 'Qualitäts-Recovery' : task.recovery?.trigger === 'error' ? 'Problem-Recovery' : 'Timeout-Recovery'} für ${task.recovery?.originalAgentName || 'den ursprünglichen Agenten'}.`,
              `Untersuche die zu große oder festgefahrene Aufgabe und delegiere höchstens EINEN deutlich kleineren, konkret prüfbaren Schritt an @${task.recovery?.originalAgentName || 'den ursprünglichen Agenten'}.`,
              'Delegiere während der Recovery nicht mehrere Schritte gleichzeitig und verwende noch kein [[PROJECT_DONE]].',
              'Wenn die festgefahrene Aufgabe vollständig gelöst ist, bestätige das ausdrücklich mit [[RECOVERY_RESOLVED]].',
              'Wenn du keine sichere Lösung innerhalb des freigegebenen Plans findest oder eine Entscheidung benötigst, beginne eine konkrete Rückfrage auf einer eigenen Zeile mit @user.',
              'Eine @user-Rückfrage soll die Diagnose und möglichst zwei verständliche Handlungsoptionen enthalten.',
            ] : []),
            ...(task.source === 'timeout-recovery-step' ? [
              'Dies ist ein verkleinerter Recovery-Teilschritt. Bearbeite ausschließlich diesen Schritt und erweitere seinen Umfang nicht.',
              'Dein Ergebnis wird danach sofort vom PM geprüft.',
            ] : []),
            ...(task.preparationOnly ? [
              'Dies ist ausschließlich ein sicherer Vorbereitungslauf, während freigegebene Abhängigkeiten noch laufen.',
              'Bearbeite nur reversible, von den fehlenden Vorgängerergebnissen unabhängige Vorarbeit. Triff keine Annahmen über diese Ergebnisse.',
              'Schließe die Gesamtaufgabe nicht ab. Stelle keine Rückfragen, delegiere nichts und gib keine @Erwähnungen, TASK_PLAN- oder PROJECT_DONE-Blöcke aus.',
              'Dokumentiere präzise, was vorbereitet wurde und was bis zum Eintreffen der Abhängigkeiten offenbleibt.',
            ] : []),
            ...(isOrchestrator && task.source === 'turn-limit-review' ? [
              'Dies ist die einmalige PM-Prüfung am Ende eines begrenzten Laufsegments.',
              'Wenn die User-Anforderung vollständig erfüllt ist, gib den finalen Abschluss mit [[PROJECT_DONE]].',
              'Wenn Arbeit offen ist, übergib höchstens EINEN priorisierten, kleinen und konkret prüfbaren nächsten Schritt.',
              'Erstelle keinen neuen Gesamtplan und wiederhole keine bereits erledigte Aufgabe.',
            ] : []),
          ],
          context: [
            taskKbContext ? 'Aufgabenbezogene Wissensbasis-Auszüge stehen im Systemkontext.' : '',
            memoryContext ? `Relevantes Shared Memory: memory://${memoryNamespace}` : '',
            !task.outOfBand && projectPath ? `Projektdateien müssen in ${projectPath} als vollständige file:-Artefakte geliefert werden.` : '',
            !isDirectChat ? currentPlanContext : '',
          ].filter(Boolean),
          handoff: activeHandoff,
          acceptanceCriteria: currentGraphTaskNode?.acceptanceCriteria || [],
          requestedOutput: isDirectChat || task.outOfBand
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
          servers: planningOnly || task.outOfBand ? [] : activeMcpServers,
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
            kbContext: taskKbContext + memoryContext + taskProjectContext + taskReviewContext + extraContext,
            isolatedSession,
            projectPath: task.outOfBand ? '' : projectPath,
            requestId: agentRequestId,
            language,
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
            projectPath: task.outOfBand ? '' : projectPath,
            requestId: agentRequestId,
            language,
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
        const callWithoutTools = (modelAgent, modelHistory) => callLLM({
          apiKeys,
          providerConnections,
          agent: modelAgent,
          history: modelHistory,
          userMessage: null,
          groupContext: isOrchestrator ? chatAgents.map(a => a.name).join(', ') : null,
          kbContext: taskKbContext + memoryContext + taskProjectContext + taskReviewContext,
          isolatedSession,
          projectPath: task.outOfBand ? '' : projectPath,
          requestId: `${agentRequestId}-quality`,
          language,
        });

        const taskModelContext = taskKbContext + memoryContext + taskProjectContext + taskReviewContext;
        let estimatedInputTokens = estimateTokens(isolatedSystemPrompt) + estimateTokens(taskModelContext) + estimateTokens(agentHistory.map(message => message.text).join('\n'));
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
              requiresInitialPlan: isOrchestrator && task.source === 'user' && (planningOnly || !useLeanFastPath),
              parsedTaskPlan: candidatePlan,
              projectFiles: candidateFiles,
              projectPath: task.outOfBand ? '' : projectPath,
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
          !task.modelOverride &&
          qualityPolicy.enabled &&
          qualityPolicy.maxEscalations > 0 &&
          !qualityResult.evaluation.accepted
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
          estimatedInputTokens += estimateTokens(isolatedSystemPrompt) + estimateTokens(taskModelContext) + estimateTokens(escalationHistory.map(message => message.text).join('\n'));
          try {
            // MCP side effects must never be repeated by a quality retry. The
            // stronger model improves the captured first result without tools.
            reply = usedMcp
              ? await callWithoutTools(selectedModelAgent, escalationHistory)
              : await callWithModel(selectedModelAgent, escalationHistory);
            if (runIdRef.current !== myRunId) return;
            if (!reply || typeof reply !== 'string' || !reply.trim()) throw new Error(t('Leere Antwort der stärkeren Modellstufe.'));
            estimatedOutputTokens += estimateTokens(reply);
            qualityResult = assessCandidate(reply);
            qualityOutcome = 'escalated';
          } catch (qualityError) {
            escalationFailed = true;
            selectedModelAgent = configuredAgent;
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
            text: `⚠️|${t('{agent}: Auch die stärkere Modellstufe erfüllt nicht alle automatisch prüfbaren Kriterien.', { agent: agent.name })}`,
            ts: Date.now(), isError: false,
          });
        }
        const shouldStartQualityRecovery = Boolean(
          qualityUnresolved &&
          !planningOnly &&
          !task.outOfBand &&
          !task.preparationOnly &&
          !task.runtimeRecovery &&
          taskGraphRef.current?.approvedPlan &&
          pm &&
          agent.id !== pm.id
        );
        if (shouldStartQualityRecovery) {
          const qualityRecoveryError = new Error(
            `Die Aufgabe blieb nach der Qualitätskaskade unzureichend: ${qualityResult.evaluation.reasons.join('; ') || 'automatische Kriterien nicht erfüllt'}`,
          );
          qualityRecoveryError.isTaskComplexityFailure = true;
          throw qualityRecoveryError;
        }

        let rawReply = normalizeAgentMentionLayout(reply, agent, chatAgents);
        const submittedTaskEvidence = extractTaskEvidence(rawReply);
        const acceptanceDecisions = isOrchestrator ? extractAcceptanceReview(rawReply) : [];
        const canMaterializePlan = shouldMaterializeTaskPlan({
          isOrchestrator,
          planningOnly,
          taskSource: task.source,
          hasApprovedPlan: Boolean(taskGraphRef.current?.approvedPlan),
          userOwnedPlan: taskGraphRef.current?.planOwner === 'user',
        });
        const parsedTaskPlan = canMaterializePlan
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
            commitTaskGraph(graph => {
              const materialized = materializeTaskPlan(graph, {
                rootNodeId: planRootNodeId,
                tasks: normalizedPlanTasks,
                replace: planningOnly,
                allowPlanningRevision: planningOnly,
              });
              return restartPlanningFromScratch ? {
                ...materialized,
                workflowResetRequired: false,
                workflowResetConsumedAt: Date.now(),
              } : materialized;
            });
          }
        }
        rawReply = rewritePlanHandoffAssignments(rawReply, normalizedPlanTasks);
        const projectFiles = extractProjectFiles(rawReply);
        const savedProjectFiles = [];
        if (!planningOnly && !task.outOfBand && !task.preparationOnly && projectPath && window.electronAPI?.projectWrite) {
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
        const evidenceNode = taskGraphRef.current?.nodes?.find(node => node.id === evidenceGraphNodeId);
        if (!planningOnly && !task.preparationOnly && evidenceNode?.acceptanceCriteria?.length) {
          const evidenceKind = savedProjectFiles.length
            ? 'artifact'
            : taskReviewContext.includes('Status: ERFOLGREICH')
              ? 'automatic-test'
              : 'result';
          commitTaskGraph(graph => submitTaskEvidence(graph, evidenceGraphNodeId, submittedTaskEvidence, {
            author: agent.name,
            fallbackSummary: reviewEvidence,
            kind: evidenceKind,
          }));
        }
        if (!planningOnly && !task.preparationOnly && acceptanceDecisions.length) {
          commitTaskGraph(graph => applyAcceptanceDecisions(graph, acceptanceDecisions, { reviewer: agent.name }));
        }
        if (!planningOnly && !task.outOfBand && projectPath && window.electronAPI?.projectWrite) {
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
            (task.preparationOnly ? reviewEvidence : displayReply).slice(0, 100000),
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
        savedInterimResult = String(reviewEvidence || displayReply || '').slice(0, 12000);
        const addressedGroups = task.outOfBand || task.preparationOnly
          ? []
          : extractGroupMentions(rawReply, groups, { sourceGroupId: chat.id, userAuthored: false });
        if (addressedGroups.length > 0) {
          const batchId = `group-request-batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          groupPauseRequests = addressedGroups.map(mention => createCrossGroupRequest({
            sourceGroup: chat,
            sourceTask: task,
            sourceAgent: agent,
            targetGroup: mention.group,
            question: mention.question,
            attachments: activeAttachments,
            batchId,
            origin: 'agent',
            qualityMode: activeQualityMode,
          })).filter(Boolean);
          groupPauseRequests.forEach(enqueueCrossGroupRequest);
          groupPauseRequested = groupPauseRequests.length > 0;
          if (groupPauseRequested) {
            setGraphTaskStatus(task, 'waiting_group', {
              waitingGroupRequestIds: groupPauseRequests.map(request => request.id),
              waitingGroupNames: groupPauseRequests.map(request => request.targetGroupName),
              groupWaitStartedAt: Date.now(),
              interimResult: savedInterimResult,
              interimSavedAt: Date.now(),
            });
            commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'waiting-group', {
              requestIds: groupPauseRequests.map(request => request.id),
            }));
            addMessage(chat.id, {
              id: `cross-group-wait-${batchId}`,
              agentId: 'system',
              senderName: 'System',
              text: `↗|${t('{agent} wartet auf eine Antwort von {groups}. Unabhängige Aufgaben laufen weiter; der freigegebene Plan bleibt unverändert.', {
                agent: agent.name,
                groups: groupPauseRequests.map(request => request.targetGroupName).join(', '),
              })}`,
              ts: Date.now(),
              isError: false,
            });
          }
        }
        if (!groupPauseRequested && !task.preparationOnly) {
          successfulTasks += 1;
          taskQueue.markSuccessful(task);
        }
        if (!task.outOfBand && task.preparationOnly) {
          setGraphTaskStatus(task, 'prepared', {
            preparationCompletedAt: Date.now(),
            interimResult: savedInterimResult,
            interimSavedAt: Date.now(),
            preparedFiles: projectFiles.map(file => file.filename),
            runtimeModel: selectedModelAgent.model,
            qualityEscalated: didEscalate,
          });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'prepared', {
            model: selectedModelAgent.model,
            savedFileCount: savedProjectFiles.length,
          }));
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `⏸|${t('{agent} hat sichere Vorarbeit für „{task}“ zwischengespeichert. Die Aufgabe wartet weiterhin auf ihre Abhängigkeiten.', {
              agent: agent.name,
              task: liveTaskNode?.title || objective,
            })}`,
            ts: Date.now(), isError: false,
          });
        } else if (!task.outOfBand && !groupPauseRequested) {
          setGraphTaskStatus(task, 'agent_done', {
            completedAt: Date.now(),
            runtimeModel: selectedModelAgent.model,
            qualityEscalated: didEscalate,
            ...(liveTaskNode?.interimResult ? { interimConsumedAt: Date.now() } : {}),
          });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'completed', { model: selectedModelAgent.model }));
        } else if (task.consultingGraphNodeId) {
          commitTaskGraph(graph => updateTaskNodeStatus(graph, task.consultingGraphNodeId, 'retryable', {
            pmConsultedAt: Date.now(),
          }));
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `💬|${t('Die PM-Einschätzung liegt vor. Der freigegebene Plan blieb unverändert; der User kann die Aufgabe erneut starten oder eine neue Planversion bearbeiten.')}`,
            ts: Date.now(), isError: false,
          });
        }

        const knowledgeEntries = extractKnowledgeFromReply(displayReply, agent.id, agent.name);
        if (!planningOnly && !task.preparationOnly && memAPI && knowledgeEntries.length > 0) {
          for (const entry of knowledgeEntries) {
            const requestedType = entry.tags.find(tag => ['fact', 'decision', 'constraint', 'finding', 'task_state'].includes(tag));
            await memAPI.write(memoryNamespace, createEntry({
              type: requestedType || 'finding', namespace: memoryNamespace, content: entry.text,
              tags: entry.tags, author: agent.name, confidence: 'medium',
            }));
          }
          await refreshMemoryCount();
        }

        const addressedGroupNames = new Set(addressedGroups.map(item => item.group.name.toLowerCase()));
        const handoffs = task.outOfBand || task.preparationOnly ? [] : extractHandoffsFromReply(rawReply, agent, chatAgents)
          .filter(handoff => !addressedGroupNames.has(String(handoff.to || '').toLowerCase()));
        const userQuestions = task.outOfBand || task.preparationOnly ? [] : extractUserQuestions(rawReply);
        let asksUser = userQuestions.length > 0;
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
          const plannedNode = findPlannedNode(target, handoff.summary);
          const isRecoveryDelegation = task.source === 'timeout-recovery' &&
            task.runtimeRecovery === true &&
            task.recovery &&
            agent.id === pm?.id &&
            target.id === task.recovery.originalAgentId;
          if (taskGraphRef.current?.approvedPlan && !plannedNode && !isRecoveryDelegation) {
            if (target.id === pm?.id && agent.id !== pm.id) {
              setGraphTaskStatus(task, 'waiting_pm', {
                blockedReason: 'pm-consultation',
                issueSummary: handoff.summary,
              });
              immediateHandoffTasks.push({
                agent: target,
                objective: `Berate zur bestehenden Aufgabe „${objective}“: ${handoff.summary}. Ändere den Workflow nicht und schlage dem User höchstens konkrete Optionen innerhalb der bestehenden Aufgabe vor.`,
                source: 'workflow-consultation',
                outOfBand: true,
                consultingGraphNodeId: task.graphNodeId,
              });
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `💬|${t('{agent} hat den PM um Hilfe gebeten. Die Aufgabe und der freigegebene Plan werden dabei nicht verändert.', { agent: agent.name })}`,
                ts: Date.now(), isError: false,
              });
            } else {
              setGraphTaskStatus(task, 'waiting_user', {
                blockedReason: 'unplanned-handoff',
                issueSummary: handoff.summary,
              });
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `🛡️|${t('{agent} schlägt zusätzliche Arbeit vor: {proposal} Der Plan wurde nicht verändert. Entscheide im Workflowfenster, ob du eine neue Planversion anlegen möchtest.', { agent: agent.name, proposal: handoff.summary })}`,
                ts: Date.now(), isError: false,
              });
            }
            continue;
          }
          if (!planningOnly && memAPI) await memAPI.handoff(memoryNamespace, handoff);
          if (shouldDeferHandoffToPM({ fromAgent: agent, targetAgent: target, pm })) {
            needsSynthesis = true;
            continue;
          }
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
          if (plannedNode) {
            claimedPlanNodeIds.add(plannedNode.id);
            // Future plan steps are visible in the tree but must not enter the
            // executable queue before all of their dependencies are complete.
            if (!isTaskNodeReady(taskGraphRef.current, plannedNode.id)) continue;
          }
          const dependencyNodeId = plannedNode
            ? null
            : inferHandoffDependency(handoff.summary, immediateHandoffTasks);
          const approvedObjective = plannedNode && taskGraphRef.current?.approvedPlan
            ? (plannedNode.objective || plannedNode.title)
            : handoff.summary;
          const predecessorFindings = agent.id !== pm?.id && reviewEvidence
            ? [`Relevantes Ergebnis des direkten Vorgängers ${agent.name}: ${String(reviewEvidence).slice(0, 8000)}`]
            : [];
          const contextualHandoff = predecessorFindings.length > 0
            ? { ...handoff, findings: [...(handoff.findings || []), ...predecessorFindings] }
            : handoff;
          const executableHandoff = approvedObjective === handoff.summary
            ? contextualHandoff
            : { ...contextualHandoff, summary: approvedObjective };
          const approvedTaskNode = plannedNode && taskGraphRef.current?.approvedPlan
            ? taskGraphRef.current.approvedPlan.nodes.find(node => node.id === plannedNode.id)
            : null;
          const approvedTaskModel = approvedTaskNode
            ? (approvedTaskNode.modelOverride || approvedTaskNode.model)
            : plannedNode?.modelOverride;
          const nextTask = registerGraphTask({
            agent: target,
            objective: approvedObjective,
            handoff: executableHandoff,
            source: recovery ? 'timeout-recovery-step' : agent.name,
            ...(recovery ? { runtimeRecovery: true } : {}),
            ...(plannedNode ? {
              graphNodeId: plannedNode.id,
              planRootId: activePlanRootNodeId,
              planTaskId: plannedNode.planTaskId,
              ...(approvedTaskModel ? { modelOverride: approvedTaskModel } : {}),
            } : {}),
            ...(recovery ? { recovery } : {}),
          }, { status: 'planned', parentNodeId: plannedNode ? null : task.graphNodeId });
          if (recovery?.originalGraphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(graph, recovery.originalGraphNodeId, recovery.originalStatus || 'timed_out', {
              recoveryStatus: 'step',
              recoveryTaskId: nextTask.graphNodeId,
            }));
          }
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
              ...(plannedNode.modelOverride ? { modelOverride: plannedNode.modelOverride } : {}),
            }, { status: 'planned' });
            immediateHandoffTasks.push(nextTask);
            claimedPlanNodeIds.add(plannedNode.id);
          }
        }
        let queuedHandoffs = immediateHandoffTasks.length;
        let prependResult = { accepted: immediateHandoffTasks, rejected: [] };
        if (planningOnly && isOrchestrator) {
          planningDraftTasks = immediateHandoffTasks;
        } else {
          queuedHandoffs = taskQueue.prepend(immediateHandoffTasks);
          prependResult = taskQueue.getLastPrependResult();
        }
        if (!planningOnly && prependResult.rejected.length > 0) {
          loopGuardRejections.push(...prependResult.rejected);
          for (const rejection of prependResult.rejected) {
            setGraphTaskStatus(rejection.task, 'blocked', {
              blockedReason: rejection.reason === 'repeat-limit'
                ? 'repeat-limit'
                : 'duplicate-handoff',
            });
          }
        }
        const parallelHandoffTasks = prependResult.accepted;
        if (!planningOnly && agent.id === pm?.id && parallelHandoffTasks.length >= 2 && task.source !== 'timeout-recovery') {
          if (taskGraphRef.current?.approvedPlan || autoRunRef.current) {
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

        if (!groupPauseRequested && agent.id === pm?.id && queuedHandoffs > 0) {
          const skipFastFinalReview = useLeanFastPath &&
            task.source === 'user' &&
            queuedHandoffs === 1 &&
            !activePlanRootNodeId;
          needsSynthesis = !skipFastFinalReview;
          if (task.source === 'timeout-recovery') {
            delegatedResults.push({
              agent: agent.name,
              objective: `${task.recovery?.trigger === 'quality' ? 'Qualitäts-Recovery' : task.recovery?.trigger === 'error' ? 'Problem-Recovery' : 'Timeout-Recovery'} für ${task.recovery?.originalAgentName || 'Agent'}`,
              result: reviewEvidence,
              graphNodeId: task.graphNodeId,
            });
          }
        } else if (!groupPauseRequested && !task.preparationOnly && agent.id !== pm?.id) {
          delegatedResults.push({ agent: agent.name, objective, result: reviewEvidence, graphNodeId: task.graphNodeId });
          // A single specialist explicitly addressed by the user remains a
          // direct conversation. Multi-agent/delegated work still returns to
          // the PM for the final synthesis.
          if (shouldRequestPMFinalReview({
            pm,
            agent,
            taskSource: task.source,
            routeMode: task.routeMode || route.mode,
            explicitMentionCount: task.explicitMentionCount ?? explicitMentions.length,
            explicitlyAddressedAgentId: task.explicitlyAddressedAgentId || explicitMentions[0]?.id,
            handoffCount: handoffs.length,
            hasActivePlan: !!activePlanRootNodeId,
            useLeanFastPath,
            asksUser,
            requiresAcceptanceReview: Boolean(evidenceNode?.acceptanceCriteria?.some(criterion => criterion.required !== false)),
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

        const recoveryResolved = /\[\[RECOVERY_RESOLVED\]\]/i.test(rawReply);
        const recoveryNeedsUser = !groupPauseRequested && task.source === 'timeout-recovery' &&
          task.runtimeRecovery === true && handoffs.length === 0 && !asksUser && !recoveryResolved;
        if (recoveryNeedsUser) {
          asksUser = true;
          pauseRequested = true;
          pauseQuestion = buildRecoveryUserQuestion({ recovery: task.recovery, pmReply: displayReply });
        }
        const recoveredOriginalNodeId = !groupPauseRequested && task.source === 'timeout-recovery' &&
          task.runtimeRecovery === true && recoveryResolved &&
          handoffs.length === 0 && !asksUser
          ? task.recovery.originalGraphNodeId
          : '';
        if (recoveredOriginalNodeId) {
          commitTaskGraph(graph => approveAgentDoneTasks(
            recordTaskExecutionEvent(
              updateTaskNodeStatus(graph, recoveredOriginalNodeId, 'agent_done', {
                recoveredAt: Date.now(),
                recoveryStatus: null,
                recoveryTaskId: null,
                recoveryTrigger: null,
                recoveryError: undefined,
                error: undefined,
                blockedReason: undefined,
              }),
              {
                graphNodeId: recoveredOriginalNodeId,
                agent: chatAgents.find(candidate => candidate.id === task.recovery.originalAgentId),
              },
              'recovered',
              { recoveryAttempt: task.recovery.attempt },
            ),
          ));
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🧭|${t('PM hat die Recovery abgeschlossen. Die ursprüngliche Aufgabe wird im freigegebenen Workflow fortgeführt.')}`,
            ts: Date.now(), isError: false,
          });
        }

        if (asksUser && !groupPauseRequested) {
          pauseRequested = true;
          pauseQuestion = pauseQuestion || userQuestions.join('\n');
          if (task.runtimeRecovery && task.recovery?.originalGraphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(graph, task.recovery.originalGraphNodeId, 'waiting_user', {
              recoveryStatus: 'user',
              recoveryTaskId: task.graphNodeId,
              recoveryTrigger: task.recovery.trigger || 'timeout',
              blockedReason: 'pm-recovery-needs-user',
              issueSummary: pauseQuestion,
            }));
          }
        }

        const openPlanTaskCount = activePlanRootNodeId
          ? (taskGraphRef.current?.nodes || []).filter(node =>
            node.planRootId === activePlanRootNodeId &&
            node.id !== task.graphNodeId &&
            !FINISHED_PLAN_STATUSES.has(node.status)
          ).length
          : 0;
        const acceptanceSummary = activePlanRootNodeId
          ? summarizeAcceptance(taskGraphRef.current, activePlanRootNodeId)
          : { ready: true, unmet: [], required: 0, passed: 0 };
        const requestedProjectCompletion = /\[\[PROJECT_DONE\]\]/i.test(rawReply);
        if (requestedProjectCompletion && !acceptanceSummary.ready) {
          resumableFailure = true;
          setGraphTaskStatus(task, 'blocked', { blockedReason: 'acceptance-pending' });
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🛡️|${t('Abschluss blockiert: {count} erforderliche Abnahmekriterien sind noch nicht bestanden. Der PM muss Nachweise prüfen, Korrekturen beauftragen oder eine erforderliche User-Freigabe einholen.', { count: acceptanceSummary.unmet.length })}`,
            ts: Date.now(), isError: false,
          });
        }
        if (!groupPauseRequested && !task.preparationOnly && !planningOnly && shouldCompleteProject({
          isOrchestrator,
          source: task.source,
          reply: rawReply,
          handoffCount: handoffs.length,
          pendingTaskCount: taskQueue.length + openPlanTaskCount,
          asksUser,
          acceptanceReady: acceptanceSummary.ready,
        })) {
          projectCompleted = true;
          needsSynthesis = false;
          taskQueue.clear();
          finishRunCheckpoint();
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
              ...(acceptanceSummary.required > 0
                ? [`- ${t('Bestandene Abnahmekriterien: {passed}/{required}', { passed: acceptanceSummary.passed, required: acceptanceSummary.required })}`]
                : []),
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
        const qualityBlocked = e.isTaskComplexityFailure === true;
        if (!task.outOfBand) {
          setGraphTaskStatus(task, task.preparationOnly ? 'planned' : rateLimited ? 'provider_paused' : timedOut ? 'timed_out' : qualityBlocked ? 'blocked' : 'failed', {
            error: task.preparationOnly ? undefined : e.message,
            ...(qualityBlocked ? { blockedReason: 'quality-recovery' } : {}),
            ...(task.preparationOnly ? { preparationFailedAt: Date.now(), preparationError: e.message } : {}),
          });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, task.preparationOnly ? 'preparation-failed' : 'failed', { error: String(e.message || '').slice(0, 600) }));
        }
        addMessage(chat.id, {
          id: Date.now() + Math.random(),
          agentId: 'system', senderName: 'System',
          text: `${agent.name}|${e.message}`,
          ts: Date.now(), isError: true,
        });
        if (task.outOfBand || task.preparationOnly) {
          // A failed side conversation must not enqueue PM synthesis, recovery,
          // or provider checkpoints into the paused workflow. Preparation is
          // best-effort and failure never blocks the later full task.
        } else if (rateLimited) {
          taskQueue.retry(task);
          providerPauseRequested = true;
          providerRetryAfterMs = e.retryAfterMs || 60000;
          resumableFailure = true;
        } else if (task.runtimeRecovery && pm && agent.id === pm.id) {
          pauseRequested = true;
          pauseQuestion = buildRecoveryUserQuestion({
            recovery: task.recovery,
            errorMessage: e.message,
          });
          if (task.recovery?.originalGraphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(graph, task.recovery.originalGraphNodeId, 'waiting_user', {
              recoveryStatus: 'user',
              recoveryTaskId: task.graphNodeId,
              recoveryTrigger: task.recovery.trigger || 'error',
              recoveryError: e.message,
              blockedReason: 'pm-recovery-needs-user',
              issueSummary: pauseQuestion,
            }));
          }
        } else if (pm && agent.id !== pm.id) {
          const problemTrigger = qualityBlocked ? 'quality' : timedOut ? 'timeout' : task.recovery?.trigger || 'error';
          delegatedResults.push({
            agent: agent.name,
            objective,
            result: `${problemTrigger === 'quality' ? 'QUALITÄTSPROBLEM' : problemTrigger === 'timeout' ? 'TIMEOUT' : 'AUSFÜHRUNGSPROBLEM'}: ${e.message}`,
            graphNodeId: task.graphNodeId,
          });
          needsSynthesis = true;
          const originalAgent = task.recovery
            ? chatAgents.find(candidate => candidate.id === task.recovery.originalAgentId) || agent
            : agent;
          const originalGraphNodeId = task.recovery?.originalGraphNodeId || task.graphNodeId;
          const recoveryTask = buildTimeoutRecoveryTask({
            pm,
            originalAgent,
            objective,
            errorMessage: e.message,
            previousRecovery: task.recovery,
            originalGraphNodeId,
            planRootId: task.planRootId || task.recovery?.planRootId || activePlanRootNodeId,
            trigger: problemTrigger,
          });
          if (recoveryTask) {
            const registeredRecoveryTask = registerGraphTask(recoveryTask, { status: 'planned', parentNodeId: task.graphNodeId });
            taskQueue.prepend([registeredRecoveryTask]);
            if (originalGraphNodeId) {
              commitTaskGraph(graph => updateTaskNodeStatus(graph, originalGraphNodeId, recoveryTask.recovery?.originalStatus || (timedOut ? 'timed_out' : 'blocked'), {
                recoveryStatus: 'pm',
                recoveryTaskId: registeredRecoveryTask.graphNodeId,
                recoveryTrigger: recoveryTask.recovery?.trigger || problemTrigger,
              }));
            }
          } else {
            resumableFailure = true;
          }
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🧭|${problemTrigger === 'quality'
              ? t('PM übernimmt die Qualitäts-Recovery für {agent}: Aufgabe verkleinern und schrittweise mit erneuter Qualitätsprüfung ausführen.', { agent: originalAgent.name })
              : problemTrigger === 'timeout'
                ? t('PM übernimmt sofort die Timeout-Recovery für {agent}: Aufgabe untersuchen, verkleinern und schrittweise neu vergeben.', { agent: originalAgent.name })
                : t('PM übernimmt die Problem-Recovery für {agent}: Ursache prüfen und einen sicheren kleineren Lösungsschritt planen.', { agent: originalAgent.name })}`,
            ts: Date.now(), isError: false,
          });
        } else if (taskGraphRef.current?.approvedPlan) {
          // Without an available PM, or when the PM's own approved task fails,
          // the user becomes the final decision authority.
          pauseRequested = true;
          pauseQuestion = buildRecoveryUserQuestion({
            recovery: task.recovery || {
              trigger: timedOut ? 'timeout' : qualityBlocked ? 'quality' : 'error',
              originalObjective: objective,
            },
            errorMessage: e.message,
          });
          setGraphTaskStatus(task, 'waiting_user', {
            blockedReason: 'pm-recovery-needs-user',
            issueSummary: pauseQuestion,
          });
          needsSynthesis = false;
        } else if (agent.id === pm?.id) {
          resumableFailure = true;
        } else if (pm) {
          delegatedResults.push({
            agent: agent.name,
            objective,
            result: `FEHLER: ${e.message}`,
            graphNodeId: task.graphNodeId,
          });
          needsSynthesis = true;
        }
      } finally {
        releaseAgentLease();
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
        groupPauseRequested,
        groupPauseRequests,
        interimResult: savedInterimResult,
      };
    };

    const enqueueReadyApprovedWorkflowTasks = (excludedNodeIds = new Set()) => {
      const currentGraph = taskGraphRef.current;
      if (planningOnly || !currentGraph?.approvedPlan || !activePlanRootNodeId) return [];
      const queuedNodeIds = new Set(taskQueue.pendingTasks().map(pendingTask => pendingTask.graphNodeId).filter(Boolean));
      const readyNodes = (currentGraph.nodes || [])
        .filter(node =>
          node.planRootId === activePlanRootNodeId &&
          inferTaskNodeType(node) !== 'request' &&
          CLAIMABLE_PLAN_STATUSES.has(node.status) &&
          !queuedNodeIds.has(node.id) &&
          !excludedNodeIds.has(node.id) &&
          isTaskNodeReady(currentGraph, node.id)
        )
        .sort((left, right) => (left.planOrder || 0) - (right.planOrder || 0));
      const acceptedTasks = [];
      for (const plannedNode of readyNodes) {
        const target = chatAgents.find(candidate => candidate.id === plannedNode.agentId);
        if (!target) continue;
        const runtimeRecovery = plannedNode.runtimeRecovery === true && String(plannedNode.source || '').startsWith('timeout-recovery');
        const approvedNode = currentGraph.approvedPlan.nodes.find(node => node.id === plannedNode.id);
        const approvedModel = approvedNode?.modelOverride || approvedNode?.model;
        const relevantResultNodeIds = workflowDependencyAncestorIds(currentGraph, plannedNode.id);
        const relevantResults = delegatedResults
          .filter(result => relevantResultNodeIds.has(result.graphNodeId))
          .slice(-12);
        const preparedFinding = plannedNode.interimResult
          ? [`Zwischengespeicherte Vorarbeit dieser Aufgabe: ${String(plannedNode.interimResult).slice(0, 12000)}`]
          : [];
        const handoff = createHandoff({
          from: runtimeRecovery ? 'Timeout-Wächter' : 'Workflow-Scheduler',
          to: target.name,
          taskId: `approved-${plannedNode.planTaskId || plannedNode.id}`,
          summary: plannedNode.objective || plannedNode.title,
          findings: [
            ...preparedFinding,
            ...relevantResults.map(item => `${item.agent}: ${String(item.result || '').slice(0, 6000)}`),
          ],
        });
        const readyTask = registerGraphTask({
          agent: target,
          objective: plannedNode.objective || plannedNode.title,
          handoff,
          source: runtimeRecovery ? plannedNode.source : 'approved-workflow',
          ...(runtimeRecovery ? { runtimeRecovery: true, recovery: plannedNode.recovery } : {}),
          graphNodeId: plannedNode.id,
          planRootId: activePlanRootNodeId,
          planTaskId: plannedNode.planTaskId,
          ...(approvedModel ? { modelOverride: approvedModel } : {}),
        }, { status: plannedNode.status });
        if (taskQueue.enqueue(readyTask)) acceptedTasks.push(readyTask);
      }
      return acceptedTasks;
    };

    const enqueueDependencyPreparationTasks = ({
      activeNodeIds = new Set(),
      activeAgentIds = new Set(),
      limit = 2,
    } = {}) => {
      const currentGraph = taskGraphRef.current;
      if (planningOnly || !currentGraph?.approvedPlan || !activePlanRootNodeId) return [];
      const pendingTasks = taskQueue.pendingTasks();
      const queuedNodeIds = new Set(pendingTasks.map(pendingTask => pendingTask.graphNodeId).filter(Boolean));
      const queuedAgentIds = new Set(pendingTasks.map(pendingTask => pendingTask.agent?.id).filter(Boolean));
      const candidateIds = findDependencyPreparationCandidateIds(currentGraph, {
        activeNodeIds: [...activeNodeIds],
        activeAgentIds: [...activeAgentIds, ...queuedAgentIds],
        queuedNodeIds: [...queuedNodeIds],
        limit,
      });
      const preparationTasks = [];
      for (const nodeId of candidateIds) {
        const plannedNode = currentGraph.nodes.find(node => node.id === nodeId);
        const target = chatAgents.find(candidate => candidate.id === plannedNode?.agentId);
        if (!plannedNode || !target || plannedNode.planRootId !== activePlanRootNodeId) continue;
        const approvedNode = currentGraph.approvedPlan.nodes.find(node => node.id === nodeId);
        const approvedModel = approvedNode?.modelOverride || approvedNode?.model;
        const taskObjective = plannedNode.objective || plannedNode.title;
        const handoff = createHandoff({
          from: 'Workflow-Scheduler',
          to: target.name,
          taskId: `prepare-${plannedNode.planTaskId || plannedNode.id}`,
          summary: `Sichere Vorarbeit für die freigegebene Aufgabe „${taskObjective}“ erstellen. Bearbeite ausschließlich Teile, die ohne die noch laufenden Vorgängerergebnisse korrekt und reversibel vorbereitet werden können.`,
          findings: ['Die eigentliche Aufgabe bleibt blockiert, bis alle freigegebenen Abhängigkeiten abgeschlossen sind.'],
        });
        const preparationTask = registerGraphTask({
          agent: target,
          objective: handoff.summary,
          handoff,
          source: 'dependency-preparation',
          preparationOnly: true,
          approvedContinuation: true,
          graphNodeId: plannedNode.id,
          planRootId: activePlanRootNodeId,
          planTaskId: plannedNode.planTaskId,
          ...(approvedModel ? { modelOverride: approvedModel } : {}),
        }, { status: plannedNode.status });
        if (taskQueue.enqueue(preparationTask)) preparationTasks.push(preparationTask);
      }
      return preparationTasks;
    };

    const runWorkConservingApprovedBatch = async (initialTasks) => {
      const activeRuns = new Map();
      const activeAgentIds = new Set();
      const executions = [];
      let launchSequence = 0;
      let stopScheduling = false;

      const launchTask = (nextTask) => {
        const runKey = `${nextTask.graphNodeId || nextTask.agent.id}:${launchSequence++}`;
        activeAgentIds.add(nextTask.agent.id);
        requestedParallelTaskIds.delete(nextTask.graphNodeId);
        const promise = executeAgentTask(nextTask).then(execution => {
          if (
            !execution || execution.pauseRequested || execution.scheduleDecisionRequested ||
            execution.providerPauseRequested || projectCompleted || runIdRef.current !== myRunId
          ) stopScheduling = true;
          return { runKey, task: nextTask, execution };
        });
        activeRuns.set(runKey, { task: nextTask, promise });
      };

      const drainRunnableTasks = () => {
        if (stopScheduling || projectCompleted || runIdRef.current !== myRunId) return;
        const activeNodeIds = new Set([...activeRuns.values()].map(activeRun => activeRun.task.graphNodeId).filter(Boolean));
        enqueueReadyApprovedWorkflowTasks(activeNodeIds);
        enqueueDependencyPreparationTasks({ activeNodeIds, activeAgentIds });
        let runnableTask;
        while ((runnableTask = taskQueue.nextMatching(candidate => (
          !activeAgentIds.has(candidate.agent.id) &&
          (candidate.outOfBand || validateApprovedTaskExecution(taskGraphRef.current, candidate).ok)
        )))) {
          launchTask(runnableTask);
        }
      };

      const persistActiveWork = () => {
        if (runIdRef.current !== myRunId) return;
        const activeTasks = [...activeRuns.values()].map(activeRun => activeRun.task);
        persistRunCheckpoint({
          status: 'running',
          pendingTasks: [...activeTasks, ...taskQueue.pendingTasks()],
          parallelTaskIds: activeTasks.length >= 2 ? activeTasks.map(activeTask => activeTask.graphNodeId).filter(Boolean) : [],
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
      };

      initialTasks.forEach(launchTask);
      drainRunnableTasks();
      persistActiveWork();

      while (activeRuns.size > 0) {
        const settled = await Promise.race([...activeRuns.values()].map(activeRun => activeRun.promise));
        activeRuns.delete(settled.runKey);
        activeAgentIds.delete(settled.task.agent.id);
        executions.push(settled.execution);
        drainRunnableTasks();
        persistActiveWork();
      }

      return executions;
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

      const authorizationFailure = taskBatch
        .map(candidate => ({
          task: candidate,
          validation: candidate.outOfBand
            ? { ok: true, mode: 'side-conversation' }
            : validateApprovedTaskExecution(taskGraphRef.current, candidate),
        }))
        .find(item => !item.validation.ok);
      if (authorizationFailure) {
        const rejectedTask = authorizationFailure.task;
        if (rejectedTask?.graphNodeId && taskGraphRef.current?.nodes?.some(node => node.id === rejectedTask.graphNodeId)) {
          const belongsToContract = taskGraphRef.current?.approvedPlan?.nodes?.some(node => node.id === rejectedTask.graphNodeId);
          commitTaskGraph(graph => belongsToContract
            ? updateTaskNodeStatus(graph, rejectedTask.graphNodeId, 'waiting_user', {
              blockedReason: 'contract-violation',
              issueSummary: authorizationFailure.validation.reason,
            })
            : removePlanningTask(graph, rejectedTask.graphNodeId));
        }
        const attentionCheckpoint = {
          mode: 'execution',
          status: 'needs-attention',
          pendingTasks: [],
          parallelTaskIds: [],
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        };
        persistRunCheckpoint(attentionCheckpoint);
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🛡️|${t('Eine nicht freigegebene Workflowaktion wurde blockiert: {reason} Der Plan blieb unverändert. Nur der User kann eine neue Planversion anlegen.', { reason: authorizationFailure.validation.reason })}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
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

      const executions = !planningOnly && taskGraphRef.current?.approvedPlan
        ? await runWorkConservingApprovedBatch(taskBatch)
        : await runTaskBatch(taskBatch, async batchTask => {
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
      const groupPauseExecutions = executions.filter(execution => execution.groupPauseRequested);
      const delegationApprovalExecutions = executions.filter(execution => execution.delegationApprovalRequested);
      const delegationUnavailableExecutions = executions.filter(execution => execution.delegationUnavailable);
      for (const execution of groupPauseExecutions) {
        const requests = execution.groupPauseRequests || [];
        const batchId = requests[0]?.batchId;
        if (!batchId || retainedGroupWaits.some(wait => wait.batchId === batchId)) continue;
        retainedGroupWaits.push({
          batchId,
          requestIds: requests.map(request => request.id),
          targetGroupIds: requests.map(request => request.targetGroupId),
          targetGroupNames: requests.map(request => request.targetGroupName),
          kind: requests.some(request => request.kind === 'task_delegation') ? 'task_delegation' : 'consultation',
          task: execution.task,
          interimResult: execution.interimResult || '',
          createdAt: Date.now(),
        });
      }
      for (const execution of delegationApprovalExecutions) {
        if (retainedDelegationWaits.some(wait => wait.taskId === execution.task.graphNodeId)) continue;
        retainedDelegationWaits.push({
          taskId: execution.task.graphNodeId,
          task: execution.task,
          proposal: execution.delegationProposal,
          createdAt: Date.now(),
        });
      }
      if (planningOnly) {
        const planningPause = executions.find(execution => execution.pauseRequested);
        const pauseQuestion = planningPause?.pauseQuestion || '';
        if (planningPause) setGraphTaskStatus(planningPause.task, 'waiting_user');
        persistRunCheckpoint({
          status: planningPause ? 'awaiting-user' : groupPauseExecutions.length > 0 ? 'awaiting-group' : 'planning',
          ...(planningPause ? {
            askingAgent: planningPause.agent,
            askingGraphNodeId: planningPause.task.graphNodeId,
            question: pauseQuestion,
          } : {}),
          pendingTasks: planningDraftTasks,
          initialObjective,
          needsSynthesis: planningDraftTasks.length > 0,
          synthesisCount,
          delegatedResults: [],
          successfulTasks: 0,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        if (planningPause) {
          const questionList = pauseQuestion
            .split('\n')
            .map(question => question.trim())
            .filter(Boolean)
            .map(question => `• ${question}`)
            .join('\n');
          setStoppedForUser(true);
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `💬|${t('{agent} wartet auf deine Antwort:', { agent: planningPause.agent.name })}\n\n${questionList || `• ${t('Bitte beantworte die Rückfrage des Agenten.')}`}\n\n${t('Antworte einfach im Eingabefeld – danach läuft die Agenten-Konversation weiter.')}`,
            ts: Date.now(), isError: false,
          });
        }
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
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🗺️|${t('Der Aufgabenplan ist bereit. Prüfe ihn im Workflowfenster und starte die laut Abhängigkeiten bereiten Aufgaben.')}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (delegationUnavailableExecutions.length > 0) {
        persistRunCheckpoint({
          status: 'needs-attention',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setRunning(false);
        return;
      }

      if (delegationApprovalExecutions.length > 0) {
        persistRunCheckpoint({
          status: 'awaiting-delegation',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setRunning(false);
        return;
      }

      if (groupPauseExecutions.length > 0) {
        persistRunCheckpoint({
          status: 'awaiting-group',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setRunning(false);
        return;
      }

      // A locked workflow advances from the approved graph itself. The PM may
      // describe work, but cannot silently redefine which task runs next.
      if (taskQueue.length === 0 && needsSynthesis && taskGraphRef.current?.approvedPlan && activePlanRootNodeId) {
        const approvedTasks = enqueueReadyApprovedWorkflowTasks();
        if (approvedTasks.length > 0) {
          const safeParallelIds = findSafeAutoParallelTaskIds(taskGraphRef.current, approvedTasks);
          safeParallelIds.forEach(nodeId => requestedParallelTaskIds.add(nodeId));
          taskQueue.prioritize(safeParallelIds);
        }
      }

      if (taskQueue.length === 0 && needsSynthesis && taskGraphRef.current?.approvedPlan) {
        const openContractNodes = (taskGraphRef.current.nodes || []).filter(node =>
          node.planRootId === activePlanRootNodeId &&
          inferTaskNodeType(node) !== 'request' &&
          !FINISHED_PLAN_STATUSES.has(node.status)
        );
        resumableFailure = openContractNodes.length > 0;
        needsSynthesis = false;
        if (resumableFailure) {
          persistRunCheckpoint({
            status: retainedDelegationWaits.length > 0
              ? 'awaiting-delegation'
              : retainedGroupWaits.length > 0
                ? 'awaiting-group'
                : 'needs-attention',
            pendingTasks: [],
            initialObjective,
            needsSynthesis: false,
            synthesisCount,
            delegatedResults: [...delegatedResults],
            successfulTasks,
            queueGuard: taskQueue.guardState(),
            planRootGraphNodeId: activePlanRootNodeId,
          });
        } else {
          delegatedResults.length = 0;
        }
      }

      // Free mode retains dynamic PM synthesis. Approved workflows execute only
      // user-authored nodes; even the PM cannot create a hidden review task.
      if (taskQueue.length === 0 && needsSynthesis && pm && delegatedResults.length > 0 && !taskGraphRef.current?.approvedPlan) {
        synthesisCount += 1;
        const reviewDependencyIds = [...new Set(delegatedResults.map(item => item.graphNodeId).filter(Boolean))];
        const synthesisHandoff = createHandoff({
          from: `Team-Runde-${synthesisCount}`,
          to: pm.name,
          taskId: `synthesis-${Date.now().toString(36)}`,
          summary: `Final-Review: Prüfe alle Ergebnisse gegen die ursprüngliche User-Anforderung "${initialObjective}". Falls etwas offen ist, delegiere es konkret an den zuständigen Agenten. Falls alles erfüllt ist, gib den Abschluss an den User und beende mit [[PROJECT_DONE]].`,
          findings: delegatedResults.slice(-12).map(item => `${item.agent} | Aufgabe: ${item.objective} | Ergebnis: ${String(item.result || '').slice(0, 6000)}`),
        });
        const synthesisTask = registerGraphTask({
          agent: pm,
          objective: synthesisHandoff.summary,
          handoff: synthesisHandoff,
          source: 'team-synthesis',
          planRootId: activePlanRootNodeId,
        }, {
          status: 'planned',
          parentNodeId: reviewDependencyIds.length ? null : task.graphNodeId,
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
      if (taskGraphRef.current?.approvedPlan) {
        persistRunCheckpoint({
          status: 'limit-reached',
          pendingTasks: pendingAtLimit,
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
          text: `💾|${t('Der freigegebene Workflow wurde an der Laufgrenze sicher pausiert. Mit „Fortsetzen“ läuft derselbe Plan weiter.', { count: conversationLimits.maxTurns })}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }
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
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🗺️|${t('Der Aufgabenplan ist bereit. Prüfe ihn im Workflowfenster und starte die laut Abhängigkeiten bereiten Aufgaben.')}`,
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
      finishRunCheckpoint();
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
    } else if (retainedDelegationWaits.length > 0) {
      persistRunCheckpoint({
        status: 'awaiting-delegation',
        pendingTasks: taskQueue.pendingTasks(),
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
      });
    } else if (retainedGroupWaits.length > 0) {
      persistRunCheckpoint({
        status: 'awaiting-group',
        pendingTasks: taskQueue.pendingTasks(),
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
      });
    } else if (resumableFailure) {
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `⏸|${t('Der Arbeitsstand wurde gespeichert. Du kannst den Lauf mit „Fortsetzen“ an derselben Stelle erneut starten.')}`,
        ts: Date.now(), isError: false,
      });
    } else if (successfulTasks > 0) {
      finishRunCheckpoint();
      if (chat.type === 'group' && !sideConversation) {
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
      finishRunCheckpoint();
    }
    setRunning(false);
  }, [apiKeys, providerConnections, chatAgents, groups, conversationStates, kbPath, projectPath, memoryEnabled, memoryConfig?.namespace, memoryAPI, mcpServers, chat, qualityRouting, conversationLimits, recordQualityEvent, refreshMemoryCount, addMessage, enqueueCrossGroupRequest, requestMcpPermission, handleMcpPermissionConsumed, handleMcpToolResult, persistConversationCheckpoint, discardConversationCheckpoint, commitTaskGraph, registerGraphTask, setGraphTaskStatus, language, t]);

  const handleCancelRun = useCallback(async (options = {}) => {
    if (!running) return;
    const preserveProgress = options?.preserveProgress !== false;
    const announce = options?.announce !== false;
    queueDrainPausedRef.current = true;
    cancelAllMcpApprovals();
    const activeRuns = [...activeAgentRunRef.current.values()];
    const currentCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];

    // Stop the local queue immediately. A pending remote API response may still
    // arrive in the background, but its result is discarded by runId.
    runIdRef.current += 1;
    activeAgentRunRef.current.clear();
    if (preserveProgress && activeRuns.length > 0) {
      commitTaskGraph(graph => activeRuns.reduce((nextGraph, activeRun) => {
        if (!activeRun.graphNodeId) return nextGraph;
        const activeNode = nextGraph.nodes.find(node => node.id === activeRun.graphNodeId);
        let interruptedGraph = updateTaskNodeStatus(nextGraph, activeRun.graphNodeId, 'interrupted', { interruptedAt: Date.now() });
        if (activeNode?.runtimeRecovery && activeNode.recovery?.originalGraphNodeId) {
          interruptedGraph = updateTaskNodeStatus(interruptedGraph, activeNode.recovery.originalGraphNodeId, activeNode.recovery.originalStatus || 'timed_out', {
            recoveryStatus: null,
            recoveryTaskId: null,
          });
        }
        return interruptedGraph;
      }, graph));
    }
    if (preserveProgress && currentCheckpoint) {
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

    if (window.electronAPI?.reviewStop) {
      await window.electronAPI.reviewStop(chat.id, 'test').catch(() => null);
    }
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

    if (announce) {
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
    }
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
    const addressedGroups = chat.type === 'group'
      ? extractGroupMentions(text, groups, { sourceGroupId: chat.id, userAuthored: true })
      : [];
    if (addressedGroups.length > 0) {
      const batchId = `group-request-batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const createdRequests = [];
      for (const mention of addressedGroups) {
        const request = createCrossGroupRequest({
          sourceGroup: chat,
          targetGroup: mention.group,
          question: mention.question,
          attachments,
          batchId,
          origin: 'user',
          qualityMode: messageQualityMode,
        });
        if (request) {
          enqueueCrossGroupRequest(request);
          createdRequests.push(request);
        }
      }
      if (createdRequests.length === 0) {
        addMessage(chat.id, {
          id: `cross-group-disabled-${batchId}`,
          agentId: 'system',
          senderName: 'System',
          text: `↗|${t('Die Informationsanfrage wurde nicht gesendet. Prüfe, ob die Quellgruppe Anfragen senden darf und die Zielgruppe als erreichbar ausgewählt ist.')}`,
          ts: Date.now(),
          isError: true,
        });
        return;
      }
      addMessage(chat.id, {
        id: `cross-group-sent-${batchId}`,
        agentId: 'system',
        senderName: 'System',
        text: `↗|${t('Anfrage an {groups} gesendet. Die Zielgruppe arbeitet auch dann im Hintergrund, wenn ihr Chat nicht geöffnet ist.', {
          groups: createdRequests.map(request => request.targetGroupName).join(', '),
        })}`,
        ts: Date.now(),
        isError: false,
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
  }, [input, running, focusComposer, sendUserMessage, chatMessages, runAgents, addMessage, enqueueUserRequest, enqueueCrossGroupRequest, chat, groups, messageQualityMode, t]);

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

  const handleRunNow = useCallback(() => {
    queueDrainPausedRef.current = false;
    // A saved checkpoint takes precedence; otherwise the PM starts a new run.
    const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
    const workflowResetAt = Number(taskGraphRef.current?.workflowResetAt) || 0;
    const hasNewRequest = chatMessages.some(message => message.agentId === 'user' && Number(message.ts) > workflowResetAt);
    if (taskGraphRef.current?.workflowResetRequired && !hasNewRequest) {
      addMessage(chat.id, {
        id: `workflow-reset-input-required-${workflowResetAt}`,
        agentId: 'system', senderName: 'System',
        text: `⚠️|${t('Bitte sende zuerst eine neue Anforderung. Der gelöschte Workflow wird nicht aus dem alten Chat rekonstruiert.')}`,
        ts: Date.now(), isError: false,
      });
      return;
    }
    if (!checkpoint && queuedUserRequests.length > 0) {
      setQueuePump(current => current + 1);
      return;
    }
    runAgents(chatMessages, null);
  }, [addMessage, chat.id, chatMessages, conversationStates, queuedUserRequests.length, runAgents, t]);

  const handleScheduleChoice = (parallelTaskIds = []) => {
    queueDrainPausedRef.current = false;
    const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
    if (!checkpoint || (checkpoint.status !== 'awaiting-schedule' && checkpoint.mode !== 'planning')) return;
    const pendingTasks = checkpoint.mode === 'planning'
      ? buildPlanningPendingTasks(taskGraphRef.current, checkpoint, chatAgents)
      : (checkpoint.pendingTasks || []);
    if (!pendingTasks.length) return;
    const workflowValidation = checkpoint.mode === 'planning'
      ? validateWorkflowPlan(taskGraphRef.current)
      : { ok: true };
    if (!workflowValidation.ok) {
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🔐|${t('Der Workflow kann noch nicht freigegeben werden: {reason}', {
          reason: t(workflowValidation.messageKey || workflowValidation.reason, workflowValidation.messageValues),
        })}`,
        ts: Date.now(), isError: true,
      });
      return;
    }
    if (checkpoint.mode === 'planning') {
      const unavailableAgent = (taskGraphRef.current?.nodes || [])
        .filter(node => inferTaskNodeType(node) !== 'request')
        .map(node => chatAgents.find(agent => agent.id === node.agentId))
        .find(agent => agent && !isAgentProviderConfigured(agent, apiKeys, providerConnections));
      if (unavailableAgent) {
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🔌|${t('Der Workflow kann noch nicht freigegeben werden: Der Provider für {agent} ist nicht verbunden.', { agent: unavailableAgent.name })}`,
          ts: Date.now(), isError: true,
        });
        return;
      }
    }
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
    const executionGraph = commitTaskGraph(graph => {
      const scheduledGraph = pendingTasks.reduce((nextGraph, pendingTask) => {
      if (!pendingTask.graphNodeId) return nextGraph;
      return updateTaskNodeStatus(nextGraph, pendingTask.graphNodeId, 'queued', {
        parallelBatchId: selectedIds.has(pendingTask.graphNodeId) ? parallelBatchId : null,
      });
      }, graph);
      if (checkpoint.mode !== 'planning') return scheduledGraph;
      const configuredGraph = {
        ...scheduledGraph,
        nodes: scheduledGraph.nodes.map(node => {
          const agent = chatAgents.find(candidate => candidate.id === node.agentId);
          return agent ? { ...node, provider: agent.provider, model: node.modelOverride || agent.model } : node;
        }),
      };
      return lockTaskGraphPlan(configuredGraph);
    });
    const executionPendingTasks = checkpoint.mode === 'planning'
      ? pendingTasks.map(pendingTask => {
        const approvedNode = executionGraph.approvedPlan?.nodes?.find(node => node.id === pendingTask.graphNodeId);
        const approvedModel = approvedNode?.modelOverride || approvedNode?.model;
        return approvedModel ? { ...pendingTask, modelOverride: approvedModel } : pendingTask;
      })
      : pendingTasks;
    persistConversationCheckpoint({
      ...checkpoint,
      mode: 'execution',
      status: 'interrupted',
      pendingTasks: executionPendingTasks,
      parallelTaskIds,
    });
    addMessage(chat.id, {
      id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
      text: parallelTaskIds.length > 0
        ? `⚡|${t('{count} unabhängige Aufgaben starten jetzt parallel. Die übrigen Aufgaben folgen danach.', { count: parallelTaskIds.length })}`
        : `▶|${t('Die bereiten Aufgaben werden gemäß ihren Abhängigkeiten gestartet.')}`,
      ts: Date.now(), isError: false,
    });
    runAgents(chatMessages, null);
  };

  const activatePlanningMode = useCallback(({ fresh = false, resetRequired = false } = {}) => {
    const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
    if (chat.type !== 'group' || (!fresh && (running || checkpoint))) return;
    const currentGraph = fresh ? null : taskGraphRef.current;
    const suspendedCheckpoint = !fresh && currentGraph?.planningSuspended
      ? currentGraph.suspendedPlanningCheckpoint
      : null;
    const graph = currentGraph?.planningSuspended
      ? {
        ...currentGraph,
        workflowState: 'planning',
        planningSuspended: false,
        suspendedPlanningCheckpoint: null,
        updatedAt: Date.now(),
      }
      : {
        ...createTaskGraph(chat.id, chat.name),
        workflowState: 'planning',
        ...(resetRequired ? { workflowResetRequired: true, workflowResetAt: Date.now() } : {}),
      };
    taskGraphRef.current = graph;
    saveTaskGraph(chat.id, graph);
    queueDrainPausedRef.current = false;
    const rootNode = graph.nodes.find(node => inferTaskNodeType(node) === 'request');
    persistConversationCheckpoint({
      ...(suspendedCheckpoint || {}),
      mode: 'planning',
      status: 'planning',
      pendingTasks: suspendedCheckpoint?.pendingTasks
        || buildPlanningPendingTasks(graph, suspendedCheckpoint || {}, chatAgents),
      parallelTaskIds: suspendedCheckpoint?.parallelTaskIds || [],
      initialObjective: suspendedCheckpoint?.initialObjective || rootNode?.objective || rootNode?.title || '',
      needsSynthesis: suspendedCheckpoint?.needsSynthesis || false,
      synthesisCount: suspendedCheckpoint?.synthesisCount || 0,
      delegatedResults: suspendedCheckpoint?.delegatedResults || [],
      successfulTasks: suspendedCheckpoint?.successfulTasks || 0,
      planRootGraphNodeId: suspendedCheckpoint?.planRootGraphNodeId || rootNode?.id || null,
    });
    window.requestAnimationFrame(focusComposer);
  }, [chat.id, chat.name, chat.type, chatAgents, conversationStates, focusComposer, persistConversationCheckpoint, running, saveTaskGraph]);

  const handleStartPlanningMode = () => activatePlanningMode();

  const handleDeactivatePlanningMode = async () => {
    if (chat.type !== 'group') return;
    if (running) await handleCancelRun();
    const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
    const suspendedAt = Date.now();
    commitTaskGraph(graph => ({
      ...graph,
      workflowState: 'idle',
      planningSuspended: true,
      suspendedPlanningCheckpoint: checkpoint ? {
        ...checkpoint,
        mode: 'planning',
        status: 'planning',
      } : null,
      planningSuspendedAt: suspendedAt,
      updatedAt: suspendedAt,
    }));
    discardConversationCheckpoint();
    window.requestAnimationFrame(focusComposer);
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

  const cancelAndRemoveGroupRequests = useCallback((requestIds, reason) => {
    const allGroupRequests = Object.values(crossGroupRequests || {});
    const relatedRequestIds = new Set(requestIds);
    const relatedRequests = allGroupRequests.filter(request => relatedRequestIds.has(request.id));
    if (relatedRequests.length === 0) return 0;
    const relatedBatchIds = new Set(relatedRequests.map(request => request.batchId).filter(Boolean));
    for (const [queueChatId, requests] of Object.entries(userRequestQueues || {})) {
      for (const queuedRequest of requests || []) {
        if (queuedRequest.kind === 'cross-group-answer' && relatedBatchIds.has(queuedRequest.crossGroupBatchId)) {
          removeUserRequest(queueChatId, queuedRequest.id);
        }
      }
    }
    const cancelledAt = Date.now();
    for (const request of relatedRequests) {
      if (isCrossGroupRequestTerminal(request) && !['failed', 'timed_out'].includes(request.status)) continue;
      updateCrossGroupRequest(request.id, {
        status: 'cancelled',
        runtimePlan: finishRequestRuntimePlan(request.runtimePlan, 'cancelled', reason),
        error: reason,
        completedAt: cancelledAt,
        deliveredAt: cancelledAt,
      });
    }
    removeCrossGroupRequests([...relatedRequestIds]);
    return relatedRequests.length;
  }, [crossGroupRequests, removeCrossGroupRequests, removeUserRequest, updateCrossGroupRequest, userRequestQueues]);

  const groupRequestTreeIds = useCallback((predicate) => {
    const requests = Object.values(crossGroupRequests || {});
    const rootIds = new Set(requests.filter(predicate).map(request => request.rootRequestId || request.id));
    return requests
      .filter(request => rootIds.has(request.rootRequestId || request.id))
      .map(request => request.id);
  }, [crossGroupRequests]);

  const cancelTaskBoundGroupWork = useCallback((graph, reason = t('Der zugehörige Workflow wurde gelöscht.')) => {
    const workflowTaskIds = new Set((graph?.nodes || []).map(node => node.id));
    const requestIds = groupRequestTreeIds(request => workflowTaskIds.has(request.sourceTaskId));
    return cancelAndRemoveGroupRequests(requestIds, reason);
  }, [cancelAndRemoveGroupRequests, groupRequestTreeIds, t]);

  const handleDeleteWorkflow = useCallback(async () => {
    if (workflowDeletePendingRef.current) return;
    const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
    const graph = taskGraphRef.current;
    const groupRequestIds = groupRequestTreeIds(request => (
      request.sourceGroupId === chat.id || request.targetGroupId === chat.id
    ));
    if (!checkpoint && !(graph?.nodes || []).length && groupRequestIds.length === 0) return;
    workflowDeletePendingRef.current = true;

    try {
      cancelAndRemoveGroupRequests(groupRequestIds, t('Der zugehörige Workflow wurde gelöscht.'));

      // Invalidate provider work before removing persistence. Otherwise a late
      // response could recreate progress that the user explicitly deleted.
      if (running) {
        await handleCancelRun({ preserveProgress: false, announce: false });
      } else {
        runIdRef.current += 1;
        activeAgentRunRef.current.clear();
        cancelAllMcpApprovals();
        setTypingAgents([]);
        setAgentProgress({});
      }

      discardConversationCheckpoint();
      clearTaskGraph(chat.id);
      workflowUndoStackRef.current = [];
      workflowQuestionAnswerPendingRef.current = false;
      setLastRunContext(null);
      setStoppedForUser(false);
      // Deletion ends the old execution contract, but groups default to a new,
      // empty planning session. The reset marker gives the next PM call a
      // system-level instruction not to reconstruct the removed plan from chat.
      activatePlanningMode({ fresh: true, resetRequired: true });
      addMessage(chat.id, {
        id: Date.now() + Math.random(),
        agentId: 'system',
        senderName: 'System',
        text: `⚠️|${t('Achtung, der Workflow wurde entfernt. Beginne eine neue Planung. Chatnachrichten und Gruppen bleiben erhalten.')}`,
        ts: Date.now(),
        isError: false,
        workflowReset: true,
      });
      window.requestAnimationFrame(focusComposer);
    } finally {
      workflowDeletePendingRef.current = false;
    }
  }, [activatePlanningMode, addMessage, cancelAllMcpApprovals, cancelAndRemoveGroupRequests, chat.id, clearTaskGraph, conversationStates, discardConversationCheckpoint, focusComposer, groupRequestTreeIds, handleCancelRun, running, t]);

  const handleExportWorkflow = useCallback(async () => {
    if (workflowFileStatus.busy || !(taskGraphRef.current?.nodes || []).length) return;
    setWorkflowFileStatus({ busy: 'export', message: '', error: '' });
    try {
      if (!window.electronAPI?.exportWorkflowFile) throw new Error(t('Workflow-Dateien werden in dieser Umgebung nicht unterstützt.'));
      const document = createWorkflowExportDocument(taskGraphRef.current, { agents: chatAgents });
      const result = await window.electronAPI.exportWorkflowFile(document, document.title || chat.name);
      if (result?.cancelled) {
        setWorkflowFileStatus({ busy: '', message: '', error: '' });
        return;
      }
      if (!result?.ok) throw new Error(result?.error || t('Workflow konnte nicht exportiert werden.'));
      const message = t('Workflow wurde als „{file}“ exportiert.', { file: result.fileName || 'Workflow.json' });
      setWorkflowFileStatus({ busy: '', message, error: '' });
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `⇩|${message}`, ts: Date.now(), isError: false,
      });
    } catch (error) {
      setWorkflowFileStatus({ busy: '', message: '', error: error.message || t('Workflow konnte nicht exportiert werden.') });
    }
  }, [addMessage, chat.id, chat.name, chatAgents, t, workflowFileStatus.busy]);

  const handleImportWorkflow = useCallback(async () => {
    if (running || workflowFileStatus.busy) return;
    setWorkflowFileStatus({ busy: 'import', message: '', error: '' });
    try {
      if (!window.electronAPI?.importWorkflowFile) throw new Error(t('Workflow-Dateien werden in dieser Umgebung nicht unterstützt.'));
      const result = await window.electronAPI.importWorkflowFile();
      if (result?.cancelled) {
        setWorkflowFileStatus({ busy: '', message: '', error: '' });
        return;
      }
      if (!result?.ok) throw new Error(result?.error || t('Workflow konnte nicht importiert werden.'));
      const preview = suggestWorkflowAgentMappings(result.document, chatAgents);
      // Validate topology before showing the mapping dialog. A synthetic local
      // agent is used only for slots that still require a manual assignment.
      const validationAgent = { id: '__workflow_import_validation__', name: 'Importprüfung', role: '', provider: '', model: '' };
      const validationMappings = Object.fromEntries(preview.slots.map(slot => [
        slot.id,
        preview.mappings[slot.id] || validationAgent.id,
      ]));
      createImportedTaskGraph(preview.document, {
        chatId: chat.id,
        chatName: chat.name,
        agents: [...chatAgents, validationAgent],
        mappings: validationMappings,
      });
      const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
      setWorkflowImportDraft({
        ...preview,
        fileName: result.fileName || 'Workflow.json',
        replacesExistingWorkflow: Boolean(checkpoint || (taskGraphRef.current?.nodes || []).length),
      });
      setWorkflowFileStatus({ busy: '', message: '', error: '' });
    } catch (error) {
      setWorkflowImportDraft(null);
      setWorkflowFileStatus({ busy: '', message: '', error: error.message || t('Workflow konnte nicht importiert werden.') });
    }
  }, [chat.id, chat.name, chatAgents, conversationStates, running, t, workflowFileStatus.busy]);

  const handleWorkflowImportMapping = useCallback((slotId, agentId) => {
    setWorkflowImportDraft(current => {
      if (!current?.slots.some(slot => slot.id === slotId)) return current;
      const validAgentId = chatAgents.some(agent => agent.id === agentId) ? agentId : '';
      return { ...current, mappings: { ...current.mappings, [slotId]: validAgentId } };
    });
  }, [chatAgents]);

  const handleApplyWorkflowImport = useCallback((confirmedReplace = false) => {
    const draft = workflowImportDraft;
    if (!draft || running) return;
    const currentCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
    const replacementRequired = Boolean(currentCheckpoint || (taskGraphRef.current?.nodes || []).length);
    if (replacementRequired && !confirmedReplace) {
      setWorkflowImportDraft(current => current ? { ...current, replacesExistingWorkflow: true } : current);
      return;
    }
    try {
      const { graph, rootNodeId } = createImportedTaskGraph(draft.document, {
        chatId: chat.id,
        chatName: chat.name,
        agents: chatAgents,
        mappings: draft.mappings,
      });
      cancelTaskBoundGroupWork(taskGraphRef.current, t('Der zugehörige Workflow wurde durch einen Import ersetzt.'));
      runIdRef.current += 1;
      activeAgentRunRef.current.clear();
      cancelAllMcpApprovals();
      setTypingAgents([]);
      setAgentProgress({});
      taskGraphRef.current = graph;
      saveTaskGraph(chat.id, graph);
      workflowUndoStackRef.current = [];
      workflowQuestionAnswerPendingRef.current = false;
      queueDrainPausedRef.current = true;
      setLastRunContext(null);
      setStoppedForUser(false);
      const checkpoint = {
        version: 1,
        mode: 'planning',
        status: 'planning',
        pendingTasks: [],
        parallelTaskIds: [],
        initialObjective: graph.nodes.find(node => node.id === rootNodeId)?.objective || graph.title,
        needsSynthesis: false,
        synthesisCount: 0,
        delegatedResults: [],
        successfulTasks: 0,
        planRootGraphNodeId: rootNodeId,
        qualityMode: messageQualityMode,
      };
      checkpoint.pendingTasks = buildPlanningPendingTasks(graph, checkpoint, chatAgents);
      persistConversationCheckpoint(checkpoint);
      setWorkflowImportDraft(null);
      const message = t('Workflow „{title}“ wurde als Planungsentwurf importiert. Prüfe den Plan und gib ihn anschließend frei.', { title: graph.title });
      setWorkflowFileStatus({ busy: '', message, error: '' });
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `⇧|${message}`, ts: Date.now(), isError: false,
      });
      window.requestAnimationFrame(focusComposer);
    } catch (error) {
      setWorkflowFileStatus({ busy: '', message: '', error: error.message || t('Workflow konnte nicht importiert werden.') });
    }
  }, [addMessage, cancelAllMcpApprovals, cancelTaskBoundGroupWork, chat.id, chat.name, chatAgents, conversationStates, focusComposer, messageQualityMode, persistConversationCheckpoint, running, saveTaskGraph, t, workflowImportDraft]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = Math.min(textareaRef.current.scrollHeight, 120) + 'px';
    }
  }, [input]);

  // Keep every direct and group chat ready for immediate typing. Only the
  // memory editor temporarily owns focus; tool approvals are inline.
  useEffect(() => {
    if (memoryViewer.open) return undefined;
    const frame = window.requestAnimationFrame(focusComposer);
    return () => window.cancelAnimationFrame(frame);
  }, [chat.id, running, memoryViewer.open, mcpApproval, focusComposer]);

  useEffect(() => {
    const restoreComposerFocus = () => {
      if (!memoryViewer.open) window.requestAnimationFrame(focusComposer);
    };
    window.addEventListener('focus', restoreComposerFocus);
    return () => window.removeEventListener('focus', restoreComposerFocus);
  }, [memoryViewer.open, focusComposer]);

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

  const getAgent = (id) => agents.find(a => a.id === id)
    || groups.find(group => `group:${group.id}` === id)
    || (id === 'group:multiple' ? { name: t('Gruppenantworten'), emoji: '↗', color: 2 } : null);

  // Check if last messages contain retryable error
  const hasRecentError = chatMessages.slice(-3).some(m => m.isError);
  const activeTaskGraph = taskGraphs?.[chat.id] || taskGraphRef.current || createTaskGraph(chat.id, chat.name);
  const lastUserMessageIndex = chatMessages.findLastIndex(m => m.agentId === 'user');
  const workflowResetAt = Number(activeTaskGraph?.workflowResetAt) || 0;
  const hasUserRequestAfterWorkflowReset = !activeTaskGraph?.workflowResetRequired || chatMessages.some(message => (
    message.agentId === 'user' && Number(message.ts) > workflowResetAt
  ));
  const hasAgentResponseAfterLastUser = lastUserMessageIndex >= 0 && chatMessages
    .slice(lastUserMessageIndex + 1)
    .some(m => m.agentId !== 'user' && m.agentId !== 'system');
  const canStartAgentsManually = lastUserMessageIndex >= 0 && !hasAgentResponseAfterLastUser && hasUserRequestAfterWorkflowReset;
  const conversationCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
  const providerRetryRemainingMs = conversationCheckpoint?.status === 'provider-limited'
    ? Math.max(0, (conversationCheckpoint.retryNotBefore || 0) - retryClock)
    : 0;
  const providerCooldownActive = providerRetryRemainingMs > 0;
  const resumeMode = RESUMABLE_CHECKPOINT_STATUSES.has(conversationCheckpoint?.status);
  const canResumeConversation = resumeMode
    && !providerCooldownActive;
  const planningActive = conversationCheckpoint?.mode === 'planning';
  const awaitingSchedule = conversationCheckpoint?.status === 'awaiting-schedule';
  const workflowPlanningActive = planningActive || awaitingSchedule;
  const pendingDelegations = useMemo(() => (conversationCheckpoint?.waitingDelegationTasks || []).map(waiting => {
    const taskNode = activeTaskGraph.nodes.find(node => node.id === waiting.taskId);
    const currentDecision = evaluateTaskDelegation({ taskNode, sourceGroup: chat, groups, agents });
    const candidates = ['ask', 'delegate'].includes(currentDecision.action) ? currentDecision.candidates : [];
    return {
      ...waiting,
      proposal: {
        ...waiting.proposal,
        candidate: candidates[0],
        candidates,
      },
    };
  }), [activeTaskGraph, agents, chat, conversationCheckpoint, groups]);
  const workflowModelOptions = useMemo(
    () => buildWorkflowModelOptions(activeTaskGraph, chatAgents, providerConnections),
    [activeTaskGraph, chatAgents, providerConnections],
  );
  const plannedParallelTaskIds = useMemo(() => {
    return findSafeAutoParallelTaskIds(activeTaskGraph, conversationCheckpoint?.pendingTasks || []);
  }, [activeTaskGraph, conversationCheckpoint]);
  const workflowStartValidation = useMemo(
    () => plannedParallelTaskIds.length < 2
      ? { ok: true }
      : validateParallelSelection(activeTaskGraph, plannedParallelTaskIds),
    [activeTaskGraph, plannedParallelTaskIds],
  );
  const workflowInspectionValidation = useMemo(
    () => validateWorkflowPlan(activeTaskGraph),
    [activeTaskGraph],
  );
  const workflowProblems = useMemo(() => collectWorkflowProblems({
    graph: activeTaskGraph,
    sourceGroup: chat,
    groups,
    agents,
    chatAgents,
    apiKeys,
    providerConnections,
    t,
  }), [activeTaskGraph, agents, apiKeys, chat, chatAgents, groups, providerConnections, t]);
  const workflowProblemRootId = (activeTaskGraph?.nodes || []).find(node => inferTaskNodeType(node) === 'request')?.id || chat.id;
  const workflowProblemByNoticeKey = useMemo(() => new Map(workflowProblems.map(problem => [
    `${workflowProblemRootId}:${problem.taskId}:${problem.message}`,
    problem,
  ])), [workflowProblemRootId, workflowProblems]);
  const workflowInspectionReason = workflowProblems[0]?.message || (!workflowInspectionValidation.ok
    ? t(workflowInspectionValidation.messageKey || workflowInspectionValidation.reason, workflowInspectionValidation.messageValues)
    : '');
  const workflowInspectionTaskIds = useMemo(() => workflowProblems.map(problem => problem.taskId), [workflowProblems]);
  const workflowPreflightReason = planningActive ? workflowInspectionReason : '';
  const workflowStartDisabled = running || !(conversationCheckpoint?.pendingTasks || []).length || !workflowStartValidation.ok || !!workflowPreflightReason;
  const queuedUserMessageIds = new Set(queuedUserRequests.map(request => String(request.messageId)));

  const resolveWorkflowProblem = useCallback(async (taskId, answer, suppliedProblem = null) => {
    const normalizedAnswer = String(answer || '').trim();
    const problem = suppliedProblem || workflowProblems.find(candidate => candidate.taskId === taskId);
    if (!normalizedAnswer || !problem || running || workflowProblemAnswerPendingRef.current) return;
    workflowProblemAnswerPendingRef.current = true;
    try {
      const prompt = [
        '@PM: Löse das folgende Workflow-Problem in der Planungsphase.',
        `Betroffene Aufgabe: ${problem.taskTitle}`,
        `Problem: ${problem.message}`,
        problem.suggestion ? `Bisheriger Lösungsvorschlag: ${problem.suggestion}` : '',
        `Vorgabe oder Zusatzinformation des Users: ${normalizedAnswer}`,
        'Passe den Aufgabenplan nur soweit nötig an. Wenn stattdessen eine Gruppen- oder Agentenkonfiguration geändert werden muss, erkläre dem User konkret welche Einstellung fehlt.',
      ].filter(Boolean).join('\n\n');
      const userMessage = await sendUserMessage(prompt, [], messageQualityMode);
      if (!userMessage) return;
      await runAgents([...chatMessagesRef.current, userMessage], prompt, { planningOnly: true });
    } finally {
      workflowProblemAnswerPendingRef.current = false;
    }
  }, [messageQualityMode, runAgents, running, sendUserMessage, workflowProblems]);

  useEffect(() => {
    if (!active || chat.type !== 'group' || !planningActive) return;
    const currentKeys = new Set(workflowProblemByNoticeKey.keys());
    for (const key of [...announcedWorkflowProblemKeysRef.current]) {
      if (!currentKeys.has(key)) announcedWorkflowProblemKeysRef.current.delete(key);
    }
    for (const problem of workflowProblems) {
      const key = `${workflowProblemRootId}:${problem.taskId}:${problem.message}`;
      const alreadyPersisted = chatMessages.some(message => message.workflowProblemKey === key);
      if (announcedWorkflowProblemKeysRef.current.has(key) || alreadyPersisted) {
        announcedWorkflowProblemKeysRef.current.add(key);
        continue;
      }
      announcedWorkflowProblemKeysRef.current.add(key);
      addMessage(chat.id, {
        id: `workflow-problem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        agentId: 'system',
        senderName: 'System',
        text: `⚠|${t('Workflow-Problem bei „{task}“: {problem} Klicke auf „Lösen“, um dem PM eine Vorgabe oder Zusatzinformation zu geben.', { task: problem.taskTitle, problem: problem.message })}`,
        ts: Date.now(),
        isError: true,
        workflowProblemKey: key,
        workflowProblem: problem,
      });
    }
  }, [active, addMessage, chat.id, chat.type, chatMessages, planningActive, t, workflowProblemByNoticeKey, workflowProblemRootId, workflowProblems]);

  // The first active view of an unused group starts in planning mode. An
  // explicit X/deactivation persists planningSuspended and is therefore not
  // undone when the user switches chats or restarts the app.
  useEffect(() => {
    if (
      !active || chat.type !== 'group' || running || conversationCheckpoint ||
      activeTaskGraph?.planningSuspended || activeTaskGraph?.approvedPlan ||
      (activeTaskGraph?.nodes || []).length > 0
    ) return;
    activatePlanningMode();
  }, [activatePlanningMode, active, activeTaskGraph, chat.type, conversationCheckpoint, running]);

  useEffect(() => {
    if (!planningActive) workflowUndoStackRef.current = [];
  }, [chat.id, planningActive]);

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
        await runAgents(history, triggerText, request.kind === 'cross-group-answer'
          ? { crossGroupBatchId: request.crossGroupBatchId }
          : {});
      } finally {
        removeUserRequest(chat.id, request.id);
        queueProcessingRef.current = null;
        setQueuePump(current => current + 1);
      }
    })();
  }, [awaitingSchedule, chat.id, providerCooldownActive, queuePump, queuedUserRequests, removeUserRequest, runAgents, running, t]);

  useEffect(() => {
    if (!active || chat.type !== 'group' || !window.electronAPI?.updateTaskWindow) return;
    window.electronAPI.updateTaskWindow({
      chatId: chat.id,
      chatName: chat.name,
      windowTitle: `${t('Workflow')} – ${chat.name}`,
      graph: activeTaskGraph,
      running,
      activeTaskIds: getActiveWorkflowTaskIds(activeTaskGraph),
      pendingQuestions: getPendingWorkflowQuestions(conversationCheckpoint),
      workflowProblems,
      pendingDelegations,
      groupRequests: chatGroupRequests,
      delegationEnabled: chat.crossGroupCollaborationEnabled === true,
      groupOptions: groups
        .filter(group => reachableCrossGroupIds.includes(group.id))
        .map(group => ({ id: group.id, name: group.name, emoji: group.emoji || '💬' })),
      resumeMode,
      canResumeWorkflow: canResumeConversation,
      resumeRetrySeconds: Math.ceil(providerRetryRemainingMs / 1000),
      canUndo: planningActive && !running && workflowUndoStackRef.current.length > 0,
      canDeleteWorkflow: Boolean(conversationCheckpoint || activeTaskGraph.nodes.length > 0 || chatGroupRequests.length > 0),
      workflowImport: workflowImportWindowState,
      workflowFileStatus,
      awaitingSchedule: workflowPlanningActive,
      structureEditable: planningActive && !running,
      canEditWorkflow: !planningActive && activeTaskGraph.nodes.length > 0,
      modelOptionsByTask: workflowModelOptions,
      agentOptions: chatAgents.map(({ id, name, emoji, role, provider, model }) => ({ id, name, emoji, role, provider, model })),
      preflightError: workflowInspectionReason,
      preflightTaskIds: workflowInspectionTaskIds,
    });
  }, [active, activeTaskGraph, canResumeConversation, chat.crossGroupCollaborationEnabled, chat.crossGroupTargetGroupId, chat.crossGroupTargetGroupIds, chat.id, chat.name, chat.type, chatAgents, chatGroupRequests, getActiveWorkflowTaskIds, getPendingWorkflowQuestions, groups, pendingDelegations, planningActive, providerRetryRemainingMs, resumeMode, running, t, typingAgents, workflowFileStatus, workflowImportWindowState, workflowInspectionReason, workflowInspectionTaskIds, workflowModelOptions, workflowPlanningActive, workflowProblems]);

  useEffect(() => {
    if (!window.electronAPI?.onTaskWindowAction) return undefined;
    return window.electronAPI.onTaskWindowAction(action => {
      if (action?.chatId !== chat.id) return;
      const syncPlanningCheckpoint = nextGraph => {
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
        if (checkpoint) persistConversationCheckpoint({
          ...checkpoint,
          pendingTasks: buildPlanningPendingTasks(nextGraph, checkpoint, chatAgents),
          });
        };
      const commitUndoableGraphChange = (updater, { userOwned = false } = {}) => commitTaskGraph(graph => {
        const updatedGraph = typeof updater === 'function' ? updater(graph) : updater;
        if (!updatedGraph || updatedGraph === graph) return graph;
        workflowUndoStackRef.current.push(graph);
        if (workflowUndoStackRef.current.length > 50) workflowUndoStackRef.current.shift();
        return userOwned ? markTaskGraphUserOwned(updatedGraph) : updatedGraph;
      });
      const commitUserPlanChange = updater => commitUndoableGraphChange(updater, { userOwned: true });
      if (action.type === 'export-workflow') {
        void handleExportWorkflow();
        return;
      }
      if (action.type === 'import-workflow') {
        void handleImportWorkflow();
        return;
      }
      if (action.type === 'map-workflow-import-slot') {
        handleWorkflowImportMapping(action.slotId, action.agentId);
        return;
      }
      if (action.type === 'apply-workflow-import') {
        handleApplyWorkflowImport(action.confirmedReplace === true);
        return;
      }
      if (action.type === 'cancel-workflow-import') {
        setWorkflowImportDraft(null);
        setWorkflowFileStatus({ busy: '', message: '', error: '' });
        return;
      }
      if (action.type === 'clear-workflow-file-status') {
        setWorkflowFileStatus({ busy: '', message: '', error: '' });
        return;
      }
      if (action.type === 'delete-workflow') {
        void handleDeleteWorkflow();
        return;
      }
      if (action.type === 'answer-agent-question') {
        const answer = String(action.answer || '').trim();
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
        if (
          !answer || running || workflowQuestionAnswerPendingRef.current ||
          checkpoint?.status !== 'awaiting-user' ||
          checkpoint.askingGraphNodeId !== action.taskId
        ) return;
        workflowQuestionAnswerPendingRef.current = true;
        void (async () => {
          try {
            const userMessage = await sendUserMessage(answer, [], messageQualityMode);
            if (!userMessage) return;
            await runAgents([...chatMessagesRef.current, userMessage], answer);
          } finally {
            workflowQuestionAnswerPendingRef.current = false;
          }
        })();
        return;
      }
      if (action.type === 'resolve-workflow-problem') {
        void resolveWorkflowProblem(action.taskId, action.answer, action.problem);
        return;
      }
      if (action.type === 'undo-workflow-change') {
        if (running || !planningActive) return;
        const previousGraph = workflowUndoStackRef.current.pop();
        if (!previousGraph) return;
        const nextGraph = commitTaskGraph(markTaskGraphUserOwned(previousGraph));
        syncPlanningCheckpoint(nextGraph);
        return;
      }
      if (action.type === 'restore-workflow-snapshot') {
        if (!planningActive || !taskGraphRef.current?.previousApprovedPlan) return;
        const nextGraph = commitUserPlanChange(restoreTaskGraphSnapshot);
        syncPlanningCheckpoint(nextGraph);
        return;
      }
      if (action.type === 'edit-workflow') {
        if (running || planningActive || !taskGraphRef.current?.nodes?.length) return;
        const currentCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || {};
        const nextGraph = commitTaskGraph(beginUserPlanEdit);
        const rootNode = nextGraph.nodes.find(node => inferTaskNodeType(node) === 'request');
        const draftCheckpoint = {
          ...currentCheckpoint,
          mode: 'planning',
          status: 'planning',
          parallelTaskIds: [],
          planRootGraphNodeId: currentCheckpoint.planRootGraphNodeId || rootNode?.id || null,
          initialObjective: currentCheckpoint.initialObjective || rootNode?.objective || rootNode?.title || '',
          changeRequest: nextGraph.changeRequest,
        };
        draftCheckpoint.pendingTasks = buildPlanningPendingTasks(nextGraph, draftCheckpoint, chatAgents);
        persistConversationCheckpoint(draftCheckpoint);
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `✎|${t('Du bearbeitest Planversion {version}. Agenten und PM können diesen Entwurf nicht verändern.', { version: nextGraph.planRevision })}`,
          ts: Date.now(), isError: false,
        });
        return;
      }
      if (action.type === 'repair-timeout-task') {
        if (planningActive) return;
        const currentGraph = taskGraphRef.current;
        const timeoutNode = currentGraph?.nodes?.find(node => node.id === action.taskId);
        // recoveryStatus is the single-flight guard. The card hides its fixer
        // button at the same time, but this check also rejects stale UI events.
        if (!timeoutNode || timeoutNode.status !== 'timed_out' || timeoutNode.recoveryStatus) return;
        const pmAgent = getGroupPMAgent(chat.type, chatAgents);
        const originalAgent = chatAgents.find(agent => agent.id === timeoutNode.agentId);
        if (!pmAgent || !originalAgent) {
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `⚠️|${t('Der Workflow-Fixer konnte nicht gestartet werden, weil PM oder ursprünglicher Agent nicht verfügbar ist.')}`,
            ts: Date.now(), isError: true,
          });
          return;
        }
        // Preserve the attempt counter across failed recovery nodes so the PM
        // can distinguish a fresh recovery from a repeated repair attempt.
        const previousRecovery = (currentGraph.nodes || [])
          .filter(node => node.runtimeRecovery && node.recovery?.originalGraphNodeId === timeoutNode.id)
          .map(node => node.recovery)
          .sort((left, right) => (right.attempt || 0) - (left.attempt || 0))[0] || null;
        const rootNode = currentGraph.nodes.find(node => inferTaskNodeType(node) === 'request');
        const recoveryTask = buildTimeoutRecoveryTask({
          pm: pmAgent,
          originalAgent,
          objective: timeoutNode.objective || timeoutNode.title,
          errorMessage: timeoutNode.recoveryError || timeoutNode.error || '',
          previousRecovery,
          originalGraphNodeId: timeoutNode.id,
          planRootId: timeoutNode.planRootId || rootNode?.id || '',
        });
        if (!recoveryTask) return;
        const registeredRecoveryTask = registerGraphTask(recoveryTask, { status: 'planned', parentNodeId: timeoutNode.id });
        const nextGraph = commitTaskGraph(graph => updateTaskNodeStatus(graph, timeoutNode.id, 'timed_out', {
          recoveryStatus: 'pm',
          recoveryTaskId: registeredRecoveryTask.graphNodeId,
          recoveryError: undefined,
        }));
        if (running) {
          // The work-conserving scheduler rereads the graph whenever an agent
          // finishes. Leaving the recovery node planned injects it safely into
          // that run without starting a second concurrent scheduler.
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🧭|${t('Workflow-Fixer für „{task}“ wurde vorgemerkt und startet beim nächsten freien PM-Zeitfenster.', { task: timeoutNode.title })}`,
            ts: Date.now(), isError: false,
          });
          return;
        }
        const currentCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || {};
        const resumeCheckpoint = {
          ...currentCheckpoint,
          mode: 'execution',
          status: 'interrupted',
          askingAgent: undefined,
          askingGraphNodeId: undefined,
          question: undefined,
          planRootGraphNodeId: currentCheckpoint.planRootGraphNodeId || timeoutNode.planRootId || rootNode?.id || null,
          initialObjective: currentCheckpoint.initialObjective || rootNode?.objective || rootNode?.title || timeoutNode.objective || timeoutNode.title,
          parallelTaskIds: [],
        };
        const pendingTasks = buildPlanningPendingTasks(nextGraph, resumeCheckpoint, chatAgents);
        resumeCheckpoint.pendingTasks = [
          ...pendingTasks.filter(task => task.graphNodeId === registeredRecoveryTask.graphNodeId),
          ...pendingTasks.filter(task => task.graphNodeId !== registeredRecoveryTask.graphNodeId),
        ];
        persistConversationCheckpoint(resumeCheckpoint);
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🧭|${t('Workflow-Fixer für „{task}“ wurde gestartet.', { task: timeoutNode.title })}`,
          ts: Date.now(), isError: false,
        });
        void runAgents(chatMessagesRef.current, null);
        return;
      }
      if (action.type === 'resolve-task-delegation') {
        if (running || planningActive) return;
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
        const waitingDelegations = checkpoint?.waitingDelegationTasks || [];
        const waiting = waitingDelegations.find(item => item.taskId === action.taskId);
        if (!waiting?.task || !waiting.proposal) return;
        const remainingDelegations = waitingDelegations.filter(item => item.taskId !== action.taskId);
        if (action.decision === 'delegate') {
          const sourceNode = taskGraphRef.current?.nodes?.find(node => node.id === action.taskId);
          const currentDecision = evaluateTaskDelegation({ taskNode: sourceNode, sourceGroup: chat, groups, agents });
          const currentCandidates = ['ask', 'delegate'].includes(currentDecision.action) ? currentDecision.candidates : [];
          const candidate = currentCandidates.find(item => item.candidateId === action.targetCandidateId)
            || currentCandidates.find(item => item.agentId === action.targetAgentId)
            || currentCandidates[0];
          const targetGroup = groups.find(group => group.id === candidate?.groupId);
          const targetAgent = agents.find(candidateAgent => candidateAgent.id === candidate?.agentId);
          const targetAgents = (candidate?.agentIds || [candidate?.agentId])
            .map(agentId => agents.find(candidateAgent => candidateAgent.id === agentId))
            .filter(Boolean);
          const policy = normalizeDelegationPolicy(sourceNode?.delegation);
          const batchId = `task-delegation-batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const request = createCrossGroupRequest({
            sourceGroup: chat,
            sourceTask: waiting.task,
            sourceAgent: waiting.task.agent,
            targetGroup,
            targetAgent,
            targetAgents,
            question: buildDelegatedTaskQuestion(sourceNode, policy),
            attachments: checkpoint.attachments || [],
            batchId,
            origin: 'user',
            kind: 'task_delegation',
            requiredCapabilities: policy.requiredCapabilities,
            delegationReason: 'user-approved',
            qualityMode: checkpoint.qualityMode || 'auto',
          });
          if (!request) {
            addMessage(chat.id, {
              id: `delegation-approval-failed-${Date.now()}`,
              agentId: 'system',
              senderName: 'System',
              text: `⇄|${t('Die Delegation konnte nicht gestartet werden. Prüfe die ausgehende Freigabe und die erreichbaren Zielgruppen der Quellgruppe.')}`,
              ts: Date.now(),
              isError: true,
            });
            return;
          }
          enqueueCrossGroupRequest(request);
          commitTaskGraph(graph => updateTaskNodeStatus(graph, action.taskId, 'waiting_group', {
            delegationProposal: undefined,
            delegationKind: 'task',
            delegatedToGroupId: request.targetGroupId,
            delegatedToGroupName: request.targetGroupName,
            delegatedToAgentId: request.targetAgentId,
            delegatedToAgentName: request.targetAgentName,
            waitingGroupRequestIds: [request.id],
            groupWaitStartedAt: Date.now(),
          }));
          const groupWait = {
            batchId,
            requestIds: [request.id],
            targetGroupIds: [request.targetGroupId],
            targetGroupNames: [request.targetGroupName],
            kind: 'task_delegation',
            task: waiting.task,
            createdAt: Date.now(),
          };
          persistConversationCheckpoint({
            ...checkpoint,
            status: remainingDelegations.length > 0 ? 'awaiting-delegation' : 'awaiting-group',
            waitingDelegationTasks: remainingDelegations,
            waitingGroupTasks: [...(checkpoint.waitingGroupTasks || []), groupWait],
          });
          addMessage(chat.id, {
            id: `delegation-approved-${request.id}`,
            agentId: 'system',
            senderName: 'System',
            text: `⇄|${t('Delegation freigegeben: {agent} in {group} führt „{task}“ aus.', {
              agent: request.targetAgentName,
              group: request.targetGroupName,
              task: sourceNode?.title || waiting.proposal.taskTitle,
            })}`,
            ts: Date.now(),
            isError: false,
          });
          return;
        }
        if (action.decision === 'local') {
          const nextGraph = commitTaskGraph(graph => updateTaskNodeStatus(graph, action.taskId, 'planned', {
            delegationProposal: undefined,
            delegationLocalApprovedAt: Date.now(),
          }));
          const taskToResume = { ...waiting.task, source: 'delegation-local-override' };
          const existingPending = checkpoint.pendingTasks || [];
          persistConversationCheckpoint({
            ...checkpoint,
            status: 'interrupted',
            waitingDelegationTasks: remainingDelegations,
            pendingTasks: [taskToResume, ...existingPending.filter(taskItem => taskItem.graphNodeId !== action.taskId)],
          });
          addMessage(chat.id, {
            id: `delegation-local-${action.taskId}-${Date.now()}`,
            agentId: 'system',
            senderName: 'System',
            text: `⇄|${t('„{task}“ wird nach deiner Entscheidung lokal ausgeführt.', {
              task: nextGraph.nodes.find(node => node.id === action.taskId)?.title || waiting.proposal.taskTitle,
            })}`,
            ts: Date.now(),
            isError: false,
          });
          void runAgents(chatMessagesRef.current, null);
          return;
        }
        return;
      }
      if (action.type === 'retry-group-request') {
        const request = crossGroupRequests?.[action.requestId];
        if (
          !request ||
          request.sourceGroupId !== chat.id ||
          !['failed', 'timed_out'].includes(request.status)
        ) return;
        retryCrossGroupRequest(request.id);
        addMessage(chat.id, {
          id: `cross-group-retry-${request.id}-attempt-${request.attempt + 1}`,
          agentId: 'system',
          senderName: 'System',
          text: `↻|${t('Die Anfrage an {group} wird erneut im Hintergrund ausgeführt.', { group: request.targetGroupName })}`,
          ts: Date.now(),
          isError: false,
        });
        return;
      }
      if (action.type === 'retry-task') {
        if (planningActive) return;
        const currentCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || {};
        const nextGraph = commitTaskGraph(graph => retryTaskNode(graph, action.taskId));
        const retriedNode = nextGraph.nodes.find(node => node.id === action.taskId);
        if (!retriedNode || retriedNode.status !== 'planned') return;
        if (running) {
          // As above, the active scheduler will claim this planned node at its
          // next drain point. Starting runAgents here would duplicate the run.
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `↻|${t('Die Aufgabe „{task}“ wurde für den nächsten freien passenden Agenten vorgemerkt.', { task: retriedNode.title })}`,
            ts: Date.now(), isError: false,
          });
          return;
        }
        const rootNode = nextGraph.nodes.find(node => inferTaskNodeType(node) === 'request');
        const resumeCheckpoint = {
          ...currentCheckpoint,
          mode: 'execution',
          status: 'interrupted',
          planRootGraphNodeId: currentCheckpoint.planRootGraphNodeId || retriedNode.planRootId || rootNode?.id || null,
          initialObjective: currentCheckpoint.initialObjective || rootNode?.objective || rootNode?.title || '',
          parallelTaskIds: [],
        };
        resumeCheckpoint.pendingTasks = buildPlanningPendingTasks(nextGraph, resumeCheckpoint, chatAgents);
        persistConversationCheckpoint(resumeCheckpoint);
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `↻|${t('Die Aufgabe „{task}“ wird innerhalb der unveränderten Planversion erneut ausgeführt.', { task: retriedNode.title })}`,
          ts: Date.now(), isError: false,
        });
        void runAgents(chatMessagesRef.current, null);
        return;
      }
      if (action.type === 'resume-workflow') {
        if (canResumeConversation) handleRunNow();
        return;
      }
      if (action.type === 'pause-workflow') {
        if (running) void handleCancelRun();
        return;
      }
      if (action.type === 'start-workflow') handleScheduleChoice(action.taskIds || []);
      if (action.type === 'add-task' && planningActive) {
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
        const rootNodeId = checkpoint?.planRootGraphNodeId || taskGraphRef.current?.nodes?.find(node => inferTaskNodeType(node) === 'request')?.id;
        const pmAgent = getGroupPMAgent(chat.type, chatAgents);
        const defaultAgent = chatAgents.find(agent => agent.id !== pmAgent?.id) || chatAgents[0];
        const nodeType = action.nodeType === 'review' ? 'review' : 'task';
        const assignedAgent = nodeType === 'review' ? pmAgent || defaultAgent : defaultAgent;
        if (!rootNodeId || !assignedAgent) return;
        const nextGraph = commitUserPlanChange(graph => addPlanningTask(graph, { rootNodeId, agent: assignedAgent, nodeType, position: action.position }));
        syncPlanningCheckpoint(nextGraph);
      }
      if (action.type === 'add-flow-point' && planningActive) {
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
        const rootNodeId = checkpoint?.planRootGraphNodeId || taskGraphRef.current?.nodes?.find(node => inferTaskNodeType(node) === 'request')?.id;
        if (!['fork', 'join'].includes(action.pointType)) return;
        const nextGraph = commitUserPlanChange(graph => addWorkflowPoint(graph, {
          type: action.pointType,
          position: action.position,
          rootNodeId,
        }));
        syncPlanningCheckpoint(nextGraph);
      }
      if (action.type === 'delete-flow-point' && planningActive) {
        const nextGraph = commitUserPlanChange(graph => removeWorkflowPoint(graph, action.pointId));
        syncPlanningCheckpoint(nextGraph);
      }
      if (action.type === 'update-task' && planningActive) {
        const updates = {
          ...(typeof action.updates?.title === 'string' ? { title: action.updates.title } : {}),
          ...(typeof action.updates?.objective === 'string' ? { objective: action.updates.objective } : {}),
          ...(['task', 'review'].includes(action.updates?.nodeType) ? { nodeType: action.updates.nodeType } : {}),
          ...(action.updates?.delegation && typeof action.updates.delegation === 'object'
            ? { delegation: normalizeDelegationPolicy(action.updates.delegation) }
            : {}),
        };
        if (!Object.keys(updates).length) return;
        const nextGraph = commitUserPlanChange(graph => updatePlanningTask(graph, action.taskId, updates));
        syncPlanningCheckpoint(nextGraph);
      }
      if (action.type === 'delete-task' && planningActive) {
        const nextGraph = commitUserPlanChange(graph => removePlanningTask(graph, action.taskId));
        syncPlanningCheckpoint(nextGraph);
      }
      if (action.type === 'split-task' && planningActive) {
        const nextGraph = commitUserPlanChange(graph => splitPlanningTask(graph, action.taskId));
        syncPlanningCheckpoint(nextGraph);
      }
      if (action.type === 'move-task' && planningActive) {
        const direction = Number(action.direction) < 0 ? -1 : 1;
        const nextGraph = commitUserPlanChange(graph => movePlanningTask(graph, action.taskId, direction));
        syncPlanningCheckpoint(nextGraph);
      }
      if (action.type === 'update-acceptance-criteria' && planningActive) {
        const node = taskGraphRef.current?.nodes?.find(candidate => candidate.id === action.taskId);
        if (!node || !Array.isArray(action.criteria)) return;
        const criteria = normalizeAcceptanceCriteria(action.criteria.map((text, index) => ({
          id: `${node.planTaskId || 'task'}-criterion-${index + 1}`,
          text,
          required: true,
          verification: 'reviewer',
        })), { taskId: node.planTaskId || node.id });
        const nextGraph = commitUserPlanChange(graph => updatePlanningTask(graph, action.taskId, { acceptanceCriteria: criteria }));
        syncPlanningCheckpoint(nextGraph);
      }
      if (action.type === 'update-task-model' && planningActive) {
        const config = workflowModelOptions[action.taskId];
        const node = taskGraphRef.current?.nodes?.find(candidate => candidate.id === action.taskId);
        if (!node || inferTaskNodeType(node) === 'request' || !config?.models.includes(action.model)) return;
        const nextGraph = commitUserPlanChange(graph => upsertTaskNode(graph, {
          id: action.taskId,
          modelOverride: action.model,
          ...(action.model !== (node.modelOverride || node.model) ? {
            status: 'planned',
            ...CLEARED_PREPARATION_STATE,
          } : {}),
        }));
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
        if (checkpoint) {
          persistConversationCheckpoint({
            ...checkpoint,
            pendingTasks: buildPlanningPendingTasks(nextGraph, checkpoint, chatAgents),
          });
        }
      }
      if (action.type === 'update-task-agent' && planningActive) {
        const target = chatAgents.find(candidate => candidate.id === action.agentId);
        const node = taskGraphRef.current?.nodes?.find(candidate => candidate.id === action.taskId);
        if (!target || !node || inferTaskNodeType(node) === 'request') return;
        const nextGraph = commitUserPlanChange(graph => upsertTaskNode(graph, {
          id: action.taskId,
          agentId: target.id,
          agentName: target.name,
          provider: target.provider,
          model: target.model,
          modelOverride: undefined,
          ...(target.id !== node.agentId ? {
            status: 'planned',
            ...CLEARED_PREPARATION_STATE,
          } : {}),
        }));
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
        if (checkpoint) persistConversationCheckpoint({
          ...checkpoint,
          pendingTasks: buildPlanningPendingTasks(nextGraph, checkpoint, chatAgents),
        });
      }
      if (action.type === 'add-dependency' && planningActive) {
        const targetNode = taskGraphRef.current?.nodes?.find(candidate => candidate.id === action.toTaskId);
        const targetPoint = taskGraphRef.current?.flowPoints?.find(candidate => candidate.id === action.toTaskId);
        if ((!targetNode && !targetPoint) || (targetNode && inferTaskNodeType(targetNode) === 'request')) return;
        const validation = validateWorkflowConnection(taskGraphRef.current, action.fromTaskId, action.toTaskId, action.connectionKind);
        if (!validation.ok || validation.exists) return;
        const nextGraph = commitUserPlanChange(graph => {
          const connected = addWorkflowConnection(graph, action.fromTaskId, action.toTaskId, action.connectionKind);
          return connected !== graph && targetNode && (['agent_done', 'completed', 'prepared'].includes(targetNode.status) || targetNode.interimResult)
            ? updateTaskNodeStatus(connected, targetNode.id, 'planned', CLEARED_PREPARATION_STATE)
            : connected;
        });
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
        if (checkpoint) persistConversationCheckpoint({
          ...checkpoint,
          pendingTasks: buildPlanningPendingTasks(nextGraph, checkpoint, chatAgents),
        });
      }
      if (action.type === 'remove-dependency' && planningActive) {
        const targetNode = taskGraphRef.current?.nodes?.find(candidate => candidate.id === action.toTaskId);
        const targetPoint = taskGraphRef.current?.flowPoints?.find(candidate => candidate.id === action.toTaskId);
        if ((!targetNode && !targetPoint) || (targetNode && inferTaskNodeType(targetNode) === 'request')) return;
        const nextGraph = commitUserPlanChange(graph => {
          const disconnected = action.connectionKind
            ? removeWorkflowConnection(graph, action.fromTaskId, action.toTaskId, action.connectionKind)
            : removeTaskDependency(graph, action.fromTaskId, action.toTaskId);
          return disconnected !== graph && targetNode && (['agent_done', 'completed', 'prepared'].includes(targetNode.status) || targetNode.interimResult)
            ? updateTaskNodeStatus(disconnected, targetNode.id, 'planned', CLEARED_PREPARATION_STATE)
            : disconnected;
        });
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id];
        if (checkpoint) persistConversationCheckpoint({
          ...checkpoint,
          pendingTasks: buildPlanningPendingTasks(nextGraph, checkpoint, chatAgents),
        });
      }
      if (action.type === 'update-task-position') {
        if (planningActive && !running) {
          const nextGraph = commitUndoableGraphChange(graph => updateWorkflowViewPosition(graph, action.taskId, action.position));
          syncPlanningCheckpoint(nextGraph);
        } else {
          commitTaskGraph(graph => updateWorkflowViewPosition(graph, action.taskId, action.position));
        }
      }
      if (action.type === 'reset-workflow-layout') {
        if (planningActive && !running) {
          const nextGraph = commitUndoableGraphChange(resetWorkflowViewState);
          syncPlanningCheckpoint(nextGraph);
        } else {
          commitTaskGraph(resetWorkflowViewState);
        }
      }
      if (action.type === 'acceptance-decision') {
        const node = taskGraphRef.current?.nodes?.find(candidate => candidate.id === action.taskId);
        const criterion = node?.acceptanceCriteria?.find(candidate => candidate.id === action.criterionId);
        if (!node || !['agent_done', 'completed'].includes(node.status) || !criterion || criterion.verification !== 'user' || !['passed', 'failed'].includes(action.status)) return;
        commitTaskGraph(graph => applyAcceptanceDecisions(graph, [{
          taskId: node.id,
          criterionId: criterion.id,
          status: action.status,
          note: action.status === 'passed' ? t('Vom User im Workflowfenster bestätigt.') : t('Vom User im Workflowfenster abgelehnt.'),
        }], { reviewer: 'User', userOnly: true }));
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🛡️|${t(
            action.status === 'passed'
              ? 'User-Abnahme bestätigt: {criterion}'
              : 'User-Abnahme abgelehnt: {criterion}',
            { criterion: criterion.text },
          )}`,
          ts: Date.now(), isError: action.status === 'failed',
        });
      }
    });
  }, [addMessage, agents, canResumeConversation, chat, chatAgents, commitTaskGraph, conversationCheckpoint, conversationStates, crossGroupRequests, enqueueCrossGroupRequest, groups, handleApplyWorkflowImport, handleCancelRun, handleDeleteWorkflow, handleExportWorkflow, handleImportWorkflow, handleRunNow, handleScheduleChoice, handleWorkflowImportMapping, messageQualityMode, persistConversationCheckpoint, planningActive, registerGraphTask, resolveWorkflowProblem, retryCrossGroupRequest, runAgents, running, sendUserMessage, t, workflowModelOptions]);

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
          <button className="icon-btn" title={t('Workflow')} onClick={() => openTaskGraphWindow()} style={{ fontSize: 14 }}>🔀</button>
        )}
        {chat.type === 'group' && !conversationCheckpoint && !running && (
          <button className="icon-btn" title={t('Planungsmodus starten')} onClick={handleStartPlanningMode} style={{ fontSize: 14 }}>📝</button>
        )}
        {chat.type === 'group' && projectPath && (
          <button className="icon-btn" title={t('Prüf- und Vorschauumgebung')} onClick={openReviewWindow} style={{ fontSize: 14 }}>🧪</button>
        )}
        {chat.type === 'group' && memoryEnabled && (
          <MemoryBadge count={memoryCount} onOpen={handleOpenMemory} />
        )}
      </div>

      {chat.type === 'group' && !projectPath && (
        <div className="project-folder-notice" role="status">
          <span aria-hidden="true">📁</span>
          <div>
            <strong>{t('Noch kein Zielordner eingerichtet')}</strong>
            <span>{t('Lege einen Zielordner fest, damit Agenten Dateien erstellen, lesen und gemeinsam bearbeiten können.')}</span>
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => onEditGroup?.(chat)}>
            {t('Zielordner auswählen')}
          </button>
        </div>
      )}

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
                  const pendingDelegation = pendingDelegations.find(waiting => (
                    String(waiting.proposal?.id || '') === String(msg.id || '') ||
                    (msg.delegationTaskId && waiting.taskId === msg.delegationTaskId)
                  ));
                  const delegationCandidate = pendingDelegation?.proposal?.candidate;
                  const isWorkflowProblemNotice = Boolean(msg.workflowProblemKey);
                  const messageWorkflowProblem = workflowProblemByNoticeKey.get(msg.workflowProblemKey) || null;
                  return (
                    <ErrorBubble
                      key={msg.id || mi}
                      text={label ? `${label}: ${errorText}` : errorText}
                      isError={msg.isError !== false}
                      onRetry={msg.isError && lastRunContext && !isWorkflowProblemNotice ? handleRetry : null}
                      action={pendingDelegation ? {
                        label: t('Freigeben'),
                        icon: '⇄',
                        tone: 'delegation',
                        disabled: running || planningActive || !delegationCandidate,
                        title: delegationCandidate
                          ? t('Delegation an {agent} in {group} freigeben', {
                            agent: delegationCandidate.agentName,
                            group: delegationCandidate.groupName,
                          })
                          : t('Keine erreichbare Zielgruppe verfügbar'),
                        onClick: () => {
                          if (!delegationCandidate) return;
                          window.electronAPI?.sendTaskWindowAction?.({
                            type: 'resolve-task-delegation',
                            chatId: chat.id,
                            taskId: pendingDelegation.taskId,
                            decision: 'delegate',
                            targetCandidateId: delegationCandidate.candidateId || delegationCandidate.agentId,
                          });
                        },
                      } : messageWorkflowProblem ? {
                        label: t('Lösen'),
                        icon: '!',
                        tone: 'problem',
                        disabled: running,
                        title: t('Workflow-Problem lösen'),
                        onClick: () => setOpenWorkflowProblem(messageWorkflowProblem),
                      } : null}
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
                      <div className={`message-bubble ${isUser ? 'out' : 'in'} ${msgText ? 'has-copy-action' : ''}`}>
                        <MessageAttachments attachments={msg.attachments || []} />
                        {msgText && <div className="message-text">{msgText}</div>}
                        {msg.diagram && <ExcalidrawDiagram diagram={msg.diagram} />}
                        <div className="message-meta">
                          {queuedUserMessageIds.has(String(msg.id)) && <span className="message-queued-label">⏳ {t('Eingereiht')} · </span>}
                          {formatTime(msg.ts, language)}
                        </div>
                        {msgText && <MessageCopyButton text={msgText} />}
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
        {mcpApproval && <McpPermissionPrompt request={mcpApproval} onDecision={resolveMcpApproval} />}
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
          {conversationCheckpoint?.status === 'awaiting-group' && !running && (
            <span style={{ fontSize: 12, color: '#aeb9ff', marginLeft: 4 }}>↗ {t('Wartet auf eine andere Gruppe')}</span>
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
        {chat.type === 'group' && workflowPlanningActive && (
          <div className="planning-mode-bar" role="status">
            <div className="planning-mode-copy">
              <strong>📝 {t(planningActive ? 'Planungsmodus aktiv' : 'Ausführungsplanung pausiert')}</strong>
              <span>{t(planningActive
                ? (workflowPreflightReason || (activeTaskGraph.planOwner === 'user'
                  ? 'Du bearbeitest den verbindlichen Plan. Der PM kann beraten, aber keine Aufgabe oder Abhängigkeit verändern.'
                  : 'Der PM erstellt einen ersten Entwurf. Andere Agenten beginnen erst nach deiner Freigabe.'))
                : 'Prüfe den Workflow und starte die laut Abhängigkeiten bereiten Aufgaben.')}</span>
            </div>
            <button type="button" className="btn btn-secondary" onClick={() => openTaskGraphWindow()}>
              {t('Workflow ansehen')}
            </button>
            <button
              type="button"
              className="run-btn"
              onClick={() => handleScheduleChoice(plannedParallelTaskIds.length >= 2 ? plannedParallelTaskIds : [])}
              disabled={workflowStartDisabled}
              title={!workflowStartValidation.ok
                ? t(workflowStartValidation.messageKey || workflowStartValidation.reason, workflowStartValidation.messageValues)
                : workflowPreflightReason || undefined}
            >
              {t(planningActive ? 'Planversion freigeben & Workflow starten' : 'Bereite Aufgaben starten')}
            </button>
            {planningActive && (
              <button
                type="button"
                className="planning-mode-close"
                title={t('Planungsmodus deaktivieren')}
                aria-label={t('Planungsmodus deaktivieren')}
                onClick={handleDeactivatePlanningMode}
              >×</button>
            )}
          </div>
        )}
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
      {openWorkflowProblem && <WorkflowProblemDialog
        problem={openWorkflowProblem}
        running={running}
        onSubmit={resolveWorkflowProblem}
        onClose={() => setOpenWorkflowProblem(null)}
      />}
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
    </>
  );
}
