const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Store = require('electron-store');
const { callAnthropicMessages, callConfiguredProvider, httpsPostDirect } = require('./llm-main');
const { AgentAPIServer } = require('./api-server');
const { callCodexCLI, cancelCodexRun, getCodexStatus, startCodexLogin } = require('./codex-main');
const { callClaudeCLI, cancelClaudeRun, getClaudeStatus } = require('./claude-main');
const { writeProjectFile, listProjectFiles } = require('./project-files');
const { ensureMemoryFile, operateMemoryFile, validateMemoryFilePath } = require('./memory-file');
const { McpManager, configFingerprint, normalizeServer } = require('./mcp-manager');
const { ensureOfficialMcpPreset } = require('./mcp-preset');
const { createCredentialStore } = require('./credential-store');
const { migrateAppData } = require('./app-migrations');
const { assertAllowedStateKey, createSenderValidator } = require('./ipc-security');
const { findProviderConnection, normalizeProviderConnections } = require('./provider-config');
const {
  attachmentData,
  appendAttachmentContext,
  clearChatAttachments,
  deleteAttachment,
  prepareApiMessages,
  resolveAttachmentBundle,
  savePickedAttachments,
  validateStoredAttachment,
} = require('./chat-attachments');

const PRODUCT_NAME = 'Agent Teams';
const isDev = process.env.NODE_ENV === 'development';

// The public package name no longer uses the historical project codename. An
// existing installation keeps using its old data directory so chats and
// settings are not lost during the rename. New installations use the new path.
const defaultUserDataPath = app.getPath('userData');
const legacyUserDataPath = path.join(app.getPath('appData'), 'whatsapp-agents');
if (!samePath(defaultUserDataPath, legacyUserDataPath)
    && fs.existsSync(path.join(legacyUserDataPath, 'config.json'))
    && !fs.existsSync(path.join(defaultUserDataPath, 'config.json'))) {
  app.setPath('userData', legacyUserDataPath);
}
const store = new Store();
migrateAppData(store);
const credentialStore = createCredentialStore(store, safeStorage);
const assertTrustedSender = createSenderValidator({ appRoot: path.join(__dirname, '..'), isDev });

function handleIpc(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...args);
  });
}

function onIpc(channel, handler) {
  ipcMain.on(channel, (event, ...args) => {
    assertTrustedSender(event);
    return handler(event, ...args);
  });
}

function isSensitiveConfigurationName(name) {
  return /(?:authorization|api[-_]?key|token|secret|password|credential|cookie)/i.test(String(name || ''));
}

function protectMcpRecord(record, serverId, scope) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return {};
  return Object.fromEntries(Object.entries(record).map(([key, rawValue]) => {
    const value = String(rawValue ?? '');
    if (!value || !isSensitiveConfigurationName(key) || /^\$(?:env|secure):/i.test(value)) return [key, value];
    return [key, credentialStore.setNamedSecret(`mcp:${serverId}:${scope}:${key}`, value)];
  }));
}

function protectMcpServers(servers) {
  if (!Array.isArray(servers)) return [];
  return servers.map(server => ({
    ...server,
    headers: protectMcpRecord(server?.headers, server?.id || 'server', 'header'),
    env: protectMcpRecord(server?.env, server?.id || 'server', 'env'),
  }));
}

function migrateStoredMcpSecrets() {
  const servers = store.get('mcpServers');
  if (Array.isArray(servers)) store.set('mcpServers', protectMcpServers(servers));
  const groups = store.get('groups');
  if (Array.isArray(groups)) {
    store.set('groups', groups.map(group => ({ ...group, mcpServers: protectMcpServers(group?.mcpServers) })));
  }
}

function brandedWindowTitle(detail = '') {
  const normalizedDetail = String(detail || '').trim();
  return normalizedDetail ? `${PRODUCT_NAME} – ${normalizedDetail}` : PRODUCT_NAME;
}

function hardenWindow(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (targetUrl !== window.webContents.getURL()) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
}

let mainWindow;
const mcpManager = new McpManager({ secretResolver: marker => credentialStore.getNamedSecret(marker) });

async function ensureMcpServerTrusted(event, rawServer) {
  const server = normalizeServer(rawServer);
  const fingerprint = configFingerprint(server);
  const trusted = store.get('trustedMcpServers') || {};
  if (trusted[server.id] === fingerprint) return server;
  const detail = server.transport === 'http'
    ? `Adresse: ${server.url}`
    : `Programm: ${server.command}\nArgumente: ${server.args.join(' ') || '(keine)'}`;
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const options = {
    type: 'warning',
    buttons: ['Abbrechen', 'Diesem Server vertrauen'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'MCP-Server bestätigen',
    message: `Möchtest du den MCP-Server „${server.name}“ verbinden?`,
    detail: `${detail}\n\nMCP-Server können Daten lesen, verändern oder lokale Programme ausführen. Die Freigabe verfällt automatisch, wenn sich die Konfiguration ändert.`,
  };
  const result = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (result.response !== 1) throw new Error(`MCP-Server „${server.name}“ wurde nicht freigegeben.`);
  store.set('trustedMcpServers', { ...trusted, [server.id]: fingerprint });
  return server;
}

// Keep one visible app instance. A second desktop-shortcut click focuses the
// existing window instead of starting another Electron process tree.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

handleIpc('codex-call', async (event, params = {}) => callCodexCLI({
  ...prepareCliAttachmentParams(params),
  onProgress: (progress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('codex-progress', { requestId: params.requestId, ...progress });
    }
  },
}));
handleIpc('codex-cancel', async (_, requestId) => cancelCodexRun(requestId));
handleIpc('codex-status', async () => getCodexStatus());
handleIpc('codex-login', async () => startCodexLogin());
handleIpc('claude-call', async (event, params = {}) => callClaudeCLI({
  ...prepareCliAttachmentParams(params),
  onProgress: (progress) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('claude-progress', { requestId: params.requestId, ...progress });
    }
  },
}));
handleIpc('claude-cancel', async (_, requestId) => cancelClaudeRun(requestId));
handleIpc('claude-status', async () => getClaudeStatus());

function chatAttachmentsRoot() {
  return path.join(app.getPath('userData'), 'chat-attachments');
}

function samePath(left, right) {
  if (!left || !right) return false;
  return path.resolve(String(left)).toLowerCase() === path.resolve(String(right)).toLowerCase();
}

function trustedFileSystemPaths() {
  const raw = store.get('trustedFileSystemPaths');
  return Array.isArray(raw) ? raw.filter(Boolean) : [];
}

function trustFileSystemPath(candidate) {
  const resolved = path.resolve(String(candidate));
  const current = trustedFileSystemPaths();
  if (!current.some(item => samePath(item, resolved))) store.set('trustedFileSystemPaths', [...current, resolved]);
  return resolved;
}

function isTrustedFileSystemPath(candidate) {
  return trustedFileSystemPaths().some(item => samePath(item, candidate));
}

function migrateConfiguredFileSystemTrust() {
  for (const configured of configuredProjectPaths()) trustFileSystemPath(configured);
  const knowledgeBase = store.get('kbPath');
  if (knowledgeBase) trustFileSystemPath(knowledgeBase);
  for (const group of store.get('groups') || []) {
    if (group?.memory?.filePath) trustFileSystemPath(group.memory.filePath);
  }
}

function configuredProjectPaths() {
  return [
    store.get('projectPath'),
    ...(store.get('groups') || []).map(group => group?.projectPath),
  ].filter(Boolean);
}

function assertConfiguredProjectPath(candidate) {
  if (!configuredProjectPaths().some(configured => samePath(configured, candidate))) {
    throw new Error('Der Projektordner ist nicht in der App konfiguriert.');
  }
  if (!isTrustedFileSystemPath(candidate)) throw new Error('Der Projektordner wurde nicht über die App ausgewählt.');
  return path.resolve(String(candidate));
}

function assertConfiguredMemoryPath(candidate) {
  const configuredPaths = (store.get('groups') || []).map(group => group?.memory?.filePath).filter(Boolean);
  if (!configuredPaths.some(configured => samePath(configured, candidate))) {
    throw new Error('Die Memory-Datei ist keiner gespeicherten Gruppe zugeordnet.');
  }
  if (!isTrustedFileSystemPath(candidate)) throw new Error('Die Memory-Datei wurde nicht über die App ausgewählt.');
  return validateMemoryFilePath(candidate);
}

function prepareCliAttachmentParams(params = {}) {
  const { cwd: requestedCwd, ...safeParams } = params;
  const bundle = resolveAttachmentBundle(params.attachments, chatAttachmentsRoot());
  const merged = appendAttachmentContext(params.merged || [], bundle.textContext, bundle.fileContext);
  const cwd = requestedCwd ? assertConfiguredProjectPath(requestedCwd) : undefined;
  return { ...safeParams, ...(cwd ? { cwd } : {}), merged, attachments: bundle.attachments };
}

handleIpc('pick-chat-attachments', async (_, { chatId } = {}) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    title: 'Dateien anhängen',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Alle Dateien', extensions: ['*'] },
      { name: 'Dokumente', extensions: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'csv', 'json'] },
      { name: 'Bilder', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] },
    ],
  });
  if (result.canceled || !result.filePaths.length) return { attachments: [], errors: [] };
  return savePickedAttachments({ sourcePaths: result.filePaths, root: chatAttachmentsRoot(), chatId });
});

handleIpc('chat-attachment-data', async (_, { attachment } = {}) => {
  try { return attachmentData(attachment, chatAttachmentsRoot()); }
  catch (error) { return { error: error.message }; }
});

handleIpc('open-chat-attachment', async (_, { attachment } = {}) => {
  try {
    const item = validateStoredAttachment(attachment, chatAttachmentsRoot());
    const electronShell = require('electron').shell;
    const unsafeToLaunch = new Set(['.exe', '.msi', '.com', '.scr', '.bat', '.cmd', '.ps1', '.vbs', '.js', '.jse', '.wsf', '.wsh', '.lnk', '.reg', '.jar', '.app', '.sh']);
    if (unsafeToLaunch.has(path.extname(item.path).toLowerCase())) {
      electronShell.showItemInFolder(item.path);
      return { ok: true, revealed: true };
    }
    const result = await electronShell.openPath(item.path);
    return result ? { error: result } : { ok: true };
  } catch (error) { return { error: error.message }; }
});

handleIpc('delete-chat-attachment', async (_, { attachment } = {}) => {
  try { return deleteAttachment(attachment, chatAttachmentsRoot()); }
  catch (error) { return { error: error.message }; }
});

handleIpc('clear-chat-attachments', async (_, { chatId } = {}) => {
  try { return clearChatAttachments(chatId, chatAttachmentsRoot()); }
  catch (error) { return { error: error.message }; }
});

// ── Model Context Protocol ───────────────────────────────────────────────────
// Connections live in the main process: stdio child processes and HTTP auth
// headers are never exposed to web content outside the isolated preload API.
handleIpc('mcp-list-tools', async (event, { servers = [] } = {}) => {
  const trustedServers = [];
  for (const server of protectMcpServers(Array.isArray(servers) ? servers.slice(0, 30) : [])) {
    trustedServers.push(await ensureMcpServerTrusted(event, server));
  }
  return mcpManager.listTools(trustedServers);
});
handleIpc('mcp-call-tool', async (event, { server, name, arguments: args = {} } = {}) => (
  mcpManager.callTool(await ensureMcpServerTrusted(event, protectMcpServers([server])[0]), name, args)
));
handleIpc('mcp-test-server', async (event, { server } = {}) => (
  mcpManager.testServer(await ensureMcpServerTrusted(event, protectMcpServers([server])[0]))
));
handleIpc('mcp-disconnect', async (_, serverId) => mcpManager.disconnect(serverId));

// ── LLM API call via IPC ──────────────────────────────────────────────────────
handleIpc('llm-call', async (_, { provider, model, systemContent, merged, cwd, attachments = [] }) => {
  try {
    if (provider === 'codex') {
      return callCodexCLI(prepareCliAttachmentParams({ systemContent, merged, model, cwd, attachments }));
    }
    if (provider === 'anthropic') {
      const apiKey = credentialStore.getSecret('anthropic');
      if (!apiKey) return { error: 'Anthropic ist nicht konfiguriert.', status: 401 };
      const prepared = prepareApiMessages({ messages: merged, attachments, root: chatAttachmentsRoot(), provider: 'anthropic' });
      return callAnthropicMessages({ auth: { type: 'api-key', value: apiKey }, model, systemContent, messages: prepared.messages });
    } else if (provider === 'openai') {
      const apiKey = credentialStore.getSecret('openai');
      if (!apiKey) return { error: 'OpenAI ist nicht konfiguriert.', status: 401 };
      const prepared = prepareApiMessages({ messages: merged, attachments, root: chatAttachmentsRoot(), provider: 'openai' });
      const headers = { 'content-type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
      const res = await httpsPostDirect('api.openai.com', '/v1/chat/completions', headers,
        JSON.stringify({ model, messages: [{ role: 'system', content: systemContent }, ...prepared.messages], temperature: 0.85, max_tokens: 300 }));
      if (res.body.error) return { error: res.body.error.message, status: res.status };
      return { text: res.body.choices?.[0]?.message?.content || '' };
    }
    const connection = findProviderConnection(store.get('providerConnections'), provider);
    if (!connection) return { error: 'Der konfigurierte API-Provider wurde nicht gefunden.', status: 404 };
    const apiKey = credentialStore.getProviderSecret(connection.id);
    if (connection.requiresApiKey && !apiKey) return { error: `Für „${connection.name}“ ist kein API-Key konfiguriert.`, status: 401 };
    const attachmentProtocol = connection.protocol === 'anthropic' ? 'anthropic' : 'openai';
    const prepared = prepareApiMessages({ messages: merged, attachments, root: chatAttachmentsRoot(), provider: attachmentProtocol });
    return callConfiguredProvider({ connection, apiKey, model, systemContent, messages: prepared.messages });
  } catch (e) {
    return { error: e.message };
  }
});
// Run bundled MCP migrations before the renderer reads its initial state. This
// also covers production starts where an older renderer instance never wrote
// the new keys to electron-store.
ensureOfficialMcpPreset(store);

let taskWindow;
let taskWindowState = null;
let closingMcpConnections = false;
let apiServer = null;
let externalApiError = '';

function externalApiConfig() {
  const raw = store.get('externalApi') || {};
  return {
    enabled: Boolean(raw.enabled),
    port: Math.min(65535, Math.max(1024, Number(raw.port) || 3001)),
    allowedOrigins: Array.isArray(raw.allowedOrigins)
      ? raw.allowedOrigins.filter(origin => /^https?:\/\//i.test(origin)).slice(0, 20)
      : [],
  };
}

function removeChatKey(storeKey, chatId) {
  const current = store.get(storeKey) || {};
  if (!Object.prototype.hasOwnProperty.call(current, chatId)) return;
  const next = { ...current };
  delete next[chatId];
  store.set(storeKey, next);
}

async function deleteConversationData(chatId, { keepGroup = false } = {}) {
  const safeChatId = String(chatId || '').trim().slice(0, 200);
  if (!safeChatId) throw new Error('Chat-ID fehlt.');
  const group = (store.get('groups') || []).find(item => item.id === safeChatId);
  for (const key of ['messages', 'conversationStates', 'userRequestQueues', 'taskGraphs', 'mcpPermissions']) {
    removeChatKey(key, safeChatId);
  }
  if (!keepGroup) {
    removeChatKey('groupMemory', safeChatId);
    store.set('groups', (store.get('groups') || []).filter(item => item.id !== safeChatId));
    if (group?.memory?.provider !== 'file' && group?.memory?.namespace) {
      store.delete(`memspace:${group.memory.namespace}`);
    }
  }
  clearChatAttachments(safeChatId, chatAttachmentsRoot());
  return { ok: true };
}

function stopExternalApiServer() {
  if (apiServer) apiServer.stop();
  apiServer = null;
}

function syncExternalApiServer() {
  stopExternalApiServer();
  externalApiError = '';
  const config = externalApiConfig();
  if (!config.enabled) return { ...config, running: false, tokenConfigured: false };
  try {
    credentialStore.getExternalApiToken({ create: true });
    apiServer = new AgentAPIServer({
      store,
      credentialStore,
      port: config.port,
      allowedOrigins: config.allowedOrigins,
      onDeleteConversation: deleteConversationData,
      onError: error => { externalApiError = error.code || error.message; },
    });
    apiServer.start();
    return { ...config, running: true, tokenConfigured: true };
  } catch (error) {
    externalApiError = error.message;
    stopExternalApiServer();
    return { ...config, running: false, tokenConfigured: false, error: externalApiError };
  }
}

function externalApiStatus() {
  const config = externalApiConfig();
  return {
    ...config,
    running: Boolean(apiServer?.server?.listening),
    tokenConfigured: Boolean(credentialStore.getExternalApiToken()),
    error: externalApiError,
  };
}

function redactSensitiveConfiguration(value) {
  if (Array.isArray(value)) return value.map(redactSensitiveConfiguration);
  if (!value || typeof value !== 'object') return value;
  const next = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:authorization|api[-_]?key|token|secret|password|credential|cookie)/i.test(key)) {
      next[key] = nested ? '[REDACTED]' : nested;
    } else {
      next[key] = redactSensitiveConfiguration(nested);
    }
  }
  return next;
}

function exportableUserData() {
  const excluded = new Set([
    'secureCredentials', 'trustedMcpServers', 'trustedFileSystemPaths', 'apiKeys',
  ]);
  return {
    format: 'agent-teams-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    appVersion: app.getVersion(),
    data: Object.fromEntries(Object.entries(store.store).flatMap(([key, value]) => (
      excluded.has(key) ? [] : [[key, redactSensitiveConfiguration(value)]]
    ))),
  };
}

function sendTaskWindowState() {
  if (!taskWindow || taskWindow.isDestroyed() || taskWindow.webContents.isLoading()) return;
  taskWindow.webContents.send('task-window-state', taskWindowState);
}

function loadTaskWindow() {
  const distFile = path.join(__dirname, '../dist/index.html');
  const mainUrl = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.getURL() : '';
  if (isDev && /^https?:/i.test(mainUrl)) {
    const url = new URL(mainUrl);
    url.searchParams.set('taskWindow', '1');
    return taskWindow.loadURL(url.toString());
  }
  return taskWindow.loadFile(distFile, { query: { taskWindow: '1' } });
}

function openTaskWindow(nextState = {}) {
  taskWindowState = nextState;
  const title = brandedWindowTitle(nextState.windowTitle || 'Aufgabenbaum');
  if (taskWindow && !taskWindow.isDestroyed()) {
    taskWindow.setTitle(title);
    sendTaskWindowState();
    if (taskWindow.isMinimized()) taskWindow.restore();
    taskWindow.show();
    taskWindow.focus();
    return taskWindow;
  }

  taskWindow = new BrowserWindow({
    width: 900,
    height: 720,
    minWidth: 560,
    minHeight: 440,
    title,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#111b21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  hardenWindow(taskWindow);

  taskWindow.once('ready-to-show', () => {
    if (!taskWindow || taskWindow.isDestroyed()) return;
    sendTaskWindowState();
    taskWindow.show();
  });
  taskWindow.webContents.on('did-finish-load', sendTaskWindowState);
  taskWindow.on('closed', () => {
    taskWindow = null;
    taskWindowState = null;
  });
  loadTaskWindow();
  return taskWindow;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: PRODUCT_NAME,
    frame: false,
    backgroundColor: '#111b21',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  hardenWindow(mainWindow);

  const distFile = path.join(__dirname, '../dist/index.html');
  const distExists = fs.existsSync(distFile);

  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  if (isDev) {
    // Probe Vite with short timeout; fall back to dist immediately
    const http = require('http');
    const req = http.get('http://localhost:5173', res => {
      if (res.statusCode < 400) {
        mainWindow.loadURL('http://localhost:5173');
      } else {
        mainWindow.loadFile(distFile);
      }
    });
    req.on('error', () => {
      console.log('[main] Vite unreachable — loading dist/');
      if (distExists) {
        mainWindow.loadFile(distFile);
      } else {
        mainWindow.loadURL('http://localhost:5173'); // retry anyway
      }
    });
    req.setTimeout(1000, () => {
      req.destroy();
      console.log('[main] Vite timeout — loading dist/');
      if (distExists) mainWindow.loadFile(distFile);
    });
  } else {
    if (distExists) {
      mainWindow.loadFile(distFile);
    } else {
      // dist missing — show error page
      mainWindow.loadURL(`data:text/html,<h2 style="font-family:sans-serif;color:#e9edef;background:#111b21;padding:40px">Agent Teams: dist/ nicht gefunden.<br><small>Bitte einmal <code>npm run build</code> im Projektordner ausführen.</small></h2>`);
    }
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (taskWindow && !taskWindow.isDestroyed()) taskWindow.close();
  });
}

app.whenReady().then(() => {
  credentialStore.migrateLegacyCredentials();
  migrateStoredMcpSecrets();
  migrateConfiguredFileSystemTrust();
  // Detect locally authenticated CLIs without copying their OAuth tokens.
  autoInjectCredentials();
  createWindow();
  syncExternalApiServer();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function autoInjectCredentials() {
  try {
    const existing = credentialStore.getProviderSettings();
    let claudeCli = Boolean(existing.claudeCli);
    let subscriptionType = existing.claudeSubscriptionType || '';

    // Detect Claude Code without copying its OAuth token into the app store.
    const claudePath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (fs.existsSync(claudePath)) {
      const creds = JSON.parse(fs.readFileSync(claudePath, 'utf-8'));
      const token = creds?.claudeAiOauth?.accessToken;
      const isExpired = creds?.claudeAiOauth?.expiresAt && Date.now() > creds.claudeAiOauth.expiresAt;
      if (token && !isExpired && !claudeCli) {
        claudeCli = true;
        subscriptionType = creds.claudeAiOauth.subscriptionType || 'pro';
        console.log('[auto-detect] Claude Code session detected');
      }
    }
    credentialStore.setProviderSettings({ claudeCli, claudeSubscriptionType: subscriptionType });
  } catch (e) {
    console.error('[auto-inject] Error:', e.message);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  stopExternalApiServer();
  if (closingMcpConnections || mcpManager.connections.size === 0) return;
  event.preventDefault();
  closingMcpConnections = true;
  mcpManager.closeAll().finally(() => app.quit());
});

// Window controls
onIpc('window-minimize', (event) => BrowserWindow.fromWebContents(event.sender)?.minimize());
onIpc('window-maximize', (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target) return;
  if (target.isMaximized()) target.unmaximize();
  else target.maximize();
});
onIpc('window-close', (event) => BrowserWindow.fromWebContents(event.sender)?.close());

// Detached task-tree window. Electron owns the singleton so repeated requests
// focus and update the existing OS window instead of creating duplicates.
handleIpc('task-window-open', (_, state = {}) => {
  openTaskWindow(state);
  return { ok: true };
});
onIpc('task-window-update', (_, state = {}) => {
  taskWindowState = state;
  if (taskWindow && !taskWindow.isDestroyed()) {
    taskWindow.setTitle(brandedWindowTitle(state.windowTitle || 'Aufgabenbaum'));
    sendTaskWindowState();
  }
});
handleIpc('task-window-get-state', () => taskWindowState);
onIpc('task-window-close', () => {
  if (taskWindow && !taskWindow.isDestroyed()) taskWindow.close();
});
onIpc('task-window-action', (_, action = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('task-window-action', action);
});

// Narrow app-state IPC. Renderer code cannot inspect security credentials or
// arbitrary electron-store values.
handleIpc('app-state-get', (_, key) => store.get(assertAllowedStateKey(key)));
handleIpc('app-state-set', (_, key, value) => {
  const allowedKey = assertAllowedStateKey(key);
  const protectedValue = allowedKey === 'mcpServers'
    ? protectMcpServers(value)
    : allowedKey === 'providerConnections'
      ? normalizeProviderConnections(value, { strict: true })
    : allowedKey === 'groups' && Array.isArray(value)
      ? value.map(group => ({ ...group, mcpServers: protectMcpServers(group?.mcpServers) }))
      : value;
  const serialized = JSON.stringify(protectedValue);
  if (serialized && Buffer.byteLength(serialized) > 50 * 1024 * 1024) {
    throw new Error('App-State ist größer als 50 MB.');
  }
  store.set(allowedKey, protectedValue);
  return { ok: true, value: protectedValue };
});
handleIpc('app-state-delete', (_, key) => {
  store.delete(assertAllowedStateKey(key));
  return { ok: true };
});

handleIpc('provider-credentials-status', () => credentialStore.status());
handleIpc('provider-credentials-update', (_, updates = {}) => {
  const safeUpdates = {};
  for (const provider of ['openai', 'anthropic']) {
    if (!Object.prototype.hasOwnProperty.call(updates, provider)) continue;
    const value = String(updates[provider] ?? '');
    if (value.length > 1000) throw new Error('Der API-Schlüssel ist ungültig.');
    safeUpdates[provider] = value;
  }
  if (updates.providers !== undefined) {
    if (!updates.providers || typeof updates.providers !== 'object' || Array.isArray(updates.providers)) {
      throw new Error('Ungültige Provider-Schlüssel.');
    }
    const providerUpdates = Object.entries(updates.providers);
    if (providerUpdates.length > 30) throw new Error('Zu viele Provider-Schlüssel.');
    safeUpdates.providers = Object.fromEntries(providerUpdates.map(([providerId, rawValue]) => {
      if (!/^api-[a-zA-Z0-9_-]{1,86}$/.test(providerId)) throw new Error('Ungültige Provider-ID.');
      const value = String(rawValue ?? '');
      if (value.length > 2000) throw new Error('Der API-Schlüssel ist ungültig.');
      return [providerId, value];
    }));
  }
  if (updates.claudeCli !== undefined) safeUpdates.claudeCli = Boolean(updates.claudeCli);
  if (updates.claudeSubscriptionType !== undefined) {
    safeUpdates.claudeSubscriptionType = String(updates.claudeSubscriptionType).slice(0, 80);
  }
  return credentialStore.updateProviders(safeUpdates);
});

handleIpc('delete-conversation-data', (_, chatId, options = {}) => (
  deleteConversationData(chatId, { keepGroup: Boolean(options.keepGroup) })
));

handleIpc('external-api-status', () => externalApiStatus());
handleIpc('external-api-configure', (_, next = {}) => {
  const current = externalApiConfig();
  const allowedOrigins = Array.isArray(next.allowedOrigins)
    ? next.allowedOrigins.map(value => {
      try {
        const parsed = new URL(String(value));
        return /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
      } catch { return ''; }
    }).filter(Boolean).slice(0, 20)
    : current.allowedOrigins;
  const config = {
    enabled: next.enabled === undefined ? current.enabled : Boolean(next.enabled),
    port: next.port === undefined ? current.port : Math.min(65535, Math.max(1024, Number(next.port) || 3001)),
    allowedOrigins,
  };
  store.set('externalApi', config);
  const result = syncExternalApiServer();
  return {
    ...result,
    token: config.enabled && !result.error ? credentialStore.getExternalApiToken({ create: true }) : '',
  };
});
handleIpc('external-api-regenerate-token', () => {
  if (!externalApiConfig().enabled) throw new Error('Die externe API ist deaktiviert.');
  const token = credentialStore.regenerateExternalApiToken();
  return { ...externalApiStatus(), token };
});

handleIpc('user-data-export', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const options = {
    title: 'Agent-Teams-Daten exportieren',
    defaultPath: path.join(app.getPath('documents'), `agent-teams-export-${new Date().toISOString().slice(0, 10)}.json`),
    filters: [{ name: 'Agent Teams Export', extensions: ['json'] }],
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  };
  const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (result.canceled || !result.filePath) return { cancelled: true };
  const target = path.resolve(result.filePath);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(exportableUserData(), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, target);
    return { ok: true, filePath: target };
  } catch (error) {
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); } catch {}
    return { error: error.message };
  }
});

handleIpc('user-data-open-folder', async () => {
  const result = await shell.openPath(app.getPath('userData'));
  return result ? { error: result } : { ok: true };
});

handleIpc('user-data-delete-all', async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) || mainWindow;
  const options = {
    type: 'warning',
    buttons: ['Abbrechen', 'Alle lokalen App-Daten löschen'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    title: 'Lokale Daten löschen',
    message: 'Alle lokalen Agent-Teams-Daten wirklich löschen?',
    detail: 'Chats, Gruppen, App-Memory, Einstellungen, Anhänge, Toolrechte und gespeicherte API-Schlüssel werden entfernt. Externe Projektordner und separat ausgewählte Memory-Dateien bleiben erhalten.',
  };
  const decision = owner ? await dialog.showMessageBox(owner, options) : await dialog.showMessageBox(options);
  if (decision.response !== 1) return { cancelled: true };
  stopExternalApiServer();
  await mcpManager.closeAll();
  store.clear();
  const attachmentRoot = chatAttachmentsRoot();
  if (fs.existsSync(attachmentRoot)) fs.rmSync(attachmentRoot, { recursive: true, force: true });
  setImmediate(() => {
    app.relaunch();
    app.exit(0);
  });
  return { ok: true };
});

// ── JSON file-backed Shared Memory ───────────────────────────────────────────
// Serialize all operations per file so parallel agents cannot overwrite one
// another's entries with stale read/modify/write cycles.
const memoryFileQueues = new Map();

function queueMemoryFileOperation(filePath, operation) {
  const key = validateMemoryFilePath(filePath).toLowerCase();
  const previous = memoryFileQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  memoryFileQueues.set(key, current);
  return current.finally(() => {
    if (memoryFileQueues.get(key) === current) memoryFileQueues.delete(key);
  });
}

handleIpc('memory-file-operation', async (_, params = {}) => (
  queueMemoryFileOperation(assertConfiguredMemoryPath(params.filePath), () => operateMemoryFile({
    ...params,
    filePath: assertConfiguredMemoryPath(params.filePath),
  }))
));

handleIpc('pick-memory-file', async (_, {
  mode = 'existing', currentPath = '', defaultName = 'gruppen-memory', namespace = 'shared',
  newTitle = 'Neue Shared-Memory-Datei anlegen', existingTitle = 'Bestehende Shared-Memory-Datei auswählen',
} = {}) => {
  const { dialog } = require('electron');
  const safeName = String(defaultName || 'gruppen-memory')
    .trim()
    .replace(/[^a-zA-Z0-9äöüÄÖÜß_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'gruppen-memory';
  const defaultPath = currentPath || path.join(app.getPath('documents'), `${safeName}.memory.json`);

  const result = mode === 'new'
    ? await dialog.showSaveDialog({
      title: newTitle,
      defaultPath,
      filters: [{ name: 'Shared Memory (JSON)', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    })
    : await dialog.showOpenDialog({
      title: existingTitle,
      defaultPath,
      filters: [{ name: 'Shared Memory (JSON)', extensions: ['json'] }],
      properties: ['openFile'],
    });

  const rawSelectedPath = mode === 'new' ? result.filePath : result.filePaths?.[0];
  if (result.canceled || !rawSelectedPath) return null;
  const selectedPath = mode === 'new' && !path.extname(rawSelectedPath)
    ? `${rawSelectedPath}.json`
    : rawSelectedPath;

  try {
    const filePath = validateMemoryFilePath(selectedPath);
    await queueMemoryFileOperation(filePath, () => ensureMemoryFile(filePath, namespace));
    trustFileSystemPath(filePath);
    return { filePath };
  } catch (error) {
    return { error: error.message };
  }
});

// ── CLI Credential Detection ────────────────────────────────────────────────

/**
 * Read Claude Code credentials from ~/.claude/.credentials.json
 * Returns { accessToken, refreshToken, expiresAt, subscriptionType } or null
 */
handleIpc('read-claude-credentials', () => {
  try {
    const credPath = path.join(os.homedir(), '.claude', '.credentials.json');
    if (!fs.existsSync(credPath)) return null;
    const raw = fs.readFileSync(credPath, 'utf-8');
    const data = JSON.parse(raw);
    const creds = data.claudeAiOauth;
    if (!creds?.accessToken) return null;

    // Check expiry
    const isExpired = creds.expiresAt && Date.now() > creds.expiresAt;

    return {
      connected: !isExpired,
      expiresAt: creds.expiresAt || null,
      subscriptionType: creds.subscriptionType || 'unknown',
      rateLimitTier: creds.rateLimitTier || null,
      isExpired,
      source: 'claude-code-cli',
    };
  } catch (e) {
    return { error: e.message };
  }
});

/**
 * Read OpenAI API key from common CLI config locations.
 */
handleIpc('import-openai-credentials', () => {
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey && envKey.startsWith('sk-')) {
    return { ...credentialStore.status(), imported: false, source: 'environment' };
  }
  const candidates = [
    path.join(os.homedir(), '.config', 'openai', 'api_key'),
    path.join(os.homedir(), '.openai', 'api_key'),
    path.join(process.env.APPDATA || '', 'openai', 'api_key'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const content = fs.readFileSync(p, 'utf-8').trim();
        if (content.startsWith('sk-')) {
          const status = credentialStore.updateProviders({ openai: content });
          return { ...status, imported: true, source: p };
        }
      }
    } catch {}
  }
  return null;
});

// ── Knowledge base (Markdown/text search) ─────────────────────────────────────
handleIpc('kb-search', async (_, { query, kbPath, maxResults = 5 }) => {
  try {
    if (!samePath(kbPath, store.get('kbPath'))) return { results: [], error: 'Wissensbasis ist nicht konfiguriert.' };
    if (!kbPath || !fs.existsSync(kbPath)) return { results: [], error: 'Ordner nicht gefunden: ' + kbPath };
    const results = [];
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    function walkDir(dir, depth = 0) {
      if (depth > 5 || results.length >= maxResults * 3) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) { walkDir(fullPath, depth + 1); continue; }
        if (!entry.name.endsWith('.md') && !entry.name.endsWith('.txt')) continue;
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lower = content.toLowerCase();
          const score = terms.reduce((s, t) => s + (lower.split(t).length - 1), 0);
          if (score > 0) {
            // Extract most relevant snippet
            let snippet = '';
            for (const term of terms) {
              const idx = lower.indexOf(term);
              if (idx !== -1) {
                snippet = content.slice(Math.max(0, idx - 100), idx + 300).trim();
                break;
              }
            }
            results.push({
              file: path.relative(kbPath, fullPath),
              score,
              snippet: snippet.slice(0, 400),
              title: entry.name.replace(/\.md$/, ''),
            });
          }
        } catch {}
      }
    }

    walkDir(kbPath);
    results.sort((a, b) => b.score - a.score);
    return { results: results.slice(0, maxResults) };
  } catch (e) {
    return { results: [], error: e.message };
  }
});

// ── Project folder: write file ────────────────────────────────────────────────
handleIpc('project-write', async (_, { projectPath, filename, content }) => {
  return writeProjectFile({ projectPath: assertConfiguredProjectPath(projectPath), filename, content });
});

// ── Project folder: list files ─────────────────────────────────────────────────
handleIpc('project-list', async (_, { projectPath }) => {
  return listProjectFiles({ projectPath: assertConfiguredProjectPath(projectPath) });
});

// ── Folder picker via Electron dialog ────────────────────────────────────────
handleIpc('pick-folder', async (_, { title }) => {
  const { dialog } = require('electron');
  const result = await dialog.showOpenDialog({
    title: title || 'Ordner auswählen',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return trustFileSystemPath(result.filePaths[0]);
});
// ── Open folder in Explorer ───────────────────────────────────────────────────
handleIpc('open-folder', async (_, { folderPath }) => {
  try {
    const resolved = path.resolve(String(folderPath || ''));
    const configuredPaths = [...configuredProjectPaths(), store.get('kbPath')].filter(Boolean);
    if (!configuredPaths.some(configured => samePath(configured, resolved))) throw new Error('Ordner ist nicht in der App konfiguriert.');
    if (!isTrustedFileSystemPath(resolved)) throw new Error('Ordner wurde nicht über die App ausgewählt.');
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('Ordner nicht gefunden.');
    const result = await shell.openPath(resolved);
    if (result) throw new Error(result);
    return { ok: true };
  }
  catch (e) { return { error: e.message }; }
});
