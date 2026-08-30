/**
 * Agent Teams — optional external REST API server.
 * Allows external tools to control agent teams and trigger conversations.
 * Runs on http://localhost:3001
 *
 * Endpoints:
 *   GET  /api/status          — health check + agent/group list
 *   GET  /api/agents          — list all agents
 *   GET  /api/groups          — list all groups
 *   POST /api/groups          — create a new group
 *   DELETE /api/groups/:id    — delete a group
 *   POST /api/chat/send       — send a message to a group/agent and get responses
 *   GET  /api/chat/:chatId    — get message history for a chat
 *   DELETE /api/chat/:chatId  — clear message history
 *
 * POST /api/chat/send body:
 *   { "chatId": "group-dev-team", "message": "...", "waitForAll": true }
 * Returns:
 *   { "responses": [{ "agentName": "Max", "text": "...", "model": "..." }] }
 */

const http = require('http');
const crypto = require('crypto');
const { callLLMDirect } = require('./llm-main');
const { getCodexStatus } = require('./codex-main');

class AgentAPIServer {
  constructor({ store, credentialStore, port = 3001, allowedOrigins = [], onDeleteConversation = null, onError = null }) {
    this.store = store;
    this.credentialStore = credentialStore;
    this.server = null;
    this.port = Number(port) === 0
      ? 0
      : Number.isInteger(Number(port)) ? Math.min(65535, Math.max(1024, Number(port))) : 3001;
    this.allowedOrigins = new Set((allowedOrigins || []).filter(origin => /^https?:\/\//i.test(origin)));
    this.onDeleteConversation = onDeleteConversation;
    this.onError = onError;
    this.maxBodyBytes = 1024 * 1024;
    this.requestWindows = new Map();
  }

  start() {
    if (this.server) return;
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch(err => {
        const status = Number(err?.statusCode) || 500;
        this.json(req, res, status, { error: status >= 500 ? 'Internal server error' : err.message });
      });
    });
    this.server.listen(this.port, '127.0.0.1', () => {
      console.log(`[API] Agent Teams API running on http://127.0.0.1:${this.port}`);
    });
    this.server.on('error', (e) => {
      console.error('[API] Server failed:', e.code || e.message);
      this.onError?.(e);
      this.stop();
    });
  }

  stop() {
    if (this.server?.listening) this.server.close();
    this.server = null;
  }

  json(req, res, status, data) {
    const body = JSON.stringify(data, null, 2);
    const headers = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Agent-Teams-Token',
      'Content-Length': Buffer.byteLength(body),
    };
    const origin = String(req?.headers?.origin || '');
    if (origin && this.allowedOrigins.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
    }
    res.writeHead(status, headers);
    res.end(body);
  }

  async readBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > this.maxBodyBytes) {
          const error = new Error('Request body too large');
          error.statusCode = 413;
          reject(error);
          req.destroy();
          return;
        }
        data += chunk;
      });
      req.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); }
        catch {
          const error = new Error('Invalid JSON body');
          error.statusCode = 400;
          reject(error);
        }
      });
      req.on('error', reject);
    });
  }

  isAllowedOrigin(req) {
    const origin = String(req.headers.origin || '');
    return !origin || this.allowedOrigins.has(origin);
  }

  isAuthenticated(req) {
    const expected = this.credentialStore?.getExternalApiToken() || '';
    const authorization = String(req.headers.authorization || '');
    const provided = authorization.toLowerCase().startsWith('bearer ')
      ? authorization.slice(7).trim()
      : String(req.headers['x-agent-teams-token'] || '').trim();
    if (!expected || !provided) return false;
    const expectedBuffer = Buffer.from(expected);
    const providedBuffer = Buffer.from(provided);
    return expectedBuffer.length === providedBuffer.length && crypto.timingSafeEqual(expectedBuffer, providedBuffer);
  }

  exceedsRateLimit(req) {
    const now = Date.now();
    const key = req.socket.remoteAddress || 'local';
    const current = this.requestWindows.get(key);
    if (!current || now - current.startedAt >= 60_000) {
      this.requestWindows.set(key, { startedAt: now, count: 1 });
      return false;
    }
    current.count += 1;
    return current.count > 60;
  }

  getAgents() { return this.store.get('agents') || []; }
  getGroups() { return this.store.get('groups') || []; }
  getMessages(chatId) { return (this.store.get('messages') || {})[chatId] || []; }
  addMessage(chatId, msg) {
    const all = this.store.get('messages') || {};
    all[chatId] = [...(all[chatId] || []), msg];
    this.store.set('messages', all);
  }
  getApiKeys() {
    const settings = this.credentialStore?.getProviderSettings?.() || {};
    return {
      openai: this.credentialStore?.getSecret?.('openai') || '',
      anthropic: this.credentialStore?.getSecret?.('anthropic') || '',
      ...settings,
    };
  }
  getProviderConnections() { return this.store.get('providerConnections') || []; }
  getProviderSecrets() {
    return Object.fromEntries(this.getProviderConnections().map(provider => [
      provider.id,
      this.credentialStore?.getProviderSecret?.(provider.id) || '',
    ]));
  }

  async handleRequest(req, res) {
    const url = new URL(req.url, `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    if (!this.isAllowedOrigin(req)) return this.json(req, res, 403, { error: 'Origin not allowed' });
    if (this.exceedsRateLimit(req)) return this.json(req, res, 429, { error: 'Rate limit exceeded' });
    if (req.method === 'OPTIONS') return this.json(req, res, 204, {});
    if (!this.isAuthenticated(req)) return this.json(req, res, 401, { error: 'Authentication required' });

    // GET /api/status
    if (req.method === 'GET' && path === '/api/status') {
      const agents = this.getAgents();
      const groups = this.getGroups();
      const apiKeys = this.getApiKeys();
      const providerConnections = this.getProviderConnections();
      const providerSecrets = this.getProviderSecrets();
      const codex = await getCodexStatus();
      return this.json(req, res, 200, {
        status: 'ok',
        version: '1.0.0',
        agents: agents.length,
        groups: groups.length,
        providers: {
          anthropic: !!(apiKeys.claudeCli || apiKeys.claudeOAuthToken || apiKeys.anthropic),
          openai: !!(apiKeys.openai || process.env.OPENAI_API_KEY),
          codex: apiKeys.codexCli !== false && codex.connected,
          ...Object.fromEntries(providerConnections.map(provider => [
            provider.id,
            provider.requiresApiKey === false || Boolean(providerSecrets[provider.id]),
          ])),
        },
        endpoints: [
          'GET /api/status', 'GET /api/agents', 'GET /api/groups',
          'POST /api/groups', 'DELETE /api/groups/:id',
          'POST /api/chat/send', 'GET /api/chat/:chatId', 'DELETE /api/chat/:chatId',
        ],
      });
    }

    // GET /api/agents
    if (req.method === 'GET' && path === '/api/agents') {
      return this.json(req, res, 200, this.getAgents().map(a => ({
        id: a.id, name: a.name, emoji: a.emoji, role: a.role,
        provider: a.provider, model: a.model,
      })));
    }

    // GET /api/groups
    if (req.method === 'GET' && path === '/api/groups') {
      const agents = this.getAgents();
      return this.json(req, res, 200, this.getGroups().map(g => ({
        id: g.id, name: g.name, emoji: g.emoji,
        agents: (g.agentIds || []).map(id => {
          const a = agents.find(x => x.id === id);
          return a ? { id: a.id, name: a.name, role: a.role } : { id };
        }),
      })));
    }

    // POST /api/groups — create group
    if (req.method === 'POST' && path === '/api/groups') {
      const body = await this.readBody(req);
      if (!body.name || !Array.isArray(body.agentIds) || body.agentIds.length === 0) {
        return this.json(req, res, 400, { error: 'name and agentIds[] required' });
      }
      const name = String(body.name).trim().slice(0, 120);
      const agentIds = body.agentIds.filter(id => typeof id === 'string').slice(0, 50);
      if (!name || agentIds.length === 0) return this.json(req, res, 400, { error: 'Invalid group data' });
      const groups = this.getGroups();
      const newGroup = {
        id: `group-api-${Date.now()}`,
        name, emoji: String(body.emoji || '💬').slice(0, 16),
        agentIds, type: 'group',
        memory: body.memory || {
          enabled: true,
          provider: 'local',
          namespace: name.toLowerCase().replace(/[^a-z0-9äöüß_-]+/gi, '-').replace(/^-+|-+$/g, ''),
        },
      };
      this.store.set('groups', [...groups, newGroup]);
      return this.json(req, res, 201, newGroup);
    }

    // DELETE /api/groups/:id
    const groupDeleteMatch = path.match(/^\/api\/groups\/(.+)$/);
    if (req.method === 'DELETE' && groupDeleteMatch) {
      const id = decodeURIComponent(groupDeleteMatch[1]).slice(0, 200);
      const groups = this.getGroups().filter(g => g.id !== id);
      this.store.set('groups', groups);
      await this.onDeleteConversation?.(id);
      return this.json(req, res, 200, { deleted: id });
    }

    // GET /api/chat/:chatId — get history
    const chatGetMatch = path.match(/^\/api\/chat\/(.+)$/);
    if (req.method === 'GET' && chatGetMatch) {
      const chatId = decodeURIComponent(chatGetMatch[1]).slice(0, 200);
      return this.json(req, res, 200, this.getMessages(chatId));
    }

    // DELETE /api/chat/:chatId — clear history
    if (req.method === 'DELETE' && chatGetMatch) {
      const chatId = decodeURIComponent(chatGetMatch[1]).slice(0, 200);
      const all = this.store.get('messages') || {};
      all[chatId] = [];
      this.store.set('messages', all);
      await this.onDeleteConversation?.(chatId, { keepGroup: true });
      return this.json(req, res, 200, { cleared: chatId });
    }

    // POST /api/chat/send — send message and get responses
    if (req.method === 'POST' && path === '/api/chat/send') {
      const body = await this.readBody(req);
      const chatId = typeof body.chatId === 'string' ? body.chatId.trim().slice(0, 200) : '';
      const message = typeof body.message === 'string' ? body.message.trim().slice(0, 100_000) : '';
      const waitForAll = body.waitForAll !== false;
      const agentIds = Array.isArray(body.agentIds) ? body.agentIds.filter(id => typeof id === 'string').slice(0, 50) : undefined;
      if (!chatId || !message) return this.json(req, res, 400, { error: 'chatId and message required' });

      const groups = this.getGroups();
      const agents = this.getAgents();
      const group = groups.find(g => g.id === chatId);

      // Find agents for this chat
      let targetAgents = [];
      if (group) {
        targetAgents = agents.filter(a => group.agentIds?.includes(a.id));
      } else {
        // Direct chat: chatId is agent id, or filter by agentIds param
        const targetIds = agentIds || [chatId];
        targetAgents = agents.filter(a => targetIds.includes(a.id));
      }
      if (targetAgents.length === 0) return this.json(req, res, 404, { error: 'No agents found for chatId' });

      // Add user message to history
      const userMsg = { id: Date.now(), agentId: 'user', senderName: 'API', text: message, ts: Date.now() };
      this.addMessage(chatId, userMsg);
      let history = this.getMessages(chatId);

      const groupContext = targetAgents.map(a => a.name).join(', ');
      const apiKeys = this.getApiKeys();
      const providerConnections = this.getProviderConnections();
      const providerSecrets = this.getProviderSecrets();
      const responses = [];

      for (const agent of targetAgents) {
        try {
          const text = await callLLMDirect({
            apiKeys, providerConnections, providerSecrets, agent, history,
            userMessage: null, groupContext, projectPath: group?.projectPath || '',
          });
          const agentMsg = { id: Date.now() + Math.random(), agentId: agent.id, senderName: agent.name, text, ts: Date.now() };
          this.addMessage(chatId, agentMsg);
          history = [...history, agentMsg];
          responses.push({ agentId: agent.id, agentName: agent.name, model: agent.model, provider: agent.provider, text });
          if (!waitForAll) break;
        } catch (e) {
          responses.push({ agentId: agent.id, agentName: agent.name, error: e.message });
        }
      }

      return this.json(req, res, 200, { chatId, userMessage: message, responses });
    }

    return this.json(req, res, 404, { error: 'Not found', path });
  }
}

module.exports = { AgentAPIServer };
