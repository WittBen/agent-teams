const ELIGIBLE_PARALLEL_STATUSES = new Set(['planned', 'queued', 'interrupted']);
const FINISHED_DEPENDENCY_STATUSES = new Set(['agent_done', 'completed']);

export const TASK_STATUS = {
  planned: { label: 'Geplant', color: '#8696a0' },
  queued: { label: 'Bereit', color: '#53bdeb' },
  running: { label: 'In Arbeit', color: '#e6a23c' },
  waiting_user: { label: 'Wartet auf User', color: '#c084fc' },
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

export function createTaskGraph(chatId, title = 'Aufgabenplan') {
  return { version: 2, chatId, title, nodes: [], edges: [], updatedAt: Date.now() };
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

/** Materialize a PM plan immediately while preserving statuses on plan updates. */
export function materializeTaskPlan(graph, { rootNodeId, tasks = [] } = {}) {
  if (!graph || !rootNodeId || !tasks.length) return graph;
  let nextGraph = graph;

  for (const task of tasks) {
    if (!task?.id || !task?.agentId || !task?.agentName) continue;
    const nodeId = taskPlanGraphNodeId(rootNodeId, task.id);
    const existing = nextGraph.nodes.find(node => node.id === nodeId);
    const parentNodeId = task.type === 'review'
      ? null
      : task.parentId
        ? taskPlanGraphNodeId(rootNodeId, task.parentId)
        : rootNodeId;
    const node = {
      id: nodeId,
      title: task.title,
      objective: task.title,
      agentId: task.agentId,
      agentName: task.agentName,
      status: existing?.status || 'planned',
      source: 'PM-Plan',
      nodeType: task.type === 'review' ? 'review' : 'task',
      executionMode: task.executionMode || 'sequential',
      planRootId: rootNodeId,
      planTaskId: task.id,
      planOrder: task.order || 0,
      requestedAgentName: task.requestedAgentName || task.agentName,
      acceptanceCriteria: mergeAcceptanceCriteria(
        existing?.acceptanceCriteria,
        normalizeAcceptanceCriteria(task.acceptanceCriteria, {
          taskId: task.id,
          fallbackText: task.type === 'review' ? '' : `Das Ergebnis erfüllt die Aufgabe „${task.title}“.`,
        }),
      ),
      createdAt: existing?.createdAt || Date.now() + (task.order || 0),
    };
    if (parentNodeId) node.parentNodeId = parentNodeId;
    nextGraph = upsertTaskNode(nextGraph, node);
  }

  const nodeIds = new Set(nextGraph.nodes.map(node => node.id));
  for (const task of tasks) {
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
    if (nodeIds.has(parentNodeId)) {
      nextGraph = addTaskEdge(nextGraph, { from: parentNodeId, to: nodeId, kind: 'delegation', planRootId: rootNodeId });
    }
    nextGraph = dependencyIds.reduce((current, dependencyId) =>
      addTaskEdge(current, { from: dependencyId, to: nodeId, kind: 'dependency', planRootId: rootNodeId }),
    nextGraph);
  }
  return nextGraph;
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

export function inferTaskNodeType(node = {}) {
  if (node.nodeType) return node.nodeType;
  if (node.source === 'team-synthesis') return 'review';
  if (String(node.source || '').startsWith('timeout-recovery')) return 'recovery';
  if (node.source === 'user-answer') return 'continuation';
  if (node.source === 'user' && !node.parentNodeId) return 'request';
  return 'task';
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

export function updateTaskNodeStatus(graph, nodeId, status, extra = {}) {
  if (!graph?.nodes?.some(node => node.id === nodeId)) return graph;
  return {
    ...graph,
    nodes: graph.nodes.map(node => node.id === nodeId
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
    for (const edge of graph.edges.filter(candidate => candidate.from === current)) stack.push(edge.to);
  }
  return false;
}

export function isTaskNodeReady(graph, nodeId) {
  const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
  if (!node || !ELIGIBLE_PARALLEL_STATUSES.has(node.status)) return false;
  const parentIds = (graph.edges || [])
    .filter(edge => edge.to === nodeId)
    .map(edge => edge.from);
  return parentIds.every(parentId => {
    const parent = graph.nodes.find(candidate => candidate.id === parentId);
    return parent && FINISHED_DEPENDENCY_STATUSES.has(parent.status);
  });
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
  const invalid = nodes.find(node => !ELIGIBLE_PARALLEL_STATUSES.has(node.status));
  if (invalid) return { ok: false, reason: `„${invalid.title}“ ist nicht startbereit.`, messageKey: '„{title}“ ist nicht startbereit.', messageValues: { title: invalid.title } };
  const sequential = nodes.find(node => node.executionMode === 'sequential');
  if (sequential) return { ok: false, reason: `„${sequential.title}“ ist als sequenzieller Schritt geplant.`, messageKey: '„{title}“ ist als sequenzieller Schritt geplant.', messageValues: { title: sequential.title } };
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

/**
 * Greedily builds the largest safe parallel batch in stable queue order.
 * Tasks that are sequential, blocked, dependent, assigned to an already used
 * agent, or likely to touch the same file remain in the sequential queue.
 */
export function findSafeAutoParallelTaskIds(graph, tasks = []) {
  const candidates = tasks.map(task => task?.graphNodeId).filter(nodeId => {
    const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
    return node && node.executionMode === 'parallel' && isTaskNodeReady(graph, nodeId);
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
  const depths = new Map(graph?.nodes?.map(node => [node.id, 0]) || []);
  for (let pass = 0; pass < (graph?.nodes?.length || 0); pass += 1) {
    for (const edge of graph.edges || []) {
      depths.set(edge.to, Math.max(depths.get(edge.to) || 0, (depths.get(edge.from) || 0) + 1));
    }
  }
  return depths;
}
