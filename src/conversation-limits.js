export const DEFAULT_CONVERSATION_LIMITS = Object.freeze({
  maxTurns: 12,
  maxTurnsPerAgent: 8,
  pmReviewOnLimit: true,
});

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export function normalizeConversationLimits(config = {}) {
  const maxTurns = clampInteger(config?.maxTurns, DEFAULT_CONVERSATION_LIMITS.maxTurns, 3, 50);
  const maxTurnsPerAgent = clampInteger(
    config?.maxTurnsPerAgent,
    DEFAULT_CONVERSATION_LIMITS.maxTurnsPerAgent,
    1,
    maxTurns,
  );
  return {
    maxTurns,
    maxTurnsPerAgent,
    pmReviewOnLimit: config?.pmReviewOnLimit !== false,
  };
}
