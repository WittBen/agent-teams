// A test belongs to one completed task attempt, never to the lifetime of a ticket.
export function taskCompletionKey(node) {
  const transition = (node.ticketAttempts || []).filter(item => item.to === 'agent_done').at(-1);
  return String(Math.max(Number(node.completedAt) || 0, Number(node.recoveredAt) || 0, Number(transition?.at) || 0));
}
export function hasOpenAutomaticCriteria(node) {
  return (node.acceptanceCriteria || []).some(item => item.verification === 'automatic' && !['passed', 'waived'].includes(item.status));
}
export function needsAutomaticAcceptance(node) {
  if (!['agent_done', 'completed'].includes(node.status) || !hasOpenAutomaticCriteria(node)) return false;
  const last = (node.acceptanceTestRuns || []).at(-1);
  if (!last) return true;
  return String(last.taskCompletionKey ?? '0') !== taskCompletionKey(node);
}
export function acceptanceTaskState(node) {
  const criteria = node.acceptanceCriteria || [];
  const open = criteria.filter(item => !['passed', 'waived'].includes(item.status));
  const ready = ['agent_done', 'completed', 'retryable', 'blocked'].includes(node.status);
  if (!ready) return 'waiting';
  if (!open.length && criteria.length) return 'done';
  const run = (node.acceptanceTestRuns || []).at(-1);
  if (run?.status === 'running' && String(run.taskCompletionKey ?? '0') === taskCompletionKey(node)) return 'running';
  if (open.some(item => item.status === 'failed')) return 'failed';
  if (open.some(item => item.verification === 'user') || !criteria.length) return 'decision';
  if (hasOpenAutomaticCriteria(node)) return run?.status === 'unavailable' ? 'unavailable' : 'automatic';
  return 'review';
}
