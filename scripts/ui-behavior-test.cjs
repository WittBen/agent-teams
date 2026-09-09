const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createTextProgress } = require('../electron/llm-stream');

test('expert discovery shares bounded skills and respects outbound and task routes', async () => {
  const { expertiseSkills, expertiseTargets, expertDraft, parseExpertiseAnswer } = await import('../src/expertise-help.mjs');
  const source = { id: 'source', crossGroupCollaborationEnabled: true, crossGroupTargetGroupIds: ['home', 'other'] };
  const task = { id: 'task', secretHistory: 'PRIVATE', delegation: { requiredCapabilities: ['SQL', 'SQL', ' Testing '], allowedTargetGroupIds: ['home'] } };
  assert.deepEqual(expertiseSkills(task), ['SQL', 'Testing']);
  assert.deepEqual(expertiseTargets(source, [source, { id: 'home' }, { id: 'other' }, { id: 'private' }], task).map(g => g.id), ['home']);
  assert.deepEqual(expertiseTargets({ ...source, crossGroupCollaborationEnabled: false }, [{ id: 'home' }], task), []);
  assert.equal(JSON.stringify(expertDraft(task)).includes('PRIVATE'), false);
  assert.deepEqual(parseExpertiseAnswer('{"agentIds":[]}', []), { agentIds: [], reason: '' });
  assert.throws(() => parseExpertiseAnswer('{"agentIds":["outsider"]}', [{ id: 'expert' }]));
  assert.throws(() => parseExpertiseAnswer('invalid', []));
});

test('creating a loan expert only changes home membership and opens its route', async () => {
  const { placeExpertInHomeGroup } = await import('../src/expertise-help.mjs');
  const source = { id: 'source', agentIds: ['owner'], crossGroupTargetGroupIds: ['existing'] };
  const home = { id: 'home', agentIds: ['pm'] };
  const groups = [source, home];
  const result = placeExpertInHomeGroup(groups, { sourceGroupId: 'source', homeGroupId: 'home', agentId: 'expert' });
  assert.deepEqual(result[0].agentIds, ['owner']);
  assert.deepEqual(result[1].agentIds, ['pm', 'expert']);
  assert.deepEqual(result[0].crossGroupTargetGroupIds, ['existing', 'home']);
  assert.deepEqual(groups[1].agentIds, ['pm']);
  assert.throws(() => placeExpertInHomeGroup(groups, { sourceGroupId: 'source', homeGroupId: 'source', agentId: 'expert' }));
  assert.throws(() => placeExpertInHomeGroup(groups, { sourceGroupId: 'source', homeGroupId: 'removed', agentId: 'expert' }));
});

test('a loan is scoped to the user-selected task, member and reachable home group', async () => {
  const { evaluateTaskDelegation } = await import('../src/delegation.js');
  const source = { id: 'source', agentIds: ['owner'], crossGroupCollaborationEnabled: true, crossGroupTargetGroupIds: ['home'] };
  const home = { id: 'home', name: 'Home', agentIds: ['expert', 'replacement'] };
  const agents = [{ id: 'expert', name: 'Expert' }, { id: 'replacement', name: 'Replacement' }];
  const task = { delegation: { mode: 'automatic', loanAgentId: 'expert', loanGroupId: 'home', requiredCapabilities: ['SQL'], allowedTargetGroupIds: ['home'] } };
  const decide = (taskNode, groups = [source, home], available = agents) => evaluateTaskDelegation({ taskNode, sourceGroup: source, groups, agents: available });
  assert.equal(decide(task).reason, 'loan-not-approved');
  const approved = { ...task, expertLoanApproval: { agentId: 'expert', groupId: 'home', approvedAt: 1 } };
  assert.deepEqual(decide(approved).candidate.agentIds, ['expert']);
  assert.equal(decide(approved, [source, { ...home, agentIds: ['replacement'] }]).reason, 'loan-unavailable');
  assert.equal(decide(approved, [source, home], []).reason, 'loan-unavailable');
  assert.equal(decide({ ...approved, delegation: { ...task.delegation, loanAgentId: 'replacement' } }).reason, 'loan-not-approved');
  assert.equal(decide(approved, [{ ...source, crossGroupTargetGroupIds: [] }, home]).reason, 'loan-unavailable');
  assert.deepEqual(source.agentIds, ['owner']);
});

test('the first available text is emitted immediately and subsequent text stays exact', () => {
  const events = [];
  const progress = createTextProgress(event => events.push(event), 'test');
  progress.start();
  progress.push('Hallo ');
  assert.equal(events.at(-1).delta, 'Hallo ');
  progress.push('🌍\n\n**Fertig**');
  progress.finish();
  assert.equal(events.filter(event => event.delta).map(event => event.delta).join(''), 'Hallo 🌍\n\n**Fertig**');
  assert.equal(events.at(-1).phase, 'completed');
});

test('review tabs distinguish open work from decisions and clear resolved criteria', async () => {
  const { workflowAttention } = await import('../src/workflow-attention.mjs');
  const node = { status: 'planned', acceptanceCriteria: [{ status: 'open', required: true }] };
  assert.deepEqual(workflowAttention([node]).tests, { open: 1, decisions: 0 });
  assert.deepEqual(workflowAttention([{ ...node, status: 'agent_done' }]).tests, { open: 1, decisions: 1 });
  assert.deepEqual(workflowAttention([{ ...node, acceptanceCriteria: [{ status: 'passed' }] }]).tests, { open: 0, decisions: 0 });
});

test('group tab highlights approvals and failed requests, not answered or cancelled ones', async () => {
  const { workflowAttention } = await import('../src/workflow-attention.mjs');
  assert.deepEqual(workflowAttention([], [{ status: 'answered' }, { status: 'cancelled' }]).collaboration, { open: 0, decisions: 0 });
  assert.deepEqual(workflowAttention([], [{ status: 'running' }, { status: 'failed' }], [{}]).collaboration, { open: 3, decisions: 2 });
});


test('automatic acceptance runs once per completion and again after rework', async () => {
  const { needsAutomaticAcceptance, taskCompletionKey } = await import('../src/acceptance-scheduling.mjs');
  const node = { status: 'running', completedAt: 100, acceptanceCriteria: [{ verification: 'automatic', status: 'open' }] };
  assert.equal(needsAutomaticAcceptance(node), false);
  node.status = 'agent_done';
  assert.equal(needsAutomaticAcceptance(node), true);
  node.acceptanceTestRuns = [{ taskCompletionKey: taskCompletionKey(node), status: 'failed' }];
  assert.equal(needsAutomaticAcceptance(node), false, 'do not endlessly retry failed tests');
  node.ticketAttempts = [{ to: 'agent_done', at: 200 }];
  assert.equal(needsAutomaticAcceptance(node), true, 'reworked completion gets a fresh test');
  node.acceptanceTestRuns.push({ taskCompletionKey: taskCompletionKey(node), status: 'unavailable' });
  assert.equal(needsAutomaticAcceptance(node), false, 'missing configuration does not spin');
  node.recoveredAt = 300;
  assert.equal(needsAutomaticAcceptance(node), true, 'recovery is also a new completion');
  node.acceptanceCriteria[0].status = 'waived';
  assert.equal(needsAutomaticAcceptance(node), false, 'respect explicit waivers');
});

test('acceptance view distinguishes pending work, user decisions and all criteria accepted', async () => {
  const { acceptanceTaskState } = await import('../src/acceptance-scheduling.mjs');
  const node = { status: 'planned', acceptanceCriteria: [{ verification: 'user', status: 'open' }] };
  assert.equal(acceptanceTaskState(node), 'waiting');
  node.status = 'agent_done';
  assert.equal(acceptanceTaskState(node), 'decision');
  node.acceptanceCriteria.push({ verification: 'automatic', status: 'passed' });
  node.acceptanceTestRuns = [{ status: 'passed' }];
  assert.equal(acceptanceTaskState(node), 'decision', 'a green command does not mean manual acceptance is done');
  node.acceptanceCriteria[0].status = 'passed';
  assert.equal(acceptanceTaskState(node), 'done');
  node.acceptanceCriteria = [];
  assert.equal(acceptanceTaskState(node), 'decision', 'missing criteria are never shown as approved');
});
