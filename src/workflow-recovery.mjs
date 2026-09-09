
import { inferTaskNodeType, workflowDependentTaskIds } from './workflow-topology.mjs';

export function invalidateTaskRecoveryBranch(graph, nodeId, { recoveryAttempt = 1, reason = '' } = {}) {
  if (!graph?.nodes?.some(node => node.id === nodeId)) return graph;
  const affectedIds = workflowDependentTaskIds(graph, nodeId);
  const invalidatedAt = Date.now();
  return {
    ...graph,
    nodes: graph.nodes.map(node => {
      if (node.runtimeRecovery || inferTaskNodeType(node) === 'request') return node;
      const isOriginal = node.id === nodeId;
      const isAffected = affectedIds.has(node.id);
      if (!isOriginal && !isAffected) return node;
      const acceptanceCriteria = (node.acceptanceCriteria || []).map(criterion => ({
        ...criterion,
        status: criterion.verification === 'user' ? criterion.status : 'open',
        reviewedBy: undefined,
        reviewedAt: undefined,
      }));
      if (isOriginal) {
        return {
          ...node,
          acceptanceCriteria,
          recoveryAttempt,
          recoveryInvalidatedAt: invalidatedAt,
          recoveryInvalidationReason: String(reason || '').slice(0, 1000),
          updatedAt: invalidatedAt,
        };
      }
      return {
        ...node,
        status: node.userPausedAt ? node.status : 'stale_dependency',
        acceptanceCriteria,
        stalePreviousStatus: node.status,
        staleBecauseTaskId: nodeId,
        staleAt: invalidatedAt,
        completedAt: undefined,
        error: undefined,
        blockedReason: 'upstream-recovery',
        preparationAttemptedAt: undefined,
        preparationCompletedAt: undefined,
        preparationFailedAt: undefined,
        preparationError: undefined,
        interimResult: undefined,
        interimSavedAt: undefined,
        interimConsumedAt: undefined,
        preparedFiles: undefined,
        ticketAttempts: [...(node.ticketAttempts || []), {
          from: node.status || null,
          to: 'stale_dependency',
          at: invalidatedAt,
          note: `Abhängiges Ergebnis wird nach Recovery von ${nodeId} erneut geprüft.`,
        }].slice(-30),
        updatedAt: invalidatedAt,
      };
    }),
    updatedAt: invalidatedAt,
  };
}
