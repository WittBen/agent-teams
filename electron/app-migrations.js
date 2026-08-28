const { normalizeProviderConnections } = require('./provider-config');

const CURRENT_DATA_SCHEMA_VERSION = 3;

const ARRAY_KEYS = ['agents', 'groups', 'mcpServers', 'agentRoles', 'providerConnections'];
const OBJECT_KEYS = [
  'messages', 'conversationStates', 'userRequestQueues', 'taskGraphs', 'groupMemory', 'mcpPermissions',
  'conversationLimits', 'qualityRouting', 'qualityStats',
];

function migrateAppData(store) {
  const previousVersion = Math.max(0, Number(store.get('dataSchemaVersion')) || 0);
  const notices = [];

  for (const key of ARRAY_KEYS) {
    const value = store.get(key);
    if (value !== undefined && !Array.isArray(value)) {
      store.set(key, []);
      notices.push(`${key}: ungültigen Wert durch leere Liste ersetzt`);
    }
  }
  for (const key of OBJECT_KEYS) {
    const value = store.get(key);
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) {
      store.set(key, {});
      notices.push(`${key}: ungültigen Wert durch leeres Objekt ersetzt`);
    }
  }

  const providerConnections = store.get('providerConnections');
  if (Array.isArray(providerConnections)) {
    const normalizedProviders = normalizeProviderConnections(providerConnections);
    if (JSON.stringify(providerConnections) !== JSON.stringify(normalizedProviders)) {
      store.set('providerConnections', normalizedProviders);
      notices.push('providerConnections: ungültige oder unsichere Einträge entfernt');
    }
  }

  if (previousVersion < 2) {
    const externalApi = store.get('externalApi') || {};
    store.set('externalApi', {
      enabled: false,
      port: Math.min(65535, Math.max(1024, Number(externalApi.port) || 3001)),
      allowedOrigins: Array.isArray(externalApi.allowedOrigins) ? externalApi.allowedOrigins : [],
    });
  }


  if (previousVersion < 3 && store.get('providerConnections') === undefined) {
    store.set('providerConnections', []);
  }

  store.set('dataSchemaVersion', CURRENT_DATA_SCHEMA_VERSION);
  if (notices.length) store.set('migrationNotices', notices.slice(-50));
  return { previousVersion, currentVersion: CURRENT_DATA_SCHEMA_VERSION, notices };
}

module.exports = { CURRENT_DATA_SCHEMA_VERSION, migrateAppData };
