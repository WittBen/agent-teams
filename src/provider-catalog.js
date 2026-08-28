const MAX_PROVIDER_CONNECTIONS = 30;
const MAX_PROVIDER_MODELS = 40;

export const BUILTIN_PROVIDERS = Object.freeze([
  { id: 'openai', name: 'OpenAI', emoji: '🟢', kind: 'builtin' },
  { id: 'anthropic', name: 'Anthropic', emoji: '🟣', kind: 'builtin' },
  { id: 'codex', name: 'Codex (lokal)', emoji: '🔵', kind: 'cli' },
]);

export const PROVIDER_PRESETS = Object.freeze([
  {
    id: 'openrouter', name: 'OpenRouter', emoji: '🧭', protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['~openai/gpt-latest', '~anthropic/claude-sonnet-latest', 'google/gemini-3.5-flash'],
  },
  {
    id: 'groq', name: 'Groq', emoji: '⚡', protocol: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-20b', 'openai/gpt-oss-120b'],
  },
  {
    id: 'mistral', name: 'Mistral AI', emoji: '🌬️', protocol: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-small-latest', 'mistral-large-latest'],
  },
  {
    id: 'gemini', name: 'Google Gemini', emoji: '✨', protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    models: ['gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-pro'],
  },
  {
    id: 'xai', name: 'xAI', emoji: '𝕏', protocol: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4-fast', 'grok-4'],
  },
  {
    id: 'deepseek', name: 'DeepSeek', emoji: '🐋', protocol: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  {
    id: 'together', name: 'Together AI', emoji: '🤝', protocol: 'openai',
    baseUrl: 'https://api.together.ai/v1',
    models: ['openai/gpt-oss-20b', 'meta-llama/Llama-3.3-70B-Instruct-Turbo'],
  },
  {
    id: 'ollama', name: 'Ollama', emoji: '🦙', protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1', requiresApiKey: false,
    models: ['gemma3', 'llama3.2'],
  },
  {
    id: 'lmstudio', name: 'LM Studio', emoji: '🖥️', protocol: 'openai',
    baseUrl: 'http://127.0.0.1:1234/v1', requiresApiKey: false,
    models: ['local-model'],
  },
  {
    id: 'custom', name: 'Eigener Anbieter', emoji: '🔌', protocol: 'openai',
    baseUrl: '', models: ['model-name'],
  },
]);

export function parseProviderModels(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  return [...new Set(input.map(item => String(item || '').trim()).filter(Boolean))]
    .slice(0, MAX_PROVIDER_MODELS)
    .map(item => item.slice(0, 180));
}

export function normalizeProviderConnections(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, MAX_PROVIDER_CONNECTIONS).flatMap(raw => {
    const id = String(raw?.id || '').trim().slice(0, 90);
    if (!/^api-[a-zA-Z0-9_-]+$/.test(id) || seen.has(id)) return [];
    seen.add(id);
    const protocol = ['openai', 'anthropic', 'gemini'].includes(raw?.protocol) ? raw.protocol : 'openai';
    const models = parseProviderModels(raw?.models);
    return [{
      id,
      presetId: String(raw?.presetId || 'custom').slice(0, 40),
      name: String(raw?.name || 'API Provider').trim().slice(0, 80) || 'API Provider',
      emoji: String(raw?.emoji || '🔌').slice(0, 8),
      protocol,
      baseUrl: String(raw?.baseUrl || '').trim().slice(0, 500),
      requiresApiKey: raw?.requiresApiKey !== false,
      models: models.length ? models : ['model-name'],
    }];
  });
}

export function createProviderConnection(presetId, id) {
  const preset = PROVIDER_PRESETS.find(item => item.id === presetId) || PROVIDER_PRESETS.at(-1);
  return normalizeProviderConnections([{
    ...preset,
    id,
    presetId: preset.id,
  }])[0];
}

export function getProviderConnection(providerId, connections = []) {
  return normalizeProviderConnections(connections).find(item => item.id === providerId) || null;
}

export function getProviderOptions(connections = []) {
  return [
    ...BUILTIN_PROVIDERS,
    ...normalizeProviderConnections(connections).map(item => ({ ...item, kind: 'api' })),
  ];
}

export function getProviderModels(providerId, connections = [], builtinModels = {}, currentModel = '') {
  const connection = getProviderConnection(providerId, connections);
  const models = connection?.models || builtinModels[providerId] || [];
  return [...new Set([...models, String(currentModel || '').trim()].filter(Boolean))];
}

export function getProviderLabel(providerId, connections = []) {
  return getProviderOptions(connections).find(item => item.id === providerId)?.name || providerId || 'Provider';
}

export function getProviderEmoji(providerId, connections = []) {
  return getProviderOptions(connections).find(item => item.id === providerId)?.emoji || '🔌';
}

export function isConfiguredProvider(providerId, connections = []) {
  return Boolean(getProviderConnection(providerId, connections));
}
