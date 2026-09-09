import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveQualityPolicy, runQualityCascade, recommendedEscalationModel, resolveGroupAgent } from '../electron/quality-cascade.mjs';
import { selectAgentHistory, selectTaskAttachments, handoffContext } from '../electron/agent-context.mjs';
import { MemoryAPI } from '../src/memory-provider.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createLocalMemoryOperationQueue } = require('../electron/memory-local.js');

test('shared memory uses one snapshot, bounds excerpts and excludes stale or foreign handoffs', async () => {
  let reads = 0;
  const api = new MemoryAPI({ list: async () => { reads++; return [
    { id: 'old', type: 'handoff', content: { to: 'PM', taskId: 'old', summary: 'SQL OLD_PRIVATE' } },
    { id: 'foreign', type: 'handoff', content: { to: 'Other', taskId: 'current', summary: 'SQL FOREIGN_PRIVATE' } },
    { id: 'archived', status: 'archived', content: 'SQL ARCHIVED_PRIVATE' },
    { id: 'irrelevant', content: 'unrelated topic' },
    { id: 'current', type: 'handoff', content: { to: 'PM', taskId: 'current', summary: 'CURRENT_HANDOFF' } },
    ...Array.from({ length: 12 }, (_, i) => ({ id: `fact-${i}`, content: 'SQL '.repeat(5000) })),
  ]; } });
  const context = await api.getContextForAgent('project', 'SQL', 'PM', 10, { taskId: 'current' });
  assert.equal(reads, 1);
  assert.match(context, /CURRENT_HANDOFF/);
  assert.doesNotMatch(context, /OLD_PRIVATE|FOREIGN_PRIVATE|ARCHIVED_PRIVATE|unrelated topic/);
  assert.match(context, /gekürzt/);
  assert.ok(context.length < 8200);
});

test('parallel shared-memory writeOnce operations deduplicate inside the storage queue', async () => {
  const values = new Map();
  const operate = createLocalMemoryOperationQueue({ get: key => values.get(key), set: (key, value) => values.set(key, value) });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => operate({ action: 'writeOnce', namespace: 'group', entry: { id: `attempt-${i}`, dedupeKey: 'same-result', content: 'result' } })));
  assert.equal(results.filter(result => result.created).length, 1);
  assert.equal((await operate({ action: 'list', namespace: 'group' })).length, 1);
  assert.equal((await operate({ action: 'list', namespace: 'other' })).length, 0);
});

test('provider changes never inherit a model belonging to the previous escalation provider', () => {
  const globalConfig = { escalationProvider: 'openai', escalationModel: 'openai-strong' };
  assert.equal(resolveQualityPolicy({ agent, globalConfig, groupConfig: { escalationProvider: 'anthropic' } }).escalationAgent, null);
  assert.equal(resolveQualityPolicy({ agent, globalConfig, agentConfig: { escalationProvider: 'anthropic', escalationModel: 'anthropic-strong' } }).escalationAgent.model, 'anthropic-strong');
  assert.equal(resolveQualityPolicy({ agent, globalConfig, agentConfig: { escalationProvider: 'anthropic' } }).escalationAgent, null);
});

test('asynchronous quality gates are awaited and can prevent retries with side effects', async () => {
  let calls = 0;
  const result = await runQualityCascade({ agent, policy, call: async () => { calls++; return 'bad'; },
    evaluate: async () => ({ accepted: false, reasons: ['failed-test'] }), canEscalate: async () => false });
  assert.equal(calls, 1);
  assert.equal(result.unresolved, true);
});

const agent = { id: 'specialist', provider: 'openai', model: 'gpt-4o-mini' };
const policy = resolveQualityPolicy({ agent });

test('group AI applies to every member without changing identity or other group profiles', () => {
  const group = { aiTemplate: { enabled: true, provider: 'anthropic', model: 'group-model' } };
  for (const member of [agent, { ...agent, id: 'pm', isSystemAgent: true, systemPrompt: 'Coordinate', capabilities: ['planning'] }]) {
    const effective = resolveGroupAgent(member, group);
    assert.equal(effective.provider, 'anthropic');
    assert.equal(effective.model, 'group-model');
    assert.equal(effective.id, member.id);
    assert.equal(effective.systemPrompt, member.systemPrompt);
    assert.equal(effective.capabilities, member.capabilities);
    assert.equal(member.model, 'gpt-4o-mini');
    assert.equal(resolveGroupAgent(member, {}), member);
    assert.equal(resolveGroupAgent(member, { aiTemplate: { ...group.aiTemplate, enabled: false } }), member);
  }
});

test('specialists receive no transcript or attachments from other assignments', () => {
  const history = [{ agentId: 'user', text: 'private unrelated content', attachments: [{ name: 'secret.pdf' }] }];
  assert.deepEqual(selectAgentHistory(history, { agentId: agent.id }), []);
  assert.deepEqual(selectTaskAttachments(history[0].attachments, { objective: 'Implementiere Navigation' }), []);
  assert.deepEqual(selectTaskAttachments([{ name: 'spec.pdf' }, { name: 'secret.pdf' }], { objective: 'Prüfe spec.pdf' }), [{ name: 'spec.pdf' }]);
  assert.equal(selectAgentHistory(history, { coordinator: true })[0].attachments, undefined);
});

test('direct history is two-party and bounded; PM handoff is bounded', () => {
  const history = [{ agentId: 'other', text: 'foreign' }, { agentId: agent.id, text: 'a'.repeat(30) }, { agentId: 'user', text: 'b'.repeat(30) }];
  const scoped = selectAgentHistory(history, { agentId: agent.id, direct: true, maxCharacters: 40 });
  assert.equal(scoped.map(message => message.text).join('').length, 40);
  assert.equal(scoped.some(message => message.text === 'foreign'), false);
  assert.ok(handoffContext({ findings: Array(30).fill('x'.repeat(2000)) }).length <= 8000);
});

test('group and global explicit escalation choices apply, unordered custom lists do not', () => {
  assert.equal(resolveQualityPolicy({ agent, globalConfig: { escalationModel: 'explicit' } }).escalationAgent.model, 'explicit');
  assert.equal(resolveQualityPolicy({ agent, groupConfig: { escalationModel: 'group-model' } }).escalationAgent.model, 'group-model');
  assert.equal(recommendedEscalationModel('custom', 'cheap', ['cheap', 'unknown']), '');
});

test('fast, deep, baseline and escalation use the same deterministic runner', async () => {
  for (const mode of ['fast', 'deep', 'auto']) {
    const calls = [];
    const result = await runQualityCascade({ agent, policy: resolveQualityPolicy({ agent, messageMode: mode }),
      call: async ({ phase }) => { calls.push(phase); return phase === 'baseline' ? 'bad' : 'good'; },
      evaluate: reply => ({ accepted: reply === 'good', reasons: ['test-gate'] }),
    });
    assert.deepEqual(calls, mode === 'fast' ? ['baseline'] : mode === 'deep' ? ['direct-strong'] : ['baseline', 'escalated']);
    assert.equal(result.unresolved, mode === 'fast');
  }
});

test('escalation sees only the scoped assignment and its own previous result', async () => {
  const scoped = [{ agentId: 'user', text: 'Assigned task only' }];
  await runQualityCascade({ agent, policy, history: scoped,
    evaluate: reply => ({ accepted: reply === 'good', reasons: [] }),
    call: async ({ phase, history }) => {
      assert.equal(history[0].text, 'Assigned task only');
      assert.equal(history.length, phase === 'baseline' ? 1 : 3);
      return phase === 'baseline' ? 'bad' : 'good';
    },
  });
});

test('native tool side effects are not replayed and rejected output stays unresolved', async () => {
  let calls = 0;
  const result = await runQualityCascade({ agent, policy, canEscalate: () => false,
    call: async () => { calls += 1; return 'bad'; }, evaluate: () => ({ accepted: false, reasons: ['gate'] }),
  });
  assert.equal(calls, 1);
  assert.equal(result.unresolved, true);
  assert.equal(result.outcome, 'rejected');
});

test('cancellation and rate limits propagate instead of returning rejected baseline text', async () => {
  for (const error of [Object.assign(new Error('cancelled'), { cancelled: true }), Object.assign(new Error('limit'), { status: 429 })]) {
    await assert.rejects(runQualityCascade({ agent, policy,
      evaluate: () => ({ accepted: false, reasons: [] }),
      call: async ({ phase }) => { if (phase === 'escalated') throw error; return 'bad'; },
    }), candidate => candidate === error);
  }
});
