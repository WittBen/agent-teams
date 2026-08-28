const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  Client,
  StreamableHTTPClientTransport,
} = require('@modelcontextprotocol/client');
const {
  StdioClientTransport,
  getDefaultEnvironment,
} = require('@modelcontextprotocol/client/stdio');

const MAX_TOOL_RESULT_CHARS = 24000;
const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;
const ENV_REFERENCE = /^\$env:([A-Z_][A-Z0-9_]*)$/i;

function isSensitiveName(name) {
  return /(?:authorization|api[-_]?key|token|secret|password|credential|cookie)/i.test(String(name || ''));
}

function resolveConfiguredRecord(record, label, secretResolver = null) {
  const resolved = {};
  for (const [key, rawValue] of Object.entries(record || {})) {
    const value = String(rawValue || '');
    const reference = value.match(ENV_REFERENCE);
    if (reference) {
      const environmentValue = process.env[reference[1]];
      if (!environmentValue) throw new Error(`${label} „${key}“ verweist auf eine nicht gesetzte Umgebungsvariable.`);
      resolved[key] = environmentValue;
      continue;
    }
    if (value.startsWith('$secure:')) {
      const secret = secretResolver?.(value);
      if (!secret) throw new Error(`${label} „${key}“ enthält keinen lesbaren geschützten Wert.`);
      resolved[key] = secret;
      continue;
    }
    if (value && isSensitiveName(key)) {
      throw new Error(`${label} „${key}“ darf nicht im Klartext gespeichert werden. Verwende $env:VARIABLENNAME.`);
    }
    resolved[key] = value;
  }
  return resolved;
}

function cleanRecord(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey || '').trim();
    if (!key || /[\r\n]/.test(key)) throw new Error(`${label} enthält einen ungültigen Namen.`);
    const text = String(rawValue ?? '');
    if (/[\r\n]/.test(text) && label === 'HTTP-Header') {
      throw new Error('HTTP-Header dürfen keine Zeilenumbrüche enthalten.');
    }
    result[key] = text;
  }
  return result;
}

function normalizeServer(raw = {}) {
  const id = String(raw.id || '').trim();
  const name = String(raw.name || '').trim();
  const transport = raw.transport === 'http' ? 'http' : 'stdio';
  if (!id) throw new Error('Der MCP-Server hat keine ID.');
  if (!name) throw new Error('Der MCP-Server hat keinen Namen.');

  if (transport === 'http') {
    let url;
    try {
      url = new URL(String(raw.url || '').trim());
    } catch {
      throw new Error(`MCP-Server „${name}“: ungültige URL.`);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`MCP-Server „${name}“: nur HTTP- und HTTPS-URLs sind erlaubt.`);
    }
    const isLoopback = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
    if (url.protocol === 'http:' && !isLoopback) {
      throw new Error(`MCP-Server „${name}“: unverschlüsseltes HTTP ist nur für lokale Loopback-Server erlaubt.`);
    }
    return {
      id, name, transport, url: url.toString(),
      headers: cleanRecord(raw.headers, 'HTTP-Header'),
    };
  }

  const command = String(raw.command || '').trim();
  if (!command || /[\0\r\n]/.test(command)) throw new Error(`MCP-Server „${name}“: kein gültiger Befehl eingetragen.`);
  const args = Array.isArray(raw.args) ? raw.args.map(value => String(value)).slice(0, 100) : [];
  if (args.some(value => /\0/.test(value) || value.length > 10_000)) {
    throw new Error(`MCP-Server „${name}“: ungültiges Befehlsargument.`);
  }
  const cwd = String(raw.cwd || '').trim();
  if (cwd && (!path.isAbsolute(cwd) || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())) {
    throw new Error(`MCP-Server „${name}“: Arbeitsordner ist ungültig oder nicht vorhanden.`);
  }
  return {
    id, name, transport, command,
    args,
    cwd,
    env: cleanRecord(raw.env, 'Umgebungsvariable'),
  };
}

function configFingerprint(server) {
  return crypto.createHash('sha256').update(JSON.stringify(server)).digest('hex');
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} hat nach ${Math.ceil(ms / 1000)}s nicht geantwortet.`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function resultText(result) {
  const parts = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === 'text') parts.push(String(item.text || ''));
    else if (item?.type === 'resource' && item.resource?.text) parts.push(String(item.resource.text));
    else if (item?.type === 'image' || item?.type === 'audio') {
      parts.push(`[${item.type}: ${item.mimeType || 'Binärdaten'}]`);
    } else {
      try { parts.push(JSON.stringify(item)); } catch { parts.push('[Nicht serialisierbarer MCP-Inhalt]'); }
    }
  }
  if (result?.structuredContent !== undefined) {
    try { parts.push(JSON.stringify(result.structuredContent)); } catch {}
  }
  const text = parts.join('\n').trim() || '(Leeres MCP-Ergebnis)';
  return text.length > MAX_TOOL_RESULT_CHARS
    ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n[Ergebnis gekürzt]`
    : text;
}

class McpManager {
  constructor({ connectionTimeoutMs = 15000, requestTimeoutMs = 30000, secretResolver = null } = {}) {
    this.connections = new Map();
    this.connectionTimeoutMs = connectionTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.secretResolver = secretResolver;
  }

  async createConnection(server) {
    const client = new Client(
      { name: 'agent-teams', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    const transport = server.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: resolveConfiguredRecord(server.headers, 'HTTP-Header', this.secretResolver) },
      })
      : new StdioClientTransport({
        command: server.command,
        args: server.args,
        ...(server.cwd ? { cwd: server.cwd } : {}),
        env: { ...getDefaultEnvironment(), ...resolveConfiguredRecord(server.env, 'Umgebungsvariable', this.secretResolver) },
      });

    try {
      await withTimeout(client.connect(transport), this.connectionTimeoutMs, `MCP-Verbindung zu „${server.name}“`);
      return { client, transport, server };
    } catch (error) {
      try { await client.close(); } catch {}
      throw error;
    }
  }

  async getConnection(rawServer) {
    const server = normalizeServer(rawServer);
    const fingerprint = configFingerprint(server);
    const existing = this.connections.get(server.id);
    if (existing?.fingerprint === fingerprint) return existing.promise;
    if (existing) {
      this.connections.delete(server.id);
      existing.promise.then(connection => connection.client.close()).catch(() => {});
    }

    const promise = this.createConnection(server);
    this.connections.set(server.id, { fingerprint, promise });
    try {
      return await promise;
    } catch (error) {
      if (this.connections.get(server.id)?.promise === promise) this.connections.delete(server.id);
      throw error;
    }
  }

  async listServerTools(rawServer) {
    const connection = await this.getConnection(rawServer);
    const result = await withTimeout(
      connection.client.listTools(),
      this.requestTimeoutMs,
      `Werkzeugliste von „${connection.server.name}“`,
    );
    return (result.tools || []).map(tool => ({
      serverId: connection.server.id,
      serverName: connection.server.name,
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema || { type: 'object' },
      annotations: tool.annotations || {},
      _meta: tool._meta || {},
    }));
  }

  async listTools(rawServers = []) {
    const servers = Array.isArray(rawServers) ? rawServers.filter(server => server?.enabled !== false) : [];
    const settled = await Promise.all(servers.map(async server => {
      try {
        return { tools: await this.listServerTools(server), error: null };
      } catch (error) {
        return {
          tools: [],
          error: { serverId: server?.id || '', serverName: server?.name || 'MCP', message: error.message },
        };
      }
    }));
    return {
      tools: settled.flatMap(item => item.tools),
      errors: settled.map(item => item.error).filter(Boolean),
    };
  }

  async callTool(rawServer, name, args = {}) {
    const connection = await this.getConnection(rawServer);
    const toolName = String(name || '').trim();
    if (!toolName) throw new Error('Kein MCP-Werkzeug angegeben.');
    const listed = await this.listServerTools(rawServer);
    if (!listed.some(tool => tool.name === toolName)) {
      throw new Error(`MCP-Werkzeug „${toolName}“ ist auf „${connection.server.name}“ nicht verfügbar.`);
    }
    let serializedArguments;
    try { serializedArguments = JSON.stringify(args); }
    catch { throw new Error('MCP-Argumente sind nicht serialisierbar.'); }
    if (Buffer.byteLength(serializedArguments) > MAX_TOOL_ARGUMENT_BYTES) {
      throw new Error('MCP-Argumente sind größer als 1 MB.');
    }
    const result = await withTimeout(
      connection.client.callTool({
        name: toolName,
        arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
      }),
      this.requestTimeoutMs,
      `MCP-Werkzeug „${toolName}“`,
    );
    return {
      serverId: connection.server.id,
      serverName: connection.server.name,
      name: toolName,
      isError: !!result.isError,
      text: resultText(result),
      content: Array.isArray(result.content) ? result.content : [],
      structuredContent: result.structuredContent,
      _meta: result._meta || {},
    };
  }

  async testServer(rawServer) {
    try {
      const tools = await this.listServerTools(rawServer);
      return { ok: true, toolCount: tools.length, tools: tools.map(tool => tool.name) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async disconnect(serverId) {
    const id = String(serverId || '');
    const entry = this.connections.get(id);
    if (!entry) return { ok: true };
    this.connections.delete(id);
    try {
      const connection = await entry.promise;
      await connection.client.close();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async closeAll() {
    const ids = [...this.connections.keys()];
    await Promise.all(ids.map(id => this.disconnect(id)));
  }
}

module.exports = {
  McpManager,
  configFingerprint,
  normalizeServer,
  resolveConfiguredRecord,
  resultText,
};
