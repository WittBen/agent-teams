import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTeamExport, prepareTeamImport, normalizeTeamDocument } from '../src/team-portability.mjs';

const agents = [{ id: 'pm', name: 'PM', isSystemAgent: true, role: 'Projektleiter' },
  { id: 'a', name: 'Alex', role: 'Developer', provider: 'codex', model: 'codex-default', systemPrompt: 'Arbeite sorgfältig.', apiKey: 'SECRET', capabilities: ['Code'], qualityRouting: { mode: 'strong' } }];
const groups = [{ id: 'g', name: 'Team', agentIds: ['pm', 'a'], projectPath: 'PRIVATE', mcpServers: [{ command: 'danger' }], memory: { filePath: 'PRIVATE' }, crossGroupTargetGroupIds: ['h'] },
  { id: 'h', name: 'Review', agentIds: ['a'] }];

test('group AI template survives export and import without credentials', () => {
  const aiTemplate = { enabled: true, provider: 'anthropic', model: 'shared-model' };
  const document = createTeamExport({ agents, groups: [{ ...groups[0], aiTemplate: { ...aiTemplate, apiKey: 'SECRET' } }], groupIds: ['g'] });
  assert.deepEqual(document.groups[0].aiTemplate, aiTemplate);
  let id = 0;
  assert.deepEqual(prepareTeamImport(document, { createId: () => `id-${++id}` }).groups[0].aiTemplate, aiTemplate);
});

test('group export includes members and uses a strict field allowlist', () => {
  const document = createTeamExport({ agents, groups, groupIds: ['g'] });
  assert.equal(document.agents.length, 2);
  assert.deepEqual(document.groups[0].crossGroupTargetGroupIds, []);
  assert.equal(JSON.stringify(document).includes('SECRET'), false);
  assert.equal(JSON.stringify(document).includes('PRIVATE'), false);
  assert.equal(JSON.stringify(document).includes('danger'), false);
  assert.equal(document.agents[1].systemPrompt, 'Arbeite sorgfältig.');
});

test('import remaps members and routes, reuses local system PM and does not overwrite existing entries', () => {
  const document = createTeamExport({ agents, groups, groupIds: ['g', 'h'] });
  let counter = 0;
  const imported = prepareTeamImport(document, { agents, groups, createId: () => `new-${++counter}` });
  assert.equal(imported.agents.length, 1);
  assert.equal(imported.agents[0].name, 'Alex (2)');
  assert.deepEqual(imported.groups[0].agentIds, ['pm', imported.agents[0].id]);
  assert.deepEqual(imported.groups[0].crossGroupTargetGroupIds, [imported.groups[1].id]);
  assert.equal(imported.groups[0].memory.enabled, false);
  assert.equal(agents[1].name, 'Alex');
});

test('standalone agent export and unsupported or dangling documents', () => {
  const document = createTeamExport({ agents, groups, agentIds: ['a'] });
  assert.equal(document.groups.length, 0);
  assert.throws(() => normalizeTeamDocument({ ...document, version: 99 }));
  assert.throws(() => normalizeTeamDocument({ ...document, agents: [...document.agents, ...document.agents] }));
  assert.throws(() => normalizeTeamDocument({ ...document, groups: [{ id: 'bad', name: 'Bad', agentIds: ['unknown'] }] }));
});

test('explicit mentions follow renamed imported agents and groups', () => {
  const document = createTeamExport({ agents, groups, groupIds: ['g'] });
  document.agents[1].systemPrompt = '@Alex: arbeite mit @Team. @Alexander bleibt erhalten.';
  const imported = prepareTeamImport(document, { agents, groups });
  assert.equal(imported.agents[0].systemPrompt, '@Alex (2): arbeite mit @Team (2). @Alexander bleibt erhalten.');
});
