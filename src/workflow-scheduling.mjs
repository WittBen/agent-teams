import { normalizeDelegationPolicy } from './delegation.js';
import { compareTicketPriority } from './task-ticket.js';
import { inferTaskNodeType, workflowTopologyEdges, upstreamTaskNodeIds } from './workflow-topology.mjs';

export const ELIGIBLE_PARALLEL_STATUSES = new Set(['planned', 'queued', 'prepared', 'interrupted', 'retryable', 'stale_dependency']);

export const PREPARATION_CANDIDATE_STATUSES = new Set(['planned', 'queued', 'interrupted', 'retryable', 'stale_dependency']);

export const FINISHED_DEPENDENCY_STATUSES = new Set(['agent_done', 'completed']);

export function referencedFiles(value) {
  const matches = String(value || '').match(/[A-Za-z0-9_.\-/\\]+\.(?:js|jsx|ts|tsx|css|scss|html|json|md|py|go|rs|java|sql|yaml|yml)/gi) || [];
  return new Set(matches.map(match => match.replace(/\\/g, '/').toLowerCase()));
}

/** Prevent overlapping writes when a free agent claims work during a live batch. */
export function hasTaskResourceConflict(graph, taskId, activeTaskIds = []) {
  const candidate = graph?.nodes?.find(node => node.id === taskId);
  if (!candidate) return false;
  const files = referencedFiles(candidate.objective || candidate.title);
  return [...activeTaskIds].some(id => {
    const active = graph.nodes.find(node => node.id === id);
    if (!active || id === taskId) return id === taskId;
    if (active.agentId === candidate.agentId) return true;
    const activeFiles = referencedFiles(active.objective || active.title);
    return [...files].some(file => activeFiles.has(file));
  });
}

export function hasPath(graph, from, to) {
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

export function isTaskNodeReady(graph, nodeId) {
  const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
  if (!node || !ELIGIBLE_PARALLEL_STATUSES.has(node.status)) return false;
  const parentIds = [...upstreamTaskNodeIds(graph, nodeId)];
  return parentIds.every(parentId => {
    const parent = graph.nodes.find(candidate => candidate.id === parentId);
    return parent && FINISHED_DEPENDENCY_STATUSES.has(parent.status);
  });
}

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
  for (const node of [...(graph.nodes || [])].sort(compareTicketPriority)) {
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

export function workflowPlanRepairSuggestion(validation) {
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
