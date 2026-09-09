const agentLeases = new Map();

const PROJECT_WORK_PATTERN = /(?:implementier|entwickl|erstell|erzeug|bau|änder|anpass|fix|reparier|refactor|lösch|entfern|install|migrier|test|prüf|analysier|untersuch|öffne|lies|read|write|edit|create|build|implement|develop|change|update|fix|repair|refactor|delete|remove|install|migrate|test|inspect|analy[sz]e)/i;
const PROJECT_OBJECT_PATTERN = /\b(?:app|anwendung|projekt|repository|repo|code|quellcode|datei|ordner|komponente|modul|skript|test|build|css|html|react|javascript|typescript|json|markdown|readme|file|folder|component|module|script|source)\b/i;

/** Enable expensive CLI workspace tools only when the task can use them. */
export function shouldEnableProjectTools({ projectPath = '', objective = '', source = '', planningOnly = false, outOfBand = false, preparationOnly = false, runtimeRecovery = false } = {}) {
  if (!projectPath || planningOnly || outOfBand) return false;
  if (preparationOnly || runtimeRecovery) return true;
  if (/approved-workflow|group-answer|team-synthesis|turn-limit-review|timeout-recovery/i.test(source)) return true;
  const text = String(objective || '');
  return PROJECT_WORK_PATTERN.test(text) && PROJECT_OBJECT_PATTERN.test(text);
}

/**
 * Match Codex reasoning cost to the work already classified by the generic
 * quality cascade. Model escalation remains provider-neutral; this controls
 * how deeply an individual Codex invocation reasons inside that stage.
 */
export function codexReasoningEffortForTask({
  planningOnly = false,
  outOfBand = false,
  preparationOnly = false,
  runtimeRecovery = false,
  complexity = 'low',
  qualityMode = 'auto',
  escalated = false,
} = {}) {
  if (runtimeRecovery || escalated || qualityMode === 'deep') return 'high';
  if (planningOnly || outOfBand || preparationOnly || qualityMode === 'fast') return 'low';
  if (complexity === 'high') return 'high';
  return complexity === 'medium' ? 'medium' : 'low';
}

/**
 * Serialize use of one configured agent across simultaneously mounted groups.
 * Every waiter receives a release callback, so normal workflow tasks and
 * background group consultations share the same single-flight guarantee.
 */
export async function acquireAgentLease(agentId) {
  const key = String(agentId || '').trim();
  if (!key) return () => {};
  const previous = agentLeases.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const currentTail = previous.then(() => current);
  agentLeases.set(key, currentTail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (agentLeases.get(key) === currentTail) agentLeases.delete(key);
  };
}
