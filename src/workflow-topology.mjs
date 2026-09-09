


export function directedPathExists(graph, startNodeId, targetNodeId) {
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

export function workflowDependentTaskIds(graph, nodeId) {
  const nodeIds = new Set((graph?.nodes || []).map(node => node.id));
  if (!nodeIds.has(nodeId)) return new Set();
  const outgoingBySource = new Map();
  for (const edge of workflowTopologyEdges(graph)) {
    if (!outgoingBySource.has(edge.from)) outgoingBySource.set(edge.from, []);
    outgoingBySource.get(edge.from).push(edge.to);
  }
  const dependents = new Set();
  const visitedEndpoints = new Set([nodeId]);
  const pendingEndpoints = [nodeId];
  while (pendingEndpoints.length > 0) {
    const endpointId = pendingEndpoints.pop();
    for (const targetId of outgoingBySource.get(endpointId) || []) {
      if (nodeIds.has(targetId)) dependents.add(targetId);
      if (visitedEndpoints.has(targetId)) continue;
      visitedEndpoints.add(targetId);
      pendingEndpoints.push(targetId);
    }
  }
  return dependents;
}

export function upstreamTaskNodeIds(graph, endpointId, visited = new Set()) {
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
