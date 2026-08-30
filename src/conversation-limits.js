export const DEFAULT_CONVERSATION_LIMITS = Object.freeze({
  maxTurns: 12,
  maxTurnsPerAgent: 8,
  pmReviewOnLimit: true,
});

function normalizeTaskLimit(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed === 0) return 0;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeConversationLimits(config = {}) {
  const maxTurns = normalizeTaskLimit(config?.maxTurns, DEFAULT_CONVERSATION_LIMITS.maxTurns, 3, 50);
  const maxTurnsPerAgent = normalizeTaskLimit(
    config?.maxTurnsPerAgent,
    DEFAULT_CONVERSATION_LIMITS.maxTurnsPerAgent,
    1,
    maxTurns === 0 ? 50 : maxTurns,
  );
  return {
    maxTurns,
    maxTurnsPerAgent,
    pmReviewOnLimit: config?.pmReviewOnLimit !== false,
  };
}
