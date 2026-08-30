const MAX_MCP_ROUNDS = 6;
const MAX_PERMISSION_RECOVERY_ROUNDS = 2;
const MCP_BLOCK_PATTERN = /\[\[MCP_CALL\]\]([\s\S]*?)\[\[\/MCP_CALL\]\]/gi;
const MCP_PERMISSION_HALLUCINATION_PATTERN = /(?:berechtigungs|freigabe|permission|approval)[\wäöüß-]*\s*(?:dialog|fenster|window|prompt)|(?:klick|click)[\s\S]{0,80}(?:allow|erlauben)|(?:benötige|brauche|bedarf|needs?|requires?)[\s\S]{0,100}(?:berechtigung|freigabe|permission|approval)|(?:bitte\s+)?(?:erlaube|erlauben\s+sie|allow|approve)[\s\S]{0,140}(?:zugriff|access|tool|werkzeug|dialog|fenster)/i;
export const MCP_PRESET_VERSION = 3;
export const MCP_TOOL_PERMISSION_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  ASK: 'ask',
  DENY: 'deny',
});
export const OFFICIAL_EXCALIDRAW_MCP_SERVER = Object.freeze({
  id: 'mcp-official-excalidraw',
  name: 'Excalidraw',
  enabled: false,
  transport: 'http',
  url: 'https://mcp.excalidraw.com',
  headers: {},
  source: 'official-preset',
});
export const OFFICIAL_PERPLEXITY_MCP_SERVER = Object.freeze({
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

export function applyOfficialMcpPresets(servers, presetVersion = 0) {
  const current = Array.isArray(servers) ? servers : [];
  if (Number(presetVersion) >= MCP_PRESET_VERSION) {
    return { servers: current, presetVersion: MCP_PRESET_VERSION, changed: false };
  }
  const previousVersion = Number(presetVersion) || 0;
  const hasExcalidraw = current.some(server => (
    server?.id === OFFICIAL_EXCALIDRAW_MCP_SERVER.id ||
    sameMcpUrl(server?.url, OFFICIAL_EXCALIDRAW_MCP_SERVER.url)
  ));
  let changed = false;
  let next = current;
  const officialPresetIndex = current.findIndex(server => (
    server?.id === OFFICIAL_EXCALIDRAW_MCP_SERVER.id ||
    (server?.source === OFFICIAL_EXCALIDRAW_MCP_SERVER.source
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
    server?.id === OFFICIAL_PERPLEXITY_MCP_SERVER.id ||
    sameMcpUrl(server?.url, OFFICIAL_PERPLEXITY_MCP_SERVER.url)
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

export function createMcpServer() {
  const id = globalThis.crypto?.randomUUID?.()
    || `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    name: '',
    enabled: true,
    transport: 'stdio',
    command: '',
    args: [],
    cwd: '',
    env: {},
    url: '',
    headers: {},
  };
}

export function normalizeMcpServers(servers) {
  if (!Array.isArray(servers)) return [];
  const seen = new Set();
  return servers.filter(server => {
    if (!server?.id || seen.has(server.id)) return false;
    seen.add(server.id);
    return true;
  }).map(server => ({
    id: String(server.id),
    name: String(server.name || '').trim(),
    enabled: server.enabled !== false,
    transport: server.transport === 'http' ? 'http' : 'stdio',
    command: String(server.command || '').trim(),
    args: Array.isArray(server.args) ? server.args.map(String) : [],
    cwd: String(server.cwd || '').trim(),
    env: server.env && typeof server.env === 'object' && !Array.isArray(server.env) ? server.env : {},
    url: String(server.url || '').trim(),
    headers: server.headers && typeof server.headers === 'object' && !Array.isArray(server.headers) ? server.headers : {},
    toolCatalog: normalizeMcpToolCatalog(server.toolCatalog),
    toolPermissions: normalizeMcpToolPermissions(server.toolPermissions),
    ...(server.source ? { source: String(server.source) } : {}),
  }));
}

export function getEffectiveMcpServers(globalServers, groupServers) {
  return normalizeMcpServers([
    ...normalizeMcpServers(globalServers).filter(server => server.enabled),
    ...normalizeMcpServers(groupServers).filter(server => server.enabled),
  ]);
}

export function parseKeyValueLines(text) {
  const record = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    record[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return record;
}

export function formatKeyValueLines(record) {
  if (!record || typeof record !== 'object') return '';
  return Object.entries(record).map(([key, value]) => `${key}=${value}`).join('\n');
}

export function extractMcpCalls(text) {
  const calls = [];
  const errors = [];
  const source = String(text || '');
  let markerCount = 0;
  for (const match of source.matchAll(MCP_BLOCK_PATTERN)) {
    markerCount += 1;
    try {
      const parsed = JSON.parse(match[1].trim());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Objekt erwartet');
      calls.push({
        server: String(parsed.server || '').trim(),
        tool: String(parsed.tool || '').trim(),
        arguments: parsed.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
          ? parsed.arguments
          : {},
      });
    } catch (error) {
      errors.push(`Ungültiger MCP-Aufruf: ${error.message}`);
    }
  }
  if (!markerCount && /\[\[\/?MCP_CALL\]\]/i.test(source)) errors.push('Unvollständiger MCP-Aufruf.');
  return { calls, errors, hasProtocol: markerCount > 0 || errors.length > 0 };
}

export function cleanMcpProtocol(text) {
  return String(text || '')
    .replace(MCP_BLOCK_PATTERN, '')
    .replace(/\[\[\/?MCP_CALL\]\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function isMcpPermissionHallucination(text) {
  return MCP_PERMISSION_HALLUCINATION_PATTERN.test(String(text || ''));
}

export function buildMcpRecoveryHistory(history, tool, schema = '{}') {
  const userContext = (Array.isArray(history) ? history : [])
    .filter(message => message?.agentId === 'user' && String(message.text || '').trim())
    .slice(-6)
    .map(message => String(message.text).trim())
    .join('\n\n')
    .slice(-7000);
  const description = String(tool?.description || '')
    .replace(/\bMCP\b/gi, 'extern')
    .replace(/\btools?\b/gi, 'Operation')
    .replace(/\bWerkzeuge?\b/gi, 'Operation')
    .slice(0, 1800);
  return [{
    id: `mcp-recovery-${Date.now().toString(36)}`,
    agentId: 'user',
    senderName: 'Datenplaner',
    text: `JSON-ARGUMENTOBJEKT\nErzeuge ausschließlich die Eingabedaten für eine bereits ausgewählte externe Operation. Verwende selbst keine Werkzeuge und erwähne weder Freigaben noch Berechtigungen.\n\nBeschreibung der Operation: ${description}\nErwartetes JSON-Schema: ${schema}\n\nRelevante User-Anforderungen:\n${userContext || 'Führe die zuletzt angeforderte Aktion aus.'}\n\nAntworte ausschließlich mit genau einem gültigen JSON-Objekt, das dem Schema entspricht. Kein Markdown, keine Erklärung und kein zusätzlicher Text.`,
    ts: Date.now(),
  }];
}

export function parseMcpArgumentsJson(text) {
  const source = String(text || '').trim();
  const withoutFence = source
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const candidates = [withoutFence];
  const firstBrace = withoutFence.indexOf('{');
  const lastBrace = withoutFence.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(withoutFence.slice(firstBrace, lastBrace + 1));
  }
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const args = parsed?.arguments && typeof parsed.arguments === 'object' && !Array.isArray(parsed.arguments)
        ? parsed.arguments
        : parsed;
      if (!args || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('JSON-Objekt erwartet.');
      }
      return args;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Ungültiges Werkzeug-Argumentobjekt: ${lastError?.message || 'JSON konnte nicht gelesen werden.'}`);
}

function buildCatalog(tools) {
  const serverAliases = new Map();
  const serverIndex = new Map();
  for (const tool of tools) {
    if (!serverAliases.has(tool.serverId)) {
      const alias = `server_${serverAliases.size + 1}`;
      serverAliases.set(tool.serverId, alias);
      serverIndex.set(alias, { id: tool.serverId, name: tool.serverName });
    }
  }
  const listed = tools.map(tool => ({
    ...tool,
    serverAlias: serverAliases.get(tool.serverId),
  }));
  return { tools: listed, serverIndex };
}

export function isModelVisibleMcpTool(tool) {
  const visibility = tool?._meta?.ui?.visibility || tool?._meta?.['ui/visibility'];
  return !Array.isArray(visibility) || visibility.length === 0 || visibility.includes('model');
}

export function classifyMcpToolRisk(tool) {
  const annotations = tool?.annotations || {};
  if (annotations.destructiveHint === true) return 'destructive';
  if (annotations.readOnlyHint === true) return 'read-only';
  if (annotations.openWorldHint === true) return 'external';
  return 'write';
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createMcpToolSignature(tool) {
  const source = stableSerialize({
    name: String(tool?.name || ''),
    description: String(tool?.description || ''),
    inputSchema: tool?.inputSchema || {},
    annotations: tool?.annotations || {},
  });
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function normalizeMcpToolPermissions(permissions) {
  if (!permissions || typeof permissions !== 'object' || Array.isArray(permissions)) return {};
  return Object.fromEntries(Object.entries(permissions).flatMap(([rawName, rawDecision]) => {
    const name = String(rawName || '').trim();
    const decision = String(rawDecision || '').trim();
    if (!name || !Object.values(MCP_TOOL_PERMISSION_DECISIONS).includes(decision)) return [];
    return [[name, decision]];
  }));
}

export function normalizeMcpToolCatalog(catalog) {
  if (!Array.isArray(catalog)) return [];
  const seen = new Set();
  return catalog.flatMap(rawTool => {
    const name = String(rawTool?.name || '').trim();
    if (!name || seen.has(name)) return [];
    seen.add(name);
    const risk = ['read-only', 'write', 'external', 'destructive'].includes(rawTool?.risk)
      ? rawTool.risk
      : classifyMcpToolRisk(rawTool);
    return [{
      name,
      description: String(rawTool?.description || '').trim().slice(0, 1200),
      risk,
      signature: String(rawTool?.signature || '').slice(0, 80),
    }];
  });
}

export function createMcpToolCatalog(tools) {
  return normalizeMcpToolCatalog((Array.isArray(tools) ? tools : []).map(tool => ({
    name: tool?.name,
    description: tool?.description,
    risk: classifyMcpToolRisk(tool),
    signature: createMcpToolSignature(tool),
  })));
}

export function getMcpToolPermissionDecision(server, tool) {
  const toolName = String(tool?.name || tool || '').trim();
  if (!toolName) return MCP_TOOL_PERMISSION_DECISIONS.ASK;
  if (tool && typeof tool === 'object') {
    const catalogTool = normalizeMcpToolCatalog(server?.toolCatalog).find(item => item.name === toolName);
    if (!catalogTool?.signature || catalogTool.signature !== createMcpToolSignature(tool)) {
      return MCP_TOOL_PERMISSION_DECISIONS.ASK;
    }
  }
  return normalizeMcpToolPermissions(server?.toolPermissions)[toolName]
    || MCP_TOOL_PERMISSION_DECISIONS.ASK;
}

export function buildMcpInstructions(tools) {
  if (!tools.length) return '';
  const { tools: catalog } = buildCatalog(tools);
  const rows = catalog.map(tool => {
    const description = String(tool.description || '').slice(0, 600);
    let schema = '{}';
    try { schema = JSON.stringify(tool.inputSchema || {}).slice(0, 3500); } catch {}
    return `- ${tool.serverAlias} (${tool.serverName}) :: ${tool.name}\n  ${description}\n  Eingabe: ${schema}`;
  }).join('\n');
  return `\n\nMCP-WERKZEUGE\nDir stehen die folgenden externen Werkzeuge zur Verfügung. Nutze sie nur, wenn sie für die aktuelle Aufgabe erforderlich sind. Antworte für genau einen Werkzeugaufruf ausschließlich mit diesem Block:\n[[MCP_CALL]]\n{"server":"server_1","tool":"werkzeugname","arguments":{}}\n[[/MCP_CALL]]\nErfinde keine Server oder Werkzeuge. Fordere eine Berechtigung niemals im Fließtext an und kündige keinen Dialog an. Nur der MCP_CALL-Block veranlasst die App, den echten Erlaubnisdialog zu öffnen. Nach dem Ergebnis setzt du die Aufgabe fort.\n${rows}`.slice(0, 32000);
}

function formatToolResults(results, errors) {
  return [
    'MCP-WERKZEUGERGEBNISSE',
    ...results.map(result => `${result.isError ? 'FEHLER' : 'ERFOLG'} ${result.serverName} :: ${result.name}\n${result.text}`),
    ...errors.map(error => `FEHLER\n${error}`),
    'Setze jetzt die zugewiesene Aufgabe mit diesen Ergebnissen fort. Falls ein weiteres MCP-Werkzeug erforderlich ist, gib wieder exakt einen MCP_CALL-Block aus.',
  ].join('\n\n');
}

export async function callLLMWithMcp({
  call,
  callRecovery,
  servers = [],
  history = [],
  agent,
  onActivity,
  onConnectionError,
  onPermissionConsumed,
  onToolResult,
  requestPermission,
}) {
  if (!servers.length || !window.electronAPI?.mcpListTools || !window.electronAPI?.mcpCallTool) {
    return call({ history, extraContext: '' });
  }

  const listed = await window.electronAPI.mcpListTools({ servers });
  for (const error of Array.isArray(listed?.errors) ? listed.errors : []) {
    onConnectionError?.(error);
  }
  const tools = Array.isArray(listed?.tools) ? listed.tools.filter(isModelVisibleMcpTool) : [];
  if (!tools.length) return call({ history, extraContext: '' });

  const catalog = buildCatalog(tools);
  const instructions = buildMcpInstructions(tools);
  const serversById = new Map(servers.map(server => [server.id, server]));
  let loopHistory = [...history];
  let permissionRecoveryRounds = 0;
  let preapprovedToolKey = '';
  let useRecoveryCall = false;
  let recoveryTarget = null;

  for (let round = 0; round < MAX_MCP_ROUNDS; round += 1) {
    const wasRecoveryRequest = useRecoveryCall;
    const invokeModel = wasRecoveryRequest && callRecovery ? callRecovery : call;
    const reply = await invokeModel({ history: loopHistory, extraContext: instructions });
    useRecoveryCall = false;
    let parsed;
    if (wasRecoveryRequest && recoveryTarget) {
      try {
        const recoveredArguments = parseMcpArgumentsJson(reply);
        parsed = {
          calls: [{
            server: recoveryTarget.tool.serverAlias,
            tool: recoveryTarget.tool.name,
            arguments: recoveredArguments,
          }],
          errors: [],
          hasProtocol: true,
        };
        recoveryTarget = null;
      } catch (error) {
        if (permissionRecoveryRounds >= MAX_PERMISSION_RECOVERY_ROUNDS) {
          throw new Error(`Der Datenplaner hat keine gültigen Werkzeugargumente erzeugt: ${error.message}`);
        }
        permissionRecoveryRounds += 1;
        loopHistory = buildMcpRecoveryHistory(history, recoveryTarget.tool, recoveryTarget.schema);
        loopHistory[0].text += '\n\nDer vorige Versuch war kein gültiges JSON-Objekt. Korrigiere ausschließlich das JSON-Format.';
        useRecoveryCall = true;
        continue;
      }
    } else {
      parsed = extractMcpCalls(reply);
    }
    if (!parsed.hasProtocol) {
      if (isMcpPermissionHallucination(reply)) {
        const recoveryTool = catalog.tools.find(candidate => candidate.name === 'create_view') || catalog.tools[0];
        const recoveryServer = recoveryTool ? serversById.get(recoveryTool.serverId) : null;
        if (permissionRecoveryRounds >= MAX_PERMISSION_RECOVERY_ROUNDS || !recoveryTool || !recoveryServer) {
          throw new Error('Der Agent hat trotz erteilter Werkzeugfreigabe keinen ausführbaren MCP-Aufruf erzeugt.');
        }
        permissionRecoveryRounds += 1;
        if (!preapprovedToolKey && requestPermission) {
          const recoveryPermission = await requestPermission({
            agent,
            server: recoveryServer,
            tool: recoveryTool,
            arguments: {},
            pendingArguments: true,
            risk: classifyMcpToolRisk(recoveryTool),
          });
          if (!recoveryPermission?.allowed) {
            return `Der Zugriff auf ${recoveryTool.serverName} :: ${recoveryTool.name} wurde vom User abgelehnt.`;
          }
          preapprovedToolKey = `${recoveryTool.serverId}:${recoveryTool.name}`;
        }
        let recoverySchema = '{}';
        try { recoverySchema = JSON.stringify(recoveryTool.inputSchema || {}).slice(0, 3500); } catch {}
        loopHistory = buildMcpRecoveryHistory(history, recoveryTool, recoverySchema);
        recoveryTarget = { tool: recoveryTool, server: recoveryServer, schema: recoverySchema };
        useRecoveryCall = true;
        continue;
      }
      return reply;
    }

    const results = [];
    const errors = [...parsed.errors];
    let completedResultMessage = '';
    for (const requested of parsed.calls.slice(0, 1)) {
      const serverRef = catalog.serverIndex.get(requested.server);
      const tool = catalog.tools.find(candidate => (
        candidate.serverAlias === requested.server && candidate.name === requested.tool
      ));
      const server = serverRef ? serversById.get(serverRef.id) : null;
      if (!tool || !server) {
        errors.push(`Unbekanntes MCP-Werkzeug: ${requested.server} :: ${requested.tool}`);
        continue;
      }
      const toolKey = `${tool.serverId}:${tool.name}`;
      const permission = preapprovedToolKey === toolKey
        ? { allowed: true, scope: 'recovered-once' }
        : requestPermission
          ? await requestPermission({
          agent,
          server,
          tool,
          arguments: requested.arguments,
          risk: classifyMcpToolRisk(tool),
        })
          : { allowed: false, scope: 'none' };
      if (preapprovedToolKey === toolKey) preapprovedToolKey = '';
      if (!permission?.allowed) {
        errors.push(`Vom User abgelehnt: ${tool.serverName} :: ${tool.name}`);
        continue;
      }
      onActivity?.({ serverName: tool.serverName, toolName: tool.name, phase: 'mcp' });
      try {
        const toolResult = await window.electronAPI.mcpCallTool({
          server,
          name: tool.name,
          arguments: requested.arguments,
        });
        results.push(toolResult);
        const resultMessage = onToolResult?.({
          agent,
          server,
          tool,
          arguments: requested.arguments,
          result: toolResult,
        });
        if (typeof resultMessage === 'string' && resultMessage.trim()) {
          completedResultMessage = resultMessage.trim();
        }
      } catch (error) {
        errors.push(`${tool.serverName} :: ${tool.name}: ${error.message}`);
      } finally {
        onPermissionConsumed?.({ agent, server, tool, permission });
      }
    }

    if (completedResultMessage && results.some(result => !result.isError)) {
      return completedResultMessage;
    }
    if (!results.length && !errors.length) return cleanMcpProtocol(reply);
    loopHistory = [
      ...loopHistory,
      {
        id: `mcp-assistant-${round}`,
        agentId: agent.id,
        senderName: agent.name,
        text: reply,
        ts: Date.now(),
      },
      {
        id: `mcp-result-${round}`,
        agentId: 'user',
        senderName: 'MCP',
        text: formatToolResults(results, errors),
        ts: Date.now(),
      },
    ];
  }

  throw new Error(`MCP-Aufrufslimit (${MAX_MCP_ROUNDS}) erreicht. Der Agent hat wiederholt Werkzeuge angefordert.`);
}
