import { QUALITY_MODEL_CATALOG } from './quality-model-catalog.mjs';
export const DEFAULT_QUALITY_ROUTING = Object.freeze({
  enabled: true,
  strategy: 'balanced',
  maxEscalations: 1,
  escalationProvider: 'same',
  escalationModel: '',
  learningEnabled: true,
});

/** Group defaults apply at execution time without mutating shared agent profiles. */
export function resolveGroupAgent(agent, group) {
  const template = group?.aiTemplate;
  if (!template?.enabled || !String(template.provider || '').trim() || !String(template.model || '').trim()) return agent;
  return { ...agent, provider: template.provider.trim(), model: template.model.trim() };
}

export const DEFAULT_QUALITY_STATS = Object.freeze({
  runs: 0,
  baselineAccepted: 0,
  directStrong: 0,
  escalations: 0,
  unresolved: 0,
  estimatedInputTokens: 0,
  estimatedOutputTokens: 0,
});



const HIGH_RISK_PATTERNS = [
  /\b(?:security|sicherheit|auth(?:entication|orization)?|oauth|cryptograph|verschlüssel|secret|permission|berechtigung)\b/i,
  /\b(?:production|produktiv|migration|datenverlust|data loss|rollback|deployment|release)\b/i,
  /\b(?:architecture|architektur|concurren|parallel|race condition|deadlock|performance|skalier)\b/i,
  /\b(?:legal|rechtlich|medical|medizin|financial|finanz|audit|compliance)\b/i,
];

const ARTIFACT_REQUEST_PATTERN = /\b(?:erstelle|erzeuge|implementiere|baue|schreibe|create|generate|implement|build|write)\b[\s\S]{0,80}\b(?:datei|file|skript|script|code|app|projekt|project|dokument|document|readme|json|csv|html|css|tsx?|jsx?|py|cmd|bat)\b/i;
const PLACEHOLDER_PATTERN = /\b(?:lorem ipsum|tbd|todo follows|placeholder only|nur ein platzhalter|noch zu implementieren)\b/i;
const FUTURE_ONLY_PATTERN = /^(?:ich werde|i will|als nächstes werde ich|next i will)\b[^\n]{0,240}$/i;

function normalizeMode(value) {
  return ['inherit', 'off', 'auto', 'strong'].includes(value) ? value : 'inherit';
}

export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  return Math.max(0, Math.ceil(text.length / 4));
}

export function usesNativeCli(agent, apiKeys = {}) {
  return agent?.provider === 'codex' || (agent?.provider === 'anthropic'
    && !apiKeys.anthropic?.trim() && !apiKeys.anthropicConfigured && apiKeys.claudeCli === true);
}

export function recommendedEscalationModel(provider, model, availableModels = []) {
  const builtIn = QUALITY_MODEL_CATALOG[provider]?.[model];
  if (builtIn && (!availableModels.length || availableModels.includes(builtIn))) return builtIn;
  // A provider's model-list order is not a quality ranking. Custom models
  // require an explicit escalation target instead of silently changing models.
  return '';
}

export function getEscalationAgent(agent, globalConfig = {}, agentConfig = {}, providerModelsById = {}) {
  const providerSetting = agentConfig.escalationProvider || globalConfig.escalationProvider || 'same';
  const provider = providerSetting === 'same' ? (agent.provider || 'openai') : providerSetting;
  const inheritedProvider = globalConfig.escalationProvider === 'same' || !globalConfig.escalationProvider ? (agent.provider || 'openai') : globalConfig.escalationProvider;
  const explicitModel = agentConfig.escalationModel || (provider === inheritedProvider ? globalConfig.escalationModel : '');
  const model = explicitModel || recommendedEscalationModel(provider, agent.model, providerModelsById?.[provider]);
  if (!model || (provider === agent.provider && model === agent.model)) return null;
  return { ...agent, provider, model };
}

export function assessTaskComplexity({ objective = '', source = '', attachmentCount = 0, recovery = false, requirements = [], riskLevel = '', dependencyCount = 0 } = {}) {
  const text = `${objective}\n${source}`.trim();
  const reasons = [];
  let score = 0;
  if (riskLevel === 'high') { score += 4; reasons.push('declared-high-risk'); }
  if (dependencyCount >= 3) { score += 2; reasons.push('multiple-dependencies'); }
  for (const pattern of riskLevel ? [] : HIGH_RISK_PATTERNS) {
    if (!pattern.test(text)) continue;
    score += 2;
    reasons.push('high-risk-domain');
  }
  const requirementCount = Array.isArray(requirements) && requirements.length ? requirements.length : (text.match(/(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/g) || []).length;
  if (requirementCount >= 4) {
    score += 2;
    reasons.push('many-requirements');
  }
  if (text.length > 900) {
    score += 2;
    reasons.push('large-context');
  } else if (text.length > 400) {
    score += 1;
    reasons.push('medium-context');
  }
  if (attachmentCount >= 3) {
    score += 1;
    reasons.push('multiple-attachments');
  }
  if (recovery || /timeout-recovery|unterbrochen|interrupted|timed?\s*out/i.test(source)) {
    score += 3;
    reasons.push('recovery');
  }
  return {
    score,
    level: score >= 4 ? 'high' : score >= 2 ? 'medium' : 'low',
    reasons: [...new Set(reasons)],
  };
}

export function resolveQualityPolicy({
  globalConfig = {},
  groupConfig = {},
  agentConfig = {},
  messageMode = 'auto',
  complexity = { level: 'low', score: 0 },
  agent,
  providerModelsById = {},
} = {}) {
  const globalPolicy = { ...DEFAULT_QUALITY_ROUTING, ...globalConfig };
  const selectedMode = messageMode === 'fast' ? 'off' : messageMode === 'deep' ? 'strong' : (() => {
    const agentMode = normalizeMode(agentConfig.mode);
    if (agentMode !== 'inherit') return agentMode;
    const groupMode = normalizeMode(groupConfig.mode);
    if (groupMode !== 'inherit') return groupMode;
    return globalPolicy.enabled ? 'auto' : 'off';
  })();
  const escalationAgent = agent ? getEscalationAgent(agent, {
    ...globalPolicy,
    ...(groupConfig.escalationProvider && groupConfig.escalationProvider !== globalPolicy.escalationProvider
      ? { escalationModel: '' } : {}),
    ...(groupConfig.escalationProvider ? { escalationProvider: groupConfig.escalationProvider } : {}),
    ...(groupConfig.escalationModel ? { escalationModel: groupConfig.escalationModel } : {}),
  }, agentConfig, providerModelsById) : null;
  const directStrong = selectedMode === 'strong' || (
    selectedMode === 'auto' && (
      globalPolicy.strategy === 'quality' ||
      (globalPolicy.strategy === 'balanced' && complexity.level === 'high')
    )
  );
  return {
    enabled: selectedMode !== 'off' && !!escalationAgent,
    learningEnabled: globalPolicy.learningEnabled !== false,
    mode: selectedMode,
    strategy: globalPolicy.strategy,
    maxEscalations: Math.min(1, Math.max(0, Number(globalPolicy.maxEscalations) || 0)),
    directStrong: !!escalationAgent && directStrong,
    escalationAgent,
    acceptanceCriteria: String(agentConfig.acceptanceCriteria || '').trim(),
  };
}

export function evaluateResponseQuality({
  reply = '',
  objective = '',
  complexity = { level: 'low' },
  isOrchestrator = false,
  requiresInitialPlan = false,
  parsedTaskPlan = null,
  projectFiles = [],
  projectPath = '',
  usedMcp = false,
  requiredArtifacts = [],
  structuredOutputValid = true,
} = {}) {
  const text = String(reply || '').trim();
  const reasons = [];
  if (!text) reasons.push('empty-response');
  if (!structuredOutputValid) reasons.push('invalid-structured-output');
  if (requiredArtifacts.length && !usedMcp) {
    const supplied = new Set(projectFiles.map(file => String(typeof file === 'string' ? file : file.filename || file.name || '').replace(/\\/g, '/')));
    if (requiredArtifacts.some(file => !supplied.has(String(file).replace(/\\/g, '/')))) reasons.push('missing-required-artifact');
  }
  if (text && text.length < 24 && complexity.level === 'high') reasons.push('too-short-for-complex-task');
  if (PLACEHOLDER_PATTERN.test(text)) reasons.push('placeholder-response');
  if (FUTURE_ONLY_PATTERN.test(text)) reasons.push('future-promise-without-result');
  if (isOrchestrator && requiresInitialPlan && !parsedTaskPlan?.tasks?.length) reasons.push('missing-task-plan');
  if (!isOrchestrator && !usedMcp && projectPath && ARTIFACT_REQUEST_PATTERN.test(objective) && projectFiles.length === 0) {
    reasons.push('missing-requested-artifact');
  }
  return { accepted: reasons.length === 0, reasons };
}

export function buildEscalationHistory(history, {
  previousReply,
  reasons = [],
  acceptanceCriteria = '',
} = {}) {
  const reasonText = reasons.length ? reasons.join(', ') : 'quality-gate';
  const criteriaText = acceptanceCriteria
    ? `\nZusätzliche Akzeptanzkriterien des Users:\n${acceptanceCriteria}`
    : '';
  return [
    ...history,
    {
      id: `quality-first-${Date.now()}`,
      agentId: 'assistant',
      senderName: 'Erste Modellstufe',
      text: String(previousReply || '').slice(0, 12000),
      ts: Date.now(),
    },
    {
      id: `quality-feedback-${Date.now()}`,
      agentId: 'user',
      senderName: 'Quality Gate',
      text: `Die erste Antwort wurde durch deterministische Qualitätsregeln abgelehnt (${reasonText}). Liefere jetzt eine vollständige, direkt verwendbare Endfassung. Wiederhole keine bereits ausgeführten MCP-Werkzeuge.${criteriaText}`,
      ts: Date.now(),
    },
  ];
}

/**
 * Execute the provider-neutral two-stage quality policy around any isolated
 * model call. Callers keep ownership of task-specific validation and UI state.
 */
export async function runQualityCascade({
  agent,
  policy = {},
  history = [],
  objective = '',
  complexity = { level: 'low' },
  systemContext = '',
  call,
  evaluate,
  canEscalate = () => true,
  project = '',
  learning = globalThis.window?.electronAPI?.learningHarness,
} = {}) {
  if (!agent || typeof call !== 'function') throw new Error('Quality Cascading benötigt einen Agenten und einen Modellaufruf.');
  let harness = { rules: [], text: '', estimatedTokens: 0 };
  let learningError = null;
  if (policy.learningEnabled !== false && learning) {
    try { harness = await learning({ action: 'select', project, level: complexity.level }); }
    catch (error) { learningError = String(error?.message || error); }
  }
  if (harness.text) history = [{ agentId: 'user', senderName: 'Harness', text: harness.text }, ...history];
  const evaluateCandidate = typeof evaluate === 'function'
    ? evaluate
    : reply => evaluateResponseQuality({ reply, objective, complexity });
  const directStrong = Boolean(policy.directStrong && policy.escalationAgent);
  let selectedAgent = directStrong ? policy.escalationAgent : agent;
  let estimatedInputTokens = estimateTokens(systemContext) + estimateTokens(history.map(message => message?.text || '').join('\n'));
  let reply = await call({ agent: selectedAgent, history, phase: directStrong ? 'direct-strong' : 'baseline' });
  let evaluation = await evaluateCandidate(reply);
  const initialReasons = [...(evaluation.reasons || [])];
  let estimatedOutputTokens = estimateTokens(reply);
  let outcome = directStrong ? 'direct-strong' : evaluation.accepted ? 'baseline-accepted' : 'rejected';
  let didEscalate = false;
  let escalationFailed = false;
  let escalationError = null;

  if (
    !directStrong &&
    policy.enabled &&
    policy.escalationAgent &&
    policy.maxEscalations > 0 &&
    !evaluation.accepted &&
    await canEscalate()
  ) {
    didEscalate = true;
    const baselineReply = reply;
    const escalationHistory = buildEscalationHistory(history, {
      previousReply: baselineReply,
      reasons: evaluation.reasons,
      acceptanceCriteria: policy.acceptanceCriteria,
    });
    estimatedInputTokens += estimateTokens(systemContext) + estimateTokens(escalationHistory.map(message => message?.text || '').join('\n'));
    try {
      selectedAgent = policy.escalationAgent;
      reply = await call({ agent: selectedAgent, history: escalationHistory, phase: 'escalated' });
      evaluation = await evaluateCandidate(reply);
      estimatedOutputTokens += estimateTokens(reply);
      outcome = 'escalated';
    } catch (error) {
      if (error?.cancelled || error?.timedOut || error?.isAgentTimeout || error?.status === 499 || error?.rateLimited || error?.status === 429 || error?.status === 401) throw error;
      escalationFailed = true;
      escalationError = error;
      selectedAgent = agent;
      reply = baselineReply;
      evaluation = await evaluateCandidate(reply);
    }
  }

  if (policy.learningEnabled !== false && learning) {
    try {
      await learning({ action: 'record', project, event: {
        level: complexity.level, reasons: initialReasons, rules: harness.rules,
        accepted: !escalationFailed && evaluation.accepted,
        inputTokens: estimatedInputTokens, harnessTokens: harness.estimatedTokens * (didEscalate ? 2 : 1),
      } });
    } catch (error) { learningError = String(error?.message || error); }
  }
  return {
    harness: { ...harness, error: learningError },
    reply,
    evaluation,
    selectedAgent,
    outcome,
    didEscalate,
    escalationFailed,
    escalationError,
    unresolved: Boolean(escalationFailed || !evaluation.accepted),
    estimatedInputTokens,
    estimatedOutputTokens,
  };
}

export function updateQualityStats(current = {}, event = {}) {
  const next = { ...DEFAULT_QUALITY_STATS, ...current };
  next.runs += 1;
  if (event.outcome === 'baseline-accepted') next.baselineAccepted += 1;
  if (event.outcome === 'direct-strong') next.directStrong += 1;
  if (event.outcome === 'escalated') next.escalations += 1;
  if (event.unresolved) next.unresolved += 1;
  next.estimatedInputTokens += Math.max(0, Number(event.estimatedInputTokens) || 0);
  next.estimatedOutputTokens += Math.max(0, Number(event.estimatedOutputTokens) || 0);
  return next;
}
