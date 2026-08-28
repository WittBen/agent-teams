const MAX_PROVIDER_CONNECTIONS = 30;
const MAX_PROVIDER_MODELS = 40;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function normalizeProviderId(value) {
  const id = String(value || '').trim();
  if (!/^api-[a-zA-Z0-9_-]{1,86}$/.test(id)) throw new Error('Ungültige Provider-ID.');
  return id;
}

function normalizeProviderBaseUrl(value) {
  const input = String(value || '').trim();
  if (!input || input.length > 500) throw new Error('Der API-Provider benötigt eine gültige Base-URL.');
  let parsed;
  try { parsed = new URL(input); }
  catch { throw new Error('Die API-Base-URL ist ungültig.'); }
  const localHttp = parsed.protocol === 'http:' && LOCAL_HOSTS.has(parsed.hostname.toLowerCase());
  if (parsed.protocol !== 'https:' && !localHttp) {
    throw new Error('API-Provider müssen HTTPS verwenden; HTTP ist nur für localhost erlaubt.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Die API-Base-URL darf keine Zugangsdaten, Query-Parameter oder Fragmente enthalten.');
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeModels(value) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  const models = [...new Set(input.map(item => String(item || '').trim()).filter(Boolean))]
    .slice(0, MAX_PROVIDER_MODELS)
    .map(item => item.slice(0, 180));
  if (!models.length) throw new Error('Der API-Provider benötigt mindestens ein Modell.');
  return models;
}

function normalizeProviderConnection(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Ungültige Provider-Konfiguration.');
  const protocol = ['openai', 'anthropic', 'gemini'].includes(raw.protocol) ? raw.protocol : 'openai';
  return {
    id: normalizeProviderId(raw.id),
    presetId: String(raw.presetId || 'custom').slice(0, 40),
    name: String(raw.name || '').trim().slice(0, 80) || 'API Provider',
    emoji: String(raw.emoji || '🔌').slice(0, 8),
    protocol,
    baseUrl: normalizeProviderBaseUrl(raw.baseUrl),
    requiresApiKey: raw.requiresApiKey !== false,
    models: normalizeModels(raw.models),
  };
}

function normalizeProviderConnections(value, { strict = false } = {}) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const raw of value.slice(0, MAX_PROVIDER_CONNECTIONS)) {
    try {
      const normalized = normalizeProviderConnection(raw);
      if (seen.has(normalized.id)) throw new Error(`Doppelte Provider-ID: ${normalized.id}`);
      seen.add(normalized.id);
      result.push(normalized);
    } catch (error) {
      if (strict) throw error;
    }
  }
  return result;
}

function findProviderConnection(value, providerId) {
  return normalizeProviderConnections(value).find(item => item.id === providerId) || null;
}

function providerEndpoint(connection, suffix) {
  const base = new URL(`${connection.baseUrl.replace(/\/+$/, '')}/`);
  base.pathname = `${base.pathname.replace(/\/+$/, '')}/${String(suffix || '').replace(/^\/+/, '')}`;
  return base;
}

module.exports = {
  findProviderConnection,
  normalizeProviderBaseUrl,
  normalizeProviderConnection,
  normalizeProviderConnections,
  normalizeProviderId,
  providerEndpoint,
};
