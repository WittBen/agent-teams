import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTaskNodeReady, validateParallelSelection, hasTaskResourceConflict } from '../src/workflow-scheduling.mjs';
import { invalidateTaskRecoveryBranch } from '../src/workflow-recovery.mjs';
import { setTaskPaused, restoreTaskPauses } from '../src/workflow-task-pause.mjs';
import { runTaskPool } from '../src/workflow-execution.mjs';
import { extractClosedPlanTasks } from '../src/streaming-plan.mjs';
import { reachableChildGroups, buildProcessedContextSummary } from '../src/cross-group-coordination.mjs';
import { assessTaskComplexity, evaluateResponseQuality, recommendedEscalationModel } from '../electron/quality-cascade.mjs';
import { updateTaskNodeStatus, validateApprovedTaskExecution } from '../src/task-graph.js';

const node = (id, status = 'planned', agentId = id) => ({ id, title: id, nodeType: 'task', status, agentId });
const edge = (from, to) => ({ from, to, kind: 'dependency' });
const tick = () => new Promise(resolve => setImmediate(resolve));

for (let seed = 0; seed < 16; seed++) test(`DAG readiness follows every prerequisite, seed ${seed}`, () => {
  const nodes = Array.from({ length: 12 }, (_, i) => node(String(i), (i + seed) % 3 ? 'completed' : 'planned'));
  const edges = [];
  for (let i = 1; i < nodes.length; i++) for (let j = 0; j < i; j++) if ((i * 7 + j + seed) % 4 === 0) edges.push(edge(String(j), String(i)));
  const graph = { nodes, edges };
  for (const candidate of nodes) assert.equal(isTaskNodeReady(graph, candidate.id), candidate.status === 'planned'
    && edges.filter(e => e.to === candidate.id).every(e => nodes.find(n => n.id === e.from).status === 'completed'));
});

test('pausing persists across serialization and blocks only its dependent branch', () => {
  const original = { nodes: [node('a', 'running'), node('b'), node('c')], edges: [edge('a', 'b')] };
  const pending = setTaskPaused(original, 'a', true, { active: true });
  assert.equal(pending.nodes[0].status, 'pausing');
  assert.equal(setTaskPaused(pending, 'a', false), pending);
  assert.equal(restoreTaskPauses(pending).nodes[0].status, 'paused');
  assert.equal(updateTaskNodeStatus(pending, 'a', 'completed').nodes[0].status, 'pausing');
  const paused = JSON.parse(JSON.stringify({ ...pending, nodes: pending.nodes.map(n => n.id === 'a' ? { ...n, status: 'paused' } : n) }));
  assert.equal(isTaskNodeReady(paused, 'a'), false);
  assert.equal(isTaskNodeReady(paused, 'b'), false);
  assert.equal(isTaskNodeReady(paused, 'c'), true);
  assert.equal(isTaskNodeReady(setTaskPaused(paused, 'a', false), 'a'), true);
  assert.equal(original.nodes[0].status, 'running');
});

test('approved tasks cannot change provider silently or bypass a user pause', () => {
  const approved = { ...node('a'), model: 'same-model', provider: 'provider-a' };
  const graph = { nodes: [approved], edges: [], approvedPlan: { nodes: [approved], edges: [] } };
  assert.equal(validateApprovedTaskExecution(graph, { graphNodeId: 'a', agent: { id: 'a', model: 'same-model', provider: 'provider-b' } }).ok, false);
  const paused = setTaskPaused(graph, 'a', true);
  assert.equal(validateApprovedTaskExecution(paused, { graphNodeId: 'a', agent: { id: 'a', model: 'same-model', provider: 'provider-a' } }).ok, false);
});

test('join waits for all inputs including a paused branch', () => {
  const graph = { nodes: [node('a', 'completed'), node('b', 'paused'), node('c')], edges: [],
    flowPoints: [{ id: 'join', type: 'join' }], flowEdges: [{ from: 'a', to: 'join' }, { from: 'b', to: 'join' }, { from: 'join', to: 'c' }] };
  assert.equal(isTaskNodeReady(graph, 'c'), false);
  graph.nodes[1].status = 'completed';
  assert.equal(isTaskNodeReady(graph, 'c'), true);
});

test('same-agent and same-file tasks cannot be selected in parallel', () => {
  assert.equal(validateParallelSelection({ nodes: [node('a', 'planned', 'same'), node('b', 'planned', 'same')], edges: [] }, ['a', 'b']).ok, false);
  const nodes = [node('a'), node('b')].map(n => ({ ...n, objective: 'Edit shared.js' }));
  assert.equal(validateParallelSelection({ nodes, edges: [] }, ['a', 'b']).ok, false);
  nodes[0].status = 'running';
  assert.equal(hasTaskResourceConflict({ nodes }, 'b', ['a']), true);
  nodes[1].objective = 'Edit independent.js';
  assert.equal(hasTaskResourceConflict({ nodes }, 'b', ['a']), false);
});

test('recovery does not implicitly resume a user-paused successor', () => {
  const graph = setTaskPaused({ nodes: [node('a', 'failed'), node('b')], edges: [edge('a', 'b')] }, 'b', true);
  assert.equal(invalidateTaskRecoveryBranch(graph, 'a').nodes[1].status, 'paused');
});

test('a paused task frees its agent lane while another agent is still working', async () => {
  let graph = { nodes: [node('a', 'running', 'one'), node('slow', 'running', 'two'), node('next', 'planned', 'one'), node('dependent')], edges: [edge('a', 'dependent')] };
  const toTask = n => ({ graphNodeId: n.id, agent: { id: n.agentId } });
  const controls = new Map();
  const started = [];
  const run = runTaskPool({ initialTasks: graph.nodes.slice(0, 2).map(toTask),
    execute: task => { started.push(task.graphNodeId); return new Promise(resolve => controls.set(task.graphNodeId, resolve)); },
    claim: ({ activeAgentIds }) => {
      const ready = graph.nodes.find(n => !activeAgentIds.has(n.agentId) && isTaskNodeReady(graph, n.id));
      if (!ready) return null;
      ready.status = 'running'; return toTask(ready);
    },
  });
  await tick();
  graph = setTaskPaused(graph, 'a', true);
  controls.get('a')({ taskPaused: true });
  await tick();
  assert.deepEqual(started, ['a', 'slow', 'next']);
  assert.equal(graph.nodes.find(n => n.id === 'dependent').status, 'planned');
  graph.nodes.find(n => n.id === 'next').status = 'completed';
  controls.get('next')({}); controls.get('slow')({});
  await run;
});

test('pool drains active tasks after failure without starting new work', async () => {
  let finish;
  let claimed = 0;
  const run = runTaskPool({ initialTasks: [{ agent: { id: 'a' } }, { agent: { id: 'b' } }],
    execute: task => task.agent.id === 'a' ? Promise.reject(new Error('failed')) : new Promise(resolve => { finish = resolve; }),
    claim: () => { claimed++; return null; },
  });
  const rejected = assert.rejects(run, /failed/);
  await tick();
  const previous = claimed;
  finish({}); await rejected;
  assert.equal(claimed, previous);
});

for (let attempt = 1; attempt <= 4; attempt++) test(`recovery round ${attempt} invalidates descendants without touching independent work`, () => {
  const graph = { nodes: ['a', 'b', 'c', 'independent'].map(id => ({ ...node(id, 'completed'), acceptanceCriteria: [{ id: 'test', status: 'passed', verification: 'automatic' }] })), edges: [edge('a', 'b'), edge('b', 'c')] };
  const recovered = invalidateTaskRecoveryBranch(graph, 'a', { recoveryAttempt: attempt });
  assert.equal(recovered.nodes[0].recoveryAttempt, attempt);
  assert.deepEqual(recovered.nodes.slice(1).map(n => n.status), ['stale_dependency', 'stale_dependency', 'completed']);
  assert.equal(recovered.nodes[1].acceptanceCriteria[0].status, 'open');
  assert.equal(graph.nodes[1].status, 'completed');
});

for (const language of ['中文', '日本語', 'العربية', 'Français']) test(`structured quality requirements apply independently of language: ${language}`, () => {
  const complexity = assessTaskComplexity({ objective: language, requirements: ['a', 'b', 'c', 'd'], riskLevel: 'high' });
  assert.equal(complexity.level, 'high');
  assert.equal(evaluateResponseQuality({ reply: language, requiredArtifacts: ['result.json'], projectFiles: [] }).accepted, false);
  assert.equal(evaluateResponseQuality({ reply: language, requiredArtifacts: ['result.json'], projectFiles: [{ filename: 'result.json' }] }).accepted, true);
});

test('model recommendations honor availability rather than provider list order', () => {
  assert.equal(recommendedEscalationModel('openai', 'gpt-4o-mini', ['other']), '');
  assert.equal(recommendedEscalationModel('openai', 'gpt-4o-mini', ['gpt-4o']), 'gpt-4o');
  assert.equal(recommendedEscalationModel('custom', 'cheap', ['cheap', 'expensive']), '');
});

for (const metadata of ['', '"version":2,', '"title":"A plan", "metadata":{"tasks":[]},']) test(`incremental tickets support metadata prefix ${metadata}`, () => {
  const first = { id: 'first', title: 'Escaped " text { }', description: '🌍' };
  const prefix = `[[TASK_PLAN]] {${metadata}"tasks":[`;
  assert.equal(extractClosedPlanTasks(prefix + JSON.stringify(first).slice(0, -1)), null);
  assert.deepEqual(extractClosedPlanTasks(prefix + JSON.stringify(first) + ', {"id":"partial'), [first]);
});

test('group routes exclude ancestors, visited groups and disabled collaboration', () => {
  const source = { id: 'b', crossGroupCollaborationEnabled: true, crossGroupTargetGroupIds: ['a', 'c', 'd'] };
  const request = { sourceGroupId: 'a', targetGroupId: 'b', visitedGroupIds: ['d'] };
  const groups = ['a', 'b', 'c', 'd', 'private'].map(id => ({ id }));
  assert.deepEqual(reachableChildGroups(request, source, groups).map(g => g.id), ['c']);
  assert.deepEqual(reachableChildGroups({ ...request, depth: 100 }, source, groups), []);
  assert.deepEqual(reachableChildGroups(request, { ...source, crossGroupCollaborationEnabled: false }, groups), []);
  assert.ok(buildProcessedContextSummary({}, 'x'.repeat(20000), 'y'.repeat(20000)).length <= 6000);
});
