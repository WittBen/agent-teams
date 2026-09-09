import { PROVIDER_MODELS } from './llm.js';
import { inferTaskNodeType, isTaskNodeReady, TASK_STATUS, validateWorkflowPlan } from './task-graph.js';
import { getProviderModels } from './provider-catalog.js';
import { compareTicketPriority } from './task-ticket.js';
import { evaluateTaskDelegation } from './delegation.js';


export const conversationContinuations = new Map();

export const FINISHED_PLAN_STATUSES = new Set(['agent_done', 'completed']);

export const CLAIMABLE_PLAN_STATUSES = new Set(['planned', 'queued', 'prepared', 'interrupted', 'retryable', 'stale_dependency']);

export const RESUMABLE_CHECKPOINT_STATUSES = new Set(['running', 'interrupted', 'provider-limited', 'limit-reached']);

export const CLEARED_PREPARATION_STATE = {
  preparationAttemptedAt: undefined,
  preparationCompletedAt: undefined,
  preparationFailedAt: undefined,
  preparationError: undefined,
  interimResult: undefined,
  interimSavedAt: undefined,
  interimConsumedAt: undefined,
  preparedFiles: undefined,
};

export function buildRecoveryUserQuestion({ recovery, errorMessage = '', pmReply = '' } = {}) {
  const trigger = recovery?.trigger === 'quality'
    ? 'Qualitätsproblem'
    : recovery?.trigger === 'error' ? 'Ausführungsproblem' : 'Timeout';
  const originalTask = String(recovery?.originalObjective || 'Die ursprüngliche Aufgabe').slice(0, 1200);
  const diagnosis = String(errorMessage || pmReply || 'Der PM konnte innerhalb des freigegebenen Plans keine sichere Lösung bestätigen.')
    .replace(/\s+/g, ' ').trim().slice(0, 1200);
  return [
    `Der PM konnte das ${trigger} nicht sicher innerhalb des freigegebenen Plans lösen.`,
    `Aufgabe: ${originalTask}`,
    `Diagnose: ${diagnosis}`,
    'Wie soll weitergegangen werden?',
    '1. Dieselbe Aufgabe mit dem vorhandenen Plan erneut versuchen.',
    '2. Den Planungsmodus öffnen und die Aufgabe, Abhängigkeiten oder Agentenzuordnung anpassen.',
    'Du kannst auch eine eigene Entscheidung oder zusätzliche Information eingeben.',
  ].join('\n');
}

export function buildDelegatedTaskQuestion(node, policy) {
  const criteria = (node?.acceptanceCriteria || [])
    .filter(criterion => criterion?.text)
    .map(criterion => `- ${criterion.text}`)
    .join('\n');
  return [
    `Aufgabe: ${node?.objective || node?.title || 'Delegierte Aufgabe'}`,
    `Benötigte Fähigkeiten: ${policy.requiredCapabilities.join(', ')}`,
    criteria ? `Abnahmekriterien:\n${criteria}` : '',
    'Liefere ein eigenständiges Ergebnis und nenne die konkrete Evidenz, anhand derer die Ursprungsgruppe es prüfen kann.',
  ].filter(Boolean).join('\n\n');
}

export function buildWorkflowModelOptions(graph, agents, providerConnections) {
  return Object.fromEntries((graph?.nodes || []).flatMap(node => {
    const agent = agents.find(candidate => candidate.id === node.agentId);
    if (!agent?.provider || !agent?.model) return [];
    const models = getProviderModels(
      agent.provider,
      providerConnections,
      PROVIDER_MODELS,
      node.modelOverride || agent.model,
    );
    return [[node.id, {
      provider: agent.provider,
      defaultModel: agent.model,
      currentModel: node.modelOverride || agent.model,
      models,
    }]];
  }));
}

export function isAgentProviderConfigured(agent, apiKeys, providerConnections) {
  const provider = agent?.provider || 'openai';
  if (provider === 'codex') return apiKeys?.codexCli !== false;
  if (provider === 'anthropic') return Boolean(
    apiKeys?.anthropic?.trim() || apiKeys?.anthropicConfigured || apiKeys?.claudeCli ||
    (typeof process !== 'undefined' && process.env?.ANTHROPIC_API_KEY)
  );
  if (provider === 'openai') return Boolean(
    apiKeys?.openai?.trim() || apiKeys?.openaiConfigured ||
    (typeof process !== 'undefined' && process.env?.OPENAI_API_KEY)
  );
  const connection = providerConnections.find(item => item.id === provider);
  return Boolean(connection && (connection.requiresApiKey === false || apiKeys?.providerConfigured?.[provider]));
}

export function collectWorkflowProblems({ graph, sourceGroup, groups, agents, chatAgents, apiKeys, providerConnections, t }) {
  const nodes = graph?.nodes || [];
  const problems = new Map();
  const addProblem = problem => {
    if (!problem?.taskId || problems.has(problem.taskId)) return;
    problems.set(problem.taskId, problem);
  };
  const validation = validateWorkflowPlan(graph);
  if (!validation.ok) {
    for (const taskId of validation.taskIds || []) {
      const node = nodes.find(candidate => candidate.id === taskId);
      addProblem({
        taskId,
        taskTitle: node?.title || taskId,
        kind: 'validation',
        message: t(validation.messageKey || validation.reason, validation.messageValues),
        suggestion: t('Prüfe die markierte Aufgabenangabe und ihre Verbindungen. Der PM kann den Plan anhand deiner Vorgabe korrigieren.'),
      });
    }
  }
  for (const node of nodes.filter(candidate => inferTaskNodeType(candidate) !== 'request')) {
    const agent = chatAgents.find(candidate => candidate.id === node.agentId);
    if (!agent || isAgentProviderConfigured(agent, apiKeys, providerConnections)) continue;
    addProblem({
      taskId: node.id,
      taskTitle: node.title,
      kind: 'provider',
      message: t('Der Provider für {agent} ist nicht verbunden.', { agent: agent.name }),
      suggestion: t('Verbinde den Provider oder weise die Aufgabe einem verfügbaren Agenten zu.'),
    });
  }
  for (const node of nodes.filter(candidate => inferTaskNodeType(candidate) === 'task')) {
    const decision = evaluateTaskDelegation({ taskNode: node, sourceGroup, groups, agents });
    if (decision.action !== 'unavailable') continue;
    const requiredCapabilities = decision.policy.requiredCapabilities.join(', ');
    addProblem({
      taskId: node.id,
      taskTitle: node.title,
      kind: 'delegation',
      message: t('Für „{task}“ ist keine erreichbare Gruppe mit ausreichender Kompetenzabdeckung verfügbar.', { task: node.title }),
      suggestion: t('Ergänze die fehlenden Agentenfähigkeiten oder passe die benötigten Fähigkeiten der Aufgabe an: {capabilities}', { capabilities: requiredCapabilities }),
      requiredCapabilities: decision.policy.requiredCapabilities,
    });
  }
  const executionProblemStatuses = new Set([
    'failed', 'timed_out', 'blocked', 'interrupted', 'waiting_user', 'waiting_pm', 'provider_paused', 'retryable',
  ]);
  for (const problemNode of nodes.filter(candidate => executionProblemStatuses.has(candidate.status) && inferTaskNodeType(candidate) !== 'request')) {
    const node = problemNode.runtimeRecovery && problemNode.recovery?.originalGraphNodeId
      ? nodes.find(candidate => candidate.id === problemNode.recovery.originalGraphNodeId) || problemNode
      : problemNode;
    const statusLabel = TASK_STATUS[problemNode.status]?.label || problemNode.status;
    const issue = problemNode.issueSummary || problemNode.error || problemNode.recoveryError || problemNode.blockedReason || '';
    addProblem({
      taskId: node.id,
      taskTitle: node.title,
      kind: 'execution',
      status: problemNode.status,
      message: issue
        ? t('{status}: {issue}', { status: t(statusLabel), issue: String(issue).slice(0, 1200) })
        : t('Die Aufgabe befindet sich im Status „{status}“ und benötigt eine Entscheidung.', { status: t(statusLabel) }),
      suggestion: node.recoveryStatus === 'user'
        ? t('Ergänze neue Informationen, starte eine weitere Ausführungs-Recovery oder lasse den PM eine neue Planversion vorschlagen.')
        : t('Der PM kann die Ausführung in kleinere Recovery-Tickets teilen. Ist der Hauptplan selbst falsch, wähle stattdessen eine kontrollierte Planrevision.'),
      recoveryAttempt: Number(node.recoveryAttempt) || 0,
    });
  }
  return [...problems.values()];
}

export function buildPlanningPendingTasks(graph, checkpoint, agents) {
  const existingByNodeId = new Map((checkpoint?.pendingTasks || [])
    .filter(task => task?.graphNodeId)
    .map(task => [task.graphNodeId, task]));
  const planRootId = checkpoint?.planRootGraphNodeId;
  if (!planRootId) return checkpoint?.pendingTasks || [];

  // Rebuild pending work from the graph instead of trusting a stale
  // checkpoint. Finished or dependency-blocked tasks must never be replayed.
  return (graph?.nodes || [])
    .filter(node =>
      node.planRootId === planRootId &&
      inferTaskNodeType(node) !== 'request' &&
      CLAIMABLE_PLAN_STATUSES.has(node.status) &&
      isTaskNodeReady(graph, node.id)
    )
    .sort(compareTicketPriority)
    .flatMap(node => {
      const agent = agents.find(candidate => candidate.id === node.agentId);
      if (!agent) return [];
      const existing = existingByNodeId.get(node.id);
      return [{
        ...existing,
        agent,
        objective: node.objective || node.title,
        source: existing?.source || node.source || 'PM-Plan',
        runtimeRecovery: existing?.runtimeRecovery || node.runtimeRecovery || false,
        recovery: existing?.recovery || node.recovery,
        graphNodeId: node.id,
        planRootId: node.planRootId,
        planTaskId: node.planTaskId,
        modelOverride: node.modelOverride,
      }];
    });
}

export function planTaskMatchScore(node, summary) {
  const tokens = value => new Set(String(value || '').toLowerCase().match(/[a-zäöüß0-9_.-]{3,}/g) || []);
  const nodeTokens = tokens(`${node.title} ${node.objective}`);
  const summaryTokens = tokens(summary);
  return [...summaryTokens].filter(token => nodeTokens.has(token)).length;
}

export function rewritePlanHandoffAssignments(reply, planTasks) {
  if (!planTasks.length) return reply;
  const usedPlanTaskIds = new Set();
  return String(reply || '').split(/\r?\n/).map(line => {
    const match = line.match(/^@([^:]+):\s*(.*)$/);
    if (!match) return line;
    const requestedName = match[1].trim().toLowerCase();
    const candidates = planTasks
      .filter(planTask =>
        planTask.type !== 'review' &&
        String(planTask.requestedAgentName || planTask.agentName || planTask.agent).toLowerCase() === requestedName &&
        !usedPlanTaskIds.has(planTask.id)
      )
      .map(planTask => ({ planTask, score: planTaskMatchScore(planTask, match[2]) }))
      .sort((left, right) => right.score - left.score || left.planTask.order - right.planTask.order);
    const selected = candidates[0]?.planTask;
    if (!selected) return line;
    usedPlanTaskIds.add(selected.id);
    return `@${selected.agentName || selected.agent}: ${match[2].trim()}`;
  }).join('\n');
}

export function formatAcceptanceContext(nodes = []) {
  const lines = [];
  for (const node of nodes) {
    for (const criterion of node.acceptanceCriteria || []) {
      const evidence = (criterion.evidence || []).at(-1);
      lines.push(
        `  - Kriterium ${criterion.id}: ${criterion.text} | erforderlich: ${criterion.required !== false ? 'ja' : 'nein'} | Prüfung: ${criterion.verification || 'reviewer'} | Status: ${criterion.status || 'open'}${evidence ? ` | Letzter Nachweis von ${evidence.author || 'Agent'}: ${evidence.summary}` : ''}`,
      );
    }
  }
  return lines.length ? `\nAbnahmestand:\n${lines.join('\n')}` : '';
}

export function createMcpPlannerAgent(agent) {
  if (agent?.provider === 'anthropic' && /opus/i.test(String(agent.model || ''))) {
    return { ...agent, model: 'claude-sonnet-4-5' };
  }
  return agent;
}
