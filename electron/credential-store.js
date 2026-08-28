const crypto = require('crypto');

const SECURE_CREDENTIALS_KEY = 'secureCredentials';
const PROVIDER_SETTINGS_KEY = 'providerSettings';
const CUSTOM_PROVIDER_PREFIX = 'provider:';

function createCredentialStore(store, safeStorage) {
  function encryptionAvailable() {
    return Boolean(safeStorage?.isEncryptionAvailable?.());
  }

  function readEncryptedMap() {
    const value = store.get(SECURE_CREDENTIALS_KEY);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function writeEncryptedMap(value) {
    store.set(SECURE_CREDENTIALS_KEY, value);
  }

  function encrypt(value) {
    if (!encryptionAvailable()) {
      throw new Error('Der Betriebssystem-Schlüsselspeicher ist derzeit nicht verfügbar.');
    }
    return safeStorage.encryptString(String(value)).toString('base64');
  }

  function decrypt(value) {
    if (!value || !encryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      return '';
    }
  }

  function getSecret(name) {
    const envName = name === 'openai' ? 'OPENAI_API_KEY' : name === 'anthropic' ? 'ANTHROPIC_API_KEY' : '';
    if (envName && process.env[envName]) return process.env[envName].trim();
    return decrypt(readEncryptedMap()[name]);
  }

  function hasSecret(name) {
    if (name === 'openai' && process.env.OPENAI_API_KEY?.trim()) return true;
    if (name === 'anthropic' && process.env.ANTHROPIC_API_KEY?.trim()) return true;
    return Boolean(readEncryptedMap()[name] && decrypt(readEncryptedMap()[name]));
  }

  function customProviderStorageKey(providerId) {
    const id = String(providerId || '').trim();
    if (!/^api-[a-zA-Z0-9_-]{1,86}$/.test(id)) throw new Error('Ungültige Provider-ID.');
    return `${CUSTOM_PROVIDER_PREFIX}${id}`;
  }

  function getProviderSecret(providerId) {
    return decrypt(readEncryptedMap()[customProviderStorageKey(providerId)]);
  }

  function configuredProviders() {
    const encrypted = readEncryptedMap();
    return Object.fromEntries(Object.keys(encrypted).flatMap(key => {
      if (!key.startsWith(CUSTOM_PROVIDER_PREFIX)) return [];
      const id = key.slice(CUSTOM_PROVIDER_PREFIX.length);
      if (!/^api-[a-zA-Z0-9_-]{1,86}$/.test(id) || !decrypt(encrypted[key])) return [];
      return [[id, true]];
    }));
  }

  function getProviderSettings() {
    const value = store.get(PROVIDER_SETTINGS_KEY);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function setProviderSettings(updates = {}) {
    const current = getProviderSettings();
    const next = {
      claudeCli: updates.claudeCli === undefined ? Boolean(current.claudeCli) : Boolean(updates.claudeCli),
      claudeSubscriptionType: String(updates.claudeSubscriptionType ?? current.claudeSubscriptionType ?? '').slice(0, 80),
    };
    store.set(PROVIDER_SETTINGS_KEY, next);
    return next;
  }

  function status() {
    const settings = getProviderSettings();
    return {
      encryptionAvailable: encryptionAvailable(),
      openaiConfigured: hasSecret('openai'),
      anthropicConfigured: hasSecret('anthropic'),
      openaiSource: process.env.OPENAI_API_KEY?.trim() ? 'environment' : hasSecret('openai') ? 'secure-storage' : '',
      anthropicSource: process.env.ANTHROPIC_API_KEY?.trim() ? 'environment' : hasSecret('anthropic') ? 'secure-storage' : '',
      claudeCli: Boolean(settings.claudeCli),
      claudeSubscriptionType: settings.claudeSubscriptionType || '',
      providerConfigured: configuredProviders(),
    };
  }

  function updateProviderSecrets(updates = {}) {
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return;
    const encrypted = readEncryptedMap();
    for (const [providerId, rawValue] of Object.entries(updates)) {
      const key = customProviderStorageKey(providerId);
      const value = String(rawValue ?? '').trim();
      if (value) encrypted[key] = encrypt(value);
      else delete encrypted[key];
    }
    writeEncryptedMap(encrypted);
  }

  function updateProviders(updates = {}) {
    const encrypted = readEncryptedMap();
    for (const provider of ['openai', 'anthropic']) {
      if (!Object.prototype.hasOwnProperty.call(updates, provider)) continue;
      const value = String(updates[provider] ?? '').trim();
      if (value) encrypted[provider] = encrypt(value);
      else delete encrypted[provider];
    }
    writeEncryptedMap(encrypted);
    updateProviderSecrets(updates.providers);
    if (updates.claudeCli !== undefined || updates.claudeSubscriptionType !== undefined) {
      setProviderSettings(updates);
    }
    return status();
  }

  function migrateLegacyCredentials() {
    const legacy = store.get('apiKeys');
    if (!legacy || typeof legacy !== 'object') return { migrated: false, status: status() };

    const encrypted = readEncryptedMap();
    let migrated = false;
    if (encryptionAvailable()) {
      for (const provider of ['openai', 'anthropic']) {
        const value = String(legacy[provider] || '').trim();
        if (value && !encrypted[provider]) {
          encrypted[provider] = encrypt(value);
          migrated = true;
        }
      }
      writeEncryptedMap(encrypted);
    }
    setProviderSettings({
      claudeCli: Boolean(legacy.claudeCli || legacy.claudeOAuthToken),
      claudeSubscriptionType: legacy.claudeSubscriptionType || '',
    });

    // Never keep an OAuth token or API key in the ordinary JSON store. If OS
    // encryption is unavailable we deliberately discard it and require the
    // user to configure an environment variable or save it again later.
    store.delete('apiKeys');
    return { migrated, status: status() };
  }

  function getExternalApiToken({ create = false } = {}) {
    let token = getSecret('externalApiToken');
    if (!token && create) {
      token = crypto.randomBytes(32).toString('base64url');
      const encrypted = readEncryptedMap();
      encrypted.externalApiToken = encrypt(token);
      writeEncryptedMap(encrypted);
    }
    return token;
  }

  function regenerateExternalApiToken() {
    const token = crypto.randomBytes(32).toString('base64url');
    const encrypted = readEncryptedMap();
    encrypted.externalApiToken = encrypt(token);
    writeEncryptedMap(encrypted);
    return token;
  }

  function setNamedSecret(name, value) {
    const identifier = Buffer.from(String(name), 'utf8').toString('base64url');
    const key = `named:${identifier}`;
    const encrypted = readEncryptedMap();
    encrypted[key] = encrypt(value);
    writeEncryptedMap(encrypted);
    return `$secure:${identifier}`;
  }

  function getNamedSecret(marker) {
    const match = String(marker || '').match(/^\$secure:([a-zA-Z0-9_-]+)$/);
    if (!match) return '';
    return decrypt(readEncryptedMap()[`named:${match[1]}`]);
  }

  return {
    encryptionAvailable,
    getExternalApiToken,
    getNamedSecret,
    getProviderSecret,
    getProviderSettings,
    getSecret,
    migrateLegacyCredentials,
    regenerateExternalApiToken,
    setProviderSettings,
    setNamedSecret,
    status,
    updateProviders,
    updateProviderSecrets,
  };
}

module.exports = { createCredentialStore };
