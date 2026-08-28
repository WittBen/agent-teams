const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  appStateGet: (key) => ipcRenderer.invoke('app-state-get', key),
  appStateSet: (key, value) => ipcRenderer.invoke('app-state-set', key, value),
  appStateDelete: (key) => ipcRenderer.invoke('app-state-delete', key),
  providerCredentialsStatus: () => ipcRenderer.invoke('provider-credentials-status'),
  providerCredentialsUpdate: (updates) => ipcRenderer.invoke('provider-credentials-update', updates),
  deleteConversationData: (chatId, options) => ipcRenderer.invoke('delete-conversation-data', chatId, options),
  externalApiStatus: () => ipcRenderer.invoke('external-api-status'),
  externalApiConfigure: (config) => ipcRenderer.invoke('external-api-configure', config),
  externalApiRegenerateToken: () => ipcRenderer.invoke('external-api-regenerate-token'),
  exportUserData: () => ipcRenderer.invoke('user-data-export'),
  deleteAllUserData: () => ipcRenderer.invoke('user-data-delete-all'),
  openUserDataFolder: () => ipcRenderer.invoke('user-data-open-folder'),
  pickMemoryFile: (params) => ipcRenderer.invoke('pick-memory-file', params),
  memoryFileOperation: (params) => ipcRenderer.invoke('memory-file-operation', params),
  // CLI credential detection
  llmCall: (params) => ipcRenderer.invoke('llm-call', params),
  codexCall: (params) => ipcRenderer.invoke('codex-call', params),
  codexCancel: (requestId) => ipcRenderer.invoke('codex-cancel', requestId),
  onCodexProgress: (listener) => {
    const wrapped = (_, progress) => listener(progress);
    ipcRenderer.on('codex-progress', wrapped);
    return () => ipcRenderer.removeListener('codex-progress', wrapped);
  },
  codexStatus: () => ipcRenderer.invoke('codex-status'),
  codexLogin: () => ipcRenderer.invoke('codex-login'),
  claudeCall: (params) => ipcRenderer.invoke('claude-call', params),
  claudeCancel: (requestId) => ipcRenderer.invoke('claude-cancel', requestId),
  onClaudeProgress: (listener) => {
    const wrapped = (_, progress) => listener(progress);
    ipcRenderer.on('claude-progress', wrapped);
    return () => ipcRenderer.removeListener('claude-progress', wrapped);
  },
  claudeStatus: () => ipcRenderer.invoke('claude-status'),
  // Knowledge base + project folder
  kbSearch: (params) => ipcRenderer.invoke('kb-search', params),
  projectWrite: (params) => ipcRenderer.invoke('project-write', params),
  projectList: (params) => ipcRenderer.invoke('project-list', params),
  openFolder: (folderPath) => ipcRenderer.invoke('open-folder', { folderPath }),
  pickFolder: (title) => ipcRenderer.invoke('pick-folder', { title }),
  readClaudeCredentials: () => ipcRenderer.invoke('read-claude-credentials'),
  importOpenAICredentials: () => ipcRenderer.invoke('import-openai-credentials'),
  // Model Context Protocol connections
  mcpListTools: (params) => ipcRenderer.invoke('mcp-list-tools', params),
  mcpCallTool: (params) => ipcRenderer.invoke('mcp-call-tool', params),
  mcpTestServer: (params) => ipcRenderer.invoke('mcp-test-server', params),
  mcpDisconnect: (serverId) => ipcRenderer.invoke('mcp-disconnect', serverId),
  // Chat attachments
  pickChatAttachments: (chatId) => ipcRenderer.invoke('pick-chat-attachments', { chatId }),
  chatAttachmentData: (attachment) => ipcRenderer.invoke('chat-attachment-data', { attachment }),
  openChatAttachment: (attachment) => ipcRenderer.invoke('open-chat-attachment', { attachment }),
  deleteChatAttachment: (attachment) => ipcRenderer.invoke('delete-chat-attachment', { attachment }),
  clearChatAttachments: (chatId) => ipcRenderer.invoke('clear-chat-attachments', { chatId }),
  // Detached task-tree window
  openTaskWindow: (state) => ipcRenderer.invoke('task-window-open', state),
  updateTaskWindow: (state) => ipcRenderer.send('task-window-update', state),
  getTaskWindowState: () => ipcRenderer.invoke('task-window-get-state'),
  closeTaskWindow: () => ipcRenderer.send('task-window-close'),
  sendTaskWindowAction: (action) => ipcRenderer.send('task-window-action', action),
  onTaskWindowState: (listener) => {
    const wrapped = (_, state) => listener(state);
    ipcRenderer.on('task-window-state', wrapped);
    return () => ipcRenderer.removeListener('task-window-state', wrapped);
  },
  onTaskWindowAction: (listener) => {
    const wrapped = (_, action) => listener(action);
    ipcRenderer.on('task-window-action', wrapped);
    return () => ipcRenderer.removeListener('task-window-action', wrapped);
  },
});
