/** Restore a saved graph as a draft; never restore an execution approval. */
export function rewindDraft(snapshot) {
  const graph = structuredClone(snapshot);
  graph.approvedPlan = null;
  graph.previousApprovedPlan = null;
  graph.planOwner = 'user';
  graph.planningSuspended = false;
  graph.nodes = (graph.nodes || []).map(node => ({
    ...node,
    status: ['running', 'prepared', 'queued', 'pausing', 'waiting_group'].includes(node.status) ? 'planned' : node.status,
  }));
  return graph;
}
