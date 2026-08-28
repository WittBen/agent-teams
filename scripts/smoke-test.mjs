import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const electronMainSource = await fs.readFile(path.join(root, 'electron/main.js'), 'utf8');
const codexMainSource = await fs.readFile(path.join(root, 'electron/codex-main.js'), 'utf8');
const preloadSource = await fs.readFile(path.join(root, 'electron/preload.js'), 'utf8');
const chatViewSource = await fs.readFile(path.join(root, 'src/ChatView.jsx'), 'utf8');
const storeSource = await fs.readFile(path.join(root, 'src/store.jsx'), 'utf8');
const mcpConfigSource = await fs.readFile(path.join(root, 'src/McpConfig.jsx'), 'utf8');
const indexCssSource = await fs.readFile(path.join(root, 'src/index.css'), 'utf8');
const rendererEntrySource = await fs.readFile(path.join(root, 'src/main.jsx'), 'utf8');
const taskGraphWindowSource = await fs.readFile(path.join(root, 'src/TaskGraphWindow.jsx'), 'utf8');
const indexSource = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const hiddenStarterSource = await fs.readFile(path.join(root, 'start.vbs'), 'utf8');
assert.match(electronMainSource, /let taskWindow;/);
assert.match(electronMainSource, /if \(taskWindow && !taskWindow\.isDestroyed\(\)\)[\s\S]*taskWindow\.focus\(\)/);
assert.match(electronMainSource, /taskWindow = new BrowserWindow\(/);
assert.match(electronMainSource, /taskWindow\.loadFile\(distFile, \{ query: \{ taskWindow: '1' \} \}\)/);
assert.match(preloadSource, /openTaskWindow:[\s\S]*onTaskWindowAction:/);
assert.match(rendererEntrySource, /isTaskWindow[\s\S]*<TaskGraphWindow \/>/);
assert.doesNotMatch(chatViewSource, /createPortal|FloatingTaskGraphWindow|floating-task-window/);
assert.equal((chatViewSource.match(/openTaskGraphWindow\(/g) || []).length, 1);
assert.match(chatViewSource, /title=\{t\('Aufgabenplan'\)\}[\s\S]*onClick=\{\(\) => openTaskGraphWindow\(\)\}/);
assert.match(chatViewSource, /function MemoryBadge\(\{ count, onOpen \}\)/);
assert.match(chatViewSource, /Memory-Eintrag löschen[\s\S]*Alle Memory-Einträge löschen/);
assert.match(chatViewSource, /window\.confirm\(t\('Alle Einträge dieses Gruppen-Memorys wirklich löschen\?'\)\)/);
assert.match(hiddenStarterSource, /shell\.Run launchCommand, 1, False/);
assert.doesNotMatch(hiddenStarterSource, /shell\.Run launchCommand, 0, False/);
assert.match(electronMainSource, /requestSingleInstanceLock\(\)[\s\S]*second-instance[\s\S]*mainWindow\.show\(\)[\s\S]*mainWindow\.focus\(\)/);
assert.match(indexSource, /<title>Agent Teams<\/title>/);
assert.equal(packageJson.build.productName, 'Agent Teams');
assert.match(electronMainSource, /const PRODUCT_NAME = 'Agent Teams'/);
assert.match(electronMainSource, /prepareCliAttachmentParams[\s\S]*assertConfiguredProjectPath\(requestedCwd\)/);
assert.match(codexMainSource, /--sandbox', cwd \? 'workspace-write' : 'read-only'/);
assert.match(electronMainSource, /ensureOfficialMcpPreset\(store\)/);
assert.match(electronMainSource, /brandedWindowTitle\(nextState\.windowTitle \|\| 'Aufgabenbaum'\)/);
assert.match(taskGraphWindowSource, /document\.title = `Agent Teams – \$\{detail\}`/);
assert.match(chatViewSource, /typing-agent-name[\s\S]*agent\?\.name[\s\S]*typing-agent-role[\s\S]*agent\?\.role[\s\S]*typing-indicator/);
assert.match(chatViewSource, /buildRelevantConversationHistory\(\{[\s\S]*includeGroupContext: !isDirectChat && task\.source === 'user'/);
assert.match(chatViewSource, /onCreateEntry=\{handleCreateMemoryEntry\}/);
const messageComposerTextarea = chatViewSource.match(/<textarea[\s\S]*?className="message-input"[\s\S]*?\/>/)?.[0] || '';
assert.match(messageComposerTextarea, /autoFocus/);
assert.doesNotMatch(messageComposerTextarea, /disabled=\{running\}/);
const messageComposerSendButton = chatViewSource.match(/<button[\s\S]*?className="send-btn"[\s\S]*?>➤<\/button>/)?.[0] || '';
assert.match(messageComposerSendButton, /disabled=\{!input\.trim\(\) && !pendingAttachments\.length\}/);
assert.doesNotMatch(messageComposerSendButton, /disabled=\{[^}]*running/);
assert.match(chatViewSource, /queueBehindActiveRun[\s\S]*enqueueUserRequest/);
assert.match(chatViewSource, /buildQueuedRequestHistory[\s\S]*await runAgents[\s\S]*removeUserRequest/);
assert.match(chatViewSource, /\[chat\.id, running, memoryViewer\.open, mcpApproval, focusComposer\]/);
assert.match(chatViewSource, /window\.addEventListener\('focus', restoreComposerFocus\)/);
assert.match(chatViewSource, /function McpPermissionDialog\(\{ request, onDecision \}\)/);
assert.match(chatViewSource, /requestPermission: requestMcpPermission/);
assert.match(chatViewSource, /onPermissionConsumed: handleMcpPermissionConsumed/);
assert.doesNotMatch(chatViewSource, /mcpChatPermissionGrants/);
assert.match(chatViewSource, /savedGrant\?\.scope === 'chat'/);
assert.match(chatViewSource, /savedGrant\?\.scope === 'once'[\s\S]*savedGrant\.expiresAt/);
assert.match(chatViewSource, /MCP-Freigaben löschen \(\{count\}\)/);
assert.match(chatViewSource, /globalDecision === 'allow'[\s\S]*scope: 'global'/);
assert.match(chatViewSource, /globalDecision === 'deny'[\s\S]*globale Einstellung blockiert/);
assert.match(storeSource, /appStateGet\('mcpPermissions'\)/);
assert.match(storeSource, /appStateGet\('userRequestQueues'\)/);
assert.match(storeSource, /persist\('userRequestQueues', updated\)/);
assert.match(storeSource, /persist\('mcpPermissions', updated\)/);
assert.doesNotMatch(preloadSource, /storeGet|storeSet|storeDelete/);
assert.match(preloadSource, /providerCredentialsStatus/);
assert.match(storeSource, /appStateGet\('providerConnections'\)/);
assert.match(electronMainSource, /findProviderConnection\(store\.get\('providerConnections'\), provider\)/);
assert.match(electronMainSource, /sandbox: true/);
assert.match(indexSource, /Content-Security-Policy/);
assert.match(storeSource, /grantMcpPermission[\s\S]*consumeMcpPermission[\s\S]*clearMcpPermissions/);
assert.match(mcpConfigSource, /Verbindung testen und Werkzeuge laden/);
assert.match(mcpConfigSource, /Alle gefundenen erlauben[\s\S]*Nur lesende erlauben[\s\S]*Alle wieder nachfragen/);
assert.match(mcpConfigSource, /Erlauben[\s\S]*Nachfragen[\s\S]*Blockieren/);
assert.match(indexCssSource, /\.settings-panel\s*\{[\s\S]*?width:\s*100%/);
assert.match(indexCssSource, /\.settings-content\s*\{[\s\S]*?padding:\s*24px/);
assert.match(chatViewSource, /chat\.type === 'group' \? chat\.mcpServers : \[\]/);
assert.match(chatViewSource, /msg\.diagram && <ExcalidrawDiagram/);
const modalsSource = await fs.readFile(path.join(root, 'src/Modals.jsx'), 'utf8');
assert.match(modalsSource, /Globale Agentenrollen/);
assert.match(modalsSource, /setAgentRoles\(localAgentRoles\)/);
assert.match(modalsSource, /Weitere API-Anbieter/);
assert.match(modalsSource, /data-testid="anthropic-auth-group"/);
assert.match(modalsSource, /data-testid="openai-auth-group"/);
assert.match(modalsSource, /onClick=\{refreshClaudeStatus\}/);
assert.match(modalsSource, /<code>claude<\/code>/);
assert.match(modalsSource, /<code>codex login<\/code>/);
assert.equal((modalsSource.match(/Claude Code CLI verbinden/g) || []).length, 1);
assert.match(modalsSource, /OpenAI-kompatibel[\s\S]*Anthropic Messages[\s\S]*Google Gemini/);

async function importSource(relativePath) {
  const source = await fs.readFile(path.join(root, relativePath), 'utf8');
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const orchestration = await importSource('src/orchestrator.js');
const memoryRules = await importSource('src/memory.js');
const taskGraph = await importSource('src/task-graph.js');
const llm = await importSource('src/llm.js');
const mcp = await importSource('src/mcp.js');
const excalidraw = await importSource('src/excalidraw.js');
const quality = await importSource('src/quality-cascade.js');
const agentRoles = await importSource('src/agent-roles.js');
const conversationLimits = await importSource('src/conversation-limits.js');
const userRequestQueue = await importSource('src/user-request-queue.js');
const providerCatalog = await importSource('src/provider-catalog.js');
const electronMcpPreset = require(path.join(root, 'electron/mcp-preset.js'));
const pm = { id: 'pm', name: 'PM', role: 'Projektleiter', isSystemAgent: true };
const coder = { id: 'coder', name: 'Max', role: 'Developer' };
const coderTwo = { id: 'coder-two', name: 'Alex', role: 'Developer' };
const tester = { id: 'tester', name: 'Lisa', role: 'QA' };

const openRouterConnection = providerCatalog.createProviderConnection('openrouter', 'api-openrouter-test');
assert.equal(openRouterConnection.baseUrl, 'https://openrouter.ai/api/v1');
assert.equal(openRouterConnection.protocol, 'openai');
assert.equal(providerCatalog.getProviderModels(openRouterConnection.id, [openRouterConnection], {}, '').length >= 2, true);
assert.equal(providerCatalog.getProviderOptions([openRouterConnection]).at(-1).name, 'OpenRouter');
assert.equal(providerCatalog.PROVIDER_PRESETS.some(provider => provider.id === 'gemini' && provider.protocol === 'gemini'), true);

assert.deepEqual(conversationLimits.normalizeConversationLimits({
  maxTurns: 100,
  maxTurnsPerAgent: 90,
  pmReviewOnLimit: false,
}), { maxTurns: 50, maxTurnsPerAgent: 50, pmReviewOnLimit: false });
assert.deepEqual(conversationLimits.normalizeConversationLimits({ maxTurns: 2, maxTurnsPerAgent: 0 }), {
  maxTurns: 3,
  maxTurnsPerAgent: 1,
  pmReviewOnLimit: true,
});
assert.match(chatViewSource, /maxTurns: conversationLimits\.maxTurns/);
assert.match(chatViewSource, /source === 'turn-limit-review'/);
assert.match(chatViewSource, /status: 'limit-reached'/);
assert.doesNotMatch(chatViewSource, /maxTurns: 12/);
assert.doesNotMatch(chatViewSource, /500 \+ Math\.min\(taskQueue\.turns/);
assert.match(chatViewSource, /findSafeAutoParallelTaskIds[\s\S]*taskQueue\.prioritize/);
assert.match(chatViewSource, /useLeanFastPath[\s\S]*skipFastFinalReview/);

const queuedRequestOne = { id: 'request-1', messageId: 'message-1', createdAt: 1 };
const queuedRequestTwo = { id: 'request-2', messageId: 'message-2', createdAt: 2 };
let userQueues = userRequestQueue.enqueueUserRequest({}, 'chat-1', queuedRequestOne);
userQueues = userRequestQueue.enqueueUserRequest(userQueues, 'chat-1', queuedRequestTwo);
assert.deepEqual(userQueues['chat-1'].map(item => item.id), ['request-1', 'request-2']);
assert.deepEqual(userRequestQueue.buildQueuedRequestHistory([
  { id: 'message-1', agentId: 'user', text: 'Erste Folgefrage' },
  { id: 'agent-result', agentId: 'agent', text: 'Aktueller Lauf beendet' },
  { id: 'message-2', agentId: 'user', text: 'Zweite Folgefrage' },
], userQueues['chat-1'], 'request-1').map(message => message.id), ['message-1', 'agent-result']);
userQueues = userRequestQueue.removeUserRequest(userQueues, 'chat-1', 'request-1');
assert.deepEqual(userQueues['chat-1'].map(item => item.id), ['request-2']);
assert.deepEqual(userRequestQueue.clearUserRequests(userQueues, 'chat-1'), {});

const migratedRoles = agentRoles.normalizeAgentRoleState([
  { id: 'role-dev', name: 'Developer' },
  { id: 'role-dev-duplicate', name: ' developer ' },
], [{ id: 'legacy', name: 'Ada', role: 'DEVELOPER' }]);
assert.equal(migratedRoles.roles.length, 1);
assert.equal(migratedRoles.agents[0].roleId, 'role-dev');
assert.equal(migratedRoles.agents[0].role, 'Developer');
const renamedRoles = agentRoles.normalizeAgentRoleState(
  [{ id: 'role-dev', name: 'Entwicklung' }],
  [{ ...migratedRoles.agents[0], role: 'Developer' }],
);
assert.equal(renamedRoles.agents[0].role, 'Entwicklung');
assert.equal(agentRoles.isRoleUsed(renamedRoles.roles[0], renamedRoles.agents), true);

const qualityAgent = { ...coder, provider: 'anthropic', model: 'claude-haiku-4-5' };
const highComplexity = quality.assessTaskComplexity({ objective: 'Prüfe Security, OAuth-Berechtigungen und eine parallele Production-Migration.' });
assert.equal(highComplexity.level, 'high');
const balancedPolicy = quality.resolveQualityPolicy({
  globalConfig: { enabled: true, strategy: 'balanced', maxEscalations: 1, escalationProvider: 'same' },
  groupConfig: { mode: 'inherit' },
  agentConfig: { mode: 'inherit' },
  messageMode: 'auto',
  complexity: highComplexity,
  agent: qualityAgent,
});
assert.equal(balancedPolicy.directStrong, true);
assert.equal(balancedPolicy.escalationAgent.model, 'claude-sonnet-4-5');
assert.equal(quality.resolveQualityPolicy({
  globalConfig: { enabled: false }, messageMode: 'deep', complexity: { level: 'low' }, agent: qualityAgent,
}).directStrong, true);
assert.equal(quality.resolveQualityPolicy({
  globalConfig: { enabled: true }, groupConfig: { mode: 'off' }, messageMode: 'auto', complexity: highComplexity, agent: qualityAgent,
}).enabled, false);
assert.equal(quality.resolveQualityPolicy({
  globalConfig: { enabled: true }, messageMode: 'fast', complexity: highComplexity, agent: qualityAgent,
}).mode, 'off');
assert.equal(quality.getEscalationAgent(qualityAgent, { escalationProvider: 'openai', escalationModel: 'o1-mini' }).provider, 'openai');
assert.equal(quality.getEscalationAgent(
  { ...coder, provider: 'api-openrouter-test', model: 'cheap-model' },
  { escalationProvider: 'same' }, {},
  { 'api-openrouter-test': ['cheap-model', 'strong-model'] },
).model, 'strong-model');
assert.deepEqual(quality.evaluateResponseQuality({
  reply: 'Ich koordiniere die Umsetzung.', objective: 'Baue die App.', isOrchestrator: true,
  requiresInitialPlan: true, parsedTaskPlan: null, projectPath: 'C:\\project', complexity: { level: 'medium' },
}).reasons, ['missing-task-plan']);
assert.match(quality.evaluateResponseQuality({
  reply: 'Die Implementierung ist fertig.', objective: 'Erstelle eine CMD-Datei.', isOrchestrator: false,
  projectPath: 'C:\\project', projectFiles: [], complexity: { level: 'low' },
}).reasons.join(','), /missing-requested-artifact/);
assert.equal(quality.evaluateResponseQuality({
  reply: 'Die Analyse ist vollständig und enthält ein direkt nutzbares Ergebnis.',
  objective: 'Analysiere die Optionen.', complexity: { level: 'low' },
}).accepted, true);
const qualityStats = quality.updateQualityStats({}, { outcome: 'escalated', unresolved: false, estimatedInputTokens: 100, estimatedOutputTokens: 25 });
assert.equal(qualityStats.escalations, 1);
assert.equal(qualityStats.estimatedInputTokens + qualityStats.estimatedOutputTokens, 125);
assert.match(chatViewSource, /quality-mode-select[\s\S]*Schnell[\s\S]*Automatisch[\s\S]*Gründlich/);

const browserAttachments = [
  { id: 'readme', name: 'README.md', kind: 'markdown', mimeType: 'text/markdown', size: 12, content: '# Kontext' },
  { id: 'image', name: 'screen.png', kind: 'image', mimeType: 'image/png', size: 4, dataUrl: 'data:image/png;base64,AAAA' },
  { id: 'pdf', name: 'spec.pdf', kind: 'pdf', mimeType: 'application/pdf', size: 4, dataUrl: 'data:application/pdf;base64,JVBERg==' },
  { id: 'archive', name: 'data.zip', kind: 'file', mimeType: 'application/zip', size: 4, dataUrl: 'data:application/zip;base64,UEs=' },
];
assert.equal(llm.collectChatAttachments([
  { agentId: 'user', attachments: browserAttachments.slice(0, 2) },
  { agentId: 'user', attachments: [browserAttachments[0], browserAttachments[2]] },
]).length, 3);
assert.deepEqual(llm.collectChatAttachments(Array.from({ length: 10 }, (_, index) => ({
  agentId: 'user', attachments: [{ id: `attachment-${index}`, name: `${index}.bin` }],
}))).map(item => item.id), Array.from({ length: 8 }, (_, index) => `attachment-${index + 2}`));
const browserOpenAIMessages = llm.prepareBrowserAttachmentMessages([{ role: 'user', content: 'Analysiere.' }], browserAttachments, 'openai');
assert.match(browserOpenAIMessages[0].content.find(part => part.type === 'text').text, /README\.md/);
assert.equal(browserOpenAIMessages[0].content.filter(part => part.type === 'image_url').length, 1);
assert.deepEqual(browserOpenAIMessages[0].content.filter(part => part.type === 'file').map(part => part.file.filename), ['spec.pdf', 'data.zip']);
const browserAnthropicMessages = llm.prepareBrowserAttachmentMessages([{ role: 'user', content: 'Analysiere.' }], browserAttachments, 'anthropic');
assert.equal(browserAnthropicMessages[0].content.filter(part => part.type === 'image').length, 1);
assert.equal(browserAnthropicMessages[0].content.filter(part => part.type === 'document').length, 1);
assert.match(browserAnthropicMessages[0].content.find(part => part.type === 'text').text, /data\.zip/);

let claudeCallCount = 0;
let directAnthropicCallCount = 0;
globalThis.window = {
  electronAPI: {
    claudeCall: async params => {
      claudeCallCount += 1;
      assert.equal(params.model, 'claude-opus-4-5');
      assert.equal(params.requestId, 'claude-test-request');
      assert.equal(params.attachments?.[0]?.name, 'README.md');
      return { text: 'Claude-CLI-Antwort' };
    },
    llmCall: async params => {
      directAnthropicCallCount += 1;
      assert.equal(params.provider, 'anthropic');
      assert.equal(Object.prototype.hasOwnProperty.call(params, 'auth'), false);
      return { text: 'Anthropic-API-Antwort' };
    },
  },
};
const claudeAgent = { ...coder, provider: 'anthropic', model: 'claude-opus-4-5' };
assert.equal(await llm.callLLM({
  apiKeys: { claudeCli: true },
  agent: claudeAgent,
  history: [{ agentId: 'user', senderName: 'User', text: 'Teste den CLI-Weg.', attachments: [browserAttachments[0]] }],
  requestId: 'claude-test-request',
}), 'Claude-CLI-Antwort');
assert.equal(claudeCallCount, 1);
assert.equal(directAnthropicCallCount, 0);
assert.equal(await llm.callLLM({
  apiKeys: { anthropicConfigured: true },
  agent: claudeAgent,
  history: [{ agentId: 'user', senderName: 'User', text: 'Teste den API-Weg.' }],
}), 'Anthropic-API-Antwort');
assert.equal(directAnthropicCallCount, 1);
window.electronAPI.llmCall = async params => {
  assert.equal(params.provider, 'api-openrouter-test');
  assert.equal(params.model, '~openai/gpt-latest');
  return { text: 'OpenRouter-Antwort' };
};
assert.equal(await llm.callLLM({
  apiKeys: { providerConfigured: { 'api-openrouter-test': true } },
  providerConnections: [openRouterConnection],
  agent: { ...coder, provider: 'api-openrouter-test', model: '~openai/gpt-latest' },
  history: [{ agentId: 'user', senderName: 'User', text: 'Teste den eigenen Provider.' }],
}), 'OpenRouter-Antwort');

const globalMcp = { id: 'global-mcp', name: 'Global', enabled: true, transport: 'http', url: 'https://example.com/mcp' };
const groupMcp = { id: 'group-mcp', name: 'Group', enabled: true, transport: 'stdio', command: 'node' };
const disabledMcp = { id: 'disabled-mcp', name: 'Disabled', enabled: false, transport: 'stdio', command: 'node' };
assert.deepEqual(mcp.getEffectiveMcpServers([globalMcp, disabledMcp], [groupMcp]).map(server => server.id), ['global-mcp', 'group-mcp']);
const presetState = mcp.applyOfficialMcpPresets([], 0);
assert.equal(presetState.changed, true);
assert.equal(presetState.presetVersion, mcp.MCP_PRESET_VERSION);
assert.deepEqual(presetState.servers[0], mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER);
assert.equal(presetState.servers[0].enabled, false);
assert.deepEqual(mcp.applyOfficialMcpPresets([], mcp.MCP_PRESET_VERSION).servers, []);
const migratedOfficialPreset = mcp.applyOfficialMcpPresets([
  { ...mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER, enabled: true },
], 1);
assert.equal(migratedOfficialPreset.changed, true);
assert.equal(migratedOfficialPreset.servers[0].enabled, false);
assert.deepEqual(mcp.applyOfficialMcpPresets([], 1).servers, []);
const customExcalidrawServer = {
  id: 'custom-excalidraw', name: 'Eigenes Excalidraw', enabled: true,
  transport: 'http', url: mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER.url,
};
assert.equal(mcp.applyOfficialMcpPresets([customExcalidrawServer], 1).servers[0].enabled, true);
assert.equal(mcp.applyOfficialMcpPresets([
  { ...mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER, enabled: true },
], mcp.MCP_PRESET_VERSION).servers[0].enabled, true);
assert.deepEqual(electronMcpPreset.OFFICIAL_EXCALIDRAW_MCP_SERVER, mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER);
const presetStoreData = new Map();
const presetStore = {
  get: key => presetStoreData.get(key),
  set: (key, value) => presetStoreData.set(key, value),
};
assert.equal(electronMcpPreset.ensureOfficialMcpPreset(presetStore).changed, true);
assert.equal(presetStoreData.get('mcpServers')[0].id, 'mcp-official-excalidraw');
assert.equal(presetStoreData.get('mcpServers')[0].enabled, false);
assert.equal(presetStoreData.get('mcpPresetVersion'), electronMcpPreset.MCP_PRESET_VERSION);
presetStoreData.set('mcpServers', []);
assert.equal(electronMcpPreset.ensureOfficialMcpPreset(presetStore).changed, false);
assert.deepEqual(presetStoreData.get('mcpServers'), []);
assert.equal(mcp.isModelVisibleMcpTool({ _meta: { ui: { visibility: ['app'] } } }), false);
assert.equal(mcp.isModelVisibleMcpTool({ _meta: { ui: { visibility: ['model', 'app'] } } }), true);
assert.equal(mcp.classifyMcpToolRisk({ annotations: { readOnlyHint: true } }), 'read-only');
assert.equal(mcp.classifyMcpToolRisk({ annotations: { destructiveHint: true } }), 'destructive');
assert.deepEqual(mcp.parseKeyValueLines('TOKEN=abc\n# ignored\nMODE=test=value'), { TOKEN: 'abc', MODE: 'test=value' });
const permissionConfiguredServer = mcp.normalizeMcpServers([{
  ...globalMcp,
  toolCatalog: [
    { name: 'read', description: 'Read data', risk: 'read-only' },
    { name: 'write', description: 'Write data', risk: 'write' },
  ],
  toolPermissions: { read: 'allow', write: 'deny', invalid: 'unsupported' },
}])[0];
assert.deepEqual(permissionConfiguredServer.toolPermissions, { read: 'allow', write: 'deny' });
assert.equal(permissionConfiguredServer.toolCatalog.length, 2);
assert.equal(mcp.getMcpToolPermissionDecision(permissionConfiguredServer, 'read'), 'allow');
assert.equal(mcp.getMcpToolPermissionDecision(permissionConfiguredServer, 'write'), 'deny');
assert.equal(mcp.getMcpToolPermissionDecision(permissionConfiguredServer, 'new-tool'), 'ask');
assert.deepEqual(mcp.createMcpToolCatalog([
  { name: 'safe', description: 'Safe', annotations: { readOnlyHint: true } },
  { name: 'danger', description: 'Danger', annotations: { destructiveHint: true } },
]).map(tool => [tool.name, tool.risk]), [['safe', 'read-only'], ['danger', 'destructive']]);
assert.equal(mcp.extractMcpCalls('[[MCP_CALL]]{"server":"server_1","tool":"echo","arguments":{"value":"ok"}}[[/MCP_CALL]]').calls[0].tool, 'echo');
assert.equal(mcp.isMcpPermissionHallucination('Klicke im Berechtigungsdialog auf Allow.'), true);
assert.equal(mcp.isMcpPermissionHallucination('Ich benötige weiterhin deine Berechtigung für das Werkzeug.'), true);
assert.equal(mcp.isMcpPermissionHallucination('Bitte erlaube den Zugriff auf das Excalidraw `create_view` Tool im erscheinenden Dialog.'), true);
assert.equal(mcp.isMcpPermissionHallucination('Please allow access to the create_view tool in the permission dialog.'), true);
assert.equal(mcp.isMcpPermissionHallucination('Hier ist das fertige Diagramm.'), false);
assert.match(mcp.buildMcpInstructions([{ serverId: 'x', serverName: 'X', name: 'draw' }]), /Berechtigung niemals im Fließtext/);
assert.deepEqual(mcp.parseMcpArgumentsJson('```json\n{"value":"ok"}\n```'), { value: 'ok' });
assert.deepEqual(mcp.parseMcpArgumentsJson('Ausgabe: {"arguments":{"value":"ok"}}'), { value: 'ok' });
const excalidrawElements = excalidraw.parseExcalidrawElements(JSON.stringify([
  { id: 'box', type: 'rectangle', x: 10, y: 20, width: 160, height: 80 },
  { id: 'label', type: 'text', x: 35, y: 45, width: 80, height: 25, text: 'Start' },
]));
assert.equal(excalidrawElements.length, 2);
assert.ok(excalidraw.excalidrawElementBounds(excalidrawElements).width >= 160);
assert.equal(excalidraw.createExcalidrawDocument(excalidrawElements).type, 'excalidraw');

let mcpModelRound = 0;
let mcpToolCalls = 0;
let mcpPermissionRequests = 0;
let mcpToolResults = 0;
let mcpPermissionConsumptions = 0;
globalThis.window.electronAPI.mcpListTools = async () => ({
  tools: [{ serverId: 'group-mcp', serverName: 'Group', name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
  errors: [],
});
globalThis.window.electronAPI.mcpCallTool = async params => {
  mcpToolCalls += 1;
  assert.equal(params.server.id, 'group-mcp');
  assert.deepEqual(params.arguments, { value: 'ok' });
  return { serverName: 'Group', name: 'echo', isError: false, text: 'echo:ok' };
};
const mcpReply = await mcp.callLLMWithMcp({
  servers: [groupMcp],
  history: [],
  agent: coder,
  requestPermission: async request => {
    mcpPermissionRequests += 1;
    assert.equal(request.risk, 'read-only');
    assert.equal(request.tool.name, 'echo');
    return { allowed: true, scope: 'once' };
  },
  onToolResult: ({ result }) => {
    mcpToolResults += 1;
    assert.equal(result.text, 'echo:ok');
  },
  onPermissionConsumed: ({ tool, permission }) => {
    mcpPermissionConsumptions += 1;
    assert.equal(tool.name, 'echo');
    assert.equal(permission.scope, 'once');
  },
  call: async ({ history, extraContext }) => {
    mcpModelRound += 1;
    assert.match(extraContext, /MCP-WERKZEUGE/);
    if (mcpModelRound === 1) return '[[MCP_CALL]]\n{"server":"server_1","tool":"echo","arguments":{"value":"ok"}}\n[[/MCP_CALL]]';
    assert.match(history.at(-1).text, /echo:ok/);
    return 'Werkzeug erfolgreich verwendet.';
  },
});
assert.equal(mcpReply, 'Werkzeug erfolgreich verwendet.');
assert.equal(mcpToolCalls, 1);
assert.equal(mcpPermissionRequests, 1);
assert.equal(mcpToolResults, 1);
assert.equal(mcpPermissionConsumptions, 1);

let correctionMainRounds = 0;
let correctionPlannerRounds = 0;
let correctionPermissionRequests = 0;
let correctionPermissionConsumptions = 0;
const correctedMcpReply = await mcp.callLLMWithMcp({
  servers: [groupMcp],
  history: [],
  agent: coder,
  requestPermission: async request => {
    correctionPermissionRequests += 1;
    assert.equal(request.tool.name, 'echo');
    assert.equal(request.pendingArguments, true);
    return { allowed: true, scope: 'once' };
  },
  call: async () => {
    correctionMainRounds += 1;
    if (correctionMainRounds === 1) return 'Bitte erlaube den Zugriff auf das Excalidraw `create_view` Tool im erscheinenden Dialog.';
    throw new Error('Nach dem UI-Werkzeug darf kein weiterer Hauptmodell-Aufruf nötig sein.');
  },
  callRecovery: async ({ history, extraContext }) => {
    correctionPlannerRounds += 1;
    assert.equal(history.length, 1);
    assert.match(history[0].text, /JSON-ARGUMENTOBJEKT/);
    assert.doesNotMatch(history[0].text, /MCP_CALL|bereits freigegeben/);
    assert.match(extraContext, /MCP-WERKZEUGE/);
    return '```json\n{"value":"ok"}\n```';
  },
  onToolResult: () => 'UI-Werkzeug erfolgreich abgeschlossen.',
  onPermissionConsumed: ({ permission }) => {
    correctionPermissionConsumptions += 1;
    assert.equal(permission.scope, 'recovered-once');
  },
});
assert.equal(correctedMcpReply, 'UI-Werkzeug erfolgreich abgeschlossen.');
assert.equal(mcpToolCalls, 2);
assert.equal(correctionPermissionRequests, 1);
assert.equal(correctionPlannerRounds, 1);
assert.equal(correctionMainRounds, 1);
assert.equal(correctionPermissionConsumptions, 1);

let timedOutPermissionRequests = 0;
let timedOutPermissionConsumptions = 0;
await assert.rejects(
  () => mcp.callLLMWithMcp({
    servers: [groupMcp],
    history: [],
    agent: coder,
    requestPermission: async () => {
      timedOutPermissionRequests += 1;
      return { allowed: true, scope: 'once' };
    },
    call: async () => 'Bitte erlaube den Zugriff im Berechtigungsdialog.',
    callRecovery: async () => { throw new Error('Planner timeout'); },
    onPermissionConsumed: () => { timedOutPermissionConsumptions += 1; },
  }),
  /Planner timeout/,
);
assert.equal(timedOutPermissionRequests, 1);
assert.equal(timedOutPermissionConsumptions, 0);

let deniedRound = 0;
const deniedReply = await mcp.callLLMWithMcp({
  servers: [groupMcp],
  history: [],
  agent: coder,
  requestPermission: async () => ({ allowed: false, scope: 'none' }),
  call: async ({ history }) => {
    deniedRound += 1;
    if (deniedRound === 1) return '[[MCP_CALL]]{"server":"server_1","tool":"echo","arguments":{"value":"denied"}}[[/MCP_CALL]]';
    assert.match(history.at(-1).text, /Vom User abgelehnt/);
    return 'Werkzeug wurde nicht ausgeführt.';
  },
});
assert.equal(deniedReply, 'Werkzeug wurde nicht ausgeführt.');
assert.equal(mcpToolCalls, 2);

let reportedConnectionError = null;
globalThis.window.electronAPI.mcpListTools = async () => ({
  tools: [],
  errors: [{ serverId: 'group-mcp', serverName: 'Group', message: 'offline' }],
});
assert.equal(await mcp.callLLMWithMcp({
  servers: [groupMcp],
  history: [],
  agent: coder,
  onConnectionError: error => { reportedConnectionError = error; },
  call: async ({ extraContext }) => {
    assert.equal(extraContext, '');
    return 'Fallback ohne MCP.';
  },
}), 'Fallback ohne MCP.');
assert.equal(reportedConnectionError.message, 'offline');

globalThis.window.electronAPI.claudeCall = async () => ({
  error: 'rate limit', status: 429, rateLimited: true, retryable: true, retryAfterMs: 2000,
});
await assert.rejects(
  () => llm.callLLM({
    apiKeys: { claudeCli: true },
    agent: claudeAgent,
    history: [{ agentId: 'user', senderName: 'User', text: 'Rate-Limit testen.' }],
  }),
  error => error.rateLimited === true && error.retryAfterMs === 2000 && /Arbeitsstand/.test(error.message),
);

let graph = taskGraph.createTaskGraph('chat-1', 'App-Projekt');
graph = taskGraph.upsertTaskNode(graph, { id: 'plan', title: 'Projekt planen', agentId: pm.id, agentName: pm.name, source: 'user', nodeType: 'request', status: 'agent_done' });
graph = taskGraph.upsertTaskNode(graph, { id: 'frontend', title: 'Frontend bauen', objective: 'Bearbeite src/App.jsx', agentId: coder.id, agentName: coder.name, source: 'PM', parentNodeId: 'plan', status: 'planned' });
graph = taskGraph.upsertTaskNode(graph, { id: 'qa', title: 'Testplan erstellen', objective: 'Erstelle den unabhängigen Testplan', agentId: tester.id, agentName: tester.name, source: 'PM', parentNodeId: 'plan', status: 'planned' });
graph = taskGraph.addTaskEdge(graph, { from: 'plan', to: 'frontend', kind: 'delegation' });
graph = taskGraph.addTaskEdge(graph, { from: 'plan', to: 'qa', kind: 'delegation' });
assert.equal(taskGraph.validateParallelSelection(graph, ['frontend', 'qa']).ok, true);
assert.equal(taskGraph.graphNodeDepths(graph).get('frontend'), 1);
const baseTree = taskGraph.projectTaskTree(graph);
assert.deepEqual(baseTree.roots.map(node => node.id), ['plan']);
assert.deepEqual(baseTree.childrenByParent.get('plan').map(node => node.id), ['frontend', 'qa']);
assert.deepEqual(
  taskGraph.orderTasksForParallelSelection([
    { graphNodeId: 'later', agent: pm },
    { graphNodeId: 'frontend', agent: coder },
    { graphNodeId: 'qa', agent: tester },
  ], ['frontend', 'qa']).map(task => task.graphNodeId),
  ['frontend', 'qa', 'later'],
);

const parallelStarts = [];
let releaseParallelTasks;
const parallelGate = new Promise(resolve => { releaseParallelTasks = resolve; });
const parallelRun = taskGraph.runTaskBatch([
  { graphNodeId: 'frontend' },
  { graphNodeId: 'qa' },
], async task => {
  parallelStarts.push(task.graphNodeId);
  await parallelGate;
  return `${task.graphNodeId}-done`;
});
assert.deepEqual(parallelStarts, ['frontend', 'qa']);
releaseParallelTasks();
assert.deepEqual(await parallelRun, ['frontend-done', 'qa-done']);

const dependentGraph = taskGraph.updateTaskNodeStatus(graph, 'plan', 'planned');
assert.match(taskGraph.validateParallelSelection(dependentGraph, ['plan', 'frontend']).reason, /vorherige Aufgabe|hängen voneinander ab/);
assert.equal(taskGraph.inferHandoffDependency('Prüfe danach die Umsetzung von Max.', [
  { graphNodeId: 'frontend', agent: coder },
]), 'frontend');
assert.equal(taskGraph.inferHandoffDependency('Erstelle parallel einen unabhängigen Testplan.', [
  { graphNodeId: 'frontend', agent: coder },
]), null);
let sequentialGraph = taskGraph.upsertTaskNode(graph, { id: 'regression', title: 'Regression prüfen', agentId: tester.id, agentName: tester.name, source: 'PM', parentNodeId: 'plan', status: 'planned' });
sequentialGraph = taskGraph.addTaskEdge(sequentialGraph, { from: 'plan', to: 'regression', kind: 'delegation' });
sequentialGraph = taskGraph.addTaskEdge(sequentialGraph, { from: 'frontend', to: 'regression', kind: 'dependency' });
assert.equal(taskGraph.isTaskNodeReady(sequentialGraph, 'regression'), false);
assert.match(taskGraph.validateParallelSelection(sequentialGraph, ['regression', 'qa']).reason, /wartet noch/);
const sequentialTree = taskGraph.projectTaskTree(sequentialGraph);
assert.equal(sequentialTree.primaryParentByNode.get('regression'), 'plan');
assert.deepEqual(sequentialTree.metadataByNode.get('regression').dependencyIds, ['frontend']);

let reviewGraph = taskGraph.updateTaskNodeStatus(graph, 'frontend', 'agent_done');
reviewGraph = taskGraph.updateTaskNodeStatus(reviewGraph, 'qa', 'agent_done');
reviewGraph = taskGraph.upsertTaskNode(reviewGraph, { id: 'review', title: 'Ergebnisse final prüfen', agentId: pm.id, agentName: pm.name, source: 'team-synthesis', nodeType: 'review', status: 'planned' });
reviewGraph = taskGraph.addTaskEdge(reviewGraph, { from: 'frontend', to: 'review', kind: 'review' });
reviewGraph = taskGraph.addTaskEdge(reviewGraph, { from: 'qa', to: 'review', kind: 'review' });
const reviewTree = taskGraph.projectTaskTree(reviewGraph);
assert.equal(reviewTree.primaryParentByNode.get('review'), 'plan');
assert.deepEqual(reviewTree.metadataByNode.get('review').reviewSourceIds.sort(), ['frontend', 'qa']);
assert.equal(reviewTree.childrenByParent.get('plan').at(-1).id, 'review');

let plannedGraph = taskGraph.createTaskGraph('chat-planned', 'Vollständiger PM-Plan');
plannedGraph = taskGraph.upsertTaskNode(plannedGraph, {
  id: 'plan-root', title: 'CMD-Anwendung liefern', agentId: pm.id, agentName: pm.name,
  source: 'user', nodeType: 'request', status: 'agent_done',
});
plannedGraph = taskGraph.materializeTaskPlan(plannedGraph, {
  rootNodeId: 'plan-root',
  tasks: [
    { id: 'implement', title: 'CMD implementieren', agentId: coder.id, agentName: coder.name, type: 'task', dependsOn: [], executionMode: 'parallel', order: 0 },
    { id: 'docs', title: 'Nutzung dokumentieren', agentId: tester.id, agentName: tester.name, type: 'task', dependsOn: [], executionMode: 'parallel', order: 1 },
    { id: 'qa', title: 'CMD testen', agentId: tester.id, agentName: tester.name, type: 'task', dependsOn: ['implement'], executionMode: 'sequential', order: 2 },
    { id: 'final-review', title: 'Finale PM-Abnahme', agentId: pm.id, agentName: pm.name, type: 'review', dependsOn: ['docs', 'qa'], executionMode: 'sequential', order: 3 },
  ],
});
const plannedIds = Object.fromEntries(plannedGraph.nodes
  .filter(node => node.planTaskId)
  .map(node => [node.planTaskId, node.id]));
assert.equal(taskGraph.projectTaskTree(plannedGraph).roots[0].id, 'plan-root');
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds.implement), true);
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds.docs), true);
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds.qa), false);
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds['final-review']), false);
assert.equal(taskGraph.validateParallelSelection(plannedGraph, [plannedIds.implement, plannedIds.docs]).ok, true);
assert.deepEqual(taskGraph.findSafeAutoParallelTaskIds(plannedGraph, [
  { graphNodeId: plannedIds.implement },
  { graphNodeId: plannedIds.docs },
  { graphNodeId: plannedIds.qa },
]), [plannedIds.implement, plannedIds.docs]);
assert.match(taskGraph.validateParallelSelection(plannedGraph, [plannedIds.qa, plannedIds.docs]).reason, /sequenzieller Schritt/);
plannedGraph = taskGraph.updateTaskNodeStatus(plannedGraph, plannedIds.implement, 'agent_done');
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds.qa), true);
plannedGraph = taskGraph.updateTaskNodeStatus(plannedGraph, plannedIds.docs, 'agent_done');
plannedGraph = taskGraph.updateTaskNodeStatus(plannedGraph, plannedIds.qa, 'agent_done');
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds['final-review']), true);

let agentHandoffGraph = taskGraph.upsertTaskNode(graph, { id: 'qa-fix', title: 'Spezialprüfung', agentId: tester.id, agentName: tester.name, source: 'Max', parentNodeId: 'frontend', status: 'planned' });
agentHandoffGraph = taskGraph.addTaskEdge(agentHandoffGraph, { from: 'frontend', to: 'qa-fix', kind: 'delegation' });
assert.equal(taskGraph.projectTaskTree(agentHandoffGraph).primaryParentByNode.get('qa-fix'), 'frontend');

let legacyGraph = taskGraph.upsertTaskNode(graph, { id: 'legacy-qa', title: 'Legacy QA danach', agentId: tester.id, agentName: tester.name, source: 'PM', parentNodeId: 'frontend', status: 'planned' });
legacyGraph = taskGraph.addTaskEdge(legacyGraph, { from: 'frontend', to: 'legacy-qa', kind: 'handoff' });
const migratedLegacyTree = taskGraph.projectTaskTree(legacyGraph);
assert.equal(migratedLegacyTree.primaryParentByNode.get('legacy-qa'), 'plan');
assert.deepEqual(migratedLegacyTree.metadataByNode.get('legacy-qa').dependencyIds, ['frontend']);
let conflictingGraph = taskGraph.createTaskGraph('chat-conflict');
conflictingGraph = taskGraph.upsertTaskNode(conflictingGraph, { id: 'one', title: 'App ändern', objective: 'Ändere src/App.jsx', agentId: coder.id, status: 'planned' });
conflictingGraph = taskGraph.upsertTaskNode(conflictingGraph, { id: 'two', title: 'App testen', objective: 'Prüfe src/App.jsx', agentId: tester.id, status: 'planned' });
assert.match(taskGraph.validateParallelSelection(conflictingGraph, ['one', 'two']).reason, /Dateikonflikt/);
const approvedGraph = taskGraph.approveAgentDoneTasks(graph);
assert.equal(approvedGraph.nodes.find(node => node.id === 'plan').status, 'completed');
assert.equal(JSON.parse(JSON.stringify(approvedGraph)).nodes.length, 3);

assert.equal(orchestration.isPMAgent(pm), true);
assert.equal(orchestration.isPMAgent({ id: 'pm-role', role: 'PM' }), true);
assert.equal(orchestration.isPMAgent({ id: 'developer', role: 'Development' }), false);
assert.equal(orchestration.getGroupPMAgent('direct', [pm, coder]), null);
assert.equal(orchestration.getGroupPMAgent('group', [coder, pm]), pm);

assert.deepEqual(
  orchestration.orchestrate({ request: '@Max prüfen', chatAgents: [pm, coder, tester], isEveryone: false, explicitMentions: [coder] }).agents,
  [coder],
);
assert.deepEqual(
  orchestration.orchestrate({ request: '@everyone prüfen', chatAgents: [pm, coder, tester], isEveryone: true }).agents,
  [pm],
);
const directBubbleSortHistory = [
  { id: 'd1', agentId: 'user', senderName: 'User', text: 'Kannst du mir Bubble Sort erklären?' },
  { id: 'd2', agentId: coder.id, senderName: coder.name, text: 'Bubble Sort vergleicht benachbarte Werte.' },
  { id: 'd3', agentId: 'user', senderName: 'User', text: 'Erstelle daraus ein Diagramm.' },
  { id: 'd4', agentId: coder.id, senderName: coder.name, text: 'Welche Art von Diagramm?' },
  { id: 'd5', agentId: 'user', senderName: 'User', text: 'Flowchart' },
];
const selectedDirectContext = orchestration.buildRelevantConversationHistory({
  history: directBubbleSortHistory,
  agent: coder,
  chatType: 'direct',
});
assert.equal(selectedDirectContext.length, 5);
assert.match(selectedDirectContext[0].text, /Bubble Sort/);
assert.equal(selectedDirectContext.at(-1).text, 'Flowchart');

const groupContextSource = [
  { id: 'old', agentId: 'user', text: 'Sehr alter Kontext' },
  ...Array.from({ length: 13 }, (_, index) => ({
    id: `g${index}`,
    agentId: index % 3 === 0 ? 'user' : (index % 3 === 1 ? pm.id : coder.id),
    senderName: index % 3 === 0 ? 'User' : (index % 3 === 1 ? pm.name : coder.name),
    text: `Gruppennachricht ${index}`,
  })),
  { id: 'system', agentId: 'system', text: 'Interner Systemstatus' },
  { id: 'memory-only', agentId: 'user', text: '#fact Nur Memory', memoryOnly: true },
];
const selectedGroupContext = orchestration.buildRelevantConversationHistory({
  history: groupContextSource,
  agent: coder,
  chatType: 'group',
  includeGroupContext: true,
});
assert.equal(selectedGroupContext.length, 12);
assert.equal(selectedGroupContext[0].text, 'Gruppennachricht 1');
assert.equal(selectedGroupContext.at(-1).text, 'Gruppennachricht 12');
assert.deepEqual(orchestration.buildRelevantConversationHistory({
  history: groupContextSource,
  agent: coder,
  chatType: 'group',
  includeGroupContext: false,
}), []);

assert.equal(orchestration.shouldRequestPMFinalReview({
  pm, agent: coder, taskSource: 'user', routeMode: 'explicit', explicitMentionCount: 1,
  explicitlyAddressedAgentId: coder.id, handoffCount: 0,
}), false);
assert.equal(orchestration.shouldRequestPMFinalReview({
  pm, agent: coder, taskSource: 'user', routeMode: 'explicit', explicitMentionCount: 2,
  explicitlyAddressedAgentId: coder.id, handoffCount: 0,
}), true);
assert.equal(orchestration.shouldRequestPMFinalReview({
  pm, agent: coder, taskSource: 'user', routeMode: 'explicit', explicitMentionCount: 1,
  explicitlyAddressedAgentId: coder.id, handoffCount: 1,
}), true);

const accidentalMemoryReply = '#Informationsarchitektur\n\n1. **Header:** Quicksort verstehen.\n#Accessibility Zustände sind erkennbar.';
assert.deepEqual(memoryRules.extractMemoryCommands(accidentalMemoryReply), []);
assert.deepEqual(memoryRules.extractKnowledgeFromReply(accidentalMemoryReply, coder.id, coder.name), []);
assert.deepEqual(memoryRules.extractMemoryCommands('Im Fließtext steht #fact nur als Beispiel.'), []);
const explicitMemoryCommands = memoryRules.extractMemoryCommands([
  '#decision PostgreSQL wird für das Projekt verwendet.',
  '#fact #Max Bubble Sort vergleicht benachbarte Elemente.',
].join('\n'));
assert.deepEqual(explicitMemoryCommands.map(command => command.commandTag), ['decision', 'fact']);
assert.deepEqual(explicitMemoryCommands[1].tags, ['fact', 'max']);
assert.equal(memoryRules.isMemoryCommandOnly('#fact Bubble Sort ist stabil.'), true);
assert.equal(memoryRules.isMemoryCommandOnly('#fact Bubble Sort ist stabil.\n@Max Nutze diese Information.'), false);
const multilineMemory = memoryRules.extractMemoryCommands('#constraint\nDie Anwendung muss offline starten.\nKeine Anmeldung erzwingen.');
assert.equal(multilineMemory.length, 1);
assert.match(multilineMemory[0].text, /Keine Anmeldung erzwingen/);
const capsule = orchestration.buildTaskCapsule({
  agentName: 'Max', agentRole: 'Developer', objective: 'Feature prüfen',
  context: ['memory://shared'], requestedOutput: ['Ergebnis'],
});
assert.match(capsule, /Feature prüfen/);
assert.doesNotMatch(capsule, /UNERLAUBTER_VOLLER_VERLAUF/);
const sessionA = orchestration.buildAgentSession({ agent: coder, taskCapsule: capsule });
const sessionB = orchestration.buildAgentSession({ agent: coder, taskCapsule: capsule });
assert.notEqual(sessionA.sessionId, sessionB.sessionId);
assert.equal(sessionA.messages.length, 1);

const handoffs = orchestration.extractHandoffsFromReply(
  '@Max: Implementiere die Seite.\n@Lisa: Prüfe danach die Navigation.\n@user: Optionales Feedback.',
  pm,
  [pm, coder, tester],
);
assert.deepEqual(handoffs.map(handoff => handoff.to), ['Max', 'Lisa']);
assert.match(handoffs[0].summary, /Implementiere die Seite/);
assert.match(handoffs[1].summary, /Prüfe danach die Navigation/);

assert.equal(orchestration.hasDirectedMention('@Max: Starte.', 'Max'), true);
assert.equal(orchestration.hasDirectedMention('Bitte stimme dich mit @Max ab.', 'Max'), false);
assert.equal(orchestration.hasDirectedMention('  @Max: Nur eingerückter Text.', 'Max'), false);
assert.equal(orchestration.hasDirectedMention('```text\n@Max: Beispiel\n```', 'Max'), false);
const nonActionableMentions = [
  'Im Fließtext wurde @Max nur erwähnt.',
  '  @Max: Diese eingerückte Zeile ist keine Übergabe.',
  '@Lisa: Nur diese linkbündige Zeile ist eine Übergabe.',
].join('\n');
assert.deepEqual(
  orchestration.extractHandoffsFromReply(nonActionableMentions, pm, [pm, coder, tester]).map(handoff => handoff.to),
  ['Lisa'],
);
const normalizedNonActionableMentions = orchestration.normalizeAgentMentionLayout(nonActionableMentions, pm, [pm, coder, tester]);
assert.match(normalizedNonActionableMentions, /^Im Fließtext wurde @Max/m);
assert.match(normalizedNonActionableMentions, /^  @Max:/m);
assert.deepEqual(
  orchestration.extractHandoffsFromReply(normalizedNonActionableMentions, pm, [pm, coder, tester]).map(handoff => handoff.to),
  ['Lisa'],
);

const layoutReply = [
  'Die Analyse ist abgeschlossen.',
  '@Max: Implementiere die Startseite.',
  '@Lisa: Prüfe anschließend die Navigation.',
  'Weitere Details stehen im Bericht.',
].join('\n');
const normalizedLayout = orchestration.normalizeAgentMentionLayout(layoutReply, pm, [pm, coder, tester]);
const normalizedLines = normalizedLayout.split('\n');
assert.deepEqual(normalizedLines.slice(-2), [
  '@Max: Implementiere die Startseite.',
  '@Lisa: Prüfe anschließend die Navigation.',
]);
assert.equal(normalizedLines.slice(-2).every(line => line.startsWith('@')), true);
assert.match(normalizedLayout, /Weitere Details stehen im Bericht\.\n\n@Max/);

const codeMentionReply = '```js\nconst owner = "@Max";\n```\n@Lisa: Teste den Code.';
assert.deepEqual(orchestration.extractHandoffsFromReply(codeMentionReply, pm, [pm, coder, tester]).map(handoff => handoff.to), ['Lisa']);
assert.match(orchestration.normalizeAgentMentionLayout(codeMentionReply, pm, [pm, coder, tester]), /const owner = "@Max"/);
const nestedFenceMentionReply = [
  '````file:README.md',
  '# Beispiel',
  '```text',
  '@Lisa: Diese Beispielzeile darf keine Übergabe auslösen.',
  '```',
  '@Max: Auch normaler Text in der Datei bleibt inaktiv.',
  '````',
].join('\n');
assert.deepEqual(
  orchestration.extractHandoffsFromReply(nestedFenceMentionReply, pm, [pm, coder, tester]),
  [],
);

const userQuestionReply = [
  'Die technische Planung ist abgeschlossen.',
  '@user Welche Hauptfarbe soll verwendet werden? Soll ein vorhandenes Logo eingebunden werden?',
].join('\n');
assert.deepEqual(orchestration.extractUserQuestions(userQuestionReply), [
  'Welche Hauptfarbe soll verwendet werden?',
  'Soll ein vorhandenes Logo eingebunden werden?',
]);
assert.deepEqual(orchestration.extractUserQuestions('```js\nconst owner = "@user";\n```'), []);
assert.deepEqual(orchestration.extractUserQuestions('Im Fließtext steht @user: Soll das pausieren?'), []);
assert.deepEqual(orchestration.extractUserQuestions('  @user Soll das eingerückt pausieren?'), []);

const taskQueue = new orchestration.AgentTaskQueue({ maxTurns: 8, maxTurnsPerAgent: 3 });
assert.equal(taskQueue.enqueue({ agent: pm, objective: 'Plane das Projekt', source: 'user' }), true);
assert.equal(taskQueue.next().agent.name, 'PM');

const priorityQueue = new orchestration.AgentTaskQueue({ maxTurns: 8, maxTurnsPerAgent: 3 });
priorityQueue.enqueue({ agent: tester, objective: 'Bereits wartende QA-Aufgabe', source: 'user' });
assert.equal(priorityQueue.prepend([
  { agent: coder, objective: 'Direkt angesprochene Implementierung', source: 'PM' },
  { agent: pm, objective: 'Direkt danach planen', source: 'Max' },
]), 2);
assert.deepEqual(
  [priorityQueue.next().agent.name, priorityQueue.next().agent.name, priorityQueue.next().agent.name],
  ['Max', 'PM', 'Lisa'],
);
const autoParallelQueue = new orchestration.AgentTaskQueue({ maxTurns: 8, maxTurnsPerAgent: 3 });
autoParallelQueue.enqueue({ agent: tester, objective: 'Sequenziell', graphNodeId: 'sequential' });
autoParallelQueue.enqueue({ agent: coder, objective: 'Parallel A', graphNodeId: 'parallel-a' });
autoParallelQueue.enqueue({ agent: pm, objective: 'Parallel B', graphNodeId: 'parallel-b' });
autoParallelQueue.prioritize(['parallel-a', 'parallel-b']);
assert.deepEqual(
  [autoParallelQueue.next().graphNodeId, autoParallelQueue.next().graphNodeId, autoParallelQueue.next().graphNodeId],
  ['parallel-a', 'parallel-b', 'sequential'],
);
const providerRetryQueue = new orchestration.AgentTaskQueue({ maxTurns: 2, maxTurnsPerAgent: 1 });
providerRetryQueue.enqueue({ agent: coder, objective: 'Temporär begrenzter Task', source: 'PM' });
const limitedTask = providerRetryQueue.next();
assert.equal(providerRetryQueue.retry(limitedTask), true);
assert.equal(providerRetryQueue.next().objective, 'Temporär begrenzter Task');
assert.equal(providerRetryQueue.reachedLimit, false);
const repeatedFileQueue = new orchestration.AgentTaskQueue({ maxSuccessfulScopeRepeats: 2 });
const readmeTask = summary => ({
  agent: tester,
  objective: summary,
  handoff: { from: 'PM', summary },
  source: 'PM',
});
assert.equal(repeatedFileQueue.enqueue(readmeTask('Erstelle README.md vollständig.')), true);
const firstReadmeTask = repeatedFileQueue.next();
repeatedFileQueue.markSuccessful(firstReadmeTask);
assert.equal(repeatedFileQueue.enqueue(readmeTask('Überarbeite die vollständige Datei README.md.')), true);
const secondReadmeTask = repeatedFileQueue.next();
repeatedFileQueue.markSuccessful(secondReadmeTask);
assert.equal(repeatedFileQueue.prepend([readmeTask('Lege README.md mit kompletter Dokumentation neu an.')]), 0);
assert.equal(repeatedFileQueue.getLastPrependResult().rejected[0].reason, 'repeat-limit');
const restoredFileQueue = new orchestration.AgentTaskQueue({ guardState: repeatedFileQueue.guardState() });
assert.equal(restoredFileQueue.enqueue(readmeTask('Schreibe README.md bitte erneut.')), false);
assert.equal(orchestration.shouldDeferHandoffToPM({ fromAgent: coder, targetAgent: pm, pm }), true);
assert.equal(orchestration.shouldDeferHandoffToPM({ fromAgent: pm, targetAgent: coder, pm }), false);
assert.equal(orchestration.isAgentTimeoutError({ isAgentTimeout: true }), true);
assert.equal(orchestration.isAgentTimeoutError({ message: 'Codex-Aufruf nach 120s ohne Aktivität abgebrochen.' }), true);
assert.equal(orchestration.isAgentTimeoutError({ message: 'Normaler Modellfehler' }), false);
const timeoutRecoveryTask = orchestration.buildTimeoutRecoveryTask({
  pm,
  originalAgent: coder,
  objective: 'Implementiere die gesamte Anwendung in einem Schritt.',
  errorMessage: '120s ohne Aktivität',
});
assert.equal(timeoutRecoveryTask.agent.name, 'PM');
assert.equal(timeoutRecoveryTask.source, 'timeout-recovery');
assert.equal(timeoutRecoveryTask.recovery.originalAgentName, 'Max');
assert.match(timeoutRecoveryTask.handoff.summary, /ausschließlich den ersten ausführbaren Schritt/);
const timeoutPriorityQueue = new orchestration.AgentTaskQueue();
timeoutPriorityQueue.enqueue({ agent: tester, objective: 'Wartende QA-Aufgabe', source: 'PM' });
timeoutPriorityQueue.prepend([timeoutRecoveryTask]);
assert.deepEqual([timeoutPriorityQueue.next().agent.name, timeoutPriorityQueue.next().agent.name], ['PM', 'Lisa']);
const timeoutReviewTask = orchestration.buildTimeoutRecoveryReviewTask({
  pm,
  recovery: { ...timeoutRecoveryTask.recovery, mode: 'step', currentStep: 'Baue das Grundgerüst.' },
  stepObjective: 'Baue das Grundgerüst.',
  result: 'Grundgerüst fertig.',
});
assert.equal(timeoutReviewTask.agent.name, 'PM');
assert.match(timeoutReviewTask.handoff.findings.join(' '), /Grundgerüst fertig/);
const turnLimitReviewTask = orchestration.buildTurnLimitReviewTask({
  pm,
  initialObjective: 'Baue und teste die Anwendung.',
  maxTurns: 16,
  pendingTasks: [{ agent: tester, objective: 'Regression testen' }],
  delegatedResults: [{ agent: 'Max', objective: 'Implementieren', result: 'Feature fertig' }],
});
assert.equal(turnLimitReviewTask.agent.name, 'PM');
assert.equal(turnLimitReviewTask.source, 'turn-limit-review');
assert.match(turnLimitReviewTask.handoff.summary, /höchstens EINEN kleinen/);
assert.match(turnLimitReviewTask.handoff.findings.join(' '), /Regression testen/);
assert.equal(orchestration.shouldCompleteProject({
  isOrchestrator: true,
  source: 'turn-limit-review',
  reply: 'Alles geprüft. [[PROJECT_DONE]]',
  handoffCount: 0,
  pendingTaskCount: 3,
  asksUser: false,
}), true);

const checkpointSourceQueue = new orchestration.AgentTaskQueue();
checkpointSourceQueue.enqueue({ agent: pm, objective: 'Plane das Projekt', source: 'user' });
assert.equal(checkpointSourceQueue.next().agent.name, 'PM');
checkpointSourceQueue.enqueue({ agent: coder, objective: 'Implementiere den offenen Teil', source: 'PM' });
checkpointSourceQueue.enqueue({ agent: tester, objective: 'Prüfe anschließend', source: 'PM' });
const serializedCheckpoint = JSON.parse(JSON.stringify({
  version: 1,
  status: 'running',
  initialObjective: 'Baue das Projekt',
  pendingTasks: checkpointSourceQueue.pendingTasks(),
  delegatedResults: [{ agent: 'PM', result: 'Planung abgeschlossen' }],
  successfulTasks: 1,
}));
const interruptedCheckpoint = { ...serializedCheckpoint, status: 'interrupted', interruptedAgentId: 'coder' };
assert.equal(['running', 'interrupted'].includes(interruptedCheckpoint.status), true);
assert.equal(interruptedCheckpoint.interruptedAgentId, 'coder');
const restoredCheckpointQueue = new orchestration.AgentTaskQueue();
for (const pendingTask of serializedCheckpoint.pendingTasks) restoredCheckpointQueue.enqueue(pendingTask);
assert.deepEqual(
  [restoredCheckpointQueue.next().agent.name, restoredCheckpointQueue.next().agent.name],
  ['Max', 'Lisa'],
);
assert.equal(serializedCheckpoint.successfulTasks, 1);
assert.equal(serializedCheckpoint.delegatedResults[0].result, 'Planung abgeschlossen');
assert.equal(
  orchestration.summarizeTaskActivity({ objective: 'Implementiere die Navigation und prüfe alle Links.', source: 'user' }),
  'Arbeitet an: Implementiere die Navigation und prüfe alle Links.',
);
assert.equal(
  orchestration.summarizeTaskActivity({ objective: 'Final-Review: Prüfe gegen die ursprüngliche User-Anforderung "Baue eine responsive Navigation".', source: 'team-synthesis' }),
  'Prüft den Abschluss für: Baue eine responsive Navigation',
);
assert.match(
  orchestration.summarizeTaskActivity({ objective: 'x'.repeat(300), source: 'user' }),
  /^Arbeitet an: .{132}…$/,
);
assert.equal(taskQueue.enqueue({ agent: coder, objective: 'Implementiere', handoff: { from: 'PM', summary: 'Implementiere' } }), true);
assert.equal(taskQueue.enqueue({ agent: tester, objective: 'Prüfe', handoff: { from: 'PM', summary: 'Prüfe' } }), true);
assert.equal(taskQueue.enqueue({ agent: coder, objective: 'Korrigiere QA-Fund', handoff: { from: 'Lisa', summary: 'Korrigiere QA-Fund' } }), true);
assert.equal(taskQueue.enqueue({ agent: coder, objective: 'Korrigiere QA-Fund', handoff: { from: 'Lisa', summary: 'Korrigiere QA-Fund' } }), false);
assert.deepEqual([taskQueue.next().agent.name, taskQueue.next().agent.name, taskQueue.next().agent.name], ['Max', 'Lisa', 'Max']);
assert.equal(taskQueue.enqueue({ agent: pm, objective: 'Fasse zusammen', handoff: { from: 'Team-Runde-1', summary: 'Fasse zusammen' } }), true);
assert.equal(taskQueue.next().agent.name, 'PM');

const dialogueQueue = new orchestration.AgentTaskQueue({ maxTurns: 8, maxTurnsPerAgent: 3 });
dialogueQueue.enqueue({ agent: pm, objective: 'Baue und prüfe die Seite', source: 'user' });
const dialogueSequence = [];
const scriptedReplies = [
  '@Max: Implementiere die Seite.',
  '@Lisa: Prüfe die Implementierung.',
  '@Max: Korrigiere den gefundenen Navigationsfehler.',
  'Korrektur abgeschlossen.',
];
let dialogueTask;
while ((dialogueTask = dialogueQueue.next()) && dialogueSequence.length < scriptedReplies.length) {
  dialogueSequence.push(dialogueTask.agent.name);
  const reply = scriptedReplies[dialogueSequence.length - 1];
  for (const handoff of orchestration.extractHandoffsFromReply(reply, dialogueTask.agent, [pm, coder, tester])) {
    const target = [pm, coder, tester].find(agent => agent.name === handoff.to);
    dialogueQueue.enqueue({ agent: target, objective: handoff.summary, handoff, source: dialogueTask.agent.name });
  }
}
assert.deepEqual(dialogueSequence, ['PM', 'Max', 'Lisa', 'Max']);

const pausedQueue = new orchestration.AgentTaskQueue();
pausedQueue.enqueue({ agent: tester, objective: 'Prüfe nach der User-Antwort', source: 'PM' });
const savedPendingTasks = pausedQueue.pendingTasks();
const resumedQueue = new orchestration.AgentTaskQueue();
const answerTask = orchestration.buildUserAnswerTask({
  askingAgent: coder,
  question: '@user Welche Farbe soll verwendet werden?',
  answer: 'Verwende Blau.',
});
assert.equal(answerTask.handoff.from, 'user');
assert.match(answerTask.objective, /Verwende Blau/);
resumedQueue.enqueue(answerTask);
for (const pendingTask of savedPendingTasks) resumedQueue.enqueue(pendingTask);
assert.deepEqual([resumedQueue.next().agent.name, resumedQueue.next().agent.name], ['Max', 'Lisa']);

const artifactReply = [
  'Die Basisdateien sind fertig.',
  '```file:src/app.js',
  "console.log('ok');",
  '```',
  '````file:README.md',
  '# Testprojekt',
  '',
  '```bash',
  'npm start',
  '```',
  '',
  '## Bedienung',
  'Die Datei bleibt auch hinter dem inneren Codeblock vollständig.',
  '````',
  '[[PROJECT_DONE]]',
].join('\n');
const parsedArtifacts = orchestration.extractProjectFiles(artifactReply);
assert.deepEqual(parsedArtifacts.map(file => file.filename), ['src/app.js', 'README.md']);
assert.match(parsedArtifacts[1].content, /## Bedienung/);
assert.match(parsedArtifacts[1].content, /```bash\nnpm start\n```/);
assert.equal(orchestration.hasProjectDoneSignal(artifactReply), true);
assert.doesNotMatch(orchestration.cleanAgentReply(artifactReply), /console\.log|PROJECT_DONE/);
assert.doesNotMatch(orchestration.cleanAgentReply(artifactReply), /README\.mdbash|npm start/);
const reviewEvidence = orchestration.buildProjectReviewEvidence({
  displayReply: orchestration.cleanAgentReply(artifactReply),
  projectFiles: parsedArtifacts,
  savedProjectFiles: ['src/app.js', 'README.md'],
});
assert.match(reviewEvidence, /README\.md \| \d+ Zeichen \| vollständig gespeichert/);
assert.match(reviewEvidence, /## Bedienung/);
const structuredPlanReply = [
  '[[TASK_PLAN]]',
  '{"tasks":[',
  '{"id":"implement","title":"CMD implementieren","agent":"Max","type":"task","parentId":null,"dependsOn":[],"executionMode":"parallel"},',
  '{"id":"qa","title":"CMD testen","agent":"Lisa","type":"task","parentId":null,"dependsOn":["implement"],"executionMode":"sequential"},',
  '{"id":"final-review","title":"Finale PM-Abnahme","agent":"PM","type":"review","parentId":null,"dependsOn":["qa"],"executionMode":"sequential"}',
  ']}',
  '[[/TASK_PLAN]]',
  'Der vollständige Weg ist geplant.',
  '@Max: Implementiere die CMD-Datei.',
].join('\n');
const structuredPlan = orchestration.extractTaskPlan(structuredPlanReply);
assert.deepEqual(structuredPlan.tasks.map(task => task.id), ['implement', 'qa', 'final-review']);
assert.deepEqual(structuredPlan.tasks[1].dependsOn, ['implement']);
assert.doesNotMatch(orchestration.cleanAgentReply(structuredPlanReply), /TASK_PLAN|"dependsOn"/);
assert.match(orchestration.cleanAgentReply(structuredPlanReply), /vollständige Weg/);
const distributedDeveloperTasks = orchestration.distributeTaskPlanAcrossAgentPools([
  { id: 'dev-1', title: 'Modul A', agent: 'Max', type: 'task', order: 0 },
  { id: 'dev-2', title: 'Modul B', agent: 'Max', type: 'task', order: 1 },
  { id: 'dev-3', title: 'Modul C', agent: 'Max', type: 'task', order: 2 },
  { id: 'review', title: 'PM-Abnahme', agent: 'PM', type: 'review', order: 3 },
], [pm, coder, coderTwo, tester]);
assert.deepEqual(distributedDeveloperTasks.slice(0, 3).map(task => task.agent), ['Max', 'Alex', 'Max']);
assert.equal(distributedDeveloperTasks[1].requestedAgentName, 'Max');
assert.equal(distributedDeveloperTasks[3].agent, 'PM');
const parallelRolePlan = orchestration.extractTaskPlan([
  '[[TASK_PLAN]]',
  '{"tasks":[',
  '{"id":"frontend","title":"Frontend-Modul erstellen","agent":"Max","type":"task","dependsOn":[],"executionMode":"parallel"},',
  '{"id":"backend","title":"Backend-Modul erstellen","agent":"Max","type":"task","dependsOn":[],"executionMode":"parallel"}',
  ']}',
  '[[/TASK_PLAN]]',
].join('\n'));
const parallelRoleTasks = orchestration.distributeTaskPlanAcrossAgentPools(parallelRolePlan.tasks, [pm, coder, coderTwo, tester])
  .map(task => {
    const assigned = [coder, coderTwo].find(agent => agent.name === task.agent);
    return { ...task, agentId: assigned.id, agentName: assigned.name };
  });
assert.deepEqual(parallelRoleTasks.map(task => task.agentName), ['Max', 'Alex']);
let rolePoolGraph = taskGraph.upsertTaskNode(taskGraph.createTaskGraph('role-pool'), {
  id: 'role-root', title: 'Planung', agentId: pm.id, agentName: pm.name, status: 'completed', source: 'user',
});
rolePoolGraph = taskGraph.materializeTaskPlan(rolePoolGraph, { rootNodeId: 'role-root', tasks: parallelRoleTasks });
const rolePoolTaskIds = rolePoolGraph.nodes.filter(node => node.planTaskId).map(node => node.id);
assert.equal(taskGraph.validateParallelSelection(rolePoolGraph, rolePoolTaskIds).ok, true);
assert.deepEqual(taskGraph.findSafeAutoParallelTaskIds(
  rolePoolGraph,
  rolePoolTaskIds.map(graphNodeId => ({ graphNodeId })),
), rolePoolTaskIds);
assert.equal(orchestration.shouldCompleteProject({ isOrchestrator: true, source: 'user', reply: artifactReply, handoffCount: 0, pendingTaskCount: 0, asksUser: false }), true);
assert.equal(orchestration.shouldCompleteProject({ isOrchestrator: true, source: 'team-synthesis', reply: 'Alles erledigt.', handoffCount: 0, pendingTaskCount: 0, asksUser: false }), true);
assert.equal(orchestration.shouldCompleteProject({ isOrchestrator: true, source: 'team-synthesis', reply: 'Noch offen', handoffCount: 1, pendingTaskCount: 1, asksUser: false }), false);
const projectPrompt = orchestration.buildIsolatedSystemPrompt({
  agent: pm, groupName: 'Dev Team', groupAgentNames: ['PM', 'Max'], memoryNamespace: 'dev-team',
  groupAgents: [pm, coder, coderTwo],
  projectPath: 'C:/projects/demo', isOrchestrator: true,
});
assert.match(projectPrompt, /````file:relativer\/pfad\.ext/);
assert.match(projectPrompt, /\[\[PROJECT_DONE\]\]/);
assert.match(projectPrompt, /abschließenden Final-Review/);
assert.match(projectPrompt, /Ist noch etwas offen/);
assert.match(projectPrompt, /keine zusätzlichen README-/);
assert.match(projectPrompt, /AUFGABENPLAN/);
assert.match(projectPrompt, /\[\[TASK_PLAN\]\]/);
assert.match(projectPrompt, /Max \(Developer\)/);
assert.match(projectPrompt, /Rollenpool mit mindestens zwei Agenten/);
assert.match(projectPrompt, /gemeinsamen Arbeitsbereich freigegeben/);
assert.match(projectPrompt, /Verändere niemals \.git, \.svn oder node_modules/);
const sharedProjectFileContext = orchestration.buildSharedProjectFileContext({
  agentName: 'Max',
  projectFiles: [
    { filename: 'src/sort.js', content: 'export const sort = values => values;\n' },
    { filename: 'src/unsaved.js', content: 'nicht freigegeben\n' },
  ],
  savedProjectFiles: ['src\\sort.js'],
});
assert.match(sharedProjectFileContext, /Max/);
assert.match(sharedProjectFileContext, /src\/sort\.js/);
assert.match(sharedProjectFileContext, /export const sort/);
assert.doesNotMatch(sharedProjectFileContext, /unsaved/);
assert.match(orchestration.buildSharedProjectFileContext({
  projectFiles: [{ filename: 'large.txt', content: 'x'.repeat(100) }],
  savedProjectFiles: ['large.txt'],
  maxCharactersPerFile: 20,
}), /nach 20 von 100 Zeichen gekürzt/);
const directChatPrompt = orchestration.buildIsolatedSystemPrompt({
  agent: coder,
  groupName: coder.name,
  groupAgents: [coder],
  isDirectChat: true,
});
assert.match(directChatPrompt, /direkten Einzelchat/);
assert.match(directChatPrompt, /kein PM vorgeschaltet/);
assert.match(directChatPrompt, /Antworte unmittelbar selbst/);
assert.doesNotMatch(directChatPrompt, /Du bist der Orchestrator/);
assert.doesNotMatch(directChatPrompt, /abschließenden Final-Review/);

const memoryStore = new Map();
globalThis.window = {
  electronAPI: {
    appStateGet: async key => memoryStore.get(key),
    appStateSet: async (key, value) => memoryStore.set(key, value),
  },
};
const memory = await importSource('src/memory-provider.js');
const sharedA = memory.getMemoryAPI({ provider: 'local', namespace: 'shared-project' });
const sharedB = memory.getMemoryAPI({ provider: 'local', namespace: 'shared-project' });
await sharedA.clear('shared-project');
const localMemoryEntry = memory.createEntry({
  type: 'decision', namespace: 'shared-project', content: 'PostgreSQL verwenden', tags: ['database'], author: 'PM',
});
await sharedA.write('shared-project', localMemoryEntry);
assert.equal((await sharedB.list('shared-project')).length, 1);
assert.equal((await sharedB.search('shared-project', 'PostgreSQL', 5))[0].type, 'decision');
assert.deepEqual(await sharedB.delete('shared-project', localMemoryEntry.id), { ok: true, deleted: true });
assert.equal((await sharedA.list('shared-project')).length, 0);
assert.deepEqual(await sharedB.delete('shared-project', localMemoryEntry.id), { ok: false, deleted: false });
await sharedB.clear('shared-project');
assert.equal((await sharedA.list('shared-project')).length, 0);

const chatAttachments = require(path.join(root, 'electron/chat-attachments.js'));
const tempAttachmentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-attachments-'));
try {
  const sourceDir = path.join(tempAttachmentDir, 'sources');
  const attachmentRoot = path.join(tempAttachmentDir, 'stored');
  await fs.mkdir(sourceDir, { recursive: true });
  const sourceFiles = {
    markdown: path.join(sourceDir, 'notes.md'),
    text: path.join(sourceDir, 'data.json'),
    image: path.join(sourceDir, 'pixel.png'),
    pdf: path.join(sourceDir, 'brief.pdf'),
    binary: path.join(sourceDir, 'archive.custombin'),
  };
  await fs.writeFile(sourceFiles.markdown, '# Anforderung\nDateiinhalt', 'utf8');
  await fs.writeFile(sourceFiles.text, '{"enabled":true}', 'utf8');
  await fs.writeFile(sourceFiles.image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'));
  await fs.writeFile(sourceFiles.pdf, Buffer.from('%PDF-1.4\n%%EOF', 'utf8'));
  await fs.writeFile(sourceFiles.binary, Buffer.from([0, 1, 2, 3, 255]));

  const saved = chatAttachments.savePickedAttachments({
    sourcePaths: Object.values(sourceFiles), attachmentRoot,
    root: attachmentRoot,
    chatId: 'attachment-chat',
  });
  assert.deepEqual(saved.errors, []);
  assert.deepEqual(saved.attachments.map(item => item.kind), ['markdown', 'text', 'image', 'pdf', 'file']);
  assert.equal(saved.attachments.find(item => item.kind === 'markdown').content.includes('Dateiinhalt'), true);
  assert.equal(await fs.readFile(sourceFiles.markdown, 'utf8'), '# Anforderung\nDateiinhalt');

  const openAIPrepared = chatAttachments.prepareApiMessages({
    messages: [{ role: 'user', content: 'Bitte auswerten.' }],
    attachments: saved.attachments,
    root: attachmentRoot,
    provider: 'openai',
  });
  const openAIParts = openAIPrepared.messages[0].content;
  assert.equal(openAIParts.filter(part => part.type === 'image_url').length, 1);
  assert.deepEqual(openAIParts.filter(part => part.type === 'file').map(part => part.file.filename), ['brief.pdf', 'archive.custombin']);
  assert.match(openAIParts.find(part => part.type === 'text').text, /notes\.md/);

  const anthropicPrepared = chatAttachments.prepareApiMessages({
    messages: [{ role: 'user', content: 'Bitte auswerten.' }],
    attachments: saved.attachments,
    root: attachmentRoot,
    provider: 'anthropic',
  });
  assert.equal(anthropicPrepared.messages[0].content.filter(part => part.type === 'image').length, 1);
  assert.equal(anthropicPrepared.messages[0].content.filter(part => part.type === 'document').length, 1);
  assert.match(anthropicPrepared.messages[0].content.find(part => part.type === 'text').text, /archive\.custombin/);
  assert.match(chatAttachments.attachmentData(saved.attachments.find(item => item.kind === 'image'), attachmentRoot).dataUrl, /^data:image\/png;base64,/);
  assert.throws(() => chatAttachments.validateStoredAttachment({ path: sourceFiles.markdown, name: 'notes.md' }, attachmentRoot), /Ungültiger Anhangspfad/);
  chatAttachments.clearChatAttachments('attachment-chat', attachmentRoot);
  await assert.rejects(() => fs.access(saved.attachments[0].path));
} finally {
  await fs.rm(tempAttachmentDir, { recursive: true, force: true });
}

const memoryFiles = require(path.join(root, 'electron/memory-file.js'));
const tempMemoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-memory-'));
try {
  const memoryPath = path.join(tempMemoryDir, 'shared.memory.json');
  const secondMemoryPath = path.join(tempMemoryDir, 'other.memory.json');
  memoryFiles.ensureMemoryFile(memoryPath, 'shared-project');
  memoryFiles.ensureMemoryFile(secondMemoryPath, 'shared-project');
  globalThis.window.electronAPI.memoryFileOperation = async params => memoryFiles.operateMemoryFile(params);

  const fileMemory = memory.getMemoryAPI({ provider: 'file', filePath: memoryPath });
  const otherFileMemory = memory.getMemoryAPI({ provider: 'file', filePath: secondMemoryPath });
  const fileEntry = memory.createEntry({
    type: 'finding', namespace: 'shared-project', content: 'Datei-Memory funktioniert', tags: ['json'], author: 'Lisa',
  });
  await fileMemory.write('shared-project', fileEntry);
  await fileMemory.write('second-space', memory.createEntry({
    type: 'fact', namespace: 'second-space', content: 'Getrennter Namespace', tags: ['separate'], author: 'PM',
  }));
  assert.equal((await fileMemory.search('shared-project', 'funktioniert', 5))[0].id, fileEntry.id);
  assert.equal((await fileMemory.list('second-space')).length, 1);
  assert.equal((await otherFileMemory.list('shared-project')).length, 0);
  assert.equal((await fileMemory.update('shared-project', fileEntry.id, { confidence: 'high' })).confidence, 'high');

  const storedMemory = JSON.parse(await fs.readFile(memoryPath, 'utf8'));
  assert.equal(storedMemory.format, 'agent-teams-memory');
  assert.equal(storedMemory.version, 1);
  assert.deepEqual(Object.keys(storedMemory.namespaces).sort(), ['second-space', 'shared-project']);
  assert.deepEqual(await fileMemory.delete('shared-project', fileEntry.id), { ok: true, deleted: true });
  assert.equal((await fileMemory.list('shared-project')).length, 0);
  assert.deepEqual(await fileMemory.delete('shared-project', fileEntry.id), { ok: false, deleted: false });
  await fileMemory.clear('shared-project');
  assert.equal((await fileMemory.list('shared-project')).length, 0);

  const legacyPath = path.join(tempMemoryDir, 'legacy.json');
  await fs.writeFile(legacyPath, JSON.stringify([fileEntry]), 'utf8');
  memoryFiles.ensureMemoryFile(legacyPath, 'legacy-space');
  assert.equal(memoryFiles.operateMemoryFile({ filePath: legacyPath, action: 'list', namespace: 'legacy-space' }).length, 1);
  assert.throws(() => memoryFiles.ensureMemoryFile(path.join(tempMemoryDir, 'memory.txt'), 'shared'), /\.json/);
} finally {
  await fs.rm(tempMemoryDir, { recursive: true, force: true });
}

const claude = require(path.join(root, 'electron/claude-main.js'));
assert.equal(claude.fallbackModelFor('claude-opus-4-5'), 'sonnet');
assert.equal(claude.fallbackModelFor('claude-sonnet-4-5'), null);
assert.equal(claude.isClaudeRateLimitMessage('You have hit your usage limit'), true);
assert.equal(claude.parseClaudeResult('{"type":"result","result":"ok"}').result, 'ok');
assert.equal(claude.cancelClaudeRun('nicht-vorhanden').ok, false);
const claudeAttachmentPath = path.join(os.tmpdir(), 'attachment.bin');
const claudeAttachmentArgs = claude.buildClaudeArgs({ attachments: [{ kind: 'file', path: claudeAttachmentPath }] }).args;
assert.equal(claudeAttachmentArgs.includes('--add-dir'), true);
assert.equal(claudeAttachmentArgs.includes('Read'), true);
assert.equal(claudeAttachmentArgs.includes('Read,Write,Edit'), false);
const claudeProjectArgs = claude.buildClaudeArgs({ cwd: path.join(os.tmpdir(), 'shared-project') }).args;
assert.equal(claudeProjectArgs.includes('Read,Write,Edit'), true);
assert.equal(claudeProjectArgs.includes('Read,Edit(/**),Write(/**)'), true);
assert.equal(claudeProjectArgs.includes('dontAsk'), true);
const claudeProjectSettings = JSON.parse(claudeProjectArgs[claudeProjectArgs.indexOf('--settings') + 1]);
assert.equal(claudeProjectSettings.permissions.deny.includes('Write(/.git/**)'), true);
assert.equal(claudeProjectSettings.permissions.deny.includes('Edit(/node_modules/**)'), true);
assert.match(claude.buildClaudePrompt({ systemContent: 'System', merged: [], attachments: [{ kind: 'file', path: claudeAttachmentPath }] }), /attachment\.bin/);
const claudeStatus = await claude.getClaudeStatus();
assert.equal(typeof claudeStatus.installed, 'boolean');
assert.equal(typeof claudeStatus.connected, 'boolean');

const llmMain = require(path.join(root, 'electron/llm-main.js'));
assert.equal(llmMain.parseRetryAfterMs({ 'retry-after': '2' }, 0), 2000);
assert.equal(llmMain.parseRetryAfterMs({ 'retry-after': 'Thu, 01 Jan 1970 00:00:03 GMT' }, 1000), 2000);
const providerRuntime = require(path.join(root, 'electron/provider-config.js'));
const providerRequests = [];
const providerServer = http.createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    providerRequests.push({ url: request.url, headers: request.headers, body: parsed });
    response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/chat/completions')) {
      response.end(JSON.stringify({ choices: [{ message: { content: [
        { type: 'text', text: 'OpenAI-kompatibel' }, { type: 'text', text: 'OK' },
      ] } }] }));
    } else if (request.url.endsWith('/messages')) {
      response.end(JSON.stringify({ content: [{ type: 'text', text: 'Anthropic-kompatibel OK' }] }));
    } else {
      response.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini OK' }] } }] }));
    }
  });
});
await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
try {
  const providerPort = providerServer.address().port;
  const base = `http://127.0.0.1:${providerPort}`;
  const openAIResult = await llmMain.callConfiguredProvider({
    connection: providerRuntime.normalizeProviderConnection({
      id: 'api-openai-fixture', name: 'Fixture OpenAI', protocol: 'openai', baseUrl: `${base}/v1`, models: ['fixture-model'],
    }),
    apiKey: 'fixture-openai-key', model: 'fixture-model', systemContent: 'System', messages: [{ role: 'user', content: 'Hallo' }],
  });
  const anthropicResult = await llmMain.callConfiguredProvider({
    connection: providerRuntime.normalizeProviderConnection({
      id: 'api-anthropic-fixture', name: 'Fixture Anthropic', protocol: 'anthropic', baseUrl: `${base}/v1`, models: ['fixture-model'],
    }),
    apiKey: 'fixture-anthropic-key', model: 'fixture-model', systemContent: 'System', messages: [{ role: 'user', content: 'Hallo' }],
  });
  const geminiResult = await llmMain.callConfiguredProvider({
    connection: providerRuntime.normalizeProviderConnection({
      id: 'api-gemini-fixture', name: 'Fixture Gemini', protocol: 'gemini', baseUrl: `${base}/v1beta`, models: ['gemini-test'],
    }),
    apiKey: 'fixture-gemini-key', model: 'gemini-test', systemContent: 'System', messages: [{ role: 'user', content: 'Hallo' }],
  });
  assert.equal(openAIResult.text, 'OpenAI-kompatibel\nOK');
  assert.equal(anthropicResult.text, 'Anthropic-kompatibel OK');
  assert.equal(geminiResult.text, 'Gemini OK');
  assert.equal(providerRequests[0].headers.authorization, 'Bearer fixture-openai-key');
  assert.equal(providerRequests[1].headers['x-api-key'], 'fixture-anthropic-key');
  assert.equal(providerRequests[2].headers['x-goog-api-key'], 'fixture-gemini-key');
  assert.match(providerRequests[2].url, /models\/gemini-test:generateContent$/);
} finally {
  await new Promise(resolve => providerServer.close(resolve));
}
const projectFiles = require(path.join(root, 'electron/project-files.js'));
const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-smoke-'));
try {
  const sourceWrite = projectFiles.writeProjectFile({ projectPath: tempProject, filename: 'src/app.js', content: "console.log('ok');\n" });
  assert.equal(sourceWrite.success, true);
  assert.equal(await fs.readFile(path.join(tempProject, 'src/app.js'), 'utf8'), "console.log('ok');\n");
  assert.match(projectFiles.writeProjectFile({ projectPath: tempProject, filename: '../escape.txt', content: 'no' }).error, /innerhalb/);
  assert.match(projectFiles.writeProjectFile({ projectPath: tempProject, filename: '.git/config', content: 'no' }).error, /Geschützter/);
  assert.equal(projectFiles.writeProjectFile({ projectPath: tempProject, filename: '.agent-teams/progress/run.md', content: 'progress' }).success, true);
  const listed = projectFiles.listProjectFiles({ projectPath: tempProject }).files.map(file => file.name.replace(/\\/g, '/'));
  assert.deepEqual(listed, ['src/app.js']);
} finally {
  await fs.rm(tempProject, { recursive: true, force: true });
}

const codex = require(path.join(root, 'electron/codex-main.js'));
assert.deepEqual(codex.codexImageArgs([{ kind: 'image', path: 'C:/tmp/image.png' }, { kind: 'file', path: 'C:/tmp/data.bin' }]), ['--image', 'C:/tmp/image.png']);
assert.match(codex.buildCodexPrompt({ systemContent: 'System', merged: [], attachments: [{ kind: 'file', path: 'C:/tmp/data.bin' }] }), /data\.bin/);
assert.deepEqual(codex.describeCodexEvent({ type: 'turn.started' }), {
  phase: 'analysis', message: 'Prüft Anforderungen und plant die nächsten Schritte.',
});
assert.deepEqual(codex.describeCodexEvent({
  type: 'item.started', item: { type: 'command_execution', command: 'npm test' },
}), {
  phase: 'command', message: 'Befehl läuft: npm test',
});
assert.equal(codex.cancelCodexRun('nicht-vorhanden').ok, false);
const codexStatus = await codex.getCodexStatus();
assert.equal(typeof codexStatus.installed, 'boolean');
assert.equal(typeof codexStatus.connected, 'boolean');
if (!codexStatus.connected) {
  const result = await codex.callCodexCLI({ systemContent: 'Test', merged: [], model: 'codex-default' });
  if (codexStatus.installed) {
    assert.equal(result.status, 401);
  } else {
    assert.match(result.error, /Codex CLI nicht gefunden/i);
  }
}

const { McpManager } = require(path.join(root, 'electron/mcp-manager.js'));
const mcpManager = new McpManager({ connectionTimeoutMs: 5000, requestTimeoutMs: 5000 });
const fixtureServer = {
  id: 'fixture-mcp', name: 'Fixture MCP', enabled: true, transport: 'stdio',
  command: process.execPath, args: [path.join(root, 'scripts/fixtures/mcp-test-server.cjs')],
};
try {
  const fixtureStatus = await mcpManager.testServer(fixtureServer);
  assert.equal(fixtureStatus.ok, true);
  assert.deepEqual(fixtureStatus.tools, ['echo']);
  const fixtureResult = await mcpManager.callTool(fixtureServer, 'echo', { value: 'integration' });
  assert.equal(fixtureResult.text, 'echo:integration');
} finally {
  await mcpManager.closeAll();
}

console.log(JSON.stringify({
  ok: true,
  checks: ['no-artificial-agent-delay', 'safe-auto-parallel-batching', 'lean-fast-mode', 'configurable-run-limits', 'pm-turn-limit-review', 'resumable-run-segments', 'agent-teams-window-branding', 'typing-agent-identity', 'always-focused-chat-composer', 'draft-while-agent-runs', 'persistent-user-request-queue', 'global-agent-role-catalog', 'legacy-agent-role-migration', 'routing', 'direct-chat-conversation-history', 'directed-group-context-window', 'direct-specialist-without-pm-review', 'explicit-memory-commands', 'manual-memory-entry', 'quality-cascade-policy', 'quality-deterministic-gates', 'quality-chat-controls', 'custom-provider-quality-cascade', 'direct-chat-without-pm', 'mixed-provider-routing', 'generic-provider-presets', 'encrypted-provider-credentials', 'provider-protocol-routing', 'claude-cli-oauth-routing', 'anthropic-api-key-routing', 'claude-rate-limit-metadata', 'retryable-provider-queue', 'retry-after-parsing', 'claude-opus-sonnet-fallback', 'claude-cli-status', 'browser-file-attachments', 'persistent-file-attachments', 'provider-native-file-payloads', 'cli-file-access', 'detached-singleton-task-window', 'memory-entry-delete-controls', 'multi-handoffs', 'strict-line-start-mentions', 'left-aligned-mention-layout', 'code-block-mention-isolation', 'direct-user-question-display', 'multi-turn-task-queue', 'direct-handoff-priority', 'deferred-pm-handoff', 'timeout-detection', 'immediate-pm-timeout-recovery', 'stepwise-timeout-review', 'persistent-conversation-checkpoint', 'interrupted-agent-checkpoint', 'resume-without-restarting-pm', 'short-agent-activity', 'pm-final-review-rules', 'pause-resume-user-handoff', 'persistent-task-graph', 'initial-pm-plan-protocol', 'upfront-plan-materialization', 'planned-future-gating', 'sequential-plan-selection-guard', 'agent-role-pool-distribution', 'delegation-tree-hierarchy', 'dependency-cross-links', 'multi-result-review-placement', 'legacy-graph-tree-migration', 'agent-subtask-branching', 'graph-dependencies', 'parallel-selection-validation', 'parallel-batch-execution', 'parallel-file-conflict-guard', 'pm-task-approval', 'project-artifact-protocol', 'nested-markdown-artifact-fences', 'project-review-evidence', 'rephrased-file-task-loop-guard', 'persistent-loop-guard', 'safe-project-writes', 'project-completion-signal', 'task-capsules', 'isolated-sessions', 'shared-local-memory', 'shared-json-file-memory', 'versioned-memory-file', 'legacy-memory-file-migration', 'mcp-global-group-merge', 'mcp-official-excalidraw-preset', 'mcp-direct-chat-global-access', 'mcp-tool-permission-gate', 'mcp-global-tool-catalog', 'mcp-global-tool-policy', 'mcp-unknown-tool-asks', 'full-screen-settings', 'mcp-persistent-chat-grants', 'mcp-once-grant-consumed-on-invocation', 'mcp-timeout-keeps-pending-once-grant', 'mcp-permission-wording-recovery', 'mcp-neutral-json-planner', 'mcp-ui-result-short-circuit', 'mcp-denied-tool-path', 'mcp-app-tool-filtering', 'excalidraw-inline-preview', 'mcp-call-protocol', 'mcp-provider-neutral-tool-loop', 'mcp-stdio-integration', 'codex-progress-events', 'codex-cancel-routing', 'codex-status'],
  codex: codexStatus,
  claude: claudeStatus,
}, null, 2));
