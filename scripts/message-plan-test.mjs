import test from 'node:test';
import assert from 'node:assert/strict';
import { messagePlanParts } from '../src/message-plan-parts.mjs';
import { rewindDraft } from '../src/chat-rewind.mjs';

test('rewind restores a separate draft without execution approval or active jobs', () => {
  const saved = { approvedPlan: { revision: 1 }, previousApprovedPlan: { revision: 0 }, planOwner: 'pm', planningSuspended: true,
    nodes: [{ id: 'a', status: 'running' }, { id: 'b', status: 'completed' }], edges: [{ from: 'a', to: 'b' }] };
  const restored = rewindDraft(saved);
  assert.equal(restored.approvedPlan, null);
  assert.equal(restored.previousApprovedPlan, null);
  assert.equal(restored.nodes[0].status, 'planned');
  assert.equal(restored.nodes[1].status, 'completed');
  assert.deepEqual(restored.edges, saved.edges);
  assert.equal(saved.nodes[0].status, 'running');
  assert.equal(saved.approvedPlan.revision, 1);
});

test('recovery output renders review aliases and partial evidence independently', () => {
  const review = { criterionId: 'excel-vorhanden', accepted: true, comment: 'Datei erstellt' };
  const evidence = { criterionId: 'excel-vorhanden', summary: 'Datei enthält drei Tabellenblätter' };
  const parts = messagePlanParts(`[[RECOVERY_RESOLVED]]\n[[ACCEPTANCE_REVIEW]]{"reviews":[${JSON.stringify(review)}]}[[/ACCEPTANCE_REVIEW]]\n[[TASK_EVIDENCE]]{"evidence":[${JSON.stringify(evidence)},{"summary":"unvollständig`);
  assert.deepEqual(parts[0], { type: 'status', kind: 'RECOVERY_RESOLVED' });
  const blocks = parts.filter(part => part.type === 'review');
  assert.deepEqual(blocks[0].items, [review]);
  assert.equal(blocks[0].complete, true);
  assert.deepEqual(blocks[1].items, [evidence]);
  assert.equal(blocks[1].complete, false);
  assert.deepEqual(messagePlanParts('[[ACCEPTANCE_REVIEW]]{"decisions":[{"status":"failed"}]}[[/ACCEPTANCE_REVIEW]]')[0].items, [{ status: 'failed' }]);
});

test('streamed plans show only closed tickets and keep surrounding prose', () => {
  const first = { id: 'one', title: 'REST-Konzept', description: 'Text mit } und "Zitat"' };
  const text = `**Plan:**\n[[TASK_PLAN]]{"tasks":[${JSON.stringify(first)},{"id":"two","title":"Unfertig`;
  const parts = messagePlanParts(text);
  assert.equal(parts[0].text, '**Plan:**\n');
  assert.deepEqual(parts[1], { type: 'plan', tasks: [first], complete: false });
  assert.equal(parts.length, 2);
});

test('complete plans preserve following markdown and support multiple blocks', () => {
  const block = '[[TASK_PLAN]]{"tasks":[{"id":"one","title":"Ticket"}]}[[/TASK_PLAN]]';
  const parts = messagePlanParts(`${block}\n## Weiter\n${block}`);
  assert.equal(parts.filter(part => part.type === 'plan' && part.complete).length, 2);
  assert.equal(parts[1].text, '\n## Weiter\n');
});

test('empty, malformed and partial markers do not expose protocol JSON', () => {
  assert.deepEqual(messagePlanParts('Hallo [[TASK_PL'), [{ type: 'text', text: 'Hallo ' }]);
  assert.deepEqual(messagePlanParts('[[TASK_PLAN]]{"tasks":['), [{ type: 'plan', tasks: [], complete: false }]);
  assert.deepEqual(messagePlanParts('[[TASK_PLAN]]broken[[/TASK_PLAN]]'), [{ type: 'plan', tasks: [], complete: true }]);
  assert.deepEqual(messagePlanParts('**Normal**\n- Liste'), [{ type: 'text', text: '**Normal**\n- Liste' }]);
});
