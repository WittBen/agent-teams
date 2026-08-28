const MCP_PRESET_VERSION = 2;

const OFFICIAL_EXCALIDRAW_MCP_SERVER = Object.freeze({
  id: 'mcp-official-excalidraw',
  name: 'Excalidraw',
  enabled: false,
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
  const previousVersion = Number(presetVersion) || 0;
  const officialUrl = OFFICIAL_EXCALIDRAW_MCP_SERVER.url.replace(/\/+$/, '');
  const hasExcalidraw = current.some(server => (
    server?.id === OFFICIAL_EXCALIDRAW_MCP_SERVER.id
    || String(server?.url || '').replace(/\/+$/, '') === officialUrl
  ));
  let changed = false;
  let next = current;
  const officialPresetIndex = current.findIndex(server => (
    server?.id === OFFICIAL_EXCALIDRAW_MCP_SERVER.id
    || server?.source === OFFICIAL_EXCALIDRAW_MCP_SERVER.source
  ));
  if (officialPresetIndex >= 0 && current[officialPresetIndex]?.enabled !== false) {
    next = current.map((server, index) => index === officialPresetIndex
      ? { ...server, enabled: false }
      : server);
    changed = true;
  } else if (previousVersion < 1 && !hasExcalidraw) {
    next = [...current, { ...OFFICIAL_EXCALIDRAW_MCP_SERVER }];
    changed = true;
  }
  return {
    servers: next,
    presetVersion: MCP_PRESET_VERSION,
    changed,
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
