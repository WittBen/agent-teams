import { EXPERTISE_DISCOVERY, expertiseSkills, expertiseTargets, expertiseRequests, terminalSearch, parseExpertiseAnswer, expertDraft } from './expertise-help.mjs';
import { needsAutomaticAcceptance, taskCompletionKey } from './acceptance-scheduling.mjs';
import EntityIcon from './EntityIcon.jsx';
import Icon from './Icon.jsx';
import ChatOptionsMenu from './ChatOptionsMenu.jsx';
import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useStore } from './store.jsx';
import { createMcpToolSignature, getEffectiveMcpServers, getMcpToolPermissionDecision } from './mcp.js';
import { resolveGroupAgent } from './quality-cascade.js';
import { addPlanningTask, addWorkflowConnection, addWorkflowPoint, addTaskEdge, applyAcceptanceDecisions, appendTaskRecoveryNote, beginPMPlanRevision, beginUserPlanEdit, createTaskGraph, ensureManualAcceptanceCriterion, findSafeAutoParallelTaskIds, inferTaskNodeType, lockTaskGraphPlan, markTaskGraphUserOwned, movePlanningTask, normalizeAcceptanceCriteria, resetWorkflowViewState, retryTaskNode, restoreTaskGraphSnapshot, removePlanningTask, removeWorkflowConnection, removeWorkflowPoint, removeTaskDependency, splitPlanningTask, invalidateTaskRecoveryBranch, updateTaskNodeStatus, updateAcceptanceTestRun, updatePlanningTask, updateWorkflowViewPosition, upsertTaskNode, validateParallelSelection, validateWorkflowConnection, validateWorkflowPlan } from './task-graph.js';
import { extractMemoryCommands, isMemoryCommandOnly } from './memory.js';
import { createEntry, getMemoryAPI } from './memory-provider.js';
import { parseExcalidrawElements } from './excalidraw.js';
import { useI18n } from './i18n.jsx';
import MarkdownMessage from './MarkdownMessage.jsx';
import { rewindDraft } from './chat-rewind.mjs';
import { buildQueuedRequestHistory } from './user-request-queue.js';
import { getProviderEmoji } from './provider-catalog.js';
import { createCrossGroupRequest, extractGroupMentions, finishRequestRuntimePlan, isCrossGroupRequestTerminal, requestsForChat } from './cross-group.js';
import { agentCoversCapabilities, evaluateTaskDelegation, normalizeCrossGroupTargetIds, normalizeDelegationPolicy } from './delegation.js';
import WorkflowProblemDialog from './WorkflowProblemDialog.jsx';
import { createImportedTaskGraph, createWorkflowExportDocument, suggestWorkflowAgentMappings } from './workflow-portability.js';
import { buildTimeoutRecoveryTask, extractUserQuestions, getGroupPMAgent, MAX_PM_RECOVERY_ATTEMPTS, summarizeTaskActivity } from './orchestrator.js';
import { conversationContinuations, RESUMABLE_CHECKPOINT_STATUSES, CLEARED_PREPARATION_STATE, buildDelegatedTaskQuestion, buildWorkflowModelOptions, isAgentProviderConfigured, collectWorkflowProblems, buildPlanningPendingTasks } from './chat-workflow-helpers.mjs';
import { MentionDropdown, formatTime, Avatar, formatFileSize, attachmentIcon, AttachmentImage, MessageAttachments, copyText, MessageCopyButton, classifyBrowserFile, readBrowserFile, TypingBubble, ErrorBubble, ExcalidrawDiagram, McpPermissionPrompt, MemoryBadge, MemoryViewer } from './chat-view-ui.jsx';
import { useConversationRunner } from './useConversationRunner.js';
import { canPauseTask, setTaskPaused } from './workflow-task-pause.mjs';

export default function ChatView({ chat, onEditGroup, onCreateExpert, active = true }) {
  const { language, t } = useI18n();
  const {
    agents,
    groups,
    messages,
    conversationStates,
    userRequestQueues,
    taskGraphs,
    crossGroupRequests,
    addMessage: storeAddMessage,
    rewindMessages,
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
    ? agents.filter(agent => chat.agentIds?.includes(agent.id)).map(agent => resolveGroupAgent(agent, chat))
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
  const claudeConversationSessionsRef = useRef(new Map());
  const codexConversationSessionsRef = useRef(new Map());
  const [retryClock, setRetryClock] = useState(Date.now());
  const [queuePump, setQueuePump] = useState(0);
  const [workflowImportDraft, setWorkflowImportDraft] = useState(null);
  const [workflowFileStatus, setWorkflowFileStatus] = useState({ busy: '', message: '', error: '' });
  const [openWorkflowProblem, setOpenWorkflowProblem] = useState(null);
  const messagesEndRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const messagesContentRef = useRef(null);
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
  const addMessage = useCallback((chatId, message) => {
    storeAddMessage(chatId, chatId === chat.id ? {
      ...message, rewindSnapshot: { version: 1, graph: structuredClone(taskGraphRef.current) },
    } : message);
  }, [chat.id, storeAddMessage]);
  const workflowUndoStackRef = useRef([]);
  const workflowQuestionAnswerPendingRef = useRef(false);
  const workflowProblemAnswerPendingRef = useRef(false);
  const announcedWorkflowProblemKeysRef = useRef(new Set());
  const workflowDeletePendingRef = useRef(false);
  const acceptanceTestRunRef = useRef(null);
  const [acceptanceQueueVersion, setAcceptanceQueueVersion] = useState(0);
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
      testConfigured: Boolean(chat.reviewEnvironment?.test?.command),
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

  useEffect(() => {
    if (!active) return undefined;
    let frame;
    const container = messagesContainerRef.current;
    if (!container) return undefined;
    let followLatest = true;
    let lastScrollTop = container.scrollTop;
    const onScroll = () => {
      const top = container.scrollTop;
      if (top < lastScrollTop) followLatest = false;
      else if (container.scrollHeight - container.clientHeight - top <= 2) followLatest = true;
      lastScrollTop = top;
    };
    // Stop before the scroll event, including when a resize frame is queued.
    const onWheel = event => { if (event.deltaY < 0) followLatest = false; };
    const onKeyDown = event => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) followLatest = false;
    };
    let touchY = null;
    const onTouchStart = event => { touchY = event.touches[0]?.clientY ?? null; };
    const onTouchMove = event => {
      const nextY = event.touches[0]?.clientY;
      if (touchY !== null && nextY > touchY) followLatest = false;
      touchY = nextY ?? null;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', onWheel, { passive: true });
    container.addEventListener('keydown', onKeyDown);
    container.addEventListener('touchstart', onTouchStart, { passive: true });
    container.addEventListener('touchmove', onTouchMove, { passive: true });
    const scrollToLatest = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        if (followLatest) {
          container.scrollTop = container.scrollHeight;
          lastScrollTop = container.scrollTop;
        }
      });
    };
    const observer = new ResizeObserver(scrollToLatest);
    if (messagesContentRef.current) observer.observe(messagesContentRef.current);
    if (messagesContainerRef.current) observer.observe(messagesContainerRef.current);
    scrollToLatest();
    return () => {
      observer.disconnect();
      window.cancelAnimationFrame(frame);
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', onWheel);
      container.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('touchstart', onTouchStart);
      container.removeEventListener('touchmove', onTouchMove);
    };
  }, [active, chat.id]);
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
    if (!window.electronAPI?.onLlmProgress) return undefined;
    return window.electronAPI.onLlmProgress((progress) => {
      const active = [...activeAgentRunRef.current.values()]
        .find(candidate => progress?.requestId === candidate.requestId || progress?.requestId?.startsWith(`${candidate.requestId}-`));
      if (!active) return;
      if (progress.provider === 'codex' && progress.sessionId && active.task) {
        active.task.codexSessionId = progress.sessionId;
        active.task.codexSessionStarted = true;
        active.task.codexSessionModel = active.model;
      }
      if (active.progressRequestId !== progress.requestId || progress.phase === 'starting') {
        active.progressRequestId = progress.requestId;
        active.streamText = '';
      }
      if (progress.delta) active.streamText = (active.streamText || '') + progress.delta;
      else if (!active.streamText && progress.partialText) active.streamText = progress.partialText;
      active.onPlanProgress?.(active.streamText || '');
      setAgentProgress(previous => ({ ...previous, [active.agentId]: {
        ...(previous?.[active.agentId] || {}),
        agentId: active.agentId,
        taskSummary: previous?.[active.agentId]?.taskSummary || active.taskSummary || t('Bearbeitet den aktuellen Task.'),
        detail: progress.phase === 'activity'
          ? previous?.[active.agentId]?.detail
          : (progress.message || previous?.[active.agentId]?.detail || ''),
        phase: progress.phase === 'activity' ? (previous?.[active.agentId]?.phase || 'working') : (progress.phase || 'working'),
        partialText: active.streamText || progress.partialText || '',
        firstTokenMs: progress.firstTokenMs ?? previous?.[active.agentId]?.firstTokenMs ?? 0,
        elapsedMs: progress.elapsedMs ?? previous?.[active.agentId]?.elapsedMs ?? 0,
        provider: progress.provider || active.provider,
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
    const acceptanceCriteria = existingNode
      ? (existingNode.acceptanceCriteria || [])
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
    if (existingNode?.userPausedAt) graphNode.status = existingNode.status;
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
    const runtimeMetadata = {
      ...(task.codexSessionId ? {
        codexSessionId: task.codexSessionId,
        codexSessionModel: task.codexSessionModel,
      } : {}),
      ...(task.lastRunMetrics ? { lastRunMetrics: task.lastRunMetrics } : {}),
    };
    commitTaskGraph(graph => updateTaskNodeStatus(graph, task.graphNodeId, status, {
      ...runtimeMetadata,
      ...extra,
    }));
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

  const expertiseSearchGuard = useRef(new Set());
  const queueExpertSearch = useCallback((node, retry = false) => {
    const skills = expertiseSkills(node);
    const targets = expertiseTargets(chat, groups, node);
    if (!skills.length || !targets.length) return;
    const previous = expertiseRequests(crossGroupRequests, node.id);
    if (previous.some(request => !terminalSearch(request)) || (!retry && previous.length)) return;
    const key = `${chat.id}:${node.id}:${previous.length}`;
    if (expertiseSearchGuard.current.has(key)) return;
    expertiseSearchGuard.current.add(key);
    const batchId = `expertise-${node.id}-${Date.now()}`;
    for (const targetGroup of targets) {
      const request = createCrossGroupRequest({
        sourceGroup: chat, sourceTask: { id: node.id, title: 'Expertensuche' }, targetGroup,
        question: `Gesuchte Fähigkeiten: ${skills.join(', ')}`, requiredCapabilities: skills,
        delegationReason: EXPERTISE_DISCOVERY, batchId, origin: 'user', attachments: [],
      });
      if (request) enqueueCrossGroupRequest(request);
    }
  }, [chat, groups, crossGroupRequests, enqueueCrossGroupRequest]);

  const runAgents = useConversationRunner({ chat, language, t, agents, groups, messages, conversationStates, addMessage, apiKeys, providerConnections, kbPath, enqueueCrossGroupRequest, mcpServers, conversationLimits, qualityRouting, recordQualityEvent, projectPath, chatAgents, running, setRunning, setTypingAgents, setLastRunContext, setStoppedForUser, setAgentProgress, claudeConversationSessionsRef, codexConversationSessionsRef, autoRunRef, runIdRef, activeAgentRunRef, taskGraphRef, reportedMcpErrorsRef, requestMcpPermission, handleMcpPermissionConsumed, handleMcpToolResult, memoryConfig, memoryEnabled, memoryAPI, activeMcpServers, reachableCrossGroupIds, refreshMemoryCount, persistConversationCheckpoint, discardConversationCheckpoint, commitTaskGraph, registerGraphTask, setGraphTaskStatus });

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

  const handleRewind = message => {
    if (running || !message.rewindSnapshot?.graph) return;
    if (!window.confirm(t('Zu diesem Punkt zurückspringen? Diese Nachricht und alle folgenden werden aus dem Chat entfernt. Der gespeicherte Workflow wird als Entwurf wiederhergestellt und muss erneut freigegeben werden. Dateiänderungen, geteilte Erinnerungen und externe Aktionen werden nicht rückgängig gemacht.'))) return;
    queueDrainPausedRef.current = true;
    runIdRef.current += 1;
    cancelTaskBoundGroupWork(taskGraphRef.current, t('Der Chat wurde zurückgesetzt.'));
    cancelAllMcpApprovals();
    clearUserRequestQueue(chat.id);
    claudeConversationSessionsRef.current.clear();
    codexConversationSessionsRef.current.clear();
    discardConversationCheckpoint();
    setLastRunContext(null);
    setStoppedForUser(false);
    workflowUndoStackRef.current = [];
    const graph = rewindDraft(message.rewindSnapshot.graph);
    commitTaskGraph(graph);
    if (chat.type === 'group') {
      const root = graph.nodes.find(node => !node.parentNodeId && node.nodeType === 'request') || graph.nodes.find(node => !node.parentNodeId);
      const checkpoint = { version: 1, mode: 'planning', status: 'planning', pendingTasks: [], parallelTaskIds: [],
        planRootGraphNodeId: root?.id, initialObjective: root?.objective || '', delegatedResults: [], successfulTasks: 0, needsSynthesis: false };
      checkpoint.pendingTasks = buildPlanningPendingTasks(graph, checkpoint, chatAgents);
      persistConversationCheckpoint(checkpoint);
    }
    rewindMessages(chat.id, message.id);
    if (message.agentId === 'user') setInput(message.text || '');
    focusComposer();
  };

  const rewindButton = message => <button type="button" className="message-rewind-btn"
    disabled={running || !message.rewindSnapshot?.graph}
    title={t(running ? 'Zum Zurückspringen zuerst die laufende Arbeit stoppen' : !message.rewindSnapshot?.graph ? 'Für diese ältere Nachricht ist kein Rücksprungpunkt gespeichert' : 'Vor diese Nachricht zurückspringen')}
    aria-label={t('Vor diese Nachricht zurückspringen')} onClick={() => handleRewind(message)}><Icon name="undo" size={16} /></button>;

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
    const textarea = textareaRef.current;
    if (!textarea) return undefined;
    let frame = 0;
    const resize = () => {
      textarea.style.height = 'auto';
      // An empty textarea can report the wrapped placeholder as scroll height.
      // Keep the compact baseline until the user actually enters content.
      textarea.style.height = `${input ? Math.min(textarea.scrollHeight, 120) : 40}px`;
    };
    const scheduleResize = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(resize);
    };
    scheduleResize();
    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(scheduleResize)
      : null;
    if (textarea.parentElement) resizeObserver?.observe(textarea.parentElement);
    window.addEventListener('resize', scheduleResize);
    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', scheduleResize);
    };
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
  const expertiseHelp = useMemo(() => (activeTaskGraph.nodes || []).filter(node => {
    if (['request', 'review'].includes(inferTaskNodeType(node)) || node.status === 'completed') return false;
    return node.blockedReason === 'delegation-no-target-expert' || !chatAgents.some(agent => agent.id === node.agentId)
      || evaluateTaskDelegation({ taskNode: node, sourceGroup: chat, groups, agents }).action === 'unavailable';
  }).map(node => {
    const skills = expertiseSkills(node);
    const targets = expertiseTargets(chat, groups, node);
    const searches = expertiseRequests(crossGroupRequests, node.id);
    const latestBatch = searches.at(-1)?.batchId;
    const results = searches.filter(request => request.batchId === latestBatch);
    const candidates = [];
    const suggested = agents.find(agent => agent.id === node.expertiseSuggestedAgentId && !agent.isSystemAgent);
    const suggestedHome = suggested && expertiseTargets(chat, groups).find(group => group.agentIds?.includes(suggested.id));
    if (suggestedHome) candidates.push({ id: suggested.id, name: suggested.name, groupName: suggestedHome.name, groupId: suggestedHome.id });
    for (const member of chatAgents.filter(agent => !agent.isSystemAgent && (skills.length ? agentCoversCapabilities(agent, skills) : !node.agentId))) candidates.push({ id: member.id, name: member.name, groupName: chat.name, groupId: chat.id });
    for (const target of targets) for (const member of agents.filter(agent => target.agentIds?.includes(agent.id) && !agent.isSystemAgent && skills.length && agentCoversCapabilities(agent, skills))) {
      candidates.push({ id: member.id, name: member.name, groupName: target.name, groupId: target.id });
    }
    for (const request of results.filter(item => item.status === 'answered' && targets.some(group => group.id === item.targetGroupId))) {
      const group = targets.find(item => item.id === request.targetGroupId);
      const members = agents.filter(agent => group.agentIds?.includes(agent.id) && !agent.isSystemAgent);
      try {
        for (const id of parseExpertiseAnswer(request.answer, members).agentIds) {
          const member = members.find(agent => agent.id === id);
          candidates.push({ id, name: member.name, groupName: group.name, groupId: group.id });
        }
      } catch { /* Failed/invalid answers never grant an agent assignment. */ }
    }
    return { taskId: node.id, title: node.title, skills, targetCount: targets.length,
      searched: results.length > 0, pending: results.some(request => !terminalSearch(request)),
      failed: results.some(request => ['failed', 'timed_out', 'cancelled'].includes(request.status)),
      candidates: [...new Map(candidates.map(candidate => [candidate.id, candidate])).values()],
    };
  }), [activeTaskGraph, agents, chat, chatAgents, crossGroupRequests, groups]);
  useEffect(() => {
    if (chat.type !== 'group') return;
    for (const help of expertiseHelp) if (!help.searched && help.skills.length && help.targetCount && !help.candidates.length) {
      const node = activeTaskGraph.nodes.find(item => item.id === help.taskId);
      if (node) queueExpertSearch(node);
    }
  }, [activeTaskGraph, chat.type, expertiseHelp, queueExpertSearch]);

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

  const runAcceptanceTests = useCallback(async (requestedTaskIds = []) => {
    if (acceptanceTestRunRef.current) return false;
    const currentGraph = taskGraphRef.current;
    const requested = new Set((requestedTaskIds || []).map(String));
    const candidates = (currentGraph?.nodes || []).filter(node => {
      if (inferTaskNodeType(node) === 'request') return false;
      if (requested.size && !requested.has(String(node.id)) && !requested.has(String(node.planTaskId || ''))) return false;
      if (!['agent_done', 'completed', 'retryable'].includes(node.status)) return false;
      return (node.acceptanceCriteria || []).some(criterion => (
        criterion.verification === 'automatic' && !['passed', 'waived'].includes(criterion.status)
      ));
    });
    if (!candidates.length) {
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🧪|${t('Für die Auswahl sind keine offenen, automatisch prüfbaren Abnahmekriterien vorhanden.')}`,
        ts: Date.now(), isError: false,
      });
      return false;
    }
    if (!chat.reviewEnvironment?.test?.command || !window.electronAPI?.reviewRun) {
      const runId = `acceptance-test-${Date.now().toString(36)}`;
      commitTaskGraph(graph => updateAcceptanceTestRun(graph, candidates.map(node => node.id), {
        id: runId,
        status: 'unavailable',
        error: t('In den Gruppeneinstellungen ist kein Prüfbefehl konfiguriert.'),
      }));
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🧪|${t('Automatische AC-Prüfung nicht verfügbar: In den Gruppeneinstellungen ist kein Prüfbefehl konfiguriert. Die Kriterien können begründet manuell freigegeben werden.')}`,
        ts: Date.now(), isError: true,
      });
      return false;
    }

    const runId = `acceptance-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const taskIds = candidates.map(node => node.id);
    acceptanceTestRunRef.current = runId;
    commitTaskGraph(graph => updateAcceptanceTestRun(graph, taskIds, {
      id: runId,
      status: 'running',
      startedAt: Date.now(),
    }));
    addMessage(chat.id, {
      id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
      text: `🧪|${t('AC-Prüflauf für {count} Ticket(s) gestartet. Der Hauptworkflow kann parallel weiterarbeiten.', { count: candidates.length })}`,
      ts: Date.now(), isError: false,
    });
    try {
      const result = await window.electronAPI.reviewRun(chat.id, 'test');
      const finishedAt = Date.now();
      const decisionStatus = result.ok ? 'passed' : 'failed';
      const decisions = candidates.flatMap(node => (node.acceptanceCriteria || [])
        .filter(criterion => criterion.verification === 'automatic' && !['passed', 'waived'].includes(criterion.status))
        .map(criterion => ({
          taskId: node.id,
          criterionId: criterion.id,
          status: decisionStatus,
          note: `${result.command || 'Konfigurierter Prüfbefehl'}: ${result.ok ? 'erfolgreich' : 'fehlgeschlagen'} (Exit ${result.code ?? 'unbekannt'}). ${String(result.output || '').slice(-420)}`,
        })));
      commitTaskGraph(graph => {
        if (graph.id !== currentGraph.id) return graph;
        const validIds = candidates.filter(snapshot => {
          const current = graph.nodes.find(node => node.id === snapshot.id);
          return current && graph.planRevision === currentGraph.planRevision
            && ['agent_done', 'completed', 'retryable'].includes(current.status)
            && taskCompletionKey(current) === taskCompletionKey(snapshot);
        }).map(node => node.id);
        const staleIds = taskIds.filter(id => !validIds.includes(id) && graph.nodes.find(node => node.id === id)?.acceptanceTestRuns?.at(-1)?.id === runId);
        const settledGraph = updateAcceptanceTestRun(graph, staleIds, {
          id: runId, status: 'unavailable', finishedAt,
          error: t('Aufgabe oder Plan während der Prüfung geändert. Erneute Prüfung erforderlich.'),
        });
        return applyAcceptanceDecisions(
        updateAcceptanceTestRun(settledGraph, validIds, {
          id: runId,
          status: result.ok ? 'passed' : 'failed',
          startedAt: result.startedAt,
          finishedAt,
          command: result.command,
          output: result.output,
          error: result.timedOut ? t('Der Prüflauf hat sein Zeitlimit überschritten.') : '',
        }),
        decisions.filter(decision => {
          const criterion = graph.nodes.find(node => node.id === decision.taskId)?.acceptanceCriteria?.find(item => item.id === decision.criterionId);
          return validIds.includes(decision.taskId) && criterion?.verification === 'automatic' && !['passed', 'waived'].includes(criterion.status);
        }),
        { reviewer: 'Automatischer Prüflauf' },
      );
      });
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🧪|${t(result.ok
          ? 'AC-Prüflauf erfolgreich: Die automatisch prüfbaren Kriterien wurden bestätigt.'
          : 'AC-Prüflauf fehlgeschlagen: Die betroffenen Tickets wurden zur Nachbesserung zurückgegeben.')}`,
        ts: Date.now(), isError: !result.ok,
      });
      return result.ok;
    } catch (error) {
      commitTaskGraph(graph => updateAcceptanceTestRun(graph, taskIds.filter(id => graph.nodes.find(node => node.id === id)?.acceptanceTestRuns?.at(-1)?.id === runId), {
        id: runId,
        status: 'unavailable',
        finishedAt: Date.now(),
        error: error?.message || t('Der Prüflauf konnte nicht gestartet werden.'),
      }));
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🧪|${t('AC-Prüflauf konnte nicht ausgeführt werden: {error}', { error: error?.message || t('Unbekannter Fehler') })}`,
        ts: Date.now(), isError: true,
      });
      return false;
    } finally {
      if (acceptanceTestRunRef.current === runId) {
        acceptanceTestRunRef.current = null;
        setAcceptanceQueueVersion(version => version + 1);
      }
    }
  }, [addMessage, chat.id, chat.reviewEnvironment, commitTaskGraph, t]);

  useEffect(() => {
    if (chat.type !== 'group') return;
    const pmAgent = getGroupPMAgent(chat.type, chatAgents);
    const missingCriteriaNode = (activeTaskGraph.nodes || []).find(node => (
      node.status === 'agent_done' && inferTaskNodeType(node) !== 'review' &&
      !(node.acceptanceCriteria || []).length && !node.manualAcceptanceRequestedAt
    ));
    const pendingUserNode = missingCriteriaNode || (activeTaskGraph.nodes || []).find(node => (
      node.status === 'agent_done' && !node.manualAcceptanceRequestedAt &&
      (node.acceptanceCriteria || []).some(criterion => (
        criterion.verification === 'user' && !['passed', 'waived'].includes(criterion.status)
      ))
    ));
    if (!pendingUserNode) return;
    if (missingCriteriaNode) {
      commitTaskGraph(graph => ensureManualAcceptanceCriterion(graph, pendingUserNode.id, {
        requestedBy: pmAgent?.name || 'PM',
      }));
    } else {
      commitTaskGraph(graph => updateTaskNodeStatus(graph, pendingUserNode.id, pendingUserNode.status, {
        manualAcceptanceRequestedAt: Date.now(),
        manualAcceptanceRequestedBy: pmAgent?.name || 'PM',
        blockedReason: 'acceptance-pending',
      }));
    }
    addMessage(chat.id, {
      id: Date.now() + Math.random(),
      agentId: pmAgent?.id || 'system',
      senderName: pmAgent?.name || 'PM',
      text: missingCriteriaNode
        ? `@user: ${t('Für das Ticket „{task}“ wurden keine Abnahmekriterien definiert. Bitte prüfe das Ergebnis und erteile oder verweigere die manuelle Gesamtfreigabe im Workflowfenster.', { task: pendingUserNode.title })}`
        : `@user: ${t('Das Ticket „{task}“ benötigt deine manuelle Abnahme. Bitte öffne im Workflowfenster den Tab „Prüfungen“ und entscheide die offenen User-AC mit einem Prüfnachweis.', { task: pendingUserNode.title })}`,
      ts: Date.now(),
      isError: false,
    });
  }, [active, activeTaskGraph, addMessage, chat.id, chat.type, chatAgents, commitTaskGraph, t]);

  useEffect(() => {
    if (chat.type !== 'group' || acceptanceTestRunRef.current) return;
    const pendingAutomatic = (activeTaskGraph.nodes || []).filter(needsAutomaticAcceptance);
    if (pendingAutomatic.length) void runAcceptanceTests(pendingAutomatic.map(node => node.id));
  }, [activeTaskGraph, chat.type, runAcceptanceTests, acceptanceQueueVersion]);

  const startWorkflowRecovery = useCallback(async (taskId, {
    additionalInformation = '',
    problem = null,
  } = {}) => {
    if (planningActive || workflowProblemAnswerPendingRef.current) return false;
    const currentGraph = taskGraphRef.current;
    const problemNode = currentGraph?.nodes?.find(node => node.id === taskId);
    const recoverableStatuses = new Set([
      'failed', 'timed_out', 'blocked', 'interrupted', 'waiting_user', 'waiting_pm', 'provider_paused', 'retryable',
    ]);
    if (!problemNode || !recoverableStatuses.has(problemNode.status)) return false;
    if (problemNode.recoveryStatus && problemNode.recoveryStatus !== 'user') return false;

    const pmAgent = getGroupPMAgent(chat.type, chatAgents);
    const originalAgent = chatAgents.find(agent => agent.id === problemNode.agentId);
    if (!pmAgent || !originalAgent) {
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `⚠️|${t('Die PM-Recovery konnte nicht gestartet werden, weil PM oder zuständiger Agent nicht verfügbar ist.')}`,
        ts: Date.now(), isError: true,
      });
      return false;
    }

    const recoveryHistory = (currentGraph.nodes || [])
      .filter(node => node.runtimeRecovery && node.recovery?.originalGraphNodeId === problemNode.id)
      .map(node => node.recovery)
      .sort((left, right) => (right.attempt || 0) - (left.attempt || 0));
    let previousRecovery = recoveryHistory[0] || null;
    const normalizedInformation = String(additionalInformation || '').trim().slice(0, 5000);
    if ((previousRecovery?.attempt || 0) >= MAX_PM_RECOVERY_ATTEMPTS) {
      if (!normalizedInformation) {
        commitTaskGraph(graph => updateTaskNodeStatus(graph, problemNode.id, 'waiting_user', {
          recoveryStatus: 'user',
          blockedReason: 'pm-recovery-needs-user',
          issueSummary: t('Zwei PM-Recovery-Runden waren nicht erfolgreich. Ergänze neue Informationen oder überarbeite den Hauptplan.'),
        }));
        return false;
      }
      // New user input starts a fresh, explicitly authorized bounded cycle;
      // the previous attempts remain available in the durable ticket history.
      previousRecovery = { ...previousRecovery, attempt: 0, userRestartedAt: Date.now() };
    }

    const rootNode = currentGraph.nodes.find(node => inferTaskNodeType(node) === 'request');
    const trigger = problemNode.blockedReason === 'quality-recovery'
      ? 'quality'
      : problemNode.status === 'timed_out' ? 'timeout' : 'error';
    const recoveryTask = buildTimeoutRecoveryTask({
      pm: pmAgent,
      originalAgent,
      objective: problemNode.objective || problemNode.title,
      errorMessage: problemNode.recoveryError || problemNode.error || problem?.message || '',
      additionalInformation: normalizedInformation,
      previousRecovery,
      originalGraphNodeId: problemNode.id,
      planRootId: problemNode.planRootId || rootNode?.id || '',
      trigger,
    });
    if (!recoveryTask) return false;

    commitTaskGraph(graph => invalidateTaskRecoveryBranch(
      appendTaskRecoveryNote(graph, problemNode.id, {
        author: 'User',
        mode: 'runtime-recovery',
        text: normalizedInformation,
        problem: problem?.message || problemNode.error || problemNode.blockedReason || '',
      }),
      problemNode.id,
      {
        recoveryAttempt: recoveryTask.recovery.attempt,
        reason: problem?.message || problemNode.error || problemNode.blockedReason || '',
      },
    ));
    const registeredRecoveryTask = registerGraphTask(recoveryTask, {
      status: 'planned',
      parentNodeId: problemNode.id,
    });
    const nextGraph = commitTaskGraph(graph => updateTaskNodeStatus(
      graph,
      problemNode.id,
      recoveryTask.recovery.originalStatus || (trigger === 'timeout' ? 'timed_out' : 'blocked'),
      {
        recoveryStatus: 'pm',
        recoveryTaskId: registeredRecoveryTask.graphNodeId,
        recoveryTrigger: trigger,
        recoveryError: undefined,
        issueSummary: problem?.message || problemNode.issueSummary,
      },
    ));

    addMessage(chat.id, {
      id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
      text: running
        ? `🧭|${t('PM-Recovery für „{task}“ wurde eingereiht und startet beim nächsten freien PM-Zeitfenster.', { task: problemNode.title })}`
        : `🧭|${t('PM-Recovery für „{task}“ wurde gestartet.', { task: problemNode.title })}`,
      ts: Date.now(), isError: false,
    });
    if (running) return true;

    const currentCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || {};
    const resumeCheckpoint = {
      ...currentCheckpoint,
      mode: 'execution',
      status: 'interrupted',
      askingAgent: undefined,
      askingGraphNodeId: undefined,
      question: undefined,
      planRootGraphNodeId: currentCheckpoint.planRootGraphNodeId || problemNode.planRootId || rootNode?.id || null,
      initialObjective: currentCheckpoint.initialObjective || rootNode?.objective || rootNode?.title || problemNode.objective || problemNode.title,
      parallelTaskIds: [],
    };
    const pendingTasks = buildPlanningPendingTasks(nextGraph, resumeCheckpoint, chatAgents);
    resumeCheckpoint.pendingTasks = [
      ...pendingTasks.filter(task => task.graphNodeId === registeredRecoveryTask.graphNodeId),
      ...pendingTasks.filter(task => task.graphNodeId !== registeredRecoveryTask.graphNodeId),
    ];
    persistConversationCheckpoint(resumeCheckpoint);
    void runAgents(chatMessagesRef.current, null);
    return true;
  }, [addMessage, chat, chatAgents, commitTaskGraph, conversationStates, persistConversationCheckpoint, planningActive, registerGraphTask, runAgents, running, t]);

  const resolveWorkflowProblem = useCallback(async (taskId, answer, suppliedProblem = null, mode = 'runtime-recovery') => {
    const normalizedAnswer = String(answer || '').trim();
    const problem = suppliedProblem || workflowProblems.find(candidate => candidate.taskId === taskId);
    if (!problem || workflowProblemAnswerPendingRef.current) return;
    if (mode !== 'plan-revision') {
      await startWorkflowRecovery(taskId, { additionalInformation: normalizedAnswer, problem });
      return;
    }
    workflowProblemAnswerPendingRef.current = true;
    try {
      if (running) handleCancelRun();
      const revisedGraph = commitTaskGraph(graph => beginPMPlanRevision(
        appendTaskRecoveryNote(graph, taskId, {
          author: 'User',
          mode: 'plan-revision',
          text: normalizedAnswer,
          problem: problem.message,
        }),
        { taskId, note: normalizedAnswer, problem: problem.message },
      ));
      const currentCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || {};
      const rootNode = revisedGraph.nodes.find(node => inferTaskNodeType(node) === 'request');
      const draftCheckpoint = {
        ...currentCheckpoint,
        mode: 'planning',
        status: 'planning',
        parallelTaskIds: [],
        planRootGraphNodeId: currentCheckpoint.planRootGraphNodeId || rootNode?.id || null,
        initialObjective: currentCheckpoint.initialObjective || rootNode?.objective || rootNode?.title || '',
        changeRequest: revisedGraph.changeRequest,
      };
      draftCheckpoint.pendingTasks = buildPlanningPendingTasks(revisedGraph, draftCheckpoint, chatAgents);
      persistConversationCheckpoint(draftCheckpoint);
      const prompt = [
        '@PM: Der User verlangt wegen eines strukturellen Workflow-Problems einen neuen Planentwurf.',
        `Betroffene Aufgabe: ${problem.taskTitle}`,
        `Problem: ${problem.message}`,
        problem.suggestion ? `Bisheriger Lösungsvorschlag: ${problem.suggestion}` : '',
        normalizedAnswer ? `Vorgabe oder Zusatzinformation des Users: ${normalizedAnswer}` : '',
        'Erstelle eine vollständige neue TASK_PLAN-Version und ändere nur den betroffenen Zweig. Bewahre erfolgreiche, unabhängige Tickets und deren Nachweise. Der neue Plan darf erst nach ausdrücklicher UI-Freigabe des Users ausgeführt werden.',
      ].filter(Boolean).join('\n\n');
      const userMessage = await sendUserMessage(prompt, [], messageQualityMode);
      if (!userMessage) return;
      await runAgents([...chatMessagesRef.current, userMessage], prompt, { planningOnly: true });
    } finally {
      workflowProblemAnswerPendingRef.current = false;
    }
  }, [chat.id, chatAgents, commitTaskGraph, conversationStates, handleCancelRun, messageQualityMode, persistConversationCheckpoint, runAgents, running, sendUserMessage, startWorkflowRecovery, workflowProblems]);

  useEffect(() => {
    if (!active || chat.type !== 'group') return;
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
        text: `⚠|${t('Workflow-Problem bei „{task}“: {problem} Öffne „Lösen“, um die Ausführung reparieren oder den Hauptplan überarbeiten zu lassen.', { task: problem.taskTitle, problem: problem.message })}`,
        ts: Date.now(),
        isError: true,
        workflowProblemKey: key,
        workflowProblem: problem,
      });
    }
  }, [active, addMessage, chat.id, chat.type, chatMessages, t, workflowProblemByNoticeKey, workflowProblemRootId, workflowProblems]);

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
      expertiseHelp,
      delegationEnabled: chat.crossGroupCollaborationEnabled === true,
      testConfigured: Boolean(chat.reviewEnvironment?.test?.command),
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
  }, [active, activeTaskGraph, expertiseHelp, canResumeConversation, chat.crossGroupCollaborationEnabled, chat.crossGroupTargetGroupId, chat.crossGroupTargetGroupIds, chat.id, chat.name, chat.reviewEnvironment, chat.type, chatAgents, chatGroupRequests, getActiveWorkflowTaskIds, getPendingWorkflowQuestions, groups, pendingDelegations, planningActive, providerRetryRemainingMs, resumeMode, running, t, typingAgents, workflowFileStatus, workflowImportWindowState, workflowInspectionReason, workflowInspectionTaskIds, workflowModelOptions, workflowPlanningActive, workflowProblems]);

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
      if (action.type === 'configure-expertise-groups') {
        onEditGroup?.(chat, { tab: 'collaboration' });
        return;
      }
      if (action.type === 'search-expertise') {
        const node = taskGraphRef.current.nodes.find(item => item.id === action.taskId);
        if (node) queueExpertSearch(node, true);
        return;
      }
      if (action.type === 'create-expert') {
        const help = expertiseHelp.find(item => item.taskId === action.taskId);
        const node = taskGraphRef.current.nodes.find(item => item.id === action.taskId);
        if (!help || !node || help.pending || (help.targetCount && help.skills.length && !help.searched)) return;
        const baseline = chatAgents.find(agent => !agent.isSystemAgent && isAgentProviderConfigured(agent, apiKeys, providerConnections)) || chatAgents.find(agent => isAgentProviderConfigured(agent, apiKeys, providerConnections)) || chatAgents[0];
        onCreateExpert?.(chat, expertDraft(node, baseline));
        return;
      }
      if (action.type === 'assign-expert-task') {
        if (running) return;
        const help = expertiseHelp.find(item => item.taskId === action.taskId);
        const candidate = help?.candidates.find(item => item.id === action.agentId);
        const agent = agents.find(item => item.id === candidate?.id);
        if (!candidate || !agent) return;
        const node = taskGraphRef.current.nodes.find(item => item.id === action.taskId);
        if (!node) return;
        const local = candidate.groupId === chat.id;
        const owner = chatAgents.find(item => item.id === node.agentId) || getGroupPMAgent(chat.type, chatAgents);
        if (!owner) return;
        const nextGraph = commitTaskGraph(graph => updateTaskNodeStatus(beginUserPlanEdit(graph), action.taskId, 'planned', {
          agentId: local ? agent.id : owner.id, agentName: local ? agent.name : owner.name,
          blockedReason: undefined, error: undefined, modelOverride: undefined,
          delegationLocalApprovedAt: local ? Date.now() : undefined,
          expertLoanApproval: local ? undefined : { agentId: agent.id, groupId: candidate.groupId, approvedAt: Date.now() },
          delegation: local ? { ...normalizeDelegationPolicy(node.delegation), loanAgentId: undefined, loanGroupId: undefined } : {
            ...normalizeDelegationPolicy(node.delegation), mode: 'automatic',
            requiredCapabilities: expertiseSkills(node).length ? expertiseSkills(node) : agent.capabilities,
            allowedTargetGroupIds: [candidate.groupId], loanGroupId: candidate.groupId, loanAgentId: agent.id,
          },
        }));
        const checkpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || {};
        const root = nextGraph.nodes.find(node => inferTaskNodeType(node) === 'request');
        const draft = { ...checkpoint, mode: 'planning', status: 'planning', parallelTaskIds: [],
          planRootGraphNodeId: root?.id, initialObjective: checkpoint.initialObjective || root?.objective || root?.title || '',
          changeRequest: nextGraph.changeRequest };
        draft.pendingTasks = buildPlanningPendingTasks(nextGraph, draft, chatAgents);
        persistConversationCheckpoint(draft);
        addMessage(chat.id, { id: `expert-assigned-${Date.now()}`, agentId: 'system', senderName: 'System',
          text: `${agent.name} ist nur für diese Aufgabe vorgesehen und bleibt in der Stammgruppe. Prüfe den aktualisierten Plan und wähle „Plan freigeben & starten“.`, ts: Date.now(), isError: false });
        return;
      }
      if (action.type === 'configure-acceptance-tests') {
        onEditGroup?.(chat, { tab: 'workspace' });
        return;
      }
      if (action.type === 'open-acceptance-preview') {
        if (projectPath) openReviewWindow();
        else onEditGroup?.(chat, { tab: 'workspace' });
        return;
      }
      if (action.type === 'run-acceptance-tests') {
        void runAcceptanceTests(action.taskIds || (action.taskId ? [action.taskId] : []));
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
        void resolveWorkflowProblem(action.taskId, action.answer, action.problem, action.mode);
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
        void startWorkflowRecovery(action.taskId, { additionalInformation: action.additionalInformation || '' });
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
      if (action.type === 'pause-task') {
        const node = taskGraphRef.current?.nodes?.find(item => item.id === action.taskId);
        if (!canPauseTask(node) || planningActive) return;
        const activeRun = [...activeAgentRunRef.current.values()].find(run => run.graphNodeId === action.taskId);
        if (activeRun) activeRun.taskPaused = true;
        commitTaskGraph(graph => setTaskPaused(graph, action.taskId, true, { active: !!activeRun }));
        if (activeRun) {
          const currentApproval = activeMcpApprovalRef.current;
          if (currentApproval?.agent?.id === activeRun.agentId) {
            currentApproval.resolve({ allowed: false, scope: 'cancelled' });
            activeMcpApprovalRef.current = null;
            setMcpApproval(null);
          }
          mcpApprovalQueueRef.current = mcpApprovalQueueRef.current.filter(approval => {
            if (approval.agent?.id !== activeRun.agentId) return true;
            approval.resolve({ allowed: false, scope: 'cancelled' });
            return false;
          });
          queueMicrotask(activateNextMcpApproval);
          const cancel = activeRun.runtime === 'codex' ? window.electronAPI?.codexCancel
            : activeRun.runtime === 'claude' ? window.electronAPI?.claudeCancel : window.electronAPI?.llmCancel;
          if (cancel) void cancel(activeRun.requestId).catch(() => {});
        }
        return;
      }
      if (action.type === 'retry-task' || action.type === 'resume-task') {
        if (planningActive) return;
        const currentCheckpoint = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || {};
          const nextGraph = commitTaskGraph(graph => action.type === 'resume-task'
            ? setTaskPaused(graph, action.taskId, false) : retryTaskNode(graph, action.taskId));
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
        const criteria = normalizeAcceptanceCriteria(action.criteria.map((criterion, index) => ({
          id: `${node.planTaskId || 'task'}-criterion-${index + 1}`,
          text: typeof criterion === 'string' ? criterion : criterion?.text,
          required: true,
          verification: typeof criterion === 'object' ? criterion.verification : 'reviewer',
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
        const note = String(action.note || '').replace(/\s+/g, ' ').trim().slice(0, 600);
        if (!node || !['agent_done', 'completed', 'retryable', 'blocked'].includes(node.status) || !criterion || !['passed', 'failed', 'waived'].includes(action.status) || !note) return;
        commitTaskGraph(graph => applyAcceptanceDecisions(graph, [{
          taskId: node.id,
          criterionId: criterion.id,
          status: action.status,
          note,
        }], { reviewer: 'User', userOnly: true, allowManualOverride: true }));
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🛡️|${t(
            action.status === 'passed'
              ? 'User-Abnahme bestätigt: {criterion}'
              : action.status === 'waived'
                ? 'User-Ausnahmefreigabe erteilt: {criterion}'
                : 'User-Abnahme abgelehnt: {criterion}',
            { criterion: criterion.text },
          )}`,
          ts: Date.now(), isError: action.status === 'failed',
        });
      }
    });
  }, [addMessage, agents, canResumeConversation, chat, chatAgents, commitTaskGraph, conversationCheckpoint, conversationStates, crossGroupRequests, enqueueCrossGroupRequest, groups, handleApplyWorkflowImport, handleCancelRun, handleDeleteWorkflow, handleExportWorkflow, handleImportWorkflow, handleRunNow, handleScheduleChoice, handleWorkflowImportMapping, messageQualityMode, persistConversationCheckpoint, planningActive, registerGraphTask, resolveWorkflowProblem, retryCrossGroupRequest, runAcceptanceTests, runAgents, running, onEditGroup, onCreateExpert, expertiseHelp, queueExpertSearch, apiKeys, providerConnections, openReviewWindow, projectPath, sendUserMessage, startWorkflowRecovery, t, workflowModelOptions]);

  return (
    <>
      {/* Chat Header */}
      <div className="chat-header">
        {chat.type === 'group' ? (
          <div className="avatar group" style={{ width: 40, height: 40, fontSize: 18 }}><EntityIcon value={chat.emoji} group size={24} /></div>
        ) : (
          <Avatar agent={getAgent(chat.id)} size={40} />
        )}
        <div className="chat-header-info">
          <div className="chat-header-name">{chat.name}</div>
          <div className="chat-header-sub">
            {chat.type === 'group'
              ? chatAgents.map(a => a.name).join('  ·  ')
              : getAgent(chat.id)?.role || 'Agent'}
            {projectPath && <span style={{ color: 'var(--accent)', marginLeft: 8, fontSize: 11 }}>📁 {projectPath.split(/[\\/]/).pop()}</span>}
          </div>
        </div>
        {chat.type === 'group' && <ChatOptionsMenu>

      {/* Controls row (group only) */}
      {chat.type === 'group' && (
        <div className="group-run-controls">
          <button type="button" role="switch" aria-checked={autoRun} aria-label={t('Auto-Mode')} className={`toggle-switch ${autoRun ? 'on' : ''}`} onClick={() => { setAutoRun(!autoRun); autoRunRef.current = !autoRun; }}>
            <div className="toggle-knob" />
          </button>
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
          <div className="group-run-actions">

            {/* "Agenten laufen lassen" only makes sense when conversation is paused or no agents responded yet */}
            {!running && !resumeMode && !stoppedForUser && (canStartAgentsManually || queuedUserRequests.length > 0) && (
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
        </ChatOptionsMenu>}
        {chat.type === 'group' && (
          <button className="icon-btn" title={t('Workflow')} onClick={() => openTaskGraphWindow()} style={{ fontSize: 14 }}><Icon name="workflow" /></button>
        )}

        {chat.type === 'group' && projectPath && (
          <button className="icon-btn" title={t('Prüf- und Vorschauumgebung')} onClick={openReviewWindow} style={{ fontSize: 14 }}><Icon name="test" /></button>
        )}
        {chat.type === 'group' && memoryEnabled && (
          <MemoryBadge count={memoryCount} onOpen={handleOpenMemory} />
        )}
        {chat.type === 'group' && !conversationCheckpoint && !running && (
          <button className="icon-btn" title={t('Planungsmodus starten')} onClick={handleStartPlanningMode} style={{ fontSize: 14 }}><Icon name="plan" /></button>
        )}
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
          ><Icon name="lock" /></button>
        )}
        <button className="icon-btn" title={t('Chat leeren')} onClick={handleClearChat} style={{ fontSize: 14 }}><Icon name="trash" /></button>

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
      <div className="messages-container" ref={messagesContainerRef}>
        <div ref={messagesContentRef} className="messages-content">
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
                      rewindAction={rewindButton(msg)}
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
                        disabled: false,
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
                    <div className="message-content-column">
                      {!isUser && mi === 0 && (
                        <div className="message-sender" style={{ fontSize: 12, color: '#8696a0', marginBottom: 2, marginLeft: 10 }}>
                          {msg.senderName}
                          <span style={{ fontSize: 10, opacity: 0.6, marginLeft: 6 }}>
                            {getProviderEmoji(msg.provider || agent?.provider, providerConnections)} {msg.model || agent?.model}
                          </span>
                        </div>
                      )}
                      <div className={`message-bubble ${isUser ? 'out' : 'in'} ${msgText ? 'has-copy-action' : ''}`}>
                        {rewindButton(msg)}
                        <MessageAttachments attachments={msg.attachments || []} />
                        {msgText && <MarkdownMessage className="message-text" onCopy={copyText}>{msgText}</MarkdownMessage>}
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
            progress={agentProgress[id]}
          />
        ))}
        {mcpApproval && <McpPermissionPrompt request={mcpApproval} onDecision={resolveMcpApproval} />}
        <div ref={messagesEndRef} />
        </div>
      </div>

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
          {!running && (hasRecentError || resumeMode || (chat.type !== 'group' && queuedUserRequests.length > 0)) && (
            <div className="composer-recovery-actions" role="group" aria-label={t('Unterhaltung fortsetzen')}>
              {hasRecentError && <button type="button" className="btn btn-secondary" onClick={handleRetry} disabled={providerCooldownActive}>
                <Icon name="undo" size={16} /> Retry
              </button>}
              {(resumeMode || (chat.type !== 'group' && queuedUserRequests.length > 0)) && <button type="button" className="btn btn-primary" onClick={handleRunNow} disabled={providerCooldownActive}>
                <Icon name="play" size={16} /> {resumeMode ? t('Fortsetzen') : t('Warteschlange starten')}
              </button>}
            </div>
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

          {chat.type === 'group' && workflowPlanningActive && (
            <div className="composer-plan-actions" role="group" aria-label={t('Planfreigabe')}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => handleScheduleChoice(plannedParallelTaskIds.length >= 2 ? plannedParallelTaskIds : [])}
              disabled={workflowStartDisabled}
              title={!workflowStartValidation.ok
                ? t(workflowStartValidation.messageKey || workflowStartValidation.reason, workflowStartValidation.messageValues)
                : workflowPreflightReason || undefined}
            >
              {t(planningActive ? 'Plan freigeben & starten' : 'Bereite Aufgaben starten')}
            </button>
            </div>
          )}
          <div className="composer-message-row">
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
            ><Icon name="attach" /></button>
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
            {running && (
              <button
                className="run-btn composer-run-action"
                style={{ background: 'rgba(192,57,43,0.75)', flexShrink: 0 }}
                onClick={handleCancelRun}
              >■ {t('Stopp')}</button>
            )}
            <button
              className="send-btn"
              onClick={handleSend}
              disabled={!input.trim() && !pendingAttachments.length}
              title={running ? t('Nachricht einreihen') : t('Nachricht senden')}
              aria-label={running ? t('Nachricht einreihen') : t('Nachricht senden')}
            ><Icon name="send" size={19} /></button>
          </div>
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
