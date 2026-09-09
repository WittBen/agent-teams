// Only application-owned rules can enter the harness. Never persist prompts,
// replies, filenames or model-authored instructions as global experience.
export const HARNESS_RULES = Object.freeze({
  'empty-response': 'Liefere ein konkretes, nicht leeres Ergebnis.',
  'invalid-structured-output': 'Prüfe das geforderte Ausgabeformat vor der Abgabe.',
  'missing-required-artifact': 'Prüfe, ob alle ausdrücklich geforderten Artefakte vorhanden sind.',
  'missing-requested-artifact': 'Erstelle die angeforderten Artefakte und prüfe ihre Vollständigkeit.',
  'placeholder-response': 'Ersetze Platzhalter durch die angeforderten Inhalte.',
  'future-promise-without-result': 'Führe die Aufgabe aus und liefere das Ergebnis mit vorhandenen Nachweisen.',
  'missing-task-plan': 'Prüfe, ob der erforderliche Aufgabenplan vollständig und auswertbar ist.',
  'too-short-for-complex-task': 'Decke die Anforderungen der komplexen Aufgabe nachvollziehbar ab.',
});

export function selectHarness(events = [], { project = '', level = 'low' } = {}) {
  const relevant = events.filter(e => e.level === level).slice(-120);
  const ranked = Object.keys(HARNESS_RULES).map(id => {
    const failures = relevant.filter(e => e.reasons.includes(id));
    const local = failures.filter(e => e.project === project);
    const projects = new Set(failures.map(e => e.project));
    const trials = relevant.filter(e => e.rules.includes(id)).slice(-12);
    // Retire advice that keeps failing; bounded recent evidence allows recovery.
    const ineffective = trials.length >= 6 && trials.filter(e => e.reasons.includes(id)).length / trials.length > 0.5;
    return { id, score: local.length * 2 + failures.length,
      eligible: !ineffective && (local.length >= 2 || (failures.length >= 4 && projects.size >= 2)) };
  }).filter(r => r.eligible).sort((a, b) => b.score - a.score).slice(0, 3);
  const rules = ranked.map(r => r.id);
  const text = rules.length ? `[Erfahrungsbasierte Prüfhilfen; aktuelle Anforderungen haben Vorrang]\n${rules.map(id => `- ${HARNESS_RULES[id]}`).join('\n')}` : '';
  return { version: 1, rules, text, estimatedTokens: Math.ceil(text.length / 4) };
}

export function normalizeExperience(event = {}, project = '') {
  return {
    project,
    level: ['low', 'medium', 'high'].includes(event.level) ? event.level : 'low',
    reasons: [...new Set((Array.isArray(event.reasons) ? event.reasons : []).filter(id => Object.hasOwn(HARNESS_RULES, id)))],
    rules: [...new Set((Array.isArray(event.rules) ? event.rules : []).filter(id => Object.hasOwn(HARNESS_RULES, id)))].slice(0, 3),
    accepted: event.accepted === true,
    inputTokens: Math.min(1e8, Math.max(0, Number(event.inputTokens) || 0)),
    harnessTokens: Math.min(300, Math.max(0, Number(event.harnessTokens) || 0)),
    at: Date.now(),
  };
}
