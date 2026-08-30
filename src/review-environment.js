export const DEFAULT_REVIEW_ENVIRONMENT = Object.freeze({
  test: { command: '', args: [] },
  preview: { command: '', args: [] },
  previewUrl: '',
  testTimeoutMs: 120000,
});

function normalizeCommand(raw) {
  return {
    command: String(raw?.command || '').trim().slice(0, 500),
    args: (Array.isArray(raw?.args) ? raw.args : []).slice(0, 50).map(value => String(value || '').slice(0, 2000)),
  };
}

export function normalizeReviewEnvironment(raw) {
  return {
    test: normalizeCommand(raw?.test),
    preview: normalizeCommand(raw?.preview),
    previewUrl: String(raw?.previewUrl || '').trim().slice(0, 2048),
    testTimeoutMs: Math.min(300000, Math.max(5000, Number(raw?.testTimeoutMs) || 120000)),
  };
}

export function validateReviewPreviewUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return 'Vorschau-URL muss mit http:// oder https:// beginnen.';
    if (parsed.username || parsed.password) return 'Vorschau-URL darf keine Zugangsdaten enthalten.';
  } catch {
    return 'Vorschau-URL ist ungültig.';
  }
  return '';
}

export function parseReviewArguments(text) {
  return String(text || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(0, 50);
}

export function formatReviewArguments(args) {
  return (Array.isArray(args) ? args : []).join('\n');
}
