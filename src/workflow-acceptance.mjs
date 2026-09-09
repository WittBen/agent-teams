


export const ACCEPTANCE_STATUS = {
  open: { label: 'Offen', color: '#8696a0' },
  submitted: { label: 'Nachweis vorhanden', color: '#53bdeb' },
  passed: { label: 'Bestanden', color: '#00a884' },
  failed: { label: 'Abgelehnt', color: '#ef4444' },
  waived: { label: 'Ausnahme bestätigt', color: '#c084fc' },
};

export const ACCEPTED_CRITERION_STATUSES = new Set(['passed', 'waived']);

export const ACCEPTANCE_VERIFICATION = new Set(['reviewer', 'automatic', 'user']);

export function normalizeAcceptanceId(value, fallback) {
  return String(value || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function normalizeAcceptanceCriteria(criteria = [], { taskId = 'task', fallbackText = '' } = {}) {
  const source = Array.isArray(criteria) ? criteria : [];
  const normalized = [];
  const seen = new Set();
  for (const [index, candidate] of source.slice(0, 12).entries()) {
    const text = String(typeof candidate === 'string' ? candidate : candidate?.text || '')
      .replace(/\s+/g, ' ').trim().slice(0, 300);
    if (!text) continue;
    const id = normalizeAcceptanceId(
      typeof candidate === 'object' ? candidate?.id : '',
      `${taskId}-criterion-${index + 1}`,
    );
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const verification = ACCEPTANCE_VERIFICATION.has(candidate?.verification)
      ? candidate.verification
      : 'reviewer';
    const status = ACCEPTANCE_STATUS[candidate?.status] ? candidate.status : 'open';
    normalized.push({
      id,
      text,
      required: candidate?.required !== false,
      verification,
      status,
      evidence: Array.isArray(candidate?.evidence) ? candidate.evidence.slice(-8) : [],
      ...(candidate?.reviewedBy ? { reviewedBy: String(candidate.reviewedBy).slice(0, 80) } : {}),
      ...(candidate?.reviewedAt ? { reviewedAt: candidate.reviewedAt } : {}),
    });
  }
  if (!normalized.length && fallbackText) {
    normalized.push({
      id: normalizeAcceptanceId('', `${taskId}-result`),
      text: String(fallbackText).replace(/\s+/g, ' ').trim().slice(0, 300),
      required: true,
      verification: 'reviewer',
      status: 'open',
      evidence: [],
    });
  }
  return normalized;
}

export function mergeAcceptanceCriteria(previous = [], incoming = []) {
  const existing = new Map((previous || []).map(criterion => [criterion.id, criterion]));
  return (incoming || []).map(criterion => {
    const prior = existing.get(criterion.id);
    return prior ? {
      ...criterion,
      status: prior.status || criterion.status,
      evidence: Array.isArray(prior.evidence) ? prior.evidence : criterion.evidence,
      ...(prior.reviewedBy ? { reviewedBy: prior.reviewedBy } : {}),
      ...(prior.reviewedAt ? { reviewedAt: prior.reviewedAt } : {}),
    } : criterion;
  });
}

export function requiredCriteriaAccepted(criteria = []) {
  const required = criteria.filter(criterion => criterion.required !== false);
  return required.length > 0 && required
    .every(criterion => ACCEPTED_CRITERION_STATUSES.has(criterion.status));
}
