import { normalizeDelegationPolicy } from './delegation';

const ELIGIBLE_PARALLEL_STATUSES = new Set(['planned', 'queued', 'prepared', 'interrupted', 'retryable']);
const PREPARATION_CANDIDATE_STATUSES = new Set(['planned', 'queued', 'interrupted', 'retryable']);
const FINISHED_DEPENDENCY_STATUSES = new Set(['agent_done', 'completed']);

export const TASK_STATUS = {
  planned: { label: 'Geplant', color: '#8696a0' },
  queued: { label: 'Bereit', color: '#53bdeb' },
  preparing: { label: 'Bereitet vor', color: '#f6b94f' },
  prepared: { label: 'Vorbereitet', color: '#53bdeb' },
  running: { label: 'In Arbeit', color: '#e6a23c' },
  waiting_user: { label: 'Wartet auf User', color: '#c084fc' },
  waiting_pm: { label: 'Wartet auf PM', color: '#a78bfa' },
  waiting_group: { label: 'Wartet auf Gruppe', color: '#8b9df5' },
  delegation_pending: { label: 'Delegation freigeben', color: '#c084fc' },
  provider_paused: { label: 'Provider pausiert', color: '#f59e0b' },
  retryable: { label: 'Erneut ausführbar', color: '#fb923c' },
  agent_done: { label: 'Agent fertig', color: '#4ade80' },
  completed: { label: 'PM bestätigt', color: '#00a884' },
  blocked: { label: 'Blockiert', color: '#f59e0b' },
  timed_out: { label: 'Timeout', color: '#ef4444' },
  failed: { label: 'Fehlgeschlagen', color: '#dc2626' },
  interrupted: { label: 'Unterbrochen', color: '#fb923c' },
};

export const ACCEPTANCE_STATUS = {
  open: { label: 'Offen', color: '#8696a0' },
  submitted: { label: 'Nachweis vorhanden', color: '#53bdeb' },
  passed: { label: 'Bestanden', color: '#00a884' },
  failed: { label: 'Abgelehnt', color: '#ef4444' },
  waived: { label: 'Ausnahme bestätigt', color: '#c084fc' },
};

const ACCEPTED_CRITERION_STATUSES = new Set(['passed', 'waived']);
const ACCEPTANCE_VERIFICATION = new Set(['reviewer', 'automatic', 'user']);

function normalizeAcceptanceId(value, fallback) {
  return String(value || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function normalizeAcceptanceCriteria(criteria = [], { taskId = 'task', fallbackText = '' } = {}) {
  const source = Array.isArray(criteria) ? criteria : [];
  const normalized = [];
  const seen = new Set();
  for (const [index, candidate] of source.slice(0, 12).entries()) {
    const text = String(typeof candidate === 'string' ? candidate : candidate?.text || '')
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) continue;
    const id = normalizeAcceptanceId(
      typeof candidate === 'object' ? candidate?.id : '',
      `${taskId}-criterion-${index + 1}`,
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const verification = ACCEPTANCE_VERIFICATION.has(candidate?.verification)
      ? candidate.verification
      : 'reviewer';
    const status = ACCEPTANCE_STATUS[candidate?.status] ? candidate.status : 'open';
    normalized.push({
      id,
      text,
      required: candidate?.required !== false,
      verification,
      status,
      evidence: Array.isArray(candidate?.evidence) ? candidate.evidence.slice(-8) : [],
      ...(candidate?.reviewedBy ? { reviewedBy: String(candidate.reviewedBy).slice(0, 80) } : {}),
      ...(candidate?.reviewedAt ? { reviewedAt: candidate.reviewedAt } : {}),
    });
  }
  if (!normalized.length && fallbackText) {
    normalized.push({
      id: normalizeAcceptanceId('', `${taskId}-result`),
      text: String(fallbackText).replace(/\s+/g, ' ').trim().slice(0, 300),
      required: true,
      verification: 'reviewer',
      status: 'open',
      evidence: [],
    });
  }
  return normalized;
}

function mergeAcceptanceCriteria(previous = [], incoming = []) {
  const existing = new Map((previous || []).map(criterion => [criterion.id, criterion]));
  return (incoming || []).map(criterion => {
    const prior = existing.get(criterion.id);
    return prior ? {
      ...criterion,
      status: prior.status || criterion.status,
      evidence: Array.isArray(prior.evidence) ? prior.evidence : criterion.evidence,
      ...(prior.reviewedBy ? { reviewedBy: prior.reviewedBy } : {}),
      ...(prior.reviewedAt ? { reviewedAt: prior.reviewedAt } : {}),
    } : criterion;
  });
}

function requiredCriteriaAccepted(criteria = []) {
  return criteria.filter(criterion => criterion.required !== false)
    .every(criterion => ACCEPTED_CRITERION_STATUSES.has(criterion.status));
}

export function createTaskGraph(chatId, title = 'Workflow') {
  return {
    version: 2,
    chatId,
    title,
    workflowState: 'idle',
    planRevision: 0,
    planOwner: null,
    approvedPlan: null,
    executionLog: [],
    viewState: { positions: {} },
    nodes: [],
    edges: [],
    flowPoints: [],
    flowEdges: [],
    updatedAt: Date.now(),
  };
}

export function lockTaskGraphPlan(graph) {
  if (!graph) return graph;
  const approvedAt = Date.now();
  return {
    ...graph,
    workflowState: 'executing',
    planOwner: 'user',
    changeRequest: null,
    planHistory: [...(graph.planHistory || []), ...(graph.previousApprovedPlan
      && !(graph.planHistory || []).some(plan => plan.revision === graph.previousApprovedPlan.revision)
      ? [graph.previousApprovedPlan]
      : [])].slice(-50),
    approvedPlan: {
      revision: graph.planRevision || 1,
      approvedAt,
      approvedBy: 'user',
      nodes: graph.nodes.map(node => ({
        ...node,
        acceptanceCriteria: (node.acceptanceCriteria || []).map(criterion => ({
          ...criterion,
          evidence: [...(criterion.evidence || [])],
        })),
      })),
      edges: graph.edges.map(edge => ({ ...edge })),
      flowPoints: (graph.flowPoints || []).map(point => ({ ...point })),
      flowEdges: (graph.flowEdges || []).map(edge => ({ ...edge })),
    },
    updatedAt: approvedAt,
  };
}

/**
 * Open a user-owned draft from the current immutable contract. Runtime progress
 * is retained, while recoverable/open work becomes editable and startable in
 * the next plan revision. Agents never call this transition.
 */
export function beginUserPlanEdit(graph) {
  if (!graph) return graph;
  const snapshot = graph.approvedPlan || graph.previousApprovedPlan;
  const editableStatuses = new Set([
    'failed', 'timed_out', 'blocked', 'interrupted', 'waiting_user', 'waiting_pm', 'waiting_group', 'delegation_pending',
    'provider_paused', 'retryable', 'queued', 'running',
  ]);
  const editedAt = Date.now();
  return {
    ...graph,
    workflowState: 'planning',
    planOwner: 'user',
    planRevision: Math.max(0, Number(graph.planRevision) || Number(snapshot?.revision) || 0) + 1,
    previousApprovedPlan: snapshot || null,
    approvedPlan: null,
    changeRequest: {
      reason: 'user-edit',
      taskIds: [],
      requestedAt: editedAt,
      runtimeNodes: graph.nodes.map(node => ({
        ...node,
        acceptanceCriteria: (node.acceptanceCriteria || []).map(criterion => ({
          ...criterion,
          evidence: [...(criterion.evidence || [])],
        })),
      })),
      runtimeViewState: {
        ...(graph.viewState || {}),
        positions: { ...(graph.viewState?.positions || {}) },
      },
    },
    nodes: graph.nodes.map(node => editableStatuses.has(node.status)
      ? {
        ...node,
        status: 'planned',
        error: undefined,
        blockedReason: undefined,
        delegationProposal: undefined,
        delegationLocalApprovedAt: undefined,
        interruptedAt: undefined,
        updatedAt: editedAt,
      }
      : node),
    updatedAt: editedAt,
  };
}

export function markTaskGraphUserOwned(graph) {
  if (!graph) return graph;
  return {
    ...graph,
    planOwner: 'user',
    userEditedAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export function retryTaskNode(graph, nodeId) {
  const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
  if (!node || !['failed', 'timed_out', 'blocked', 'interrupted', 'waiting_user', 'waiting_pm', 'waiting_group', 'provider_paused', 'retryable'].includes(node.status)) return graph;
  return updateTaskNodeStatus(graph, nodeId, 'planned', {
    error: undefined,
    blockedReason: undefined,
    recoveryStatus: null,
    recoveryTaskId: null,
    recoveryError: undefined,
    startedAt: undefined,
    completedAt: undefined,
    retryRequestedAt: Date.now(),
  });
}

/**
 * Discard a planning draft and restore the last approved workflow contract.
 * Runtime progress is merged back into matching tasks so restoring the plan
 * never turns completed work into open work again.
 */
export function restoreTaskGraphSnapshot(graph) {
  const snapshot = graph?.previousApprovedPlan || graph?.approvedPlan;
  if (!graph || !snapshot?.nodes || !snapshot?.edges) return graph;
  const currentById = new Map((graph.nodes || []).map(node => [node.id, node]));
  const runtimeById = new Map((graph.changeRequest?.runtimeNodes || []).map(node => [node.id, node]));
  const restoredNodes = snapshot.nodes.map(snapshotNode => {
    const runtimeNode = currentById.get(snapshotNode.id) || runtimeById.get(snapshotNode.id);
    const restored = {
      ...snapshotNode,
      acceptanceCriteria: mergeAcceptanceCriteria(
        runtimeNode?.acceptanceCriteria || [],
        (snapshotNode.acceptanceCriteria || []).map(criterion => ({
          ...criterion,
          evidence: [...(criterion.evidence || [])],
        })),
      ),
    };
    if (!runtimeNode) return restored;
    for (const [key, value] of Object.entries(runtimeNode)) {
      if (key === 'status' || key === 'acceptanceBlocked' || key === 'errorMessage' || key === 'workflowPosition' || key.endsWith('At')) {
        restored[key] = value;
      }
    }
    return restored;
  });
  const restoredAt = Date.now();
  const restoredViewState = {
    ...(graph.changeRequest?.runtimeViewState || {}),
    ...(graph.viewState || {}),
    positions: {
      ...(graph.changeRequest?.runtimeViewState?.positions || {}),
      ...(graph.viewState?.positions || {}),
    },
  };
  return {
    ...graph,
    workflowState: 'planning',
    planRevision: Math.max(Number(graph.planRevision) || 0, (Number(snapshot.revision) || 0) + 1),
    approvedPlan: null,
    previousApprovedPlan: snapshot,
    changeRequest: {
      reason: 'snapshot-restored',
      taskIds: [],
      requestedAt: restoredAt,
      runtimeNodes: restoredNodes.map(node => ({
        ...node,
        acceptanceCriteria: (node.acceptanceCriteria || []).map(criterion => ({
          ...criterion,
          evidence: [...(criterion.evidence || [])],
        })),
      })),
      runtimeViewState: {
        ...restoredViewState,
        positions: { ...(restoredViewState.positions || {}) },
      },
    },
    nodes: restoredNodes,
    edges: snapshot.edges.map(edge => ({ ...edge })),
    flowPoints: (snapshot.flowPoints || []).map(point => ({ ...point })),
    flowEdges: (snapshot.flowEdges || []).map(edge => ({ ...edge })),
    viewState: restoredViewState,
    updatedAt: restoredAt,
  };
}

function workflowEdgeContractKey(edge = {}) {
  return `${edge.kind || 'delegation'}:${edge.from || ''}->${edge.to || ''}`;
}

function acceptanceContract(criteria = []) {
  return (criteria || []).map(criterion => ({
    id: criterion.id || '',
    text: String(criterion.text || '').replace(/\s+/g, ' ').trim(),
    required: criterion.required !== false,
    verification: criterion.verification || 'reviewer',
  }));
}

function readableAcceptanceContract(criteria = []) {
  const contract = acceptanceContract(criteria);
  return contract.length
    ? contract.map(criterion => `${criterion.required ? 'Pflicht' : 'Optional'}: ${criterion.text}`).join(' · ')
    : 'Keine';
}

function delegationContract(value = {}) {
  return normalizeDelegationPolicy(value);
}

function readableDelegationContract(value = {}) {
  const delegation = delegationContract(value);
  if (delegation.mode === 'never') return 'Nicht erlaubt';
  const mode = delegation.mode === 'automatic' ? 'Automatisch' : 'Nach User-Freigabe';
  const capabilities = delegation.requiredCapabilities.join(', ') || 'Keine Fähigkeiten angegeben';
  return `${mode} · ${capabilities}`;
}

const WORKFLOW_CONTRACT_FIELDS = [
  { field: 'title', label: 'Titel', value: node => String(node?.title || '').trim() || '–' },
  { field: 'objective', label: 'Ziel', value: node => String(node?.objective || node?.title || '').replace(/\s+/g, ' ').trim() || '–' },
  { field: 'agentId', label: 'Agent', compare: node => node?.agentId || '', value: node => node?.agentName || node?.agentId || 'Nicht zugewiesen' },
  { field: 'model', label: 'Modell', compare: node => node?.modelOverride || node?.model || '', value: node => node?.modelOverride || node?.model || 'Agentenstandard' },
  { field: 'nodeType', label: 'Aufgabentyp', value: node => inferTaskNodeType(node || {}) },
  { field: 'planOrder', label: 'Reihenfolge', compare: node => Number(node?.planOrder) || 0, value: node => String((Number(node?.planOrder) || 0) + 1) },
  {
    field: 'acceptanceCriteria',
    label: 'Abnahmekriterien',
    compare: node => JSON.stringify(acceptanceContract(node?.acceptanceCriteria)),
    value: node => readableAcceptanceContract(node?.acceptanceCriteria),
  },
  {
    field: 'delegation',
    label: 'Delegation',
    compare: node => JSON.stringify(delegationContract(node?.delegation)),
    value: node => readableDelegationContract(node?.delegation),
  },
];

/**
 * Compare a planning draft with the last approved snapshot. Runtime-only state
 * (status, timestamps, evidence, execution log and canvas positions) is omitted
 * deliberately so normal execution progress never appears as a plan change.
 */
export function buildWorkflowChangeSet(graph) {
  const baseline = graph?.previousApprovedPlan;
  if (!graph?.changeRequest || !baseline) {
    return {
      active: false,
      baselineRevision: null,
      hasContractChanges: false,
      nodeChanges: {},
      edgeChanges: {},
      removedNodes: [],
      removedEdges: [],
      requestedTaskIds: [],
    };
  }

  const currentNodes = new Map((graph.nodes || []).map(node => [node.id, node]));
  const baselineNodes = new Map((baseline.nodes || []).map(node => [node.id, node]));
  const currentFlowPoints = new Map((graph.flowPoints || []).map(point => [point.id, point]));
  const baselineFlowPoints = new Map((baseline.flowPoints || []).map(point => [point.id, point]));
  const requestedTaskIds = [...new Set(graph.changeRequest.taskIds || [])];
  const nodeChanges = {};
  const appendNodeChange = (nodeId, type, change) => {
    const existing = nodeChanges[nodeId] || { nodeId, type, changes: [] };
    if (existing.type === 'requested' || type === 'added' || type === 'removed') existing.type = type;
    else if (existing.type !== 'added' && existing.type !== 'removed') existing.type = 'changed';
    existing.changes.push(change);
    nodeChanges[nodeId] = existing;
  };

  for (const [nodeId, node] of currentNodes) {
    const previous = baselineNodes.get(nodeId);
    if (!previous) {
      appendNodeChange(nodeId, 'added', {
        field: 'node', label: 'Aufgabe', before: 'Nicht im Snapshot', after: 'Neu im Entwurf',
      });
      continue;
    }
    for (const definition of WORKFLOW_CONTRACT_FIELDS) {
      const compare = definition.compare || definition.value;
      if (compare(previous) === compare(node)) continue;
      appendNodeChange(nodeId, 'changed', {
        field: definition.field,
        label: definition.label,
        before: definition.value(previous),
        after: definition.value(node),
      });
    }
  }
  for (const [pointId, point] of currentFlowPoints) {
    const previous = baselineFlowPoints.get(pointId);
    if (!previous) {
      appendNodeChange(pointId, 'added', { field: 'flowPoint', label: 'Workflow-Punkt', before: 'Nicht im Snapshot', after: point.type === 'fork' ? 'Fork' : 'Join' });
    } else if (previous.type !== point.type) {
      appendNodeChange(pointId, 'changed', { field: 'flowPoint', label: 'Workflow-Punkt', before: previous.type, after: point.type });
    }
  }

  const removedNodes = [];
  for (const [nodeId, node] of baselineNodes) {
    if (currentNodes.has(nodeId)) continue;
    const change = {
      field: 'node', label: 'Aufgabe', before: node.title || nodeId, after: 'Aus Entwurf entfernt',
    };
    appendNodeChange(nodeId, 'removed', change);
    removedNodes.push({ ...node, change: nodeChanges[nodeId] });
  }
  for (const [pointId, point] of baselineFlowPoints) {
    if (currentFlowPoints.has(pointId)) continue;
    const change = { field: 'flowPoint', label: 'Workflow-Punkt', before: point.type === 'fork' ? 'Fork' : 'Join', after: 'Aus Entwurf entfernt' };
    appendNodeChange(pointId, 'removed', change);
    removedNodes.push({ ...point, title: point.type === 'fork' ? 'Fork' : 'Join', change: nodeChanges[pointId] });
  }

  const currentEdges = new Map(workflowTopologyEdges(graph).map(edge => [workflowEdgeContractKey(edge), edge]));
  const baselineEdges = new Map([
    ...(baseline.edges || []).filter(isWorkflowBlockingEdge),
    ...(baseline.flowEdges || []).map(edge => ({ ...edge, kind: 'flow' })),
  ].map(edge => [workflowEdgeContractKey(edge), edge]));
  const edgeChanges = {};
  const removedEdges = [];
  const nodeTitle = nodeId => currentNodes.get(nodeId)?.title || baselineNodes.get(nodeId)?.title || currentFlowPoints.get(nodeId)?.title || baselineFlowPoints.get(nodeId)?.title || nodeId;
  for (const [key, edge] of currentEdges) {
    if (baselineEdges.has(key)) continue;
    edgeChanges[key] = { key, type: 'added', edge };
    appendNodeChange(edge.to, 'changed', {
      field: `edge:${key}`,
      label: edge.kind === 'dependency' ? 'Abhängigkeit' : 'Verbindung',
      before: 'Nicht im Snapshot',
      after: `${nodeTitle(edge.from)} → ${nodeTitle(edge.to)}`,
    });
  }
  for (const [key, edge] of baselineEdges) {
    if (currentEdges.has(key)) continue;
    const change = { key, type: 'removed', edge };
    edgeChanges[key] = change;
    removedEdges.push(change);
    appendNodeChange(edge.to, 'changed', {
      field: `edge:${key}`,
      label: edge.kind === 'dependency' ? 'Abhängigkeit' : 'Verbindung',
      before: `${nodeTitle(edge.from)} → ${nodeTitle(edge.to)}`,
      after: 'Entfernt',
    });
  }

  for (const nodeId of requestedTaskIds) {
    if (nodeChanges[nodeId]) continue;
    appendNodeChange(nodeId, 'requested', {
      field: 'changeRequest',
      label: 'Änderungsabsicht',
      before: 'Freigegebener Snapshot',
      after: graph.changeRequest.reason || 'Änderung durch den PM angefordert',
    });
  }

  return {
    active: true,
    baselineRevision: baseline.revision || null,
    hasContractChanges: Object.values(nodeChanges).some(change => change.type !== 'requested'),
    nodeChanges,
    edgeChanges,
    removedNodes,
    removedEdges,
    requestedTaskIds,
  };
}

export function validateApprovedTaskExecution(graph, task) {
  if (!graph?.approvedPlan) return { ok: true, mode: 'free' };
  const recoverySource = String(task?.source || '');
  if (task?.runtimeRecovery === true && recoverySource.startsWith('timeout-recovery')) {
    const originalNodeId = task.recovery?.originalGraphNodeId;
    const originalNode = graph.approvedPlan.nodes?.find(node => node.id === originalNodeId);
    if (!originalNode) return { ok: false, reason: 'Die Timeout-Recovery gehört zu keiner freigegebenen Originalaufgabe.' };
    const liveOriginalNode = graph.nodes?.find(node => node.id === originalNodeId);
    if (!liveOriginalNode || (liveOriginalNode.status !== 'timed_out' && !liveOriginalNode.recoveryStatus)) {
      return { ok: false, reason: 'Die Originalaufgabe befindet sich nicht in einer aktiven Timeout-Recovery.' };
    }
    if (!task.recovery?.originalAgentId || task.recovery.originalAgentId !== originalNode.agentId) {
      return { ok: false, reason: 'Die Timeout-Recovery verweist auf eine abweichende Agentenzuordnung.' };
    }
    if (recoverySource === 'timeout-recovery-step' && task.agent?.id !== originalNode.agentId) {
      return { ok: false, reason: 'Der Recovery-Teilschritt ist nicht dem ursprünglichen Agenten zugewiesen.' };
    }
    if (recoverySource === 'timeout-recovery' && task.agent?.id !== task.recovery?.pmAgentId) {
      return { ok: false, reason: 'Die Timeout-Recovery ist nicht dem zuständigen PM zugewiesen.' };
    }
    return { ok: true, mode: 'timeout-recovery', approvedNode: originalNode };
  }
  const approvedNode = graph.approvedPlan.nodes?.find(node => node.id === task?.graphNodeId);
  if (!approvedNode) {
    return { ok: false, reason: 'Die Aufgabe ist nicht Bestandteil des freigegebenen Workflows.' };
  }
  if (approvedNode.agentId && approvedNode.agentId !== task?.agent?.id) {
    return { ok: false, reason: 'Die Agentenzuordnung weicht vom freigegebenen Workflow ab.' };
  }
  const approvedModel = approvedNode.modelOverride || approvedNode.model || '';
  const actualModel = task?.modelOverride || task?.agent?.model || '';
  if (approvedModel && actualModel && approvedModel !== actualModel) {
    return { ok: false, reason: 'Die Modellzuordnung weicht vom freigegebenen Workflow ab.' };
  }
  if (task?.preparationOnly === true && recoverySource === 'dependency-preparation') {
    const liveNode = graph.nodes?.find(node => node.id === task.graphNodeId);
    const unfinishedDependencies = [...upstreamTaskNodeIds(graph, task.graphNodeId)]
      .filter(parentId => {
        const parent = graph.nodes?.find(candidate => candidate.id === parentId);
        return !parent || !FINISHED_DEPENDENCY_STATUSES.has(parent.status);
      });
    if (!liveNode || !PREPARATION_CANDIDATE_STATUSES.has(liveNode.status)) {
      return { ok: false, reason: 'Die Aufgabe ist nicht für einen Vorbereitungslauf verfügbar.' };
    }
    if (inferTaskNodeType(liveNode) !== 'task' || liveNode.runtimeRecovery) {
      return { ok: false, reason: 'Nur reguläre Fachaufgaben dürfen vorzeitig vorbereitet werden.' };
    }
    if (liveNode.preparationAttemptedAt || liveNode.preparationCompletedAt || unfinishedDependencies.length === 0) {
      return { ok: false, reason: 'Für diese Aufgabe ist kein weiterer Vorbereitungslauf erforderlich.' };
    }
    return { ok: true, mode: 'dependency-preparation', approvedNode, unfinishedDependencies };
  }
  const approvedObjective = String(approvedNode.objective || approvedNode.title || '').replace(/\s+/g, ' ').trim();
  const actualObjective = String(task?.handoff?.summary || task?.objective || '').replace(/\s+/g, ' ').trim();
  if (!task?.approvedContinuation && approvedObjective && actualObjective && approvedObjective !== actualObjective) {
    return { ok: false, reason: 'Das Aufgabenziel weicht vom freigegebenen Workflow ab.' };
  }
  if (!isTaskNodeReady(graph, task.graphNodeId)) {
    return { ok: false, reason: 'Mindestens eine freigegebene Abhängigkeit ist noch nicht abgeschlossen.' };
  }
  return { ok: true, mode: 'approved', approvedNode };
}

export function recordTaskExecutionEvent(graph, task, event, extra = {}) {
  if (!graph || !task?.graphNodeId) return graph;
  const approvedNode = graph.approvedPlan?.nodes?.find(node => node.id === task.graphNodeId);
  const entry = {
    id: `execution-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    taskId: task.graphNodeId,
    event,
    planRevision: graph.approvedPlan?.revision || null,
    plannedAgentId: approvedNode?.agentId || null,
    actualAgentId: task.agent?.id || null,
    plannedModel: approvedNode?.modelOverride || approvedNode?.model || null,
    actualModel: task.modelOverride || task.agent?.model || null,
    compliant: approvedNode ? (
      (!approvedNode.agentId || approvedNode.agentId === task.agent?.id) &&
      (!(approvedNode.modelOverride || approvedNode.model) || (approvedNode.modelOverride || approvedNode.model) === (task.modelOverride || task.agent?.model))
    ) : null,
    at: Date.now(),
    ...extra,
  };
  return { ...graph, executionLog: [...(graph.executionLog || []), entry].slice(-500), updatedAt: Date.now() };
}

export function updateWorkflowViewPosition(graph, nodeId, position) {
  const isTaskNode = graph?.nodes?.some(node => node.id === nodeId);
  const isRailPoint = graph?.flowPoints?.some(point => point.id === nodeId);
  if (!isTaskNode && !isRailPoint) return graph;
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return graph;
  return {
    ...graph,
    viewState: {
      ...(graph.viewState || {}),
      positions: {
        ...(graph.viewState?.positions || {}),
        [nodeId]: { x: Math.max(8, Math.min(10000, x)), y: Math.max(8, Math.min(10000, y)) },
      },
    },
    updatedAt: Date.now(),
  };
}

export function resetWorkflowViewState(graph) {
  if (!graph) return graph;
  return {
    ...graph,
    viewState: { ...(graph.viewState || {}), positions: {} },
    // Remove positions persisted by versions before layout state was split
    // from the executable plan contract.
    nodes: graph.nodes.map(node => ({ ...node, workflowPosition: undefined })),
    updatedAt: Date.now(),
  };
}

export function taskPlanGraphNodeId(rootNodeId, planTaskId) {
  const safePlanId = String(planTaskId || 'task').replace(/[^a-zA-Z0-9_-]+/g, '-');
  return `${rootNodeId}:plan:${safePlanId}`;
}

export function upsertTaskNode(graph, node) {
  const base = graph || createTaskGraph(node.chatId || 'chat');
  const existingIndex = base.nodes.findIndex(candidate => candidate.id === node.id);
  const nodes = [...base.nodes];
  const nextNode = {
    status: 'planned',
    createdAt: Date.now(),
    ...nodes[existingIndex],
    ...node,
    updatedAt: Date.now(),
  };
  if (existingIndex >= 0) nodes[existingIndex] = nextNode;
  else nodes.push(nextNode);
  return { ...base, nodes, updatedAt: Date.now() };
}

export function addPlanningTask(graph, { rootNodeId, agent, title = null, nodeType = 'task', position = null } = {}) {
  if (!graph || !rootNodeId || !agent?.id) return graph;
  const isReview = nodeType === 'review';
  const defaultTitle = isReview ? 'Neue Abnahme' : 'Neue Aufgabe';
  const normalizedTitle = String(title || defaultTitle).trim().slice(0, 180);
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const planTaskId = `user-${isReview ? 'review' : 'task'}-${suffix}`;
  const nodeId = taskPlanGraphNodeId(rootNodeId, planTaskId);
  const executable = graph.nodes.filter(node => node.planRootId === rootNodeId && !['request', 'review'].includes(inferTaskNodeType(node)));
  let nextGraph = upsertTaskNode(graph, {
    id: nodeId,
    title: normalizedTitle,
    objective: normalizedTitle,
    agentId: agent.id,
    agentName: agent.name,
    provider: agent.provider,
    model: agent.model,
    status: 'planned',
    source: 'User-Plan',
    nodeType: isReview ? 'review' : 'task',
    planRootId: rootNodeId,
    planTaskId,
    planOrder: executable.length,
    acceptanceCriteria: isReview ? [] : normalizeAcceptanceCriteria([], {
      taskId: planTaskId,
      fallbackText: `Das Ergebnis erfüllt die Aufgabe „${normalizedTitle}“.`,
    }),
    delegation: normalizeDelegationPolicy(),
  });
  if (position) nextGraph = updateWorkflowViewPosition(nextGraph, nodeId, position);
  return nextGraph;
}

export function addWorkflowPoint(graph, { type, position, rootNodeId = null } = {}) {
  if (!graph || !['fork', 'join'].includes(type)) return graph;
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const id = `__user-${type}-${suffix}`;
  const x = Number(position?.x);
  const y = Number(position?.y);
  return {
    ...graph,
    flowPoints: [...(graph.flowPoints || []), {
      id,
      type,
      title: type === 'fork' ? 'Fork' : 'Join',
      ...(rootNodeId ? { planRootId: rootNodeId } : {}),
      createdAt: Date.now(),
    }],
    viewState: Number.isFinite(x) && Number.isFinite(y) ? {
      ...(graph.viewState || {}),
      positions: {
        ...(graph.viewState?.positions || {}),
        [id]: { x: Math.max(8, Math.min(10000, x)), y: Math.max(8, Math.min(10000, y)) },
      },
    } : graph.viewState,
    updatedAt: Date.now(),
  };
}

export function removeWorkflowPoint(graph, pointId) {
  if (!graph?.flowPoints?.some(point => point.id === pointId)) return graph;
  return {
    ...graph,
    flowPoints: graph.flowPoints.filter(point => point.id !== pointId),
    flowEdges: (graph.flowEdges || []).filter(edge => edge.from !== pointId && edge.to !== pointId),
    viewState: {
      ...(graph.viewState || {}),
      positions: Object.fromEntries(Object.entries(graph.viewState?.positions || {}).filter(([id]) => id !== pointId)),
    },
    updatedAt: Date.now(),
  };
}

export function updatePlanningTask(graph, nodeId, updates = {}) {
  const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
  if (!node || inferTaskNodeType(node) === 'request') return graph;
  const title = updates.title == null ? node.title : String(updates.title).replace(/\s+/g, ' ').trim().slice(0, 180);
  if (!title) return graph;
  const objective = updates.objective == null ? (updates.title == null ? node.objective : title) : String(updates.objective).replace(/\s+/g, ' ').trim().slice(0, 1200);
  const delegation = updates.delegation == null
    ? normalizeDelegationPolicy(node.delegation)
    : normalizeDelegationPolicy(updates.delegation);
  const contractChanged = title !== node.title || objective !== node.objective ||
    (updates.nodeType && updates.nodeType !== inferTaskNodeType(node)) ||
    (updates.acceptanceCriteria && JSON.stringify(acceptanceContract(updates.acceptanceCriteria)) !== JSON.stringify(acceptanceContract(node.acceptanceCriteria))) ||
    (updates.delegation && JSON.stringify(delegation) !== JSON.stringify(normalizeDelegationPolicy(node.delegation)));
  return upsertTaskNode(graph, {
    id: nodeId,
    ...updates,
    title,
    objective,
    delegation,
    ...(contractChanged ? {
      status: 'planned',
      preparationAttemptedAt: undefined,
      preparationCompletedAt: undefined,
      preparationFailedAt: undefined,
      preparationError: undefined,
      interimResult: undefined,
      interimSavedAt: undefined,
      interimConsumedAt: undefined,
      preparedFiles: undefined,
    } : {}),
  });
}

export function removePlanningTask(graph, nodeId) {
  const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
  if (!node || inferTaskNodeType(node) === 'request') return graph;
  const affectedTargetIds = new Set(graph.edges
    .filter(edge => edge.from === nodeId && isWorkflowBlockingEdge(edge))
    .map(edge => edge.to));
  for (const edge of graph.flowEdges || []) if (edge.from === nodeId) affectedTargetIds.add(edge.to);
  const remainingNodes = graph.nodes.filter(candidate => candidate.id !== nodeId);
  const orderedIds = remainingNodes
    .filter(candidate => candidate.planRootId === node.planRootId && !['request', 'review'].includes(inferTaskNodeType(candidate)))
    .sort((left, right) => (left.planOrder || 0) - (right.planOrder || 0))
    .map(candidate => candidate.id);
  const orderById = new Map(orderedIds.map((id, index) => [id, index]));
  return {
    ...graph,
    nodes: remainingNodes.map(candidate => {
      const ordered = orderById.has(candidate.id)
        ? { ...candidate, planOrder: orderById.get(candidate.id) }
        : candidate;
      return affectedTargetIds.has(candidate.id) && ['agent_done', 'completed'].includes(candidate.status)
        ? { ...ordered, status: 'planned', updatedAt: Date.now() }
        : ordered;
    }),
    edges: graph.edges.filter(edge => edge.from !== nodeId && edge.to !== nodeId),
    flowEdges: (graph.flowEdges || []).filter(edge => edge.from !== nodeId && edge.to !== nodeId),
    viewState: {
      ...(graph.viewState || {}),
      positions: Object.fromEntries(Object.entries(graph.viewState?.positions || {}).filter(([id]) => id !== nodeId)),
    },
    updatedAt: Date.now(),
  };
}

export function movePlanningTask(graph, nodeId, direction) {
  const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
  if (!node || ![-1, 1].includes(direction)) return graph;
  const ordered = graph.nodes
    .filter(candidate => candidate.planRootId === node.planRootId && !['request', 'review'].includes(inferTaskNodeType(candidate)))
    .sort((left, right) => (left.planOrder || 0) - (right.planOrder || 0));
  const index = ordered.findIndex(candidate => candidate.id === nodeId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= ordered.length) return graph;
  [ordered[index], ordered[targetIndex]] = [ordered[targetIndex], ordered[index]];
  const orderById = new Map(ordered.map((candidate, order) => [candidate.id, order]));
  return {
    ...graph,
    nodes: graph.nodes.map(candidate => orderById.has(candidate.id) ? { ...candidate, planOrder: orderById.get(candidate.id), updatedAt: Date.now() } : candidate),
    updatedAt: Date.now(),
  };
}

export function splitPlanningTask(graph, nodeId) {
  const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
  if (!node || ['request', 'review'].includes(inferTaskNodeType(node))) return graph;
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const secondId = taskPlanGraphNodeId(node.planRootId, `${node.planTaskId || 'task'}-part-${suffix}`);
  const firstTitle = `${node.title} – Teil 1`;
  const secondTitle = `${node.title} – Teil 2`;
  const outgoingBlocking = graph.edges.filter(edge => edge.from === nodeId && ['dependency', 'review'].includes(edge.kind));
  let nextGraph = upsertTaskNode(graph, {
    id: nodeId,
    title: firstTitle,
    objective: firstTitle,
    ...(['agent_done', 'completed'].includes(node.status) ? { status: 'planned' } : {}),
    acceptanceCriteria: normalizeAcceptanceCriteria([], { taskId: node.planTaskId, fallbackText: `„${firstTitle}“ ist abgeschlossen.` }),
  });
  nextGraph = upsertTaskNode(nextGraph, {
    ...node,
    id: secondId,
    title: secondTitle,
    objective: secondTitle,
    status: 'planned',
    planTaskId: `${node.planTaskId || 'task'}-part-${suffix}`,
    planOrder: (node.planOrder || 0) + 0.5,
    createdAt: Date.now(),
  });
  nextGraph = {
    ...nextGraph,
    edges: nextGraph.edges.filter(edge => !(edge.from === nodeId && ['dependency', 'review'].includes(edge.kind))),
  };
  nextGraph = addTaskEdge(nextGraph, { from: nodeId, to: secondId, kind: 'dependency', planRootId: node.planRootId });
  for (const edge of outgoingBlocking) nextGraph = addTaskEdge(nextGraph, { ...edge, id: undefined, from: secondId });
  const ordered = nextGraph.nodes
    .filter(candidate => candidate.planRootId === node.planRootId && !['request', 'review'].includes(inferTaskNodeType(candidate)))
    .sort((left, right) => (left.planOrder || 0) - (right.planOrder || 0));
  const orderById = new Map(ordered.map((candidate, index) => [candidate.id, index]));
  return {
    ...nextGraph,
    nodes: nextGraph.nodes.map(candidate => orderById.has(candidate.id) ? { ...candidate, planOrder: orderById.get(candidate.id) } : candidate),
    updatedAt: Date.now(),
  };
}

function normalizedPlanTaskTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/^\s*(?:aufgabe|task|schritt|step)?\s*#?\d+[.):\-\s]+/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function planTaskIdentity(task) {
  const type = task?.type === 'review' || inferTaskNodeType(task) === 'review' ? 'review' : 'task';
  return `${type}:${normalizedPlanTaskTitle(task?.title || task?.objective)}`;
}

/**
 * Reuse an existing plan task when the PM emits the same work under a new ID,
 * and collapse duplicates inside the newly emitted plan before edges are built.
 */
export function deduplicateMaterializedPlanTasks(graph, rootNodeId, tasks = []) {
  const validTasks = tasks.filter(task => task?.id && task?.agentId && task?.agentName);
  const incomingIds = new Set(validTasks.map(task => String(task.id)));
  const existingNodes = (graph?.nodes || []).filter(node =>
    node.planRootId === rootNodeId && node.planTaskId
  );
  const existingByPlanTaskId = new Map(existingNodes.map(node => [String(node.planTaskId), node]));
  const claimedExistingIds = new Set();
  const aliases = new Map();
  const normalizedTasks = [];
  const normalizedById = new Map();
  const normalizedByIdentity = new Map();

  for (const task of validTasks) {
    const incomingId = String(task.id);
    const identity = planTaskIdentity(task);
    const exactExisting = existingByPlanTaskId.get(incomingId);
    const matchingExisting = exactExisting || existingNodes.find(node =>
      !incomingIds.has(String(node.planTaskId)) &&
      !claimedExistingIds.has(String(node.planTaskId)) &&
      planTaskIdentity(node) === identity
    );
    const canonicalId = String(matchingExisting?.planTaskId || incomingId);
    const duplicate = normalizedById.get(canonicalId) || normalizedByIdentity.get(identity);

    if (duplicate) {
      aliases.set(incomingId, duplicate.id);
      duplicate.dependsOn = [...new Set([...(duplicate.dependsOn || []), ...(task.dependsOn || [])])];
      if (!duplicate.parentId && task.parentId) duplicate.parentId = task.parentId;
      continue;
    }

    const reusesExistingIdentity = Boolean(matchingExisting && !exactExisting && planTaskIdentity(matchingExisting) === identity);
    const normalizedTask = {
      ...task,
      id: canonicalId,
      ...(reusesExistingIdentity ? {
        title: matchingExisting.title,
        objective: matchingExisting.objective || matchingExisting.title,
      } : {}),
    };
    aliases.set(incomingId, canonicalId);
    normalizedTasks.push(normalizedTask);
    normalizedById.set(canonicalId, normalizedTask);
    if (identity.endsWith(':') === false) normalizedByIdentity.set(identity, normalizedTask);
    if (matchingExisting) claimedExistingIds.add(canonicalId);
  }

  return normalizedTasks.map(task => ({
    ...task,
    ...(task.parentId ? { parentId: aliases.get(String(task.parentId)) || String(task.parentId) } : {}),
    dependsOn: [...new Set((task.dependsOn || [])
      .map(dependencyId => aliases.get(String(dependencyId)) || String(dependencyId))
      .filter(dependencyId => dependencyId && dependencyId !== task.id))],
  }));
}

/**
 * Materialize a de-duplicated PM draft while preserving runtime state only for
 * an unchanged task contract. A PM may replace a user-owned draft only through
 * the explicit planning-revision path; an actively approved plan is immutable.
 */
export function materializeTaskPlan(graph, {
  rootNodeId,
  tasks = [],
  replace = false,
  allowPlanningRevision = false,
} = {}) {
  if (!graph || !rootNodeId || !tasks.length) return graph;
  const mayReviseUserDraft = Boolean(
    allowPlanningRevision && replace && graph.workflowState === 'planning'
  );
  if (graph.approvedPlan) return graph;
  if ((graph.planOwner === 'user' || graph.previousApprovedPlan) && !mayReviseUserDraft) return graph;
  const materializedTasks = deduplicateMaterializedPlanTasks(graph, rootNodeId, tasks);
  if (!materializedTasks.length) return graph;
  let nextGraph = graph;

  if (replace) {
    const retainedPlanTaskIds = new Set(materializedTasks.map(task => taskPlanGraphNodeId(rootNodeId, task.id)));
    const removedNodeIds = new Set(graph.nodes
      .filter(node => node.planRootId === rootNodeId && node.planTaskId && !retainedPlanTaskIds.has(node.id))
      .map(node => node.id));
    if (removedNodeIds.size > 0) {
      nextGraph = {
        ...graph,
        nodes: graph.nodes.filter(node => !removedNodeIds.has(node.id)),
        edges: graph.edges.filter(edge => !removedNodeIds.has(edge.from) && !removedNodeIds.has(edge.to) && edge.planRootId !== rootNodeId),
        viewState: {
          ...(graph.viewState || {}),
          positions: Object.fromEntries(Object.entries(graph.viewState?.positions || {})
            .filter(([nodeId]) => !removedNodeIds.has(nodeId))),
        },
        updatedAt: Date.now(),
      };
    }
    nextGraph = {
      ...nextGraph,
      edges: nextGraph.edges.filter(edge => edge.planRootId !== rootNodeId),
      workflowState: 'planning',
      planRevision: (graph.planRevision || 0) + 1,
      approvedPlan: null,
      updatedAt: Date.now(),
    };
  }

  for (const task of materializedTasks) {
    const nodeId = taskPlanGraphNodeId(rootNodeId, task.id);
    const existing = nextGraph.nodes.find(node => node.id === nodeId);
    const parentNodeId = task.type === 'review'
      ? null
      : task.parentId
        ? taskPlanGraphNodeId(rootNodeId, task.parentId)
        : rootNodeId;
    const normalizedCriteria = normalizeAcceptanceCriteria(task.acceptanceCriteria, {
      taskId: task.id,
      fallbackText: task.type === 'review' ? '' : `Das Ergebnis erfüllt die Aufgabe „${task.title}“.`,
    });
    const normalizedDelegation = normalizeDelegationPolicy(task.delegation);
    const plannedNodeType = task.type === 'review' ? 'review' : 'task';
    const plannedModelOverride = existing?.agentId === task.agentId ? existing.modelOverride : undefined;
    const contractUnchanged = Boolean(existing) &&
      String(existing.title || '') === String(task.title || '') &&
      String(existing.objective || existing.title || '') === String(task.title || '') &&
      existing.agentId === task.agentId &&
      inferTaskNodeType(existing) === plannedNodeType &&
      (existing.modelOverride || '') === (plannedModelOverride || '') &&
      JSON.stringify(acceptanceContract(existing.acceptanceCriteria)) === JSON.stringify(acceptanceContract(normalizedCriteria)) &&
      JSON.stringify(normalizeDelegationPolicy(existing.delegation)) === JSON.stringify(normalizedDelegation);
    const node = {
      id: nodeId,
      title: task.title,
      objective: task.title,
      agentId: task.agentId,
      agentName: task.agentName,
      status: contractUnchanged ? existing.status : 'planned',
      source: 'PM-Plan',
      nodeType: plannedNodeType,
      modelOverride: plannedModelOverride,
      planRootId: rootNodeId,
      planTaskId: task.id,
      planOrder: task.order || 0,
      requestedAgentName: task.requestedAgentName || task.agentName,
      acceptanceCriteria: contractUnchanged
        ? mergeAcceptanceCriteria(existing?.acceptanceCriteria, normalizedCriteria)
        : normalizedCriteria,
      delegation: normalizedDelegation,
      createdAt: existing?.createdAt || Date.now() + (task.order || 0),
      ...(!contractUnchanged ? {
        preparationAttemptedAt: undefined,
        preparationCompletedAt: undefined,
        preparationFailedAt: undefined,
        preparationError: undefined,
        interimResult: undefined,
        interimSavedAt: undefined,
        interimConsumedAt: undefined,
        preparedFiles: undefined,
      } : {}),
    };
    if (parentNodeId) node.parentNodeId = parentNodeId;
    nextGraph = upsertTaskNode(nextGraph, node);
  }

  const nodeIds = new Set(nextGraph.nodes.map(node => node.id));
  for (const task of materializedTasks) {
    const nodeId = taskPlanGraphNodeId(rootNodeId, task.id);
    if (!nodeIds.has(nodeId)) continue;
    const dependencyIds = (task.dependsOn || [])
      .map(planTaskId => taskPlanGraphNodeId(rootNodeId, planTaskId))
      .filter(dependencyId => nodeIds.has(dependencyId));
    if (task.type === 'review') {
      if (dependencyIds.length) {
        nextGraph = dependencyIds.reduce((current, dependencyId) =>
          addTaskEdge(current, { from: dependencyId, to: nodeId, kind: 'review', planRootId: rootNodeId }),
        nextGraph);
      } else {
        nextGraph = addTaskEdge(nextGraph, { from: rootNodeId, to: nodeId, kind: 'delegation', planRootId: rootNodeId });
      }
      continue;
    }

    const parentNodeId = task.parentId
      ? taskPlanGraphNodeId(rootNodeId, task.parentId)
      : rootNodeId;
    if (nodeIds.has(parentNodeId) && parentNodeId !== rootNodeId) {
      nextGraph = addTaskEdge(nextGraph, { from: parentNodeId, to: nodeId, kind: 'delegation', planRootId: rootNodeId });
    }
    nextGraph = dependencyIds.reduce((current, dependencyId) =>
      addTaskEdge(current, { from: dependencyId, to: nodeId, kind: 'dependency', planRootId: rootNodeId }),
    nextGraph);
  }
  return {
    ...nextGraph,
    planOwner: nextGraph.planOwner === 'user' ? 'user' : 'pm-draft',
  };
}

export function addTaskEdge(graph, edge) {
  if (!edge?.from || !edge?.to || edge.from === edge.to) return graph;
  const kind = edge.kind || 'delegation';
  const exists = graph.edges.some(candidate =>
    candidate.from === edge.from && candidate.to === edge.to && candidate.kind === kind
  );
  if (exists) return graph;
  return {
    ...graph,
    edges: [...graph.edges, { id: edge.id || `${kind}:${edge.from}->${edge.to}`, kind, ...edge }],
    updatedAt: Date.now(),
  };
}

function directedPathExists(graph, startNodeId, targetNodeId) {
  const outgoing = new Map();
  for (const edge of workflowTopologyEdges(graph)) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = [startNodeId];
  const visited = new Set();
  while (queue.length > 0) {
    const nodeId = queue.shift();
    if (nodeId === targetNodeId) return true;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    queue.push(...(outgoing.get(nodeId) || []));
  }
  return false;
}

export function validateTaskDependency(graph, prerequisiteId, taskId) {
  const endpointIds = new Set([
    ...(graph?.nodes || []).map(node => node.id),
    ...(graph?.flowPoints || []).map(point => point.id),
  ]);
  if (!endpointIds.has(prerequisiteId) || !endpointIds.has(taskId)) {
    return { ok: false, reason: 'Workflow-Element wurde nicht gefunden.', messageKey: 'Workflow-Element wurde nicht gefunden.' };
  }
  if (prerequisiteId === taskId) {
    return { ok: false, reason: 'Eine Aufgabe kann nicht von sich selbst abhängen.', messageKey: 'Eine Aufgabe kann nicht von sich selbst abhängen.' };
  }
  const usesFlowPoint = (graph.flowPoints || []).some(point => point.id === prerequisiteId || point.id === taskId);
  const exists = usesFlowPoint
    ? (graph.flowEdges || []).some(edge => edge.from === prerequisiteId && edge.to === taskId)
    : (graph.edges || []).some(edge => edge.from === prerequisiteId && edge.to === taskId && edge.kind === 'dependency');
  if (exists) return { ok: true, exists: true };
  if (directedPathExists(graph, taskId, prerequisiteId)) {
    return { ok: false, reason: 'Diese Abhängigkeit würde einen Zyklus erzeugen.', messageKey: 'Diese Abhängigkeit würde einen Zyklus erzeugen.' };
  }
  return { ok: true, exists: false };
}

export function addTaskDependency(graph, prerequisiteId, taskId) {
  const validation = validateTaskDependency(graph, prerequisiteId, taskId);
  if (!validation.ok || validation.exists) return graph;
  const usesFlowPoint = (graph.flowPoints || []).some(point => point.id === prerequisiteId || point.id === taskId);
  if (usesFlowPoint) {
    return {
      ...graph,
      flowEdges: [...(graph.flowEdges || []), {
        id: `flow:${prerequisiteId}->${taskId}`,
        kind: 'flow',
        from: prerequisiteId,
        to: taskId,
      }],
      updatedAt: Date.now(),
    };
  }
  return addTaskEdge(graph, { from: prerequisiteId, to: taskId, kind: 'dependency' });
}

export function validateWorkflowConnection(graph, prerequisiteId, taskId, requestedKind = 'dependency') {
  const usesFlowPoint = (graph?.flowPoints || []).some(point => point.id === prerequisiteId || point.id === taskId);
  const kind = usesFlowPoint ? 'flow' : requestedKind === 'review' ? 'review' : 'dependency';
  if (kind === 'dependency' || kind === 'flow') {
    const validation = validateTaskDependency(graph, prerequisiteId, taskId);
    return { ...validation, kind };
  }
  const source = graph?.nodes?.find(node => node.id === prerequisiteId);
  const target = graph?.nodes?.find(node => node.id === taskId);
  if (!source || !target) return { ok: false, kind, reason: 'Workflow-Element wurde nicht gefunden.', messageKey: 'Workflow-Element wurde nicht gefunden.' };
  if (inferTaskNodeType(source) === 'review') return { ok: false, kind, reason: 'Eine Abnahme kann keine weitere Abnahme starten.', messageKey: 'Eine Abnahme kann keine weitere Abnahme starten.' };
  if (inferTaskNodeType(target) !== 'review') return { ok: false, kind, reason: 'Eine Abnahme-Verbindung benötigt einen Prüfschritt als Ziel.', messageKey: 'Eine Abnahme-Verbindung benötigt einen Prüfschritt als Ziel.' };
  const exists = (graph.edges || []).some(edge => edge.from === prerequisiteId && edge.to === taskId && edge.kind === 'review');
  if (exists) return { ok: true, exists: true, kind };
  if (directedPathExists(graph, taskId, prerequisiteId)) {
    return { ok: false, kind, reason: 'Diese Verbindung würde einen Zyklus erzeugen.', messageKey: 'Diese Verbindung würde einen Zyklus erzeugen.' };
  }
  return { ok: true, exists: false, kind };
}

export function addWorkflowConnection(graph, prerequisiteId, taskId, requestedKind = 'dependency') {
  const validation = validateWorkflowConnection(graph, prerequisiteId, taskId, requestedKind);
  if (!validation.ok || validation.exists) return graph;
  if (validation.kind === 'flow' || validation.kind === 'dependency') return addTaskDependency(graph, prerequisiteId, taskId);
  return addTaskEdge(graph, { from: prerequisiteId, to: taskId, kind: 'review' });
}

export function removeWorkflowConnection(graph, prerequisiteId, taskId, requestedKind = 'dependency') {
  if (!graph) return graph;
  if (requestedKind === 'flow') return removeTaskDependency(graph, prerequisiteId, taskId);
  const edges = (graph.edges || []).filter(edge => !(
    edge.from === prerequisiteId && edge.to === taskId && edge.kind === requestedKind
  ));
  if (edges.length === (graph.edges || []).length) return graph;
  return { ...graph, edges, updatedAt: Date.now() };
}

export function removeTaskDependency(graph, prerequisiteId, taskId) {
  if (!graph) return graph;
  const flowEdges = (graph.flowEdges || []).filter(edge => !(edge.from === prerequisiteId && edge.to === taskId));
  const edges = graph.edges.filter(edge => !(
    edge.from === prerequisiteId && edge.to === taskId && edge.kind === 'dependency'
  ));
  if (edges.length === graph.edges.length && flowEdges.length === (graph.flowEdges || []).length) return graph;
  return { ...graph, edges, flowEdges, updatedAt: Date.now() };
}

export function inferTaskNodeType(node = {}) {
  if (node.nodeType) return node.nodeType;
  if (node.source === 'team-synthesis') return 'review';
  if (String(node.source || '').startsWith('timeout-recovery')) return 'recovery';
  if (node.source === 'user-answer') return 'continuation';
  if (node.source === 'user' && !node.parentNodeId) return 'request';
  return 'task';
}

export function isWorkflowBlockingEdge(edge = {}) {
  return edge.kind === 'dependency' || edge.kind === 'review';
}

export function workflowTopologyEdges(graph) {
  return [
    ...(graph?.edges || []).filter(isWorkflowBlockingEdge),
    ...(graph?.flowEdges || []).map(edge => ({ ...edge, kind: 'flow' })),
  ];
}

/** Return every task whose result can reach the target through blocking workflow edges. */
export function workflowDependencyAncestorIds(graph, nodeId) {
  const nodeIds = new Set((graph?.nodes || []).map(node => node.id));
  if (!nodeIds.has(nodeId)) return new Set();
  const incomingByTarget = new Map();
  for (const edge of workflowTopologyEdges(graph)) {
    if (!incomingByTarget.has(edge.to)) incomingByTarget.set(edge.to, []);
    incomingByTarget.get(edge.to).push(edge.from);
  }
  const ancestors = new Set();
  const visitedEndpoints = new Set([nodeId]);
  const pendingEndpoints = [nodeId];
  while (pendingEndpoints.length > 0) {
    const endpointId = pendingEndpoints.pop();
    for (const sourceId of incomingByTarget.get(endpointId) || []) {
      if (nodeIds.has(sourceId)) ancestors.add(sourceId);
      if (visitedEndpoints.has(sourceId)) continue;
      visitedEndpoints.add(sourceId);
      pendingEndpoints.push(sourceId);
    }
  }
  return ancestors;
}

const TREE_TYPE_ORDER = { request: 0, task: 1, continuation: 2, recovery: 3, review: 4 };

function compareTreeNodes(left, right) {
  const typeDifference = (TREE_TYPE_ORDER[inferTaskNodeType(left)] ?? 2) -
    (TREE_TYPE_ORDER[inferTaskNodeType(right)] ?? 2);
  const planOrderDifference = left.planRootId && left.planRootId === right.planRootId
    ? (left.planOrder || 0) - (right.planOrder || 0)
    : 0;
  return typeDifference || planOrderDifference || (left.createdAt || 0) - (right.createdAt || 0) ||
    String(left.title || '').localeCompare(String(right.title || ''), 'de');
}

function wouldCreateTreeCycle(primaryParentByNode, nodeId, parentId) {
  let current = parentId;
  const visited = new Set();
  while (current && !visited.has(current)) {
    if (current === nodeId) return true;
    visited.add(current);
    current = primaryParentByNode.get(current) || null;
  }
  return false;
}

function lowestCommonTreeAncestor(nodeIds, primaryParentByNode) {
  const uniqueIds = [...new Set(nodeIds || [])].filter(Boolean);
  if (!uniqueIds.length) return null;
  const chains = uniqueIds.map(nodeId => {
    const chain = [];
    const visited = new Set();
    let current = nodeId;
    while (current && !visited.has(current)) {
      chain.push(current);
      visited.add(current);
      current = primaryParentByNode.get(current) || null;
    }
    return chain;
  });
  return chains[0].find(candidate => chains.every(chain => chain.includes(candidate))) || null;
}

/**
 * Project the persisted DAG into one deterministic display tree. Delegation is
 * the hierarchy; dependencies and multi-result reviews remain visible as
 * auxiliary links instead of moving a task into the wrong agent branch.
 */
export function projectTaskTree(graph) {
  const nodes = [...(graph?.nodes || [])].sort(compareTreeNodes);
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const validEdges = (graph?.edges || []).filter(edge => nodeById.has(edge.from) && nodeById.has(edge.to));
  const incomingByNode = new Map(nodes.map(node => [node.id, []]));
  for (const edge of validEdges) incomingByNode.get(edge.to).push(edge);

  const primaryParentByNode = new Map();
  const legacyDependencyByNode = new Map();

  for (const node of nodes.filter(candidate => inferTaskNodeType(candidate) !== 'review')) {
    const incoming = incomingByNode.get(node.id) || [];
    const explicitParent = node.parentNodeId && nodeById.has(node.parentNodeId)
      ? node.parentNodeId
      : null;
    const structuralEdge = incoming.find(edge => !['dependency', 'review'].includes(edge.kind));
    let parentId = explicitParent || structuralEdge?.from || null;

    // Legacy graphs stored a PM-created sequential dependency as a handoff
    // parent. Move the child back below the PM plan and retain the old edge as
    // an auxiliary dependency.
    if (parentId && (structuralEdge?.kind === 'handoff' || !structuralEdge?.kind)) {
      const parentNode = nodeById.get(parentId);
      const grandParentId = primaryParentByNode.get(parentId);
      const grandParent = nodeById.get(grandParentId);
      if (
        node.source &&
        parentNode?.agentName &&
        node.source !== parentNode.agentName &&
        grandParent?.agentName === node.source
      ) {
        legacyDependencyByNode.set(node.id, parentId);
        parentId = grandParentId;
      }
    }

    if (parentId && !wouldCreateTreeCycle(primaryParentByNode, node.id, parentId)) {
      primaryParentByNode.set(node.id, parentId);
    }
  }

  // A review of several sibling results belongs below their common PM plan,
  // while every reviewed result remains visible as an auxiliary review link.
  for (const node of nodes.filter(candidate => inferTaskNodeType(candidate) === 'review')) {
    const incoming = incomingByNode.get(node.id) || [];
    const reviewSources = incoming
      .filter(edge => edge.kind === 'review')
      .map(edge => edge.from);
    const allSources = reviewSources.length ? reviewSources : incoming.map(edge => edge.from);
    let parentId = lowestCommonTreeAncestor(allSources, primaryParentByNode);
    if (!parentId && allSources.length === 1) parentId = allSources[0];
    if (!parentId && node.parentNodeId && nodeById.has(node.parentNodeId)) parentId = node.parentNodeId;
    if (parentId && !wouldCreateTreeCycle(primaryParentByNode, node.id, parentId)) {
      primaryParentByNode.set(node.id, parentId);
    }
  }

  const childrenByParent = new Map(nodes.map(node => [node.id, []]));
  const roots = [];
  for (const node of nodes) {
    const parentId = primaryParentByNode.get(node.id);
    if (parentId && childrenByParent.has(parentId)) childrenByParent.get(parentId).push(node);
    else roots.push(node);
  }
  roots.sort(compareTreeNodes);
  for (const children of childrenByParent.values()) children.sort(compareTreeNodes);

  const metadataByNode = new Map(nodes.map(node => {
    const incoming = incomingByNode.get(node.id) || [];
    const primaryParentId = primaryParentByNode.get(node.id) || null;
    const dependencyIds = incoming
      .filter(edge => edge.kind === 'dependency')
      .map(edge => edge.from);
    const legacyDependencyId = legacyDependencyByNode.get(node.id);
    if (legacyDependencyId) dependencyIds.push(legacyDependencyId);
    const reviewSourceIds = incoming
      .filter(edge => edge.kind === 'review' || (inferTaskNodeType(node) === 'review' && edge.from !== primaryParentId))
      .map(edge => edge.from);
    return [node.id, {
      primaryParentId,
      dependencyIds: [...new Set(dependencyIds)],
      reviewSourceIds: [...new Set(reviewSourceIds)],
    }];
  }));

  return { roots, childrenByParent, primaryParentByNode, metadataByNode, nodeById };
}

function restoreApprovedConnections(graph) {
  if (!graph?.approvedPlan) return graph;
  const edgeKey = edge => `${edge.kind || 'delegation'}:${edge.from}->${edge.to}`;
  const currentEdges = new Map((graph.edges || []).map(edge => [edgeKey(edge), edge]));
  for (const edge of graph.approvedPlan.edges || []) {
    if (!currentEdges.has(edgeKey(edge))) currentEdges.set(edgeKey(edge), { ...edge });
  }
  const currentFlowEdges = new Map((graph.flowEdges || []).map(edge => [`${edge.from}->${edge.to}`, edge]));
  for (const edge of graph.approvedPlan.flowEdges || []) {
    const key = `${edge.from}->${edge.to}`;
    if (!currentFlowEdges.has(key)) currentFlowEdges.set(key, { ...edge });
  }
  return {
    ...graph,
    edges: [...currentEdges.values()],
    flowEdges: [...currentFlowEdges.values()],
  };
}

export function updateTaskNodeStatus(graph, nodeId, status, extra = {}) {
  if (!graph?.nodes?.some(node => node.id === nodeId)) return graph;
  const graphWithConnections = restoreApprovedConnections(graph);
  return {
    ...graphWithConnections,
    nodes: graphWithConnections.nodes.map(node => node.id === nodeId
      ? { ...node, status, ...extra, updatedAt: Date.now() }
      : node),
    updatedAt: Date.now(),
  };
}

export function submitTaskEvidence(graph, nodeId, submissions = [], { author = 'Agent', fallbackSummary = '', kind = 'agent' } = {}) {
  const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
  if (!node?.acceptanceCriteria?.length) return graph;
  const submittedByCriterion = new Map();
  for (const submission of Array.isArray(submissions) ? submissions.slice(0, 20) : []) {
    const criterionId = normalizeAcceptanceId(submission?.criterionId || submission?.id);
    const summary = String(submission?.summary || submission?.evidence || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
    if (!criterionId || !summary) continue;
    submittedByCriterion.set(criterionId, {
      summary,
      kind: String(submission?.kind || kind).slice(0, 40),
    });
  }
  const fallback = String(fallbackSummary || '').replace(/\s+/g, ' ').trim().slice(0, 1200);
  const createdAt = Date.now();
  return {
    ...graph,
    version: Math.max(2, Number(graph.version) || 1),
    nodes: graph.nodes.map(candidate => {
      if (candidate.id !== nodeId) return candidate;
      const acceptanceCriteria = candidate.acceptanceCriteria.map(criterion => {
        const submission = submittedByCriterion.get(criterion.id) || (fallback ? { summary: fallback, kind } : null);
        if (!submission) return criterion;
        const evidence = [...(criterion.evidence || []), {
          id: `${criterion.id}-evidence-${createdAt}-${Math.random().toString(36).slice(2, 6)}`,
          summary: submission.summary,
          kind: submission.kind,
          author: String(author || 'Agent').slice(0, 80),
          createdAt,
        }].slice(-8);
        return {
          ...criterion,
          status: ACCEPTED_CRITERION_STATUSES.has(criterion.status) ? criterion.status : 'submitted',
          evidence,
        };
      });
      return { ...candidate, acceptanceCriteria, updatedAt: createdAt };
    }),
    updatedAt: createdAt,
  };
}

export function applyAcceptanceDecisions(graph, decisions = [], { reviewer = 'PM', userOnly = false } = {}) {
  if (!graph || !Array.isArray(decisions) || !decisions.length) return graph;
  const reviewedAt = Date.now();
  const decisionsByTask = new Map();
  for (const decision of decisions.slice(0, 100)) {
    const taskId = String(decision?.taskId || '').trim();
    const criterionId = normalizeAcceptanceId(decision?.criterionId || decision?.id);
    const status = ['passed', 'failed', 'waived'].includes(decision?.status) ? decision.status : '';
    if (!taskId || !criterionId || !status) continue;
    if (!decisionsByTask.has(taskId)) decisionsByTask.set(taskId, new Map());
    decisionsByTask.get(taskId).set(criterionId, {
      status,
      note: String(decision?.note || '').replace(/\s+/g, ' ').trim().slice(0, 600),
    });
  }
  if (!decisionsByTask.size) return graph;
  const nodes = graph.nodes.map(node => {
    const taskDecisions = decisionsByTask.get(node.id) || decisionsByTask.get(node.planTaskId);
    if (!taskDecisions || !node.acceptanceCriteria?.length) return node;
    let changed = false;
    const acceptanceCriteria = node.acceptanceCriteria.map(criterion => {
      const decision = taskDecisions.get(criterion.id);
      if (!decision || (userOnly && criterion.verification !== 'user') || (!userOnly && criterion.verification === 'user')) return criterion;
      changed = true;
      const evidence = decision.note ? [...(criterion.evidence || []), {
        id: `${criterion.id}-review-${reviewedAt}`,
        summary: decision.note,
        kind: userOnly ? 'user-review' : 'review',
        author: String(reviewer || 'PM').slice(0, 80),
        createdAt: reviewedAt,
      }].slice(-8) : criterion.evidence;
      return {
        ...criterion,
        status: decision.status,
        evidence,
        reviewedBy: String(reviewer || 'PM').slice(0, 80),
        reviewedAt,
      };
    });
    if (!changed) return node;
    const accepted = requiredCriteriaAccepted(acceptanceCriteria);
    const failed = acceptanceCriteria.some(criterion => criterion.required !== false && criterion.status === 'failed');
    const reviewableStatus = ['agent_done', 'blocked', 'completed'].includes(node.status);
    return {
      ...node,
      acceptanceCriteria,
      ...(accepted && reviewableStatus ? { status: 'completed', pmApprovedAt: reviewedAt, acceptanceBlocked: false } : {}),
      ...(failed && reviewableStatus ? { status: 'blocked', acceptanceBlocked: true } : {}),
      updatedAt: reviewedAt,
    };
  });
  return { ...graph, version: Math.max(2, Number(graph.version) || 1), nodes, updatedAt: reviewedAt };
}

export function summarizeAcceptance(graph, planRootId = null) {
  const nodes = (graph?.nodes || []).filter(node =>
    inferTaskNodeType(node) !== 'review' && (!planRootId || node.planRootId === planRootId)
  );
  const criteria = nodes.flatMap(node => (node.acceptanceCriteria || []).map(criterion => ({ node, criterion })));
  const required = criteria.filter(item => item.criterion.required !== false);
  const unmet = required.filter(item => !ACCEPTED_CRITERION_STATUSES.has(item.criterion.status));
  return {
    total: criteria.length,
    required: required.length,
    passed: required.length - unmet.length,
    submitted: required.filter(item => item.criterion.status === 'submitted').length,
    failed: required.filter(item => item.criterion.status === 'failed').length,
    userPending: unmet.filter(item => item.criterion.verification === 'user').length,
    ready: unmet.length === 0,
    unmet: unmet.map(item => ({
      taskId: item.node.planTaskId || item.node.id,
      nodeId: item.node.id,
      taskTitle: item.node.title,
      criterionId: item.criterion.id,
      text: item.criterion.text,
      status: item.criterion.status,
      verification: item.criterion.verification,
    })),
  };
}

export function approveAgentDoneTasks(graph) {
  if (!graph) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map(node => node.status === 'agent_done' && requiredCriteriaAccepted(node.acceptanceCriteria || [])
      ? { ...node, status: 'completed', pmApprovedAt: Date.now(), updatedAt: Date.now() }
      : node),
    updatedAt: Date.now(),
  };
}

function referencedFiles(value) {
  const matches = String(value || '').match(/[A-Za-z0-9_.\-/\\]+\.(?:js|jsx|ts|tsx|css|scss|html|json|md|py|go|rs|java|sql|yaml|yml)/gi) || [];
  return new Set(matches.map(match => match.replace(/\\/g, '/').toLowerCase()));
}

function hasPath(graph, from, to) {
  const visited = new Set();
  const stack = [from];
  while (stack.length) {
    const current = stack.pop();
    if (current === to) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const edge of workflowTopologyEdges(graph).filter(candidate => candidate.from === current)) stack.push(edge.to);
  }
  return false;
}

function upstreamTaskNodeIds(graph, endpointId, visited = new Set()) {
  if (visited.has(endpointId)) return new Set();
  visited.add(endpointId);
  const pointIds = new Set((graph?.flowPoints || []).map(point => point.id));
  const result = new Set();
  for (const edge of workflowTopologyEdges(graph).filter(candidate => candidate.to === endpointId)) {
    if (pointIds.has(edge.from)) {
      for (const taskId of upstreamTaskNodeIds(graph, edge.from, visited)) result.add(taskId);
    } else {
      result.add(edge.from);
    }
  }
  return result;
}

export function isTaskNodeReady(graph, nodeId) {
  const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
  if (!node || !ELIGIBLE_PARALLEL_STATUSES.has(node.status)) return false;
  const parentIds = [...upstreamTaskNodeIds(graph, nodeId)];
  return parentIds.every(parentId => {
    const parent = graph.nodes.find(candidate => candidate.id === parentId);
    return parent && FINISHED_DEPENDENCY_STATUSES.has(parent.status);
  });
}

/**
 * Finds approved tasks that can do bounded, dependency-independent preparation
 * while a direct predecessor is still running. A task is offered at most once;
 * completion still requires the unchanged dependency graph.
 */
export function findDependencyPreparationCandidateIds(graph, {
  activeNodeIds = [],
  activeAgentIds = [],
  queuedNodeIds = [],
  limit = 2,
} = {}) {
  if (!graph?.approvedPlan || limit <= 0) return [];
  const activeNodes = new Set(activeNodeIds);
  const occupiedAgents = new Set(activeAgentIds);
  const queuedNodes = new Set(queuedNodeIds);
  const candidates = [];
  for (const node of [...(graph.nodes || [])].sort((left, right) => (left.planOrder || 0) - (right.planOrder || 0))) {
    if (candidates.length >= limit) break;
    if (
      inferTaskNodeType(node) !== 'task' ||
      node.runtimeRecovery ||
      !PREPARATION_CANDIDATE_STATUSES.has(node.status) ||
      node.preparationAttemptedAt ||
      node.preparationCompletedAt ||
      queuedNodes.has(node.id) ||
      !node.agentId ||
      occupiedAgents.has(node.agentId)
    ) continue;
    const unfinishedParentIds = [...upstreamTaskNodeIds(graph, node.id)].filter(parentId => {
      const parent = graph.nodes.find(candidate => candidate.id === parentId);
      return !parent || !FINISHED_DEPENDENCY_STATUSES.has(parent.status);
    });
    if (!unfinishedParentIds.length || !unfinishedParentIds.some(parentId => activeNodes.has(parentId))) continue;
    const candidateFiles = referencedFiles(node.objective || node.title);
    const conflictsWithActiveTask = [...activeNodes].some(activeNodeId => {
      const activeNode = graph.nodes.find(candidate => candidate.id === activeNodeId);
      if (!activeNode) return false;
      const activeFiles = referencedFiles(activeNode.objective || activeNode.title);
      return [...candidateFiles].some(file => activeFiles.has(file));
    });
    if (conflictsWithActiveTask) continue;
    candidates.push(node.id);
    occupiedAgents.add(node.agentId);
  }
  return candidates;
}

export function inferHandoffDependency(summary, earlierTasks = []) {
  if (!earlierTasks.length) return null;
  const text = String(summary || '');
  const hasSequentialCue = /\b(?:danach|anschließend|anschliessend|nachdem|auf\s+basis|baut\s+auf|after|afterwards|subsequently|once\s+.+\s+is\s+done)\b/i.test(text);
  if (!hasSequentialCue) return null;
  const explicitlyNamed = [...earlierTasks].reverse().find(task =>
    task?.agent?.name && new RegExp(`\\b${task.agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)
  );
  return (explicitlyNamed || earlierTasks.at(-1))?.graphNodeId || null;
}

export function validateParallelSelection(graph, nodeIds) {
  const selectedIds = [...new Set(nodeIds || [])];
  const nodes = selectedIds.map(id => graph?.nodes?.find(node => node.id === id)).filter(Boolean);
  if (nodes.length < 2) return { ok: false, reason: 'Wähle mindestens zwei Aufgaben aus.', messageKey: 'Wähle mindestens zwei Aufgaben aus.' };
  const nonExecutable = nodes.find(node => ['request', 'review'].includes(inferTaskNodeType(node)));
  if (nonExecutable) return { ok: false, reason: `„${nonExecutable.title}“ ist keine parallel ausführbare Fachaufgabe.`, messageKey: '„{title}“ ist keine parallel ausführbare Fachaufgabe.', messageValues: { title: nonExecutable.title } };
  const invalid = nodes.find(node => !ELIGIBLE_PARALLEL_STATUSES.has(node.status));
  if (invalid) return { ok: false, reason: `„${invalid.title}“ ist nicht startbereit.`, messageKey: '„{title}“ ist nicht startbereit.', messageValues: { title: invalid.title } };
  const waitingForDependency = nodes.find(node => !isTaskNodeReady(graph, node.id));
  if (waitingForDependency) {
    return { ok: false, reason: `„${waitingForDependency.title}“ wartet noch auf eine vorherige Aufgabe.`, messageKey: '„{title}“ wartet noch auf eine vorherige Aufgabe.', messageValues: { title: waitingForDependency.title } };
  }
  const agentIds = nodes.map(node => node.agentId).filter(Boolean);
  if (new Set(agentIds).size !== agentIds.length) {
    return { ok: false, reason: 'Ein Agent kann nicht zwei Aufgaben gleichzeitig bearbeiten.', messageKey: 'Ein Agent kann nicht zwei Aufgaben gleichzeitig bearbeiten.' };
  }

  for (let left = 0; left < nodes.length; left += 1) {
    for (let right = left + 1; right < nodes.length; right += 1) {
      if (hasPath(graph, nodes[left].id, nodes[right].id) || hasPath(graph, nodes[right].id, nodes[left].id)) {
        return { ok: false, reason: 'Ausgewählte Aufgaben hängen voneinander ab.', messageKey: 'Ausgewählte Aufgaben hängen voneinander ab.' };
      }
      const leftFiles = referencedFiles(nodes[left].objective || nodes[left].title);
      const rightFiles = referencedFiles(nodes[right].objective || nodes[right].title);
      if ([...leftFiles].some(file => rightFiles.has(file))) {
        return {
          ok: false,
          reason: `Möglicher Dateikonflikt zwischen „${nodes[left].title}“ und „${nodes[right].title}“.`,
          messageKey: 'Möglicher Dateikonflikt zwischen „{left}“ und „{right}“.',
          messageValues: { left: nodes[left].title, right: nodes[right].title },
        };
      }
    }
  }
  return { ok: true, nodes };
}

export function validateWorkflowPlan(graph) {
  const nodes = graph?.nodes || [];
  const flowPoints = graph?.flowPoints || [];
  const nodeIds = new Set([...nodes.map(node => node.id), ...flowPoints.map(point => point.id)]);
  const executable = nodes.filter(node => !['request', 'review'].includes(inferTaskNodeType(node)));
  const assignedNodes = nodes.filter(node => inferTaskNodeType(node) !== 'request');
  if (!executable.length) {
    return { ok: false, reason: 'Der Workflow enthält keine ausführbare Aufgabe.', messageKey: 'Der Workflow enthält keine ausführbare Aufgabe.' };
  }
  const reviewNodes = nodes.filter(node => inferTaskNodeType(node) === 'review');
  const incomplete = assignedNodes.find(node => !node.title?.trim() || !node.agentId);
  if (incomplete) {
    return { ok: false, reason: `„${incomplete.title || incomplete.id}“ benötigt ein Ziel und einen Agenten.`, messageKey: '„{title}“ benötigt ein Ziel und einen Agenten.', messageValues: { title: incomplete.title || incomplete.id }, taskIds: [incomplete.id] };
  }
  const incompleteDelegation = executable.find(node => {
    const delegation = normalizeDelegationPolicy(node.delegation);
    return delegation.mode !== 'never' && delegation.requiredCapabilities.length === 0;
  });
  if (incompleteDelegation) {
    return {
      ok: false,
      reason: `„${incompleteDelegation.title}“ benötigt für die Delegation mindestens eine Fähigkeit.`,
      messageKey: '„{title}“ benötigt für die Delegation mindestens eine Fähigkeit.',
      messageValues: { title: incompleteDelegation.title },
      taskIds: [incompleteDelegation.id],
    };
  }

  const blockingEdges = workflowTopologyEdges(graph);
  const danglingEdge = blockingEdges.find(edge => !nodeIds.has(edge.from) || !nodeIds.has(edge.to));
  if (danglingEdge) {
    return {
      ok: false,
      reason: 'Der Workflow enthält eine Verbindung zu einer nicht vorhandenen Aufgabe.',
      messageKey: 'Der Workflow enthält eine Verbindung zu einer nicht vorhandenen Aufgabe.',
      taskIds: [danglingEdge.from, danglingEdge.to].filter(nodeId => nodeIds.has(nodeId)),
      edgeId: danglingEdge.id,
    };
  }

  const topologyItems = [...nodes, ...flowPoints];
  const indegree = new Map(topologyItems.map(node => [node.id, 0]));
  const outgoing = new Map(topologyItems.map(node => [node.id, []]));
  for (const edge of blockingEdges) {
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const queue = topologyItems.filter(node => indegree.get(node.id) === 0).map(node => node.id);
  let visited = 0;
  while (queue.length) {
    const nodeId = queue.shift();
    visited += 1;
    for (const childId of outgoing.get(nodeId) || []) {
      indegree.set(childId, indegree.get(childId) - 1);
      if (indegree.get(childId) === 0) queue.push(childId);
    }
  }
  if (visited !== topologyItems.length) {
    const cycleTaskIds = topologyItems.filter(node => (indegree.get(node.id) || 0) > 0).map(node => node.id);
    return { ok: false, reason: 'Der Workflow enthält einen Abhängigkeitszyklus.', messageKey: 'Der Workflow enthält einen Abhängigkeitszyklus.', taskIds: cycleTaskIds };
  }

  for (const point of flowPoints) {
    const incoming = blockingEdges.filter(edge => edge.to === point.id).length;
    const outgoingCount = blockingEdges.filter(edge => edge.from === point.id).length;
    if (point.type === 'fork' && (incoming < 1 || outgoingCount < 2)) {
      return { ok: false, reason: 'Ein Fork benötigt mindestens einen Eingang und zwei Ausgänge.', messageKey: 'Ein Fork benötigt mindestens einen Eingang und zwei Ausgänge.', taskIds: [point.id] };
    }
    if (point.type === 'join' && (incoming < 2 || outgoingCount < 1)) {
      return { ok: false, reason: 'Ein Join benötigt mindestens zwei Eingänge und einen Ausgang.', messageKey: 'Ein Join benötigt mindestens zwei Eingänge und einen Ausgang.', taskIds: [point.id] };
    }
  }

  for (const reviewNode of reviewNodes) {
    if (workflowTopologyEdges(graph).some(edge => {
      const source = nodes.find(node => node.id === edge.from);
      const sourcePoint = flowPoints.find(point => point.id === edge.from);
      return edge.to === reviewNode.id && (sourcePoint || inferTaskNodeType(source) !== 'request');
    })) continue;
    return { ok: false, reason: `„${reviewNode.title}“ benötigt mindestens eine eingehende Verbindung.`, messageKey: '„{title}“ benötigt mindestens eine eingehende Verbindung.', messageValues: { title: reviewNode.title }, taskIds: [reviewNode.id] };
  }
  return { ok: true };
}

function workflowPlanRepairSuggestion(validation) {
  const suggestions = {
    'Der Workflow enthält keine ausführbare Aufgabe.': 'Lege mindestens eine ausführbare Fachaufgabe an und weise ihr einen Agenten zu.',
    '„{title}“ benötigt ein Ziel und einen Agenten.': 'Ergänze für die markierte Aufgabe einen eindeutigen Titel und einen verfügbaren Agenten.',
    '„{title}“ benötigt für die Delegation mindestens eine Fähigkeit.': 'Ergänze mindestens eine frei benannte benötigte Fähigkeit oder stelle die Delegation auf „Nie delegieren“.',
    'Der Workflow enthält eine Verbindung zu einer nicht vorhandenen Aufgabe.': 'Entferne die ungültige Verbindung oder verbinde sie erneut mit einem vorhandenen Workflow-Element.',
    'Der Workflow enthält einen Abhängigkeitszyklus.': 'Entferne mindestens eine Abhängigkeit aus dem markierten Zyklus, sodass wieder eine eindeutige Ausführungsrichtung entsteht.',
    'Ein Fork benötigt mindestens einen Eingang und zwei Ausgänge.': 'Verbinde den Fork mit einem Vorgänger und mindestens zwei unabhängigen Folgepfaden.',
    'Ein Join benötigt mindestens zwei Eingänge und einen Ausgang.': 'Verbinde den Join mit mindestens zwei Vorgängerpfaden und einer Folgeaufgabe.',
    '„{title}“ benötigt mindestens eine eingehende Verbindung.': 'Verbinde die Abnahme mit mindestens einer Aufgabe, deren Ergebnis geprüft werden soll.',
  };
  return suggestions[validation.messageKey] || 'Prüfe die markierten Workflow-Elemente und korrigiere ihre Aufgabenangaben oder Verbindungen.';
}

/** Build a read-only, deterministic feasibility report for the task window. */
export function inspectWorkflowPlan(graph) {
  const validation = validateWorkflowPlan(graph);
  const executable = (graph?.nodes || []).filter(node => !['request', 'review'].includes(inferTaskNodeType(node)));
  const reviewNodes = (graph?.nodes || []).filter(node => inferTaskNodeType(node) === 'review');
  const missingAcceptance = executable.filter(node => !(node.acceptanceCriteria || []).some(criterion => criterion.text?.trim()));
  const openExecutable = executable.filter(node => !['agent_done', 'completed'].includes(node.status));
  const readyParallelTaskIds = findSafeAutoParallelTaskIds(
    graph,
    openExecutable.map(node => ({ graphNodeId: node.id })),
  );
  const issues = validation.ok ? [] : [{
    messageKey: validation.messageKey || validation.reason,
    messageValues: validation.messageValues,
    taskIds: validation.taskIds || [],
  }];
  const warnings = [];
  const suggestions = [];
  if (!validation.ok) {
    suggestions.push({
      messageKey: workflowPlanRepairSuggestion(validation),
      messageValues: validation.messageValues,
      taskIds: validation.taskIds || [],
    });
  }
  if (missingAcceptance.length > 0) {
    warnings.push({
      messageKey: '{count} Aufgaben haben keine prüfbaren Abnahmekriterien.',
      messageValues: { count: missingAcceptance.length },
      taskIds: missingAcceptance.map(node => node.id),
    });
    suggestions.push({
      messageKey: 'Ergänze für diese Aufgaben mindestens ein konkretes, überprüfbares Abnahmekriterium.',
      taskIds: missingAcceptance.map(node => node.id),
    });
  }
  if (reviewNodes.length === 0 && executable.length > 0) {
    warnings.push({ messageKey: 'Es ist keine abschließende Abnahme eingeplant.' });
    suggestions.push({ messageKey: 'Füge bei prüfpflichtigen Ergebnissen eine Abnahme hinzu und verbinde sie mit den zu prüfenden Aufgaben.' });
  }
  if (readyParallelTaskIds.length >= 2) {
    suggestions.push({
      messageKey: '{count} startbereite Aufgaben können parallel ausgeführt werden.',
      messageValues: { count: readyParallelTaskIds.length },
      taskIds: readyParallelTaskIds,
    });
  }
  return {
    ok: validation.ok,
    issues,
    warnings,
    suggestions,
    taskIds: [...new Set([...issues, ...warnings].flatMap(entry => entry.taskIds || []))],
    readyParallelTaskIds,
  };
}

/**
 * Greedily builds the largest safe parallel batch in stable queue order.
 * Every dependency-ready task is a candidate. Resource conflicts (same agent or
 * likely same file) keep tasks in the sequential queue; dependencies are the
 * only plan-level ordering rule.
 */
export function findSafeAutoParallelTaskIds(graph, tasks = []) {
  const candidates = tasks.map(task => task?.graphNodeId).filter(nodeId => {
    const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
    return node && !['request', 'review'].includes(inferTaskNodeType(node)) && isTaskNodeReady(graph, nodeId);
  });
  let best = [];
  for (const seed of candidates) {
    const batch = [seed];
    for (const nodeId of candidates) {
      if (nodeId === seed) continue;
      if (validateParallelSelection(graph, [...batch, nodeId]).ok) batch.push(nodeId);
    }
    if (batch.length > best.length) best = batch;
  }
  return best.length >= 2 ? best : [];
}

export function orderTasksForParallelSelection(tasks, nodeIds) {
  const selectedIds = new Set(nodeIds || []);
  return [...(tasks || [])].sort((left, right) =>
    Number(selectedIds.has(right?.graphNodeId)) - Number(selectedIds.has(left?.graphNodeId))
  );
}

export async function runTaskBatch(tasks, executeTask) {
  return Promise.all((tasks || []).map(task => executeTask(task)));
}

export function graphNodeDepths(graph) {
  const endpointIds = [...(graph?.nodes || []).map(node => node.id), ...(graph?.flowPoints || []).map(point => point.id)];
  const depths = new Map(endpointIds.map(id => [id, 0]));
  for (let pass = 0; pass < endpointIds.length; pass += 1) {
    for (const edge of workflowTopologyEdges(graph)) {
      depths.set(edge.to, Math.max(depths.get(edge.to) || 0, (depths.get(edge.from) || 0) + 1));
    }
  }
  return depths;
}
