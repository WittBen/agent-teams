const PAUSABLE = new Set(['planned', 'queued', 'prepared', 'running', 'interrupted', 'retryable', 'stale_dependency']);

/** Startup only: the old process no longer owns an in-flight pause. */
export function restoreTaskPauses(graph) {
  if (!graph?.nodes?.some(node => node.status === 'pausing')) return graph;
  return { ...graph, nodes: graph.nodes.map(node => node.status === 'pausing' ? { ...node, status: 'paused' } : node) };
}

export function canPauseTask(node) {
  return !!node && node.nodeType !== 'request' && PAUSABLE.has(node.status);
}

export function setTaskPaused(graph, taskId, paused, { active = false } = {}) {
  const node = graph?.nodes?.find(item => item.id === taskId);
  if (!node || (paused ? !canPauseTask(node) : !['paused', 'pausing'].includes(node.status))) return graph;
  if (!paused && node.status === 'pausing') return graph;
  const now = Date.now();
  const status = paused ? active ? 'pausing' : 'paused' : 'planned';
  return { ...graph, updatedAt: now, nodes: graph.nodes.map(item => item.id !== taskId ? item : {
    ...item, status, userPausedAt: paused ? now : undefined, updatedAt: now,
    ticketAttempts: [...(item.ticketAttempts || []), { from: item.status, to: status, at: now, note: paused ? 'Vom User pausiert.' : 'Vom User fortgesetzt.' }].slice(-30),
  }) };
}
