export const TEAM_FORMAT = 'agent-teams-configuration';
export const MAX_TEAM_FILE_BYTES = 2 * 1024 * 1024;
const text = (value, limit = 160) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const list = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string').map(item => text(item)))].slice(0, 200) : [];
const quality = value => ({
  mode: ['inherit', 'off', 'auto', 'strong'].includes(value?.mode) ? value.mode : 'inherit',
  escalationProvider: text(value?.escalationProvider), escalationModel: text(value?.escalationModel),
  acceptanceCriteria: text(value?.acceptanceCriteria, 4000),
});

export function normalizeTeamDocument(value) {
  if (value?.format !== TEAM_FORMAT || value.version !== 1) throw new Error('Keine unterstützte Agenten-/Gruppendatei.');
  if (!Array.isArray(value.agents) || !Array.isArray(value.groups) || value.agents.length > 200 || value.groups.length > 100) throw new Error('Ungültige Datei oder zu viele Einträge.');
  const agents = value.agents.map(agent => ({
    id: text(agent?.id), name: text(agent?.name), role: text(agent?.role) || 'Agent',
    systemPm: agent?.systemPm === true || agent?.isSystemAgent === true,
    emoji: text(agent?.emoji, 20), color: Math.max(0, Math.min(7, Number(agent?.color) || 0)),
    provider: text(agent?.provider) || 'openai', model: text(agent?.model),
    systemPrompt: text(agent?.systemPrompt, 40000), capabilities: list(agent?.capabilities),
    qualityRouting: quality(agent?.qualityRouting),
  }));
  const groups = value.groups.map(group => ({
    id: text(group?.id), name: text(group?.name), emoji: text(group?.emoji, 20),
    agentIds: list(group?.agentIds), qualityRouting: quality(group?.qualityRouting),
    aiTemplate: { enabled: group?.aiTemplate?.enabled === true, provider: text(group?.aiTemplate?.provider), model: text(group?.aiTemplate?.model) },
    crossGroupCollaborationEnabled: group?.crossGroupCollaborationEnabled === true,
    crossGroupTargetGroupIds: list(group?.crossGroupTargetGroupIds),
  }));
  for (const entries of [agents, groups]) {
    if (entries.some(entry => !entry.id || !entry.name) || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('Namen oder eindeutige IDs fehlen.');
  }
  const agentIds = new Set(agents.map(agent => agent.id));
  const groupIds = new Set(groups.map(group => group.id));
  if (groups.some(group => group.agentIds.some(id => !agentIds.has(id)) || group.crossGroupTargetGroupIds.some(id => !groupIds.has(id)))) throw new Error('Die Datei verweist auf fehlende Agenten oder Gruppen.');
  if (!agents.length && !groups.length) throw new Error('Die Datei enthält keine Agenten oder Gruppen.');
  return { format: TEAM_FORMAT, version: 1, agents, groups };
}

export function createTeamExport({ agents, groups, agentIds = [], groupIds = [] }) {
  const selectedGroups = groups.filter(group => groupIds.includes(group.id));
  const includedAgentIds = new Set([...agentIds, ...selectedGroups.flatMap(group => group.agentIds || [])]);
  const selectedAgents = agents.filter(agent => includedAgentIds.has(agent.id));
  return normalizeTeamDocument({ format: TEAM_FORMAT, version: 1, agents: selectedAgents,
    groups: selectedGroups.map(group => ({ ...group, crossGroupTargetGroupIds: (group.crossGroupTargetGroupIds || []).filter(id => groupIds.includes(id)) })),
  });
}

export function prepareTeamImport(document, { agents = [], groups = [], createId = () => crypto.randomUUID() } = {}) {
  const normalized = normalizeTeamDocument(document);
  const uniqueName = (name, used) => {
    let candidate = name;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) candidate = `${name} (${suffix++})`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
  const agentNames = new Set(agents.map(agent => agent.name.toLowerCase()));
  const groupNames = new Set(groups.map(group => group.name.toLowerCase()));
  const localPm = agents.find(agent => agent.isSystemAgent);
  const agentMap = new Map(normalized.agents.map(agent => [agent.id, agent.systemPm && localPm ? localPm.id : createId()]));
  const groupMap = new Map(normalized.groups.map(group => [group.id, createId()]));
  const importedAgents = normalized.agents.filter(agent => !(agent.systemPm && localPm))
    .map(agent => ({ ...agent, id: agentMap.get(agent.id), name: uniqueName(agent.name, agentNames) }));
  const importedGroups = normalized.groups.map(group => ({ ...group, id: groupMap.get(group.id), name: uniqueName(group.name, groupNames),
    type: 'group', agentIds: group.agentIds.map(id => agentMap.get(id)),
    crossGroupTargetGroupIds: group.crossGroupTargetGroupIds.map(id => groupMap.get(id)),
    projectPath: '', mcpServers: [], memory: { enabled: false, provider: 'local', namespace: `import-${groupMap.get(group.id)}` },
  }));
  const renamed = new Map([
    ...normalized.agents.map(agent => [agent.name, importedAgents.find(item => item.id === agentMap.get(agent.id))?.name || localPm?.name || agent.name]),
    ...normalized.groups.map(group => [group.name, importedGroups.find(item => item.id === groupMap.get(group.id)).name]),
  ]);
  const names = [...renamed.keys()].sort((a, b) => b.length - a.length).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mentions = names.length ? new RegExp(`@(${names.join('|')})(?=$|[\\s:.,!?])`, 'g') : null;
  return {
    agents: importedAgents.map(agent => ({ ...agent, systemPrompt: mentions
      ? agent.systemPrompt.replace(mentions, (_, name) => `@${renamed.get(name)}`) : agent.systemPrompt })),
    groups: importedGroups,
  };
}
