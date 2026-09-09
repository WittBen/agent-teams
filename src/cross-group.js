import { normalizeCrossGroupTargetIds } from './delegation.js';

const GROUP_REQUEST_STATUSES = new Set([
  'queued',
  'running',
  'waiting_child',
  'answered',
  'failed',
  'timed_out',
  'cancelled',
]);

export const CROSS_GROUP_REQUEST_STATUS = {
  queued: { label: 'Bereit', color: '#53bdeb' },
  running: { label: 'Wird beantwortet', color: '#e6a23c' },
  waiting_child: { label: 'Wartet auf Unteranfrage', color: '#c084fc' },
  answered: { label: 'Beantwortet', color: '#00a884' },
  failed: { label: 'Fehlgeschlagen', color: '#dc2626' },
  timed_out: { label: 'Timeout', color: '#ef4444' },
  cancelled: { label: 'Abgebrochen', color: '#8696a0' },
};

export const MAX_CROSS_GROUP_REQUEST_DEPTH = 3;

const TERMINAL_GROUP_REQUEST_STATUSES = new Set(['answered', 'failed', 'timed_out', 'cancelled']);
const RETRYABLE_GROUP_REQUEST_STATUSES = new Set(['failed', 'timed_out']);
const CROSS_GROUP_QUALITY_MODES = new Set(['fast', 'auto', 'deep']);
const RUNTIME_PLAN_STATUSES = new Set([
  'queued',
  'planning',
  'executing',
  'waiting_child',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
]);
const RUNTIME_STEP_STATUSES = new Set([
  'planned',
  'running',
  'waiting_child',
  'completed',
  'failed',
  'timed_out',
  'cancelled',
]);
const RUNTIME_STEP_KINDS = new Set(['pm_planning', 'agent_task', 'group_wait', 'pm_synthesis']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskFencedCode(value) {
  return String(value || '').replace(/(`{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, match => (
    match.replace(/[^\r\n]/g, ' ')
  ));
}

function uniqueId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function normalizedGroupPath(value = []) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(id => boundedText(id, 200))
    .filter(Boolean))].slice(0, MAX_CROSS_GROUP_REQUEST_DEPTH + 2);
}

function normalizedVisitedGroupIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(id => boundedText(id, 200))
    .filter(Boolean))].slice(0, 40);
}

function normalizedChildResponses(value = []) {
  const normalized = (Array.isArray(value) ? value : []).map(response => ({
    requestId: boundedText(response?.requestId, 200),
    groupId: boundedText(response?.groupId, 200),
    groupName: boundedText(response?.groupName, 200),
    question: boundedText(response?.question, 8000),
    status: GROUP_REQUEST_STATUSES.has(response?.status) ? response.status : 'failed',
    answer: boundedText(response?.answer, 30000),
    error: boundedText(response?.error, 2000),
  })).filter(response => response.requestId && response.groupId);
  const byRequestId = new Map();
  for (const response of normalized) {
    // Keep the most recent terminal representation if persistence replayed a batch.
    if (byRequestId.has(response.requestId)) byRequestId.delete(response.requestId);
    byRequestId.set(response.requestId, response);
  }
  return [...byRequestId.values()].slice(-20);
}

function normalizedProcessedChildResponseIds(value = []) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(requestId => boundedText(requestId, 200))
    .filter(Boolean))].slice(-60);
}

/** Return only child results that have not yet been consumed by the owning PM. */
export function getUnprocessedChildResponses(request = {}) {
  const processedIds = new Set(normalizedProcessedChildResponseIds(request.processedChildResponseIds));
  return normalizedChildResponses(request.childResponses)
    .filter(response => !processedIds.has(response.requestId));
}

function normalizeRuntimeStep(value) {
  if (!isRecord(value)) return null;
  const id = boundedText(value.id, 200);
  const title = boundedText(value.title, 1000);
  if (!id || !title) return null;
  return {
    id,
    kind: RUNTIME_STEP_KINDS.has(value.kind) ? value.kind : 'agent_task',
    title,
    agentId: boundedText(value.agentId, 200),
    agentName: boundedText(value.agentName, 200),
    targetGroupId: boundedText(value.targetGroupId, 200),
    targetGroupName: boundedText(value.targetGroupName, 200),
    parentStepId: boundedText(value.parentStepId, 200),
    status: RUNTIME_STEP_STATUSES.has(value.status) ? value.status : 'planned',
    attempt: Math.max(1, Number(value.attempt) || 1),
    resumeCount: Math.max(0, Math.min(20, Number(value.resumeCount) || 0)),
    error: boundedText(value.error, 2000),
    createdAt: Number(value.createdAt) || Date.now(),
    ...(value.startedAt ? { startedAt: Number(value.startedAt) } : {}),
    ...(value.completedAt ? { completedAt: Number(value.completedAt) } : {}),
  };
}

/** Persisted, read-only execution plan owned by the receiving group PM. */
export function normalizeRequestRuntimePlan(value, { recoverRunning = false } = {}) {
  const raw = isRecord(value) ? value : {};
  const steps = (Array.isArray(raw.steps) ? raw.steps : [])
    .map(normalizeRuntimeStep)
    .filter(Boolean)
    .slice(-80)
    .map(step => recoverRunning && step.status === 'running'
      ? { ...step, status: 'planned', startedAt: undefined }
      : step);
  const rawStatus = RUNTIME_PLAN_STATUSES.has(raw.status) ? raw.status : 'queued';
  return {
    version: 1,
    status: recoverRunning && ['planning', 'executing'].includes(rawStatus) ? 'queued' : rawStatus,
    steps,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

/** Merge runtime step updates by id without mutating the approved source workflow. */
export function updateRequestRuntimePlan(value, { status, steps = [] } = {}) {
  const current = normalizeRequestRuntimePlan(value);
  const mergedSteps = new Map(current.steps.map(step => [step.id, step]));
  for (const rawStep of Array.isArray(steps) ? steps : []) {
    if (!isRecord(rawStep) || !rawStep.id) continue;
    const existing = mergedSteps.get(rawStep.id) || {};
    const normalized = normalizeRuntimeStep({ ...existing, ...rawStep });
    if (normalized) mergedSteps.set(normalized.id, normalized);
  }
  return normalizeRequestRuntimePlan({
    ...current,
    status: RUNTIME_PLAN_STATUSES.has(status) ? status : current.status,
    steps: [...mergedSteps.values()],
    updatedAt: Date.now(),
  });
}

export function finishRequestRuntimePlan(value, status, error = '') {
  const terminalStatus = RUNTIME_PLAN_STATUSES.has(status) ? status : 'failed';
  const stepStatus = terminalStatus === 'completed' ? 'completed' : terminalStatus;
  const completedAt = Date.now();
  const current = normalizeRequestRuntimePlan(value);
  return updateRequestRuntimePlan(current, {
    status: terminalStatus,
    steps: current.steps
      .filter(step => ['planned', 'running', 'waiting_child'].includes(step.status))
      .map(step => ({ ...step, status: stepStatus, error, completedAt })),
  });
}

export function createCrossGroupRequest({
  sourceGroup,
  sourceTask = null,
  sourceAgent = null,
  targetGroup,
  targetAgent = null,
  targetAgents = [],
  question,
  attachments = [],
  batchId = '',
  origin = 'agent',
  kind = 'consultation',
  requiredCapabilities = [],
  delegationReason = '',
  depth = 0,
  parentRequestId = '',
  rootRequestId = '',
  groupPath = [],
  visitedGroupIds = [],
  qualityMode = 'auto',
} = {}) {
  if (!sourceGroup?.id || !targetGroup?.id || sourceGroup.id === targetGroup.id) return null;
  if (!sourceGroup.crossGroupCollaborationEnabled) return null;
  if (!normalizeCrossGroupTargetIds(sourceGroup.crossGroupTargetGroupIds, sourceGroup.crossGroupTargetGroupId).includes(targetGroup.id)) return null;
  const normalizedQuestion = boundedText(question, 8000);
  if (!normalizedQuestion) return null;
  const normalizedDepth = Math.max(0, Number(depth) || 0);
  if (normalizedDepth > MAX_CROSS_GROUP_REQUEST_DEPTH) return null;
  const inheritedPath = normalizedGroupPath(groupPath);
  const sourcePath = inheritedPath.length > 0
    ? inheritedPath
    : [boundedText(sourceGroup.id, 200)];
  if (!sourcePath.includes(sourceGroup.id)) sourcePath.push(boundedText(sourceGroup.id, 200));
  const previouslyVisited = normalizedVisitedGroupIds(visitedGroupIds);
  if (sourcePath.includes(targetGroup.id) || previouslyVisited.includes(targetGroup.id)) return null;
  const requestPath = [...sourcePath, boundedText(targetGroup.id, 200)];
  const createdAt = Date.now();
  const id = uniqueId('group-request');
  const normalizedTargetAgents = [...new Map(
    [targetAgent, ...(Array.isArray(targetAgents) ? targetAgents : [])]
      .filter(agent => agent?.id)
      .map(agent => [boundedText(agent.id, 200), agent]),
  ).values()].slice(0, 8);
  return {
    id,
    batchId: boundedText(batchId, 200) || uniqueId('group-request-batch'),
    sourceGroupId: boundedText(sourceGroup.id, 200),
    sourceGroupName: boundedText(sourceGroup.name, 200),
    sourceTaskId: boundedText(sourceTask?.graphNodeId || sourceTask?.id, 200),
    sourceTaskTitle: boundedText(sourceTask?.objective || sourceTask?.title, 500),
    sourceAgentId: boundedText(sourceAgent?.id, 200),
    sourceAgentName: boundedText(sourceAgent?.name, 200),
    targetGroupId: boundedText(targetGroup.id, 200),
    targetGroupName: boundedText(targetGroup.name, 200),
    targetGroupEmoji: boundedText(targetGroup.emoji || '💬', 20),
    targetAgentId: boundedText(normalizedTargetAgents[0]?.id, 200),
    targetAgentName: boundedText(normalizedTargetAgents.map(agent => agent.name).join(' + '), 200),
    targetAgentIds: normalizedTargetAgents.map(agent => boundedText(agent.id, 200)),
    targetAgentNames: normalizedTargetAgents.map(agent => boundedText(agent.name, 200)),
    question: normalizedQuestion,
    attachments: Array.isArray(attachments) ? attachments.slice(0, 8) : [],
    origin: origin === 'user' ? 'user' : 'agent',
    kind: kind === 'task_delegation' ? 'task_delegation' : 'consultation',
    qualityMode: CROSS_GROUP_QUALITY_MODES.has(qualityMode) ? qualityMode : 'auto',
    requiredCapabilities: Array.isArray(requiredCapabilities)
      ? requiredCapabilities.map(value => boundedText(value, 120)).filter(Boolean).slice(0, 40)
      : [],
    delegationReason: boundedText(delegationReason, 1000),
    depth: normalizedDepth,
    parentRequestId: boundedText(parentRequestId, 200),
    rootRequestId: boundedText(rootRequestId, 200) || id,
    groupPath: requestPath,
    visitedGroupIds: previouslyVisited,
    childRequestIds: [],
    childResponses: [],
    processedChildResponseIds: [],
    processedContextSummary: '',
    resumeCount: 0,
    runtimePlan: normalizeRequestRuntimePlan(),
    status: 'queued',
    attempt: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

export function normalizeCrossGroupRequests(value, { recoverRunning = false } = {}) {
  if (!isRecord(value)) return {};
  const normalized = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const id = boundedText(raw.id || key, 200);
    const sourceGroupId = boundedText(raw.sourceGroupId, 200);
    const targetGroupId = boundedText(raw.targetGroupId, 200);
    const question = boundedText(raw.question, 8000);
    if (!id || !sourceGroupId || !targetGroupId || sourceGroupId === targetGroupId || !question) continue;
    const rawStatus = GROUP_REQUEST_STATUSES.has(raw.status) ? raw.status : 'queued';
    const status = recoverRunning && rawStatus === 'running' ? 'queued' : rawStatus;
    normalized[id] = {
      ...raw,
      id,
      batchId: boundedText(raw.batchId, 200) || id,
      sourceGroupId,
      sourceGroupName: boundedText(raw.sourceGroupName, 200),
      sourceTaskId: boundedText(raw.sourceTaskId, 200),
      sourceTaskTitle: boundedText(raw.sourceTaskTitle, 500),
      sourceAgentId: boundedText(raw.sourceAgentId, 200),
      sourceAgentName: boundedText(raw.sourceAgentName, 200),
      targetGroupId,
      targetGroupName: boundedText(raw.targetGroupName, 200),
      targetGroupEmoji: boundedText(raw.targetGroupEmoji || '💬', 20),
      targetAgentId: boundedText(raw.targetAgentId, 200),
      targetAgentName: boundedText(raw.targetAgentName, 200),
      targetAgentIds: [...new Set((Array.isArray(raw.targetAgentIds)
        ? raw.targetAgentIds
        : [raw.targetAgentId])
        .map(agentId => boundedText(agentId, 200))
        .filter(Boolean))].slice(0, 8),
      targetAgentNames: [...new Set((Array.isArray(raw.targetAgentNames)
        ? raw.targetAgentNames
        : [raw.targetAgentName])
        .map(agentName => boundedText(agentName, 200))
        .filter(Boolean))].slice(0, 8),
      question,
      answer: boundedText(raw.answer, 30000),
      error: boundedText(raw.error, 2000),
      attachments: Array.isArray(raw.attachments) ? raw.attachments.slice(0, 8) : [],
      origin: raw.origin === 'user' ? 'user' : 'agent',
      kind: raw.kind === 'task_delegation' ? 'task_delegation' : 'consultation',
      qualityMode: CROSS_GROUP_QUALITY_MODES.has(raw.qualityMode) ? raw.qualityMode : 'auto',
      requiredCapabilities: Array.isArray(raw.requiredCapabilities)
        ? raw.requiredCapabilities.map(value => boundedText(value, 120)).filter(Boolean).slice(0, 40)
        : [],
      delegationReason: boundedText(raw.delegationReason, 1000),
      depth: Math.max(0, Math.min(MAX_CROSS_GROUP_REQUEST_DEPTH, Number(raw.depth) || 0)),
      parentRequestId: boundedText(raw.parentRequestId, 200),
      rootRequestId: boundedText(raw.rootRequestId, 200) || id,
      groupPath: normalizedGroupPath(raw.groupPath).length > 0
        ? normalizedGroupPath(raw.groupPath)
        : [sourceGroupId, targetGroupId],
      visitedGroupIds: normalizedVisitedGroupIds(raw.visitedGroupIds),
      childRequestIds: [...new Set((Array.isArray(raw.childRequestIds) ? raw.childRequestIds : [])
        .map(childId => boundedText(childId, 200))
        .filter(Boolean))].slice(0, 20),
      childResponses: normalizedChildResponses(raw.childResponses),
      processedChildResponseIds: normalizedProcessedChildResponseIds(raw.processedChildResponseIds),
      processedContextSummary: boundedText(raw.processedContextSummary, 6000),
      interimReply: boundedText(raw.interimReply, 30000),
      memoryStoredGroupIds: [...new Set((Array.isArray(raw.memoryStoredGroupIds) ? raw.memoryStoredGroupIds : [])
        .map(groupId => boundedText(groupId, 200))
        .filter(Boolean))].slice(0, 8),
      memoryStorageErrors: (Array.isArray(raw.memoryStorageErrors) ? raw.memoryStorageErrors : [])
        .map(error => boundedText(error, 500))
        .filter(Boolean)
        .slice(0, 4),
      resumeCount: Math.max(0, Math.min(20, Number(raw.resumeCount) || 0)),
      runtimePlan: normalizeRequestRuntimePlan(raw.runtimePlan, { recoverRunning }),
      attempt: Math.max(1, Number(raw.attempt) || 1),
      status,
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
      ...(raw.deliveredAt ? { deliveredAt: Number(raw.deliveredAt) } : {}),
      ...(raw.memoryStoredAt ? { memoryStoredAt: Number(raw.memoryStoredAt) } : {}),
    };
  }
  return normalized;
}

export function updateCrossGroupRequestMap(value, requestId, updates) {
  const requests = normalizeCrossGroupRequests(value);
  const current = requests[requestId];
  if (!current) return requests;
  const patch = typeof updates === 'function' ? updates(current) : updates;
  if (!isRecord(patch)) return requests;
  return normalizeCrossGroupRequests({
    ...requests,
    [requestId]: { ...current, ...patch, id: current.id, updatedAt: Date.now() },
  });
}

/** Remove selected request records after their running work has been cancelled. */
export function removeCrossGroupRequestsMap(value, requestIds = []) {
  const requests = normalizeCrossGroupRequests(value);
  const removedIds = new Set((Array.isArray(requestIds) ? requestIds : [])
    .map(requestId => boundedText(requestId, 200))
    .filter(Boolean));
  if (removedIds.size === 0) return requests;
  const remaining = Object.fromEntries(
    Object.entries(requests).filter(([requestId]) => !removedIds.has(requestId)),
  );
  return remaining;
}

export function retryCrossGroupRequestMap(value, requestId) {
  const requests = normalizeCrossGroupRequests(value);
  const current = requests[requestId];
  if (!current || !RETRYABLE_GROUP_REQUEST_STATUSES.has(current.status)) return requests;
  return updateCrossGroupRequestMap(requests, requestId, {
    status: 'queued',
    error: '',
    answer: '',
    deliveredAt: undefined,
    startedAt: undefined,
    completedAt: undefined,
    childRequestIds: [],
    childResponses: [],
    processedChildResponseIds: [],
    processedContextSummary: '',
    interimReply: '',
    resumeCount: 0,
    attempt: current.attempt + 1,
    runtimePlan: updateRequestRuntimePlan(current.runtimePlan, { status: 'queued' }),
  });
}

export function cancelRequestsForGroup(value, groupId, { reason = 'Eine beteiligte Gruppe wurde gelöscht.' } = {}) {
  const requests = normalizeCrossGroupRequests(value);
  const cancelledAt = Date.now();
  return Object.fromEntries(Object.entries(requests).map(([id, request]) => {
    if (
      TERMINAL_GROUP_REQUEST_STATUSES.has(request.status) ||
      (request.sourceGroupId !== groupId && request.targetGroupId !== groupId)
    ) return [id, request];
    return [id, {
      ...request,
      status: 'cancelled',
      runtimePlan: finishRequestRuntimePlan(request.runtimePlan, 'cancelled', reason),
      error: boundedText(reason, 2000),
      completedAt: cancelledAt,
      updatedAt: cancelledAt,
    }];
  }));
}

/** Cancel only outdated outbound requests after a source group changes its configured routes. */
export function cancelRequestsOutsideSourceRoutes(value, sourceGroupId, targetGroupIds, { reason = 'Die erreichbaren Zielgruppen wurden geändert.' } = {}) {
  const requests = normalizeCrossGroupRequests(value);
  const allowedTargetIds = new Set(normalizeCrossGroupTargetIds(targetGroupIds));
  const cancelledAt = Date.now();
  return Object.fromEntries(Object.entries(requests).map(([id, request]) => {
    if (
      TERMINAL_GROUP_REQUEST_STATUSES.has(request.status) ||
      request.sourceGroupId !== sourceGroupId ||
      allowedTargetIds.has(request.targetGroupId)
    ) return [id, request];
    return [id, {
      ...request,
      status: 'cancelled',
      runtimePlan: finishRequestRuntimePlan(request.runtimePlan, 'cancelled', reason),
      error: boundedText(reason, 2000),
      completedAt: cancelledAt,
      updatedAt: cancelledAt,
    }];
  }));
}

export function isCrossGroupRequestTerminal(request) {
  return TERMINAL_GROUP_REQUEST_STATUSES.has(request?.status);
}

export function canRetryCrossGroupRequest(request) {
  return RETRYABLE_GROUP_REQUEST_STATUSES.has(request?.status);
}

/** Return a complete child batch only after every child can be handed back to its parent. */
export function resolveChildRequestBatch(value, parentRequestId) {
  const requests = normalizeCrossGroupRequests(value);
  const parent = requests[parentRequestId];
  if (!parent || parent.status !== 'waiting_child' || parent.childRequestIds.length === 0) return null;
  const children = parent.childRequestIds.map(childId => requests[childId]).filter(Boolean);
  if (
    children.length !== parent.childRequestIds.length ||
    children.some(child => child.parentRequestId !== parent.id || !TERMINAL_GROUP_REQUEST_STATUSES.has(child.status))
  ) return null;
  return {
    parent,
    children,
    visitedGroupIds: [...new Set(children.flatMap(child => [
      ...(child.groupPath || []),
      ...(child.visitedGroupIds || []),
    ]))],
    responses: children.map(child => ({
      requestId: child.id,
      groupId: child.targetGroupId,
      groupName: child.targetGroupName,
      question: child.question,
      status: child.status,
      answer: child.answer || '',
      error: child.error || '',
    })),
  };
}

export function groupRequestColor(group) {
  const palette = ['#53bdeb', '#61d6a7', '#c084fc', '#fb923c', '#f472b6', '#a3e635', '#facc15', '#38bdf8'];
  if (Number.isInteger(group?.color)) return palette[Math.abs(group.color) % palette.length];
  const hash = String(group?.id || group?.name || '').split('').reduce((total, character) => (
    ((total * 31) + character.charCodeAt(0)) | 0
  ), 0);
  return palette[Math.abs(hash) % palette.length];
}

/**
 * Resolve group mentions from user text or an agent response. User mentions may
 * be inline; agent requests are actionable only at the beginning of a line.
 */
export function extractGroupMentions(value, groups = [], { sourceGroupId = '', userAuthored = false } = {}) {
  const text = String(value || '');
  if (!text.trim()) return [];
  const searchable = maskFencedCode(text);
  const candidates = groups
    .filter(group => group?.id && group.id !== sourceGroupId && group.name)
    .sort((left, right) => String(right.name).length - String(left.name).length);
  const matches = [];
  for (const group of candidates) {
    const prefix = userAuthored ? '(?:^|\\s)' : '^';
    const pattern = new RegExp(`${prefix}@${escapeRegExp(group.name)}(?=$|[\\s:;,!?])`, userAuthored ? 'gi' : 'gim');
    let match;
    while ((match = pattern.exec(searchable)) !== null) {
      const mentionIndex = match.index + match[0].lastIndexOf('@');
      matches.push({ group, index: mentionIndex, end: mentionIndex + group.name.length + 1 });
    }
  }
  matches.sort((left, right) => left.index - right.index || right.end - left.end);
  const unique = matches.filter((match, index) => (
    index === 0 || match.index !== matches[index - 1].index
  ));
  return unique.map((match, index) => {
    const nextMentionIndex = unique[index + 1]?.index ?? searchable.length;
    const lineEnd = searchable.indexOf('\n', match.end);
    const localEnd = lineEnd === -1 ? nextMentionIndex : Math.min(lineEnd, nextMentionIndex);
    const directed = text.slice(match.end, localEnd)
      .replace(/^\s*[:;,\-–—]?\s*/, '')
      .trim();
    const fallback = text
      .replace(new RegExp(`@${escapeRegExp(match.group.name)}(?=$|[\\s:;,!?])`, 'gi'), '')
      .replace(/\s+/g, ' ')
      .trim();
    return {
      group: match.group,
      question: boundedText(directed || fallback || 'Bitte beantworte die offene Informationsanfrage.', 8000),
      index: match.index,
    };
  });
}

/** Find actionable @Name: lines that do not target an allowed agent or group. */
export function extractUnknownDirectedMentions(value, allowedNames = []) {
  const allowed = new Set([
    'user',
    ...(Array.isArray(allowedNames) ? allowedNames : []),
  ].map(name => String(name || '').trim().toLocaleLowerCase()).filter(Boolean));
  const searchable = maskFencedCode(value);
  const unknown = [];
  const pattern = /^\s*@([^:\r\n]{1,120})\s*:/gim;
  let match;
  while ((match = pattern.exec(searchable)) !== null) {
    const name = String(match[1] || '').trim();
    if (name && !allowed.has(name.toLocaleLowerCase()) && !unknown.some(entry => entry.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      unknown.push(name);
    }
  }
  return unknown;
}

export function requestsForChat(value, chatId) {
  const requests = Object.values(normalizeCrossGroupRequests(value));
  const relevantRootIds = new Set(requests
    .filter(request => request.sourceGroupId === chatId || request.targetGroupId === chatId)
    .map(request => request.rootRequestId || request.id));
  return requests
    .filter(request => relevantRootIds.has(request.rootRequestId || request.id))
    .sort((left, right) => left.createdAt - right.createdAt);
}
