export function workflowAttention(nodes = [], requests = [], delegations = []) {
  const openCriteria = nodes.flatMap(node => (node.acceptanceCriteria || []).filter(criterion =>
    criterion.required !== false && !['passed', 'waived'].includes(criterion.status),
  ).map(criterion => ({ node, criterion })));
  const reviewProblems = nodes.filter(node => node.nodeType === 'review' && ['failed', 'blocked', 'timed_out', 'waiting_user'].includes(node.status));
  const reviewDecisions = openCriteria.filter(({ node, criterion }) => criterion.status === 'failed'
    || ['agent_done', 'completed', 'blocked', 'retryable'].includes(node.status));
  const openRequests = requests.filter(request => !['answered', 'completed', 'cancelled'].includes(request.status));
  const groupDecisions = openRequests.filter(request => ['failed', 'timed_out', 'waiting_user', 'awaiting-user'].includes(request.status));
  return {
    tests: { open: openCriteria.length + reviewProblems.length, decisions: reviewDecisions.length + reviewProblems.length },
    collaboration: { open: openRequests.length + delegations.length, decisions: groupDecisions.length + delegations.length },
  };
}
