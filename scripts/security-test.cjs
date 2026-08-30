const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { AgentAPIServer } = require('../electron/api-server');
const { migrateAppData } = require('../electron/app-migrations');
const { createCredentialStore } = require('../electron/credential-store');
const { assertAllowedStateKey } = require('../electron/ipc-security');
const { normalizeServer, resolveConfiguredRecord } = require('../electron/mcp-manager');
const { writeProjectFile } = require('../electron/project-files');
const { createLocalMemoryOperationQueue, operateLocalMemory } = require('../electron/memory-local');
const { normalizeProviderConnection, normalizeProviderConnections } = require('../electron/provider-config');

function fakeStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: key => values.get(key),
    set: (key, value) => values.set(key, value),
    delete: key => values.delete(key),
    values,
  };
}

const fakeSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`protected:${value}`, 'utf8'),
  decryptString: value => value.toString('utf8').replace(/^protected:/, ''),
};

function request(port, { token = '', origin = '' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (origin) headers.Origin = origin;
    const req = http.request({ host: '127.0.0.1', port, path: '/api/agents', method: 'GET', headers }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('renderer state allowlist excludes credential and trust stores', () => {
  assert.equal(assertAllowedStateKey('messages'), 'messages');
  assert.equal(assertAllowedStateKey('userRequestQueues'), 'userRequestQueues');
  assert.equal(assertAllowedStateKey('providerConnections'), 'providerConnections');
  assert.equal(assertAllowedStateKey('memspace:shared-team'), 'memspace:shared-team');
  for (const key of ['apiKeys', 'secureCredentials', 'providerSettings', 'trustedMcpServers', 'trustedReviewCommands']) {
    assert.throws(() => assertAllowedStateKey(key), /Nicht erlaubter/);
  }
});

test('legacy provider keys migrate to protected storage and leave ordinary store', () => {
  const store = fakeStore({ apiKeys: { openai: 'sk-old-secret', anthropic: 'sk-ant-old', claudeCli: true } });
  const credentials = createCredentialStore(store, fakeSafeStorage);
  const migration = credentials.migrateLegacyCredentials();
  assert.equal(migration.migrated, true);
  assert.equal(store.get('apiKeys'), undefined);
  assert.equal(credentials.getSecret('openai'), 'sk-old-secret');
  assert.equal(credentials.status().openaiConfigured, true);
  assert.equal(credentials.status().claudeCli, true);
  assert.equal(credentials.status().codexCli, true);
  credentials.updateProviders({ codexCli: false });
  assert.equal(credentials.status().codexCli, false);
  credentials.updateProviders({ codexCli: true });
  assert.equal(credentials.status().codexCli, true);
  assert.notEqual(store.get('secureCredentials').openai, 'sk-old-secret');
  const marker = credentials.setNamedSecret('mcp:test:Authorization', 'Bearer protected');
  assert.match(marker, /^\$secure:/);
  assert.equal(credentials.getNamedSecret(marker), 'Bearer protected');
  assert.equal(resolveConfiguredRecord({ Authorization: marker }, 'HTTP-Header', value => credentials.getNamedSecret(value)).Authorization, 'Bearer protected');
  credentials.updateProviders({ providers: { 'api-openrouter': 'sk-or-protected' } });
  assert.equal(credentials.getProviderSecret('api-openrouter'), 'sk-or-protected');
  assert.equal(credentials.status().providerConfigured['api-openrouter'], true);
  assert.notEqual(store.get('secureCredentials')['provider:api-openrouter'], 'sk-or-protected');
  credentials.updateProviders({ providers: { 'api-openrouter': '' } });
  assert.equal(credentials.getProviderSecret('api-openrouter'), '');
});

test('app-state migrations version and repair invalid containers', () => {
  const store = fakeStore({ dataSchemaVersion: 0, messages: [], userRequestQueues: [], groups: { invalid: true }, externalApi: { enabled: true, port: 12 } });
  const result = migrateAppData(store);
  assert.equal(result.currentVersion, 4);
  assert.deepEqual(store.get('messages'), {});
  assert.deepEqual(store.get('userRequestQueues'), {});
  assert.deepEqual(store.get('groups'), []);
  assert.equal(store.get('externalApi').enabled, false);
  assert.equal(store.get('externalApi').port, 1024);
  assert.deepEqual(store.get('providerConnections'), []);
});

test('app-state migration adds a bounded group review profile', () => {
  const store = fakeStore({
    dataSchemaVersion: 3,
    groups: [{ id: 'group-1', name: 'Team' }],
  });
  migrateAppData(store);
  assert.deepEqual(store.get('groups')[0].reviewEnvironment, {
    test: { command: '', args: [] },
    preview: { command: '', args: [] },
    previewUrl: '',
    testTimeoutMs: 120000,
  });
});

test('custom AI providers require safe endpoints and bounded configuration', () => {
  const local = normalizeProviderConnection({
    id: 'api-local', name: 'Local', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1',
    requiresApiKey: false, models: ['gemma3'],
  });
  assert.equal(local.baseUrl, 'http://127.0.0.1:11434/v1');
  assert.doesNotThrow(() => normalizeProviderConnection({
    id: 'api-local-v6', name: 'Local IPv6', protocol: 'openai', baseUrl: 'http://[::1]:1234/v1', models: ['x'],
  }));
  assert.throws(() => normalizeProviderConnection({
    id: 'api-remote', name: 'Remote', protocol: 'openai', baseUrl: 'http://example.com/v1', models: ['x'],
  }), /HTTPS/);
  assert.throws(() => normalizeProviderConnection({
    id: 'api-query', name: 'Query', protocol: 'openai', baseUrl: 'https://example.com/v1?key=secret', models: ['x'],
  }), /Query-Parameter/);
  assert.deepEqual(normalizeProviderConnections([{ id: '../bad', baseUrl: 'https://example.com', models: ['x'] }]), []);
});

test('MCP rejects cleartext remote HTTP and cleartext sensitive values', () => {
  assert.throws(() => normalizeServer({ id: 'remote', name: 'Remote', transport: 'http', url: 'http://example.com/mcp' }), /Loopback/);
  assert.doesNotThrow(() => normalizeServer({ id: 'local', name: 'Local', transport: 'http', url: 'http://127.0.0.1:3000/mcp' }));
  assert.throws(() => resolveConfiguredRecord({ Authorization: 'Bearer secret' }, 'HTTP-Header'), /Klartext/);
  const previous = process.env.AGENT_TEAMS_TEST_TOKEN;
  process.env.AGENT_TEAMS_TEST_TOKEN = 'resolved-secret';
  assert.equal(resolveConfiguredRecord({ Authorization: '$env:AGENT_TEAMS_TEST_TOKEN' }, 'HTTP-Header').Authorization, 'resolved-secret');
  if (previous === undefined) delete process.env.AGENT_TEAMS_TEST_TOKEN;
  else process.env.AGENT_TEAMS_TEST_TOKEN = previous;
});

test('project writer blocks traversal and protected directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-teams-project-'));
  try {
    assert.match(writeProjectFile({ projectPath: root, filename: '../outside.txt', content: 'x' }).error, /innerhalb/);
    assert.match(writeProjectFile({ projectPath: root, filename: '.git/config', content: 'x' }).error, /Geschützter/);
    assert.equal(writeProjectFile({ projectPath: root, filename: 'src/ok.txt', content: 'ok' }).success, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local shared memory serializes parallel writes and isolates namespaces', async () => {
  const store = fakeStore();
  const operate = createLocalMemoryOperationQueue(store);
  const namespace = 'shared-team';
  const first = { id: 'entry-a', type: 'finding', namespace, content: 'A', tags: [], author: 'Max' };
  const second = { id: 'entry-b', type: 'finding', namespace, content: 'B', tags: [], author: 'Lisa' };
  await Promise.all([
    operate({ action: 'write', namespace, entry: first }),
    operate({ action: 'write', namespace, entry: second }),
  ]);
  assert.deepEqual(operateLocalMemory(store, { action: 'list', namespace }).map(entry => entry.id), ['entry-a', 'entry-b']);
  operateLocalMemory(store, {
    action: 'write', namespace: 'other-team',
    entry: { id: 'entry-c', type: 'fact', namespace: 'wrong-value', content: 'C', tags: [], author: 'Tom' },
  });
  assert.equal(operateLocalMemory(store, { action: 'list', namespace: 'other-team' })[0].namespace, 'other-team');
  assert.equal(operateLocalMemory(store, { action: 'list', namespace }).length, 2);
  assert.throws(() => operateLocalMemory(store, { action: 'list', namespace: '../escape' }), /ungültig/);
});

test('external API requires token and never emits wildcard CORS', async () => {
  const store = fakeStore({ agents: [], groups: [] });
  const credentials = createCredentialStore(store, fakeSafeStorage);
  const token = credentials.getExternalApiToken({ create: true });
  const api = new AgentAPIServer({ store, credentialStore: credentials, port: 0, allowedOrigins: ['http://127.0.0.1:8080'] });
  api.start();
  if (!api.server.listening) await new Promise(resolve => api.server.once('listening', resolve));
  const port = api.server.address().port;
  try {
    const anonymous = await request(port);
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.headers['access-control-allow-origin'], undefined);
    const allowed = await request(port, { token, origin: 'http://127.0.0.1:8080' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers['access-control-allow-origin'], 'http://127.0.0.1:8080');
    const denied = await request(port, { token, origin: 'https://evil.example' });
    assert.equal(denied.status, 403);
  } finally {
    api.stop();
  }
});
