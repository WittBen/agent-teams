import { createCrossGroupResultEntry, getMemoryAPI } from './memory-provider.js';
import { normalizeCrossGroupTargetIds } from './delegation.js';
import { MAX_CROSS_GROUP_REQUEST_DEPTH } from './cross-group.js';


export const MAX_PARALLEL_GROUP_REQUESTS = 3;

export const MAX_SPECIALISTS_PER_REQUEST = 3;

export function groupAgents(group, agents) {
  return agents.filter(agent => group?.agentIds?.includes(agent.id));
}

export function consultationSystemPrompt({
  agent,
  group,
  sourceGroupName,
  members = [],
  reachableGroups = [],
  specialists = false,
  taskDelegation = false,
  delegatedMembers = [],
  resumed = false,
}) {
  const eligibleMembers = delegatedMembers.length > 0 ? delegatedMembers : members;
  const localSpecialists = eligibleMembers.filter(member => member.id !== agent.id);
  const localRule = localSpecialists.length > 0
    ? `Verfügbare Spezialisten deiner eigenen Gruppe: ${localSpecialists.map(member => `${member.name} (${member.role || 'Agent'})`).join(', ')}.`
    : 'In deiner eigenen Gruppe ist kein weiterer Spezialist verfügbar.';
  const groupRule = reachableGroups.length > 0
    ? `Wenn dir für diese Aufgabe eine Information einer erreichbaren Gruppe fehlt, stelle genau diese Frage auf einer linkbündigen Zeile als „@Gruppenname: konkrete Informationsfrage“ und warte danach. Erreichbare Gruppen: ${reachableGroups.map(candidate => candidate.name).join(', ')}. Delegiere die vollständige Aufgabe nicht weiter.`
    : 'Für diese Anfrage ist keine weitere, noch nicht besuchte Zielgruppe erreichbar. Stelle keine gruppenübergreifende Anfrage.';
  return `${agent.systemPrompt || 'Du bist ein hilfreicher Assistent.'}

${taskDelegation
    ? `Du bist der verantwortliche Gruppen-PM und koordinierst eine vollständig delegierte Aufgabe der Gruppe „${sourceGroupName}“ in deiner Gruppe „${group.name}“. Die semantisch ausgewählten Gruppenmitglieder ${delegatedMembers.map(member => member.name).join(', ')} decken die benötigten Fähigkeiten ab.`
    : `Du bearbeitest eine Informationsanfrage der Gruppe „${sourceGroupName}“ an deine Gruppe „${group.name}“.`}
${resumed ? 'Eine zuvor benötigte Gruppeninformation liegt jetzt vor. Setze exakt dieselbe Aufgabe mit dieser Antwort fort und liefere anschließend das Ergebnis an die anfragende Gruppe.' : ''}
${taskDelegation && specialists
    ? 'Bearbeite die dir übergebene fachliche Teilaufgabe vollständig und liefere ein prüfbares Ergebnis mit Evidenz an den Gruppen-PM.'
    : taskDelegation
    ? `Erstelle einen kleinen ausführbaren Teilplan: Verteile die fachlich passenden Teile mit je einer linkbündigen Zeile „@Name: konkrete Teilaufgabe“ an die ausgewählten Mitglieder. Wenn du selbst ausgewählt bist, darfst du deinen Anteil direkt beantworten. Führe keine zusätzlichen Agenten ein. Sobald alle Ergebnisse vorliegen, synthetisiere die vollständige Antwort.`
    : specialists
    ? 'Beantworte ausschließlich die dir übergebene Teilfrage mit dem Wissen deiner Rolle und dem bereitgestellten Gruppenkontext.'
    : 'Du bist der verantwortliche Gruppen-PM. Beantworte die Anfrage selbst oder adressiere benötigte Spezialisten deiner eigenen Gruppe mit je einer linkbündigen Zeile im Format „@Name: konkrete Teilfrage“.'}
${localRule}
${specialists ? 'Als intern befragter Spezialist stellst du selbst keine Gruppenanfrage.' : groupRule}
Verändere keinen Workflow und erzeuge keinen [[TASK_PLAN]]- oder [[PROJECT_DONE]]-Block.
Stelle keine Rückfrage an den User. Erkläre Wissenslücken transparent.
Verwende ausschließlich die oben exakt genannten Agenten- und Gruppennamen.`;
}

export function requestExecutionKey(request) {
  return `group:${request.targetGroupId}`;
}

export function requestGroupPath(request) {
  const persistedPath = Array.isArray(request?.groupPath) ? request.groupPath.filter(Boolean) : [];
  return persistedPath.length > 0
    ? persistedPath
    : [request?.sourceGroupId, request?.targetGroupId].filter(Boolean);
}

export function reachableChildGroups(request, sourceGroup, groups) {
  if (!sourceGroup?.crossGroupCollaborationEnabled || (request?.depth || 0) >= MAX_CROSS_GROUP_REQUEST_DEPTH) return [];
  const configuredTargets = new Set(normalizeCrossGroupTargetIds(
    sourceGroup?.crossGroupTargetGroupIds,
    sourceGroup?.crossGroupTargetGroupId,
  ));
  const visited = new Set([
    ...requestGroupPath(request),
    ...(request?.visitedGroupIds || []),
    ...(request?.childResponses || []).map(response => response.groupId),
  ]);
  return groups.filter(group => configuredTargets.has(group.id) && !visited.has(group.id));
}

export function formatChildResponseContext(responses = []) {
  if (responses.length === 0) return '';
  return responses.map(response => {
    const result = response.status === 'answered'
      ? response.answer
      : `Die Unteranfrage endete mit ${response.status}: ${response.error || 'keine Antwort verfügbar'}`;
    return `Antwort von „${response.groupName}“ auf „${response.question}“:\n${result}`;
  }).join('\n\n');
}

export function compactContextExcerpt(value, maxLength) {
  const compact = String(value || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function buildProcessedContextSummary(request, pmReply, localFindings = '') {
  const previous = compactContextExcerpt(request?.processedContextSummary || request?.interimReply, 1800);
  const current = compactContextExcerpt(pmReply, 2800);
  const findings = compactContextExcerpt(localFindings, 1200);
  return [
    previous && `Bisheriger verarbeiteter Stand:\n${previous}`,
    current && `Aktueller PM-Stand:\n${current}`,
    findings && `Lokale Fachresultate:\n${findings}`,
  ].filter(Boolean).join('\n\n').slice(0, 6000);
}

export async function memoryContextFor(group, agent, question, taskId) {
  const config = group?.memory;
  if (!config?.enabled || !config.namespace) return '';
  try {
    return await getMemoryAPI(config).getContextForAgent(config.namespace, question, agent.name, 6, { taskId });
  } catch {
    return '';
  }
}

export function memoryDestinationFor(group) {
  const config = group?.memory;
  if (!config?.enabled || !String(config.namespace || '').trim()) return null;
  const provider = config.provider === 'file' ? 'file' : 'local';
  const filePath = provider === 'file'
    ? String(config.filePath || '').trim().replace(/\\/g, '/').toLowerCase()
    : 'app-local';
  if (provider === 'file' && !filePath) return null;
  return {
    config,
    groupId: group.id,
    namespace: String(config.namespace).trim(),
    key: `${provider}:${filePath}:${String(config.namespace).trim()}`,
  };
}

export async function persistCrossGroupResultMemory({ request, sourceGroup, targetGroup, pm, finalAnswer }) {
  const destinationsByKey = new Map();
  for (const destination of [memoryDestinationFor(targetGroup), memoryDestinationFor(sourceGroup)].filter(Boolean)) {
    const existing = destinationsByKey.get(destination.key);
    if (existing) {
      existing.groupIds.push(destination.groupId);
    } else {
      destinationsByKey.set(destination.key, { ...destination, groupIds: [destination.groupId] });
    }
  }
  const storedGroupIds = [];
  const errors = [];

  for (const destination of destinationsByKey.values()) {
    try {
      const entry = createCrossGroupResultEntry({
        namespace: destination.namespace,
        requestId: request.id,
        requestKind: request.kind,
        question: request.question,
        answer: finalAnswer,
        sourceGroupId: sourceGroup.id,
        sourceGroupName: sourceGroup.name,
        targetGroupId: targetGroup.id,
        targetGroupName: targetGroup.name,
        sourceTaskId: request.sourceTaskId,
        sourceTaskTitle: request.sourceTaskTitle,
        author: pm.name,
      });
      await getMemoryAPI(destination.config).writeOnce(destination.namespace, entry);
      storedGroupIds.push(...destination.groupIds);
    } catch (error) {
      errors.push(String(error?.message || error).slice(0, 500));
    }
  }

  return { storedGroupIds: [...new Set(storedGroupIds)], errors };
}
