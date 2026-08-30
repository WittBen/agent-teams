const MCP_PRESET_VERSION = 3;

const OFFICIAL_EXCALIDRAW_MCP_SERVER = Object.freeze({
  id: 'mcp-official-excalidraw',
  name: 'Excalidraw',
  enabled: false,
  transport: 'http',
  url: 'https://mcp.excalidraw.com',
  headers: {},
  source: 'official-preset',
});
const OFFICIAL_PERPLEXITY_MCP_SERVER = Object.freeze({
  id: 'mcp-official-perplexity',
  name: 'Perplexity',
  enabled: false,
  transport: 'http',
  url: 'https://api.perplexity.ai/mcp',
  headers: { Authorization: '' },
  source: 'official-preset',
});

function sameMcpUrl(left, right) {
  return String(left || '').replace(/\/+$/, '') === String(right || '').replace(/\/+$/, '');
}

function applyOfficialMcpPreset(servers, presetVersion = 0) {
  const current = Array.isArray(servers) ? servers : [];
  if (Number(presetVersion) >= MCP_PRESET_VERSION) {
    return { servers: current, presetVersion: MCP_PRESET_VERSION, changed: false };
  }
  const previousVersion = Number(presetVersion) || 0;
  const hasExcalidraw = current.some(server => (
    server?.id === OFFICIAL_EXCALIDRAW_MCP_SERVER.id
      || sameMcpUrl(server?.url, OFFICIAL_EXCALIDRAW_MCP_SERVER.url)
  ));
  let changed = false;
  let next = current;
  const officialPresetIndex = current.findIndex(server => (
    server?.id === OFFICIAL_EXCALIDRAW_MCP_SERVER.id
      || (server?.source === OFFICIAL_EXCALIDRAW_MCP_SERVER.source
        && sameMcpUrl(server?.url, OFFICIAL_EXCALIDRAW_MCP_SERVER.url))
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
  const hasPerplexity = next.some(server => (
    server?.id === OFFICIAL_PERPLEXITY_MCP_SERVER.id
      || sameMcpUrl(server?.url, OFFICIAL_PERPLEXITY_MCP_SERVER.url)
  ));
  if (previousVersion < 3 && !hasPerplexity) {
    next = [...next, { ...OFFICIAL_PERPLEXITY_MCP_SERVER, headers: { ...OFFICIAL_PERPLEXITY_MCP_SERVER.headers } }];
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
  OFFICIAL_PERPLEXITY_MCP_SERVER,
  applyOfficialMcpPreset,
  ensureOfficialMcpPreset,
};
