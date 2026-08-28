export const DEFAULT_QUALITY_ROUTING = Object.freeze({
  enabled: true,
  strategy: 'balanced',
  maxEscalations: 1,
  escalationProvider: 'same',
  escalationModel: '',
});

export const DEFAULT_QUALITY_STATS = Object.freeze({
  runs: 0,
  baselineAccepted: 0,
  directStrong: 0,
  escalations: 0,
  unresolved: 0,
  estimatedInputTokens: 0,
  estimatedOutputTokens: 0,
});

const PROVIDER_FALLBACKS = {
  openai: {
    'gpt-3.5-turbo': 'gpt-4o',
    'gpt-4o-mini': 'gpt-4o',
    'gpt-4o': 'o1-mini',
    'gpt-4-turbo': 'o1-mini',
  },
  anthropic: {
    'claude-haiku-4-5': 'claude-sonnet-4-5',
    'claude-3-5-haiku-20241022': 'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20241022': 'claude-opus-4-5',
    'claude-sonnet-4-5': 'claude-opus-4-5',
  },
  codex: {
    'codex-default': 'gpt-5.6-sol',
    'gpt-5.4': 'gpt-5.6-sol',
  },
};

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

export function recommendedEscalationModel(provider, model, providerModels = []) {
  const builtIn = PROVIDER_FALLBACKS[provider]?.[model];
  if (builtIn) return builtIn;
  const models = Array.isArray(providerModels) ? providerModels.filter(Boolean) : [];
  const currentIndex = models.indexOf(model);
  if (currentIndex >= 0 && currentIndex < models.length - 1) return models[currentIndex + 1];
  return currentIndex < 0 && models.length ? models.at(-1) : '';
}

export function getEscalationAgent(agent, globalConfig = {}, agentConfig = {}, providerModelsById = {}) {
  const providerSetting = agentConfig.escalationProvider || globalConfig.escalationProvider || 'same';
  const provider = providerSetting === 'same' ? (agent.provider || 'openai') : providerSetting;
  const explicitModel = agentConfig.escalationModel || (
    providerSetting !== 'same' ? globalConfig.escalationModel : ''
  );
  const model = explicitModel || recommendedEscalationModel(provider, agent.model, providerModelsById?.[provider]);
  if (!model || (provider === agent.provider && model === agent.model)) return null;
  return { ...agent, provider, model };
}

export function assessTaskComplexity({ objective = '', source = '', attachmentCount = 0, recovery = false } = {}) {
  const text = `${objective}\n${source}`.trim();
  const reasons = [];
  let score = 0;
  for (const pattern of HIGH_RISK_PATTERNS) {
    if (!pattern.test(text)) continue;
    score += 2;
    reasons.push('high-risk-domain');
  }
  const requirementCount = (text.match(/(?:^|\n)\s*(?:[-*•]|\d+[.)])\s+/g) || []).length;
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
  const escalationAgent = agent ? getEscalationAgent(agent, globalPolicy, agentConfig, providerModelsById) : null;
  const directStrong = selectedMode === 'strong' || (
    selectedMode === 'auto' && (
      globalPolicy.strategy === 'quality' ||
      (globalPolicy.strategy === 'balanced' && complexity.level === 'high')
    )
  );
  return {
    enabled: selectedMode !== 'off' && !!escalationAgent,
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
} = {}) {
  const text = String(reply || '').trim();
  const reasons = [];
  if (!text) reasons.push('empty-response');
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
