const { createHash } = require('node:crypto');
const queues = new WeakMap();

function operateLearning(store, params = {}) {
  const operation = (queues.get(store) || Promise.resolve()).catch(() => {}).then(async () => {
    const { normalizeExperience, selectHarness } = await import('./learning-harness.mjs');
    const project = createHash('sha256').update(String(params.project || 'direct').slice(0, 2048)).digest('hex');
    const stored = store.get('learningHarness');
    const events = (Array.isArray(stored) ? stored : []).filter(e => e && Date.now() - e.at < 90 * 86400000).slice(-1000);
    if (params.action === 'record') {
      events.push(normalizeExperience(params.event, project));
      store.set('learningHarness', events.slice(-1000));
      return { ok: true };
    }
    if (params.action === 'clear') { store.set('learningHarness', []); return { ok: true }; }
    if (params.action === 'select') return selectHarness(events, { project, level: params.level });
    if (params.action === 'stats') return {
      runs: events.length, projects: new Set(events.map(e => e.project)).size,
      accepted: events.filter(e => e.accepted).length,
      inputTokens: events.reduce((sum, e) => sum + e.inputTokens, 0),
      harnessTokens: events.reduce((sum, e) => sum + e.harnessTokens, 0),
    };
    throw new Error('Unbekannte Harness-Operation');
  });
  queues.set(store, operation);
  return operation;
}
module.exports = { operateLearning };
