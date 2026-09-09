// Explicit compatibility defaults, not a ranking of arbitrary provider models.
// Maintain model aliases here; user-selected escalation targets take precedence.
export const QUALITY_MODEL_CATALOG = {
  openai: {
    'gpt-3.5-turbo': 'gpt-4o',
    'gpt-4o-mini': 'gpt-4o',
  },
  anthropic: {
    'claude-haiku-4-5': 'claude-sonnet-4-5',
    'claude-3-5-haiku-20241022': 'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20241022': 'claude-opus-4-5',
    'claude-sonnet-4-5': 'claude-opus-4-5',
  },
  // CLI aliases have no inferred strength ordering; configure a target explicitly.
  codex: {},
};
