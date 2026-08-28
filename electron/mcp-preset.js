const MCP_PRESET_VERSION = 1;

const OFFICIAL_EXCALIDRAW_MCP_SERVER = Object.freeze({
  id: 'mcp-official-excalidraw',
  name: 'Excalidraw',
  enabled: true,
  transport: 'http',
  url: 'https://mcp.excalidraw.com',
  headers: {},
  source: 'official-preset',
});

function applyOfficialMcpPreset(servers, presetVersion = 0) {
  const current = Array.isArray(servers) ? servers : [];
  if (Number(presetVersion) >= MCP_PRESET_VERSION) {
    return { servers: current, presetVersion: MCP_PRESET_VERSION, changed: false };
  }
  const officialUrl = OFFICIAL_EXCALIDRAW_MCP_SERVER.url.replace(/\/+$/, '');
  const hasExcalidraw = current.some(server => (
    server?.id === OFFICIAL_EXCALIDRAW_MCP_SERVER.id
    || String(server?.url || '').replace(/\/+$/, '') === officialUrl
  ));
  return {
    servers: hasExcalidraw ? current : [...current, { ...OFFICIAL_EXCALIDRAW_MCP_SERVER }],
    presetVersion: MCP_PRESET_VERSION,
    changed: !hasExcalidraw,
  };
}

function ensureOfficialMcpPreset(store) {
  const previousVersion = Number(store.get('mcpPresetVersion') || 0);
  const state = applyOfficialMcpPreset(store.get('mcpServers') || [], previousVersion);
  if (state.changed) store.set('mcpServers', state.servers);
  if (previousVersion !== state.presetVersion) store.set('mcpPresetVersion', state.presetVersion);
  return state;
}

module.exports = {
  MCP_PRESET_VERSION,
  OFFICIAL_EXCALIDRAW_MCP_SERVER,
  applyOfficialMcpPreset,
  ensureOfficialMcpPreset,
};
