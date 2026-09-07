import { useEffect, useRef } from 'react';
import { useStore } from './store';
import { callLLM } from './llm';
import {
  assessTaskComplexity,
  resolveQualityPolicy,
  runQualityCascade,
} from './quality-cascade';
import {
  buildRelevantConversationHistory,
  cleanAgentReply,
  extractHandoffsFromReply,
  getGroupPMAgent,
  isAgentTimeoutError,
} from './orchestrator';
import { createCrossGroupResultEntry, getMemoryAPI } from './memory-provider';
import { acquireAgentLease } from './agent-runtime';
import { matchGroupCapabilities, normalizeCrossGroupTargetIds } from './delegation';
import {
  createCrossGroupRequest,
  extractGroupMentions,
  extractUnknownDirectedMentions,
  finishRequestRuntimePlan,
  getUnprocessedChildResponses,
  MAX_CROSS_GROUP_REQUEST_DEPTH,
  resolveChildRequestBatch,
  updateRequestRuntimePlan,
} from './cross-group';
import { updateTaskNodeStatus } from './task-graph';
import { useI18n } from './i18n';

const MAX_PARALLEL_GROUP_REQUESTS = 3;
const MAX_SPECIALISTS_PER_REQUEST = 3;

function groupAgents(group, agents) {
  return agents.filter(agent => group?.agentIds?.includes(agent.id));
}

function consultationSystemPrompt({
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

function requestExecutionKey(request) {
  return `group:${request.targetGroupId}`;
}

function requestGroupPath(request) {
  const persistedPath = Array.isArray(request?.groupPath) ? request.groupPath.filter(Boolean) : [];
  return persistedPath.length > 0
    ? persistedPath
    : [request?.sourceGroupId, request?.targetGroupId].filter(Boolean);
}

function reachableChildGroups(request, sourceGroup, groups) {
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

function formatChildResponseContext(responses = []) {
  if (responses.length === 0) return '';
  return responses.map(response => {
    const result = response.status === 'answered'
      ? response.answer
      : `Die Unteranfrage endete mit ${response.status}: ${response.error || 'keine Antwort verfügbar'}`;
    return `Antwort von „${response.groupName}“ auf „${response.question}“:\n${result}`;
  }).join('\n\n');
}

function compactContextExcerpt(value, maxLength) {
  const compact = String(value || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function buildProcessedContextSummary(request, pmReply, localFindings = '') {
  const previous = compactContextExcerpt(request?.processedContextSummary || request?.interimReply, 1800);
  const current = compactContextExcerpt(pmReply, 2800);
  const findings = compactContextExcerpt(localFindings, 1200);
  return [
    previous && `Bisheriger verarbeiteter Stand:\n${previous}`,
    current && `Aktueller PM-Stand:\n${current}`,
    findings && `Lokale Fachresultate:\n${findings}`,
  ].filter(Boolean).join('\n\n').slice(0, 6000);
}

async function memoryContextFor(group, agent, question) {
  const config = group?.memory;
  if (!config?.enabled || !config.namespace) return '';
  try {
    return await getMemoryAPI(config).getContextForAgent(config.namespace, question, agent.name, 6);
  } catch {
    return '';
  }
}

function memoryDestinationFor(group) {
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

/**
 * Persist only the successful, synthesized result. Intermediate specialist
 * messages and child-request chatter stay out of memory. Identical destinations
 * are collapsed so groups intentionally sharing one memory space store it once.
 */
async function persistCrossGroupResultMemory({ request, sourceGroup, targetGroup, pm, finalAnswer }) {
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

export default function CrossGroupCoordinator() {
  const { t } = useI18n();
  const {
    agents,
    groups,
    messages,
    conversationStates,
    crossGroupRequests,
    apiKeys,
    providerConnections,
    qualityRouting,
    addMessage,
    enqueueUserRequest,
    enqueueCrossGroupRequest,
    saveConversationState,
    recordQualityEvent,
    updateTaskGraph,
    updateCrossGroupRequest,
  } = useStore();
  const runningRequestIdsRef = useRef(new Set());
  const runningExecutionKeysRef = useRef(new Set());
  const deliveringBatchIdsRef = useRef(new Set());
  const requestsRef = useRef(crossGroupRequests);
  requestsRef.current = crossGroupRequests;

  useEffect(() => {
    const providerModelsById = Object.fromEntries(
      providerConnections.map(connection => [connection.id, connection.models || []]),
    );
    const executeQualityCall = async ({
      request,
      group,
      agent,
      objective,
      history,
      systemPrompt,
      memoryContext = '',
      projectPath = '',
      requestId,
    }) => {
      const complexity = assessTaskComplexity({
        objective,
        source: `cross-group-${request.kind}`,
        attachmentCount: request.attachments?.length || 0,
      });
      const policy = resolveQualityPolicy({
        globalConfig: qualityRouting,
        groupConfig: group.qualityRouting,
        agentConfig: agent.qualityRouting,
        messageMode: request.qualityMode || 'auto',
        complexity,
        agent,
        providerModelsById,
      });
      const qualitySystemPrompt = policy.acceptanceCriteria
        ? `${systemPrompt}\n\nZusätzliche Akzeptanzkriterien für diesen Agenten:\n${policy.acceptanceCriteria}`
        : systemPrompt;
      const result = await runQualityCascade({
        agent,
        policy,
        history,
        objective,
        complexity,
        systemContext: `${qualitySystemPrompt}${memoryContext}`,
        call: ({ agent: modelAgent, history: modelHistory, phase }) => callLLM({
          apiKeys,
          providerConnections,
          agent: modelAgent,
          history: modelHistory,
          userMessage: null,
          kbContext: memoryContext,
          isolatedSession: { systemPrompt: qualitySystemPrompt },
          projectPath,
          requestId: `${requestId}-${phase}`,
        }),
      });
      recordQualityEvent({
        outcome: result.outcome,
        unresolved: result.unresolved,
        estimatedInputTokens: result.estimatedInputTokens,
        estimatedOutputTokens: result.estimatedOutputTokens,
      });
      if (result.didEscalate) {
        addMessage(group.id, {
          id: `cross-group-quality-${requestId}`,
          agentId: 'system',
          senderName: 'System',
          text: result.escalationFailed
            ? `⚠️|${t('{agent}: Die stärkere Modellstufe war nicht verfügbar. Das erste Ergebnis wird beibehalten: {error}', {
              agent: agent.name,
              error: result.escalationError?.message || t('unbekannter Fehler'),
            })}`
            : `🧠|${t('{agent}: Die Qualitätsprüfung fordert eine stärkere Modellstufe ({from} → {to}).', {
              agent: agent.name,
              from: agent.model,
              to: result.selectedAgent.model,
            })}`,
          ts: Date.now(),
          isError: false,
          crossGroupRequestId: request.id,
        });
      }
      if (!result.reply?.trim()) throw new Error('Der Agent hat keine verwertbare Antwort geliefert.');
      return result;
    };
    const queued = Object.values(crossGroupRequests || {})
      .filter(request => request.status === 'queued')
      .sort((left, right) => left.createdAt - right.createdAt);
    const availableSlots = Math.max(0, MAX_PARALLEL_GROUP_REQUESTS - runningRequestIdsRef.current.size);
    if (!availableSlots) return;
    const launchable = [];
    for (const request of queued) {
      if (launchable.length >= availableSlots) break;
      if (
        runningRequestIdsRef.current.has(request.id) ||
        runningExecutionKeysRef.current.has(requestExecutionKey(request)) ||
        launchable.some(candidate => requestExecutionKey(candidate) === requestExecutionKey(request))
      ) continue;
      launchable.push(request);
    }

    for (const request of launchable) {
      runningRequestIdsRef.current.add(request.id);
      runningExecutionKeysRef.current.add(requestExecutionKey(request));
      void (async () => {
        const targetGroup = groups.find(group => group.id === request.targetGroupId);
        const sourceGroup = groups.find(group => group.id === request.sourceGroupId);
        const members = groupAgents(targetGroup, agents);
        const pm = getGroupPMAgent('group', members);
        const capabilityMatch = request.kind === 'task_delegation'
          ? matchGroupCapabilities(targetGroup, agents, request.requiredCapabilities)
          : null;
        const delegatedAgents = capabilityMatch?.covers
          ? capabilityMatch.members.map(member => members.find(agent => agent.id === member.agentId)).filter(Boolean)
          : [];
        // Every incoming request is owned and planned by the receiving PM. The
        // selected experts execute only the PM's persisted runtime steps.
        const leadAgent = pm;
        const runtimeKey = `attempt-${request.attempt}-resume-${request.resumeCount || 0}`;
        const pmStepId = `${request.id}-${runtimeKey}-${request.resumeCount ? 'synthesis' : 'planning'}`;
        let runtimePlan = request.runtimePlan;
        const persistRuntimePlan = (status, steps = []) => {
          runtimePlan = updateRequestRuntimePlan(runtimePlan, { status, steps });
          updateCrossGroupRequest(request.id, { runtimePlan });
        };
        try {
          if (!targetGroup || !sourceGroup) throw new Error('Quell- oder Zielgruppe ist nicht mehr verfügbar.');
          if (!sourceGroup.crossGroupCollaborationEnabled) {
            throw new Error('Ausgehende Gruppenanfragen sind für die Quellgruppe deaktiviert.');
          }
          if (!normalizeCrossGroupTargetIds(sourceGroup.crossGroupTargetGroupIds, sourceGroup.crossGroupTargetGroupId).includes(targetGroup.id)) {
            throw new Error('Die Zielgruppe ist für die Quellgruppe nicht mehr als erreichbare Gruppe festgelegt.');
          }
          if (!leadAgent) throw new Error(`Die Zielgruppe „${targetGroup.name}“ besitzt keinen verfügbaren PM.`);
          if (request.kind === 'task_delegation' && !capabilityMatch?.covers) {
            throw new Error(`Die Zielgruppe besitzt nicht mehr die für die delegierte Aufgabe benötigte Kompetenzabdeckung.`);
          }
          const unprocessedChildResponses = getUnprocessedChildResponses(request);
          const childResponseContext = formatChildResponseContext(unprocessedChildResponses);
          const processedChildResponseIds = [...new Set([
            ...(request.processedChildResponseIds || []),
            ...unprocessedChildResponses.map(response => response.requestId),
          ])].slice(-60);
          const resumed = Boolean(request.resumeCount > 0 && childResponseContext);
          const availableChildGroups = reachableChildGroups(request, targetGroup, groups);
          const now = Date.now();
          persistRuntimePlan(resumed ? 'executing' : 'planning', [{
            id: pmStepId,
            kind: resumed ? 'pm_synthesis' : 'pm_planning',
            title: resumed ? 'Antworten der Unteranfragen auswerten' : 'Anfrage prüfen und Teilplan erstellen',
            agentId: pm.id,
            agentName: pm.name,
            status: 'running',
            attempt: request.attempt,
            resumeCount: request.resumeCount || 0,
            createdAt: now,
            startedAt: now,
          }]);
          updateCrossGroupRequest(request.id, {
            status: 'running',
            startedAt: now,
            targetPmAgentId: pm.id,
            targetPmAgentName: pm.name,
            targetAgentId: delegatedAgents[0]?.id || leadAgent.id,
            targetAgentName: delegatedAgents.map(agent => agent.name).join(' + ') || leadAgent.name,
            targetAgentIds: delegatedAgents.map(agent => agent.id),
            targetAgentNames: delegatedAgents.map(agent => agent.name),
          });

          const incomingMessage = {
            id: `cross-group-incoming-${request.id}-attempt-${request.attempt}-resume-${request.resumeCount || 0}`,
            agentId: `group:${sourceGroup.id}`,
            senderName: sourceGroup.name,
            text: resumed
              ? `↩ Unteranfrage beantwortet – ursprüngliche ${request.kind === 'task_delegation' ? 'Aufgabe' : 'Informationsanfrage'} wird fortgesetzt\n${childResponseContext}`
              : `${request.kind === 'task_delegation' ? '⇄ Delegierte Aufgabe' : '↗ Informationsanfrage'}\n${request.question}`,
            ts: Date.now(),
            crossGroupRequestId: request.id,
            crossGroupDirection: 'incoming',
            ...(request.attachments?.length ? { attachments: request.attachments } : {}),
          };
          addMessage(targetGroup.id, incomingMessage);
          const requestContextIds = new Set([
            request.id,
            ...(request.childRequestIds || []),
            ...(request.childResponses || []).map(response => response.requestId),
          ]);
          const targetHistory = buildRelevantConversationHistory({
            history: (messages[targetGroup.id] || []).filter(message => (
              !requestContextIds.has(message.crossGroupRequestId) &&
              !(Array.isArray(message.crossGroupRequestIds) ? message.crossGroupRequestIds : [])
                .some(requestId => requestContextIds.has(requestId))
            )),
            agent: leadAgent,
            chatType: 'group',
            includeGroupContext: true,
            query: request.question,
            requireQueryMatch: true,
            groupLimit: 6,
            maxCharacters: 12000,
          });
          const pmMemory = await memoryContextFor(targetGroup, leadAgent, request.question);
          const releasePm = await acquireAgentLease(leadAgent.id);
          let pmReply;
          let pmModelAgent = leadAgent;
          try {
            const pmSystemPrompt = consultationSystemPrompt({
              agent: leadAgent,
              group: targetGroup,
              sourceGroupName: sourceGroup.name,
              members,
              reachableGroups: availableChildGroups,
              taskDelegation: request.kind === 'task_delegation',
              delegatedMembers: delegatedAgents,
              resumed,
            });
            const callPm = (prompt, requestIdSuffix = '') => executeQualityCall({
              request,
              group: targetGroup,
              agent: leadAgent,
              objective: request.question,
              history: [...targetHistory, {
                id: `cross-group-pm-input-${request.id}${requestIdSuffix}`,
                agentId: 'user',
                senderName: sourceGroup.name,
                text: prompt,
                ts: Date.now(),
                ...(request.attachments?.length ? { attachments: request.attachments } : {}),
              }],
              systemPrompt: pmSystemPrompt,
              memoryContext: pmMemory,
              projectPath: targetGroup.projectPath || '',
              requestId: `cross-group-${request.id}-pm-${request.attempt}-resume-${request.resumeCount || 0}${requestIdSuffix}`,
            });
            const initialPrompt = resumed
              ? `Setze die ${request.kind === 'task_delegation' ? 'delegierte Aufgabe' : 'Informationsanfrage'} von „${sourceGroup.name}“ fort.\n\nUrsprüngliche Aufgabe:\n${request.question}\n\nKompakter, bereits verarbeiteter Stand:\n${request.processedContextSummary || compactContextExcerpt(request.interimReply, 1800) || 'Noch keiner.'}\n\nNur neu eingetroffene Ergebnisse der Unteranfragen:\n${childResponseContext}`
              : `${request.kind === 'task_delegation' ? 'Delegierte Aufgabe' : 'Informationsanfrage'} von „${sourceGroup.name}“:\n${request.question}`;
            let pmExecution = await callPm(initialPrompt);
            pmReply = pmExecution.reply;
            pmModelAgent = pmExecution.selectedAgent;

            // Unknown @targets used to be silently ignored, causing the PM to
            // report success although no expert had run. Give the PM one
            // constrained correction pass, then surface a real workflow error.
            const allowedNames = [
              ...(request.kind === 'task_delegation' ? delegatedAgents : members).map(member => member.name),
              ...availableChildGroups.map(group => group.name),
            ];
            let unknownMentions = extractUnknownDirectedMentions(pmReply, allowedNames);
            if (unknownMentions.length > 0) {
              pmExecution = await callPm(
                `${initialPrompt}\n\nDein vorheriger Entwurf enthielt unbekannte Ziele: ${unknownMentions.join(', ')}. Korrigiere den Teilplan vollständig. Erlaubt sind ausschließlich diese exakten Namen: ${allowedNames.join(', ')}. Wenn kein Spezialist nötig ist, antworte direkt ohne @-Zeile.\n\nVorheriger Entwurf:\n${cleanAgentReply(pmReply)}`,
                '-correction',
              );
              pmReply = pmExecution.reply;
              pmModelAgent = pmExecution.selectedAgent;
              unknownMentions = extractUnknownDirectedMentions(pmReply, allowedNames);
              if (unknownMentions.length > 0) {
                throw new Error(`Der PM-Teilplan enthält unbekannte Ziele: ${unknownMentions.join(', ')}.`);
              }
            }
          } finally {
            releasePm();
          }
          if (!requestsRef.current?.[request.id] || requestsRef.current[request.id].status === 'cancelled') return;
          const pmMessage = {
            id: `cross-group-pm-${request.id}-attempt-${request.attempt}-resume-${request.resumeCount || 0}`,
            agentId: leadAgent.id,
            senderName: leadAgent.name,
            text: cleanAgentReply(pmReply),
            ts: Date.now(),
            provider: pmModelAgent.provider,
            model: pmModelAgent.model,
            crossGroupRequestId: request.id,
          };
          addMessage(targetGroup.id, pmMessage);
          persistRuntimePlan('executing', [{
            id: pmStepId,
            status: 'completed',
            completedAt: Date.now(),
          }]);

          const childMentions = extractGroupMentions(pmReply, availableChildGroups, {
            sourceGroupId: targetGroup.id,
            userAuthored: false,
          });
          let specialistHandoffs = extractHandoffsFromReply(
            pmReply,
            pm,
            request.kind === 'task_delegation' ? delegatedAgents : members,
          ).slice(0, MAX_SPECIALISTS_PER_REQUEST);
          if (request.kind === 'task_delegation' && childMentions.length === 0) {
            // A PM may answer without emitting a handoff despite the strict
            // contract. Complete its plan with any capability-selected experts
            // that have not run yet instead of accepting an unperformed task.
            const completedAgentIds = new Set(runtimePlan.steps
              .filter(step => step.kind === 'agent_task' && step.status === 'completed')
              .map(step => step.agentId));
            const assignedNames = new Set(specialistHandoffs.map(handoff => handoff.to.toLocaleLowerCase()));
            const missingHandoffs = delegatedAgents
              .filter(agent => agent.id !== pm.id && !completedAgentIds.has(agent.id) && !assignedNames.has(agent.name.toLocaleLowerCase()))
              .map(agent => ({ to: agent.name, summary: request.question }));
            specialistHandoffs = [...specialistHandoffs, ...missingHandoffs].slice(0, MAX_SPECIALISTS_PER_REQUEST);
          }
          const specialistSteps = specialistHandoffs.map((handoff, index) => {
            const specialist = members.find(agent => agent.name.toLowerCase() === handoff.to.toLowerCase());
            return {
              id: `${request.id}-${runtimeKey}-expert-${specialist?.id || index}`,
              kind: 'agent_task',
              title: handoff.summary || request.question,
              agentId: specialist?.id || '',
              agentName: specialist?.name || handoff.to,
              parentStepId: pmStepId,
              status: 'running',
              attempt: request.attempt,
              resumeCount: request.resumeCount || 0,
              createdAt: Date.now(),
              startedAt: Date.now(),
            };
          });
          if (specialistSteps.length > 0) persistRuntimePlan('executing', specialistSteps);
          const specialistResults = await Promise.all(specialistHandoffs.map(async (handoff, index) => {
            const specialist = members.find(agent => agent.name.toLowerCase() === handoff.to.toLowerCase());
            if (!specialist || specialist.id === pm.id) return null;
            const runtimeStep = specialistSteps[index];
            const specialistObjective = handoff.summary || request.question;
            const specialistMemory = await memoryContextFor(targetGroup, specialist, specialistObjective);
            const releaseSpecialist = await acquireAgentLease(specialist.id);
            try {
              const specialistPrompt = specialistObjective === request.question
                ? specialistObjective
                : `Zugewiesene Teilaufgabe:\n${specialistObjective}\n\nAusgangsanfrage, soweit für diese Teilaufgabe nötig:\n${compactContextExcerpt(request.question, 4000)}`;
              const specialistExecution = await executeQualityCall({
                request,
                group: targetGroup,
                agent: specialist,
                objective: specialistObjective,
                history: [{
                  id: `cross-group-specialist-input-${request.id}-${specialist.id}`,
                  agentId: 'user',
                  senderName: leadAgent.name,
                  text: specialistPrompt,
                  ts: Date.now(),
                  ...(request.attachments?.length ? { attachments: request.attachments } : {}),
                }],
                systemPrompt: consultationSystemPrompt({
                  agent: specialist,
                  group: targetGroup,
                  sourceGroupName: sourceGroup.name,
                  members,
                  taskDelegation: request.kind === 'task_delegation',
                  delegatedMembers: delegatedAgents,
                  specialists: true,
                  resumed,
                }),
                memoryContext: specialistMemory,
                projectPath: targetGroup.projectPath || '',
                requestId: `cross-group-${request.id}-${specialist.id}-${request.attempt}-resume-${request.resumeCount || 0}`,
              });
              if (!requestsRef.current?.[request.id] || requestsRef.current[request.id].status === 'cancelled') return null;
              const answer = cleanAgentReply(specialistExecution.reply);
              addMessage(targetGroup.id, {
                id: `cross-group-specialist-${request.id}-${specialist.id}-attempt-${request.attempt}-resume-${request.resumeCount || 0}`,
                agentId: specialist.id,
                senderName: specialist.name,
                text: answer,
                ts: Date.now(),
                provider: specialistExecution.selectedAgent.provider,
                model: specialistExecution.selectedAgent.model,
                crossGroupRequestId: request.id,
              });
              persistRuntimePlan('executing', [{
                id: runtimeStep.id,
                status: 'completed',
                completedAt: Date.now(),
              }]);
              return { specialist, answer, modelAgent: specialistExecution.selectedAgent };
            } finally {
              releaseSpecialist();
            }
          }));

          const usableResults = specialistResults.filter(Boolean);
          if (!requestsRef.current?.[request.id] || requestsRef.current[request.id].status === 'cancelled') return;
          const childBatchId = `nested-group-request-batch-${request.id}-${request.resumeCount || 0}`;
          const childRequests = childMentions.map(mention => createCrossGroupRequest({
            sourceGroup: targetGroup,
            sourceAgent: leadAgent,
            targetGroup: mention.group,
            question: mention.question,
            attachments: request.attachments || [],
            batchId: childBatchId,
            origin: 'agent',
            kind: 'consultation',
            depth: (request.depth || 0) + 1,
            parentRequestId: request.id,
            rootRequestId: request.rootRequestId || request.id,
            groupPath: requestGroupPath(request),
            visitedGroupIds: request.visitedGroupIds || [],
            qualityMode: request.qualityMode || 'auto',
          })).filter(Boolean);
          if (childRequests.length > 0) {
            childRequests.forEach(enqueueCrossGroupRequest);
            const localFindings = usableResults.map(({ specialist, answer }) => `${specialist.name}: ${answer}`).join('\n\n');
            const processedContextSummary = buildProcessedContextSummary(
              request,
              cleanAgentReply(pmReply),
              localFindings,
            );
            persistRuntimePlan('waiting_child', childRequests.map(childRequest => ({
              id: `${request.id}-${runtimeKey}-wait-${childRequest.id}`,
              kind: 'group_wait',
              title: childRequest.question,
              targetGroupId: childRequest.targetGroupId,
              targetGroupName: childRequest.targetGroupName,
              parentStepId: pmStepId,
              status: 'waiting_child',
              attempt: request.attempt,
              resumeCount: request.resumeCount || 0,
              createdAt: Date.now(),
              startedAt: Date.now(),
            })));
            updateCrossGroupRequest(request.id, {
              status: 'waiting_child',
              childRequestIds: childRequests.map(childRequest => childRequest.id),
              processedChildResponseIds,
              processedContextSummary,
              interimReply: processedContextSummary,
              waitingChildGroupNames: childRequests.map(childRequest => childRequest.targetGroupName),
              error: '',
            });
            addMessage(targetGroup.id, {
              id: `cross-group-child-wait-${request.id}-${request.resumeCount || 0}`,
              agentId: 'system',
              senderName: 'System',
              text: `↗|${t('{agent} wartet innerhalb der Anfrage auf {groups}. Danach wird dieselbe Aufgabe automatisch fortgesetzt.', {
                agent: leadAgent.name,
                groups: childRequests.map(childRequest => childRequest.targetGroupName).join(', '),
              })}`,
              ts: Date.now(),
              isError: false,
              crossGroupRequestId: request.id,
            });
            return;
          }
          let finalAnswer = cleanAgentReply(pmReply);
          if (usableResults.length > 0) {
            const synthesisStepId = `${request.id}-${runtimeKey}-final-synthesis`;
            persistRuntimePlan('executing', [{
              id: synthesisStepId,
              kind: 'pm_synthesis',
              title: 'Fachantworten prüfen und Gesamtergebnis formulieren',
              agentId: pm.id,
              agentName: pm.name,
              parentStepId: pmStepId,
              status: 'running',
              attempt: request.attempt,
              resumeCount: request.resumeCount || 0,
              createdAt: Date.now(),
              startedAt: Date.now(),
            }]);
            const releaseSynthesis = await acquireAgentLease(pm.id);
            let synthesisModelAgent = pm;
            try {
              const synthesisExecution = await executeQualityCall({
                request,
                group: targetGroup,
                agent: pm,
                objective: request.question,
                history: [...usableResults.map(({ specialist, answer }) => ({
                  id: `finding-${specialist.id}`,
                  agentId: specialist.id,
                  senderName: specialist.name,
                  text: compactContextExcerpt(answer, 8000),
                  ts: Date.now(),
                })), {
                  id: `cross-group-synthesis-input-${request.id}`,
                  agentId: 'user',
                  senderName: 'Syntheseauftrag',
                  text: `Ursprüngliche Anfrage:\n${compactContextExcerpt(request.question, 5000)}\n\nFormuliere aus den einmalig bereitgestellten Fachantworten die endgültige, eigenständige Antwort an die Gruppe „${sourceGroup.name}“. Verwende keine @-Erwähnungen und keine Workflow-Marker.`,
                  ts: Date.now(),
                }],
                systemPrompt: consultationSystemPrompt({
                  agent: pm,
                  group: targetGroup,
                  sourceGroupName: sourceGroup.name,
                  members,
                  specialists: true,
                  resumed,
                }),
                memoryContext: pmMemory,
                projectPath: targetGroup.projectPath || '',
                requestId: `cross-group-${request.id}-synthesis-${request.attempt}-resume-${request.resumeCount || 0}`,
              });
              synthesisModelAgent = synthesisExecution.selectedAgent;
              finalAnswer = cleanAgentReply(synthesisExecution.reply);
              persistRuntimePlan('executing', [{
                id: synthesisStepId,
                status: 'completed',
                completedAt: Date.now(),
              }]);
            } finally {
              releaseSynthesis();
            }
            addMessage(targetGroup.id, {
              id: `cross-group-final-${request.id}-attempt-${request.attempt}-resume-${request.resumeCount || 0}`,
              agentId: pm.id,
              senderName: pm.name,
              text: finalAnswer,
              ts: Date.now(),
              provider: synthesisModelAgent.provider,
              model: synthesisModelAgent.model,
              crossGroupRequestId: request.id,
            });
          }
          if (!finalAnswer) throw new Error('Die Zielgruppe hat keine verwertbare Antwort geliefert.');
          if (!requestsRef.current?.[request.id] || requestsRef.current[request.id].status === 'cancelled') return;
          const memoryPersistence = await persistCrossGroupResultMemory({
            request,
            sourceGroup,
            targetGroup,
            pm,
            finalAnswer,
          });
          if (!requestsRef.current?.[request.id] || requestsRef.current[request.id].status === 'cancelled') return;
          runtimePlan = finishRequestRuntimePlan(runtimePlan, 'completed');
          updateCrossGroupRequest(request.id, {
            status: 'answered',
            answer: finalAnswer,
            processedChildResponseIds,
            processedContextSummary: buildProcessedContextSummary(request, finalAnswer),
            answeredByAgentId: pm.id,
            answeredByAgentName: pm.name,
            completedAt: Date.now(),
            error: '',
            runtimePlan,
            memoryStoredAt: memoryPersistence.storedGroupIds.length > 0 ? Date.now() : undefined,
            memoryStoredGroupIds: memoryPersistence.storedGroupIds,
            memoryStorageErrors: memoryPersistence.errors,
          });
        } catch (error) {
          if (!requestsRef.current?.[request.id] || requestsRef.current[request.id].status === 'cancelled') return;
          const timedOut = isAgentTimeoutError(error);
          const status = timedOut ? 'timed_out' : 'failed';
          runtimePlan = finishRequestRuntimePlan(runtimePlan, status, String(error?.message || 'Unbekannter Fehler'));
          updateCrossGroupRequest(request.id, {
            status,
            error: String(error?.message || 'Unbekannter Fehler').slice(0, 2000),
            completedAt: Date.now(),
            runtimePlan,
          });
          const errorMessage = {
            id: `cross-group-error-${request.id}-attempt-${request.attempt}`,
            agentId: 'system',
            senderName: 'System',
            text: `↗|${t(timedOut
              ? 'Gruppenanfrage an {group} lief in einen Timeout: {error}'
              : 'Gruppenanfrage an {group} ist fehlgeschlagen: {error}', {
              group: request.targetGroupName,
              error: error?.message || t('Unbekannter Fehler'),
            })}`,
            ts: Date.now(),
            isError: true,
            crossGroupRequestId: request.id,
          };
          addMessage(request.sourceGroupId, errorMessage);
          if (targetGroup) addMessage(targetGroup.id, { ...errorMessage, id: `${errorMessage.id}-target` });
        } finally {
          runningRequestIdsRef.current.delete(request.id);
          runningExecutionKeysRef.current.delete(requestExecutionKey(request));
        }
      })();
    }
  }, [addMessage, agents, apiKeys, crossGroupRequests, enqueueCrossGroupRequest, groups, messages, providerConnections, qualityRouting, recordQualityEvent, t, updateCrossGroupRequest]);

  // Child requests return to their parent request, not to the source workflow.
  // Once every child has reached a terminal state, the exact parent task is
  // queued again with the collected answers or errors as continuation context.
  useEffect(() => {
    const waitingParents = Object.values(crossGroupRequests || {})
      .filter(request => request.status === 'waiting_child' && request.childRequestIds?.length > 0);
    for (const parent of waitingParents) {
      const deliveryKey = `parent:${parent.id}`;
      if (deliveringBatchIdsRef.current.has(deliveryKey)) continue;
      const resolution = resolveChildRequestBatch(crossGroupRequests, parent.id);
      if (!resolution) continue;
      const { children, responses: childResponses, visitedGroupIds } = resolution;
      deliveringBatchIdsRef.current.add(deliveryKey);
      const answerText = childResponses.map(response => (
        `**${response.groupName}**\n${response.status === 'answered'
          ? response.answer
          : `Unteranfrage ${response.status}: ${response.error || t('keine Antwort verfügbar')}`}`
      )).join('\n\n');
      addMessage(parent.targetGroupId, {
        id: `cross-group-child-answer-${parent.id}-${parent.resumeCount || 0}`,
        agentId: `group:${children.length === 1 ? children[0].targetGroupId : 'multiple'}`,
        senderName: children.length === 1 ? children[0].targetGroupName : t('Gruppenantworten'),
        text: answerText,
        ts: Date.now(),
        crossGroupRequestIds: children.map(child => child.id),
        crossGroupDirection: 'child-answer',
      });
      const resumedRuntimePlan = updateRequestRuntimePlan(parent.runtimePlan, {
        status: 'queued',
        steps: (parent.runtimePlan?.steps || [])
          .filter(step => step.status === 'waiting_child')
          .map(step => ({ ...step, status: 'completed', completedAt: Date.now() })),
      });
      updateCrossGroupRequest(parent.id, {
        status: 'queued',
        childRequestIds: [],
        childResponses: [...(parent.childResponses || []), ...childResponses],
        visitedGroupIds: [...new Set([...(parent.visitedGroupIds || []), ...visitedGroupIds])],
        resumeCount: (parent.resumeCount || 0) + 1,
        waitingChildGroupNames: [],
        startedAt: undefined,
        completedAt: undefined,
        error: '',
        runtimePlan: resumedRuntimePlan,
      });
      const deliveredAt = Date.now();
      children.forEach(child => updateCrossGroupRequest(child.id, { deliveredAt }));
      deliveringBatchIdsRef.current.delete(deliveryKey);
    }
  }, [addMessage, crossGroupRequests, t, updateCrossGroupRequest]);

  useEffect(() => {
    const answeredUndelivered = Object.values(crossGroupRequests || {})
      .filter(request => request.status === 'answered' && !request.deliveredAt && !request.parentRequestId);
    const batchIds = [...new Set(answeredUndelivered.map(request => request.batchId))];
    for (const batchId of batchIds) {
      if (deliveringBatchIdsRef.current.has(batchId)) continue;
      const batch = Object.values(crossGroupRequests || {}).filter(request => request.batchId === batchId);
      if (!batch.length || batch.some(request => request.status !== 'answered')) continue;
      deliveringBatchIdsRef.current.add(batchId);
      const first = batch[0];
      const sourceGroup = groups.find(group => group.id === first.sourceGroupId);
      if (!sourceGroup) {
        batch.forEach(request => updateCrossGroupRequest(request.id, { deliveredAt: Date.now() }));
        deliveringBatchIdsRef.current.delete(batchId);
        continue;
      }
      const answerText = batch.map(request => (
        `**${request.targetGroupEmoji || '💬'} ${request.targetGroupName}**\n${request.answer}`
      )).join('\n\n');
      const messageId = `cross-group-answer-${batchId}`;
      addMessage(sourceGroup.id, {
        id: messageId,
        agentId: `group:${batch.length === 1 ? batch[0].targetGroupId : 'multiple'}`,
        senderName: batch.length === 1 ? batch[0].targetGroupName : t('Gruppenantworten'),
        text: answerText,
        ts: Date.now(),
        crossGroupBatchId: batchId,
        crossGroupRequestIds: batch.map(request => request.id),
        crossGroupDirection: 'answer',
      });
      if (first.sourceTaskId) {
        enqueueUserRequest(sourceGroup.id, {
          id: `cross-group-resume-${batchId}`,
          messageId,
          createdAt: Date.now(),
          kind: 'cross-group-answer',
          crossGroupBatchId: batchId,
        });
      }
      const deliveredAt = Date.now();
      batch.forEach(request => updateCrossGroupRequest(request.id, { deliveredAt }));
      deliveringBatchIdsRef.current.delete(batchId);
    }
  }, [addMessage, crossGroupRequests, enqueueUserRequest, groups, t, updateCrossGroupRequest]);

  useEffect(() => {
    const cancelled = Object.values(crossGroupRequests || {})
      .filter(request => request.status === 'cancelled' && !request.deliveredAt && !request.parentRequestId);
    for (const request of cancelled) {
      addMessage(request.sourceGroupId, {
        id: `cross-group-cancelled-${request.id}`,
        agentId: 'system',
        senderName: 'System',
        text: `↗|${t('Die Gruppenanfrage wurde abgebrochen: {error}', {
          error: request.error || t('Eine beteiligte Gruppe ist nicht mehr verfügbar.'),
        })}`,
        ts: Date.now(),
        isError: true,
        crossGroupRequestId: request.id,
      });
      if (request.sourceTaskId) {
        updateTaskGraph(request.sourceGroupId, graph => graph
          ? updateTaskNodeStatus(graph, request.sourceTaskId, 'blocked', {
            blockedReason: 'cross-group-cancelled',
            error: request.error,
          })
          : graph);
        const checkpoint = conversationStates?.[request.sourceGroupId];
        if (checkpoint) {
          const remainingWaits = (checkpoint.waitingGroupTasks || []).filter(wait => wait.batchId !== request.batchId);
          saveConversationState(request.sourceGroupId, {
            ...checkpoint,
            status: 'needs-attention',
            waitingGroupTasks: remainingWaits,
          });
        }
      }
      updateCrossGroupRequest(request.id, { deliveredAt: Date.now() });
    }
  }, [addMessage, conversationStates, crossGroupRequests, saveConversationState, t, updateCrossGroupRequest, updateTaskGraph]);

  return null;
}
