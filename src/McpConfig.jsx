import React, { useState } from 'react';
import {
  MCP_TOOL_PERMISSION_DECISIONS,
  createMcpToolCatalog,
  createMcpServer,
  formatKeyValueLines,
  normalizeMcpToolPermissions,
  parseKeyValueLines,
} from './mcp';
import { useI18n } from './i18n';

function updateServer(servers, id, updates) {
  return servers.map(server => server.id === id ? { ...server, ...updates } : server);
}

function ServerEditor({ server, onChange }) {
  const { t } = useI18n();
  const isOfficialPerplexity = server.id === 'mcp-official-perplexity';
  const [argsText, setArgsText] = useState((server.args || []).join('\n'));
  const [envText, setEnvText] = useState(formatKeyValueLines(server.env));
  const [headersText, setHeadersText] = useState(formatKeyValueLines(server.headers));
  return (
    <div className="mcp-editor">
      <div className="mcp-grid">
        <div className="form-group">
          <label className="form-label">{t('Name')}</label>
          <input className="form-input" value={server.name} onChange={event => onChange({ name: event.target.value })} placeholder="Filesystem" />
        </div>
        <div className="form-group">
          <label className="form-label">{t('Transport')}</label>
          <select className="form-select" value={server.transport} onChange={event => onChange({ transport: event.target.value })}>
            <option value="stdio">stdio ({t('lokaler Prozess')})</option>
            <option value="http">Streamable HTTP</option>
          </select>
        </div>
      </div>

      {server.transport === 'http' ? (
        <>
          <div className="form-group">
            <label className="form-label">MCP URL</label>
            <input className="form-input" value={server.url} onChange={event => onChange({ url: event.target.value })} placeholder="https://example.com/mcp" />
          </div>
          {isOfficialPerplexity && (
            <div className="mcp-help mcp-preset-help">
              {t('Perplexity benötigt einen API-Schlüssel. Trage unten „Authorization=Bearer DEIN_API_KEY“ ein. Der Schlüssel wird beim Speichern geschützt.')} {' '}
              <a href="https://console.perplexity.ai" target="_blank" rel="noreferrer">{t('API-Schlüssel öffnen')}</a>
            </div>
          )}
          <div className="form-group">
            <label className="form-label">{t('HTTP-Header (KEY=VALUE, eine Zeile je Eintrag)')}</label>
            <textarea className="form-textarea mcp-code-input" rows={3} value={headersText}
              onChange={event => {
                setHeadersText(event.target.value);
                onChange({ headers: parseKeyValueLines(event.target.value) });
              }}
              placeholder="Authorization=$env:MCP_AUTHORIZATION" />
            <div className="mcp-warning">{t('Sensible Werte werden beim Speichern mit dem Betriebssystem-Schlüsselspeicher geschützt. Für portable Konfigurationen kannst du $env:VARIABLENNAME verwenden.')}</div>
          </div>
        </>
      ) : (
        <>
          <div className="form-group">
            <label className="form-label">{t('Befehl')}</label>
            <input className="form-input" value={server.command} onChange={event => onChange({ command: event.target.value })} placeholder="npx" />
          </div>
          <div className="form-group">
            <label className="form-label">{t('Argumente (eines pro Zeile)')}</label>
            <textarea className="form-textarea mcp-code-input" rows={3} value={argsText}
              onChange={event => {
                setArgsText(event.target.value);
                onChange({ args: event.target.value.split(/\r?\n/).filter(value => value.length > 0) });
              }}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Projekte'} />
          </div>
          <div className="form-group">
            <label className="form-label">{t('Arbeitsordner (optional)')}</label>
            <input className="form-input" value={server.cwd || ''} onChange={event => onChange({ cwd: event.target.value })} placeholder="C:\\Projekte" />
          </div>
          <div className="form-group">
            <label className="form-label">{t('Umgebungsvariablen (KEY=VALUE, eine Zeile je Eintrag)')}</label>
            <textarea className="form-textarea mcp-code-input" rows={3} value={envText}
              onChange={event => {
                setEnvText(event.target.value);
                onChange({ env: parseKeyValueLines(event.target.value) });
              }}
              placeholder="API_TOKEN=$env:MCP_API_TOKEN" />
          </div>
          <div className="mcp-warning">{t('Beim Verbinden startet die App diesen lokalen Befehl. Füge nur MCP-Server hinzu, denen du vertraust.')}</div>
        </>
      )}
    </div>
  );
}

function ToolPermissionEditor({ server, onChange }) {
  const { t } = useI18n();
  const catalog = Array.isArray(server.toolCatalog) ? server.toolCatalog : [];
  const permissions = normalizeMcpToolPermissions(server.toolPermissions);

  if (!catalog.length) {
    return (
      <div className="mcp-permission-empty">
        {t('Lade zuerst die Werkzeugliste. Neue oder noch unbekannte Werkzeuge fragen weiterhin nach deiner Erlaubnis.')}
      </div>
    );
  }

  const updateTool = (toolName, decision) => {
    onChange({ toolPermissions: { ...permissions, [toolName]: decision } });
  };

  const setCatalogPermissions = (resolveDecision) => {
    const updated = { ...permissions };
    for (const tool of catalog) updated[tool.name] = resolveDecision(tool);
    onChange({ toolPermissions: updated });
  };

  const riskLabel = {
    'read-only': t('Nur Lesen'),
    write: t('Schreibzugriff'),
    external: t('Externer Zugriff'),
    destructive: t('Löschend'),
  };

  return (
    <div className="mcp-permissions">
      <div className="mcp-permissions-head">
        <div>
          <strong>{t('Werkzeugrechte')}</strong>
          <span>{t('Nicht freigegebene und neue Werkzeuge fragen vor der Verwendung nach.')}</span>
        </div>
        <div className="mcp-permission-bulk">
          <button type="button" className="btn btn-secondary" onClick={() => setCatalogPermissions(() => MCP_TOOL_PERMISSION_DECISIONS.ALLOW)}>
            {t('Alle gefundenen erlauben')}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setCatalogPermissions(tool => (
            tool.risk === 'read-only' ? MCP_TOOL_PERMISSION_DECISIONS.ALLOW : MCP_TOOL_PERMISSION_DECISIONS.ASK
          ))}>
            {t('Nur lesende erlauben')}
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => setCatalogPermissions(() => MCP_TOOL_PERMISSION_DECISIONS.ASK)}>
            {t('Alle wieder nachfragen')}
          </button>
        </div>
      </div>
      <div className="mcp-tool-list">
        {catalog.map(tool => (
          <div className="mcp-tool-row" key={tool.name}>
            <div className="mcp-tool-info">
              <div>
                <code>{tool.name}</code>
                <span className={`mcp-risk mcp-risk-${tool.risk}`}>{riskLabel[tool.risk] || tool.risk}</span>
              </div>
              {tool.description && <p>{tool.description}</p>}
            </div>
            <select
              className="form-select mcp-tool-decision"
              value={permissions[tool.name] || MCP_TOOL_PERMISSION_DECISIONS.ASK}
              onChange={event => updateTool(tool.name, event.target.value)}
              aria-label={t('Berechtigung für {tool}', { tool: tool.name })}
            >
              <option value={MCP_TOOL_PERMISSION_DECISIONS.ALLOW}>{t('Erlauben')}</option>
              <option value={MCP_TOOL_PERMISSION_DECISIONS.ASK}>{t('Nachfragen')}</option>
              <option value={MCP_TOOL_PERMISSION_DECISIONS.DENY}>{t('Blockieren')}</option>
            </select>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function McpServerList({ servers, onChange, inheritedServers = [], compact = false }) {
  const { t } = useI18n();
  const [editingId, setEditingId] = useState(null);
  const [testStates, setTestStates] = useState({});

  const changeServer = (server, updates) => {
    const connectionFields = ['transport', 'url', 'headers', 'command', 'args', 'cwd', 'env'];
    const connectionChanged = connectionFields.some(field => (
      Object.hasOwn(updates, field) && JSON.stringify(updates[field]) !== JSON.stringify(server[field])
    ));
    onChange(updateServer(servers, server.id, connectionChanged
      ? { ...updates, toolCatalog: [], toolPermissions: {} }
      : updates));
  };

  const addServer = () => {
    const server = createMcpServer();
    onChange([...servers, server]);
    setEditingId(server.id);
  };

  const removeServer = (server) => {
    onChange(servers.filter(candidate => candidate.id !== server.id));
    window.electronAPI?.mcpDisconnect?.(server.id);
  };

  const testServer = async (server) => {
    setTestStates(previous => ({ ...previous, [server.id]: { loading: true } }));
    if (!window.electronAPI?.mcpListTools) {
      setTestStates(previous => ({ ...previous, [server.id]: { error: t('Nur in der Electron-App verfügbar.') } }));
      return;
    }
    const result = await window.electronAPI.mcpListTools({ servers: [{ ...server, enabled: true }] });
    const error = result?.errors?.find(item => item.serverId === server.id) || result?.errors?.[0];
    if (error) {
      setTestStates(previous => ({ ...previous, [server.id]: { error: error.message || t('Verbindung fehlgeschlagen.') } }));
      return;
    }
    const tools = (result?.tools || []).filter(tool => tool.serverId === server.id);
    const toolCatalog = createMcpToolCatalog(tools);
    const previousPermissions = normalizeMcpToolPermissions(server.toolPermissions);
    const previousCatalog = new Map((server.toolCatalog || []).map(tool => [tool.name, tool]));
    const toolPermissions = Object.fromEntries(toolCatalog.map(tool => [
      tool.name,
      previousCatalog.get(tool.name)?.signature === tool.signature
        ? previousPermissions[tool.name] || MCP_TOOL_PERMISSION_DECISIONS.ASK
        : MCP_TOOL_PERMISSION_DECISIONS.ASK,
    ]));
    onChange(updateServer(servers, server.id, { toolCatalog, toolPermissions }));
    setTestStates(previous => ({ ...previous, [server.id]: {
      ok: true,
      toolCount: toolCatalog.length,
      tools: toolCatalog.map(tool => tool.name),
    } }));
  };

  return (
    <div className={compact ? 'mcp-list compact' : 'mcp-list'}>
      {inheritedServers.length > 0 && (
        <div className="mcp-inherited">
          <div className="form-label">{t('Global verfügbar')}</div>
          <div className="mcp-badges">
            {inheritedServers.filter(server => server.enabled !== false).map(server => (
              <span key={server.id} className="mcp-badge">🌐 {server.name || t('Unbenannter MCP-Server')}</span>
            ))}
          </div>
          <div className="mcp-help">{t('Aktive globale MCP-Server werden automatisch von dieser Gruppe verwendet.')}</div>
        </div>
      )}

      {servers.map(server => {
        const test = testStates[server.id];
        const isEditing = editingId === server.id;
        return (
          <div className="mcp-server-card" key={server.id}>
            <div className="mcp-server-head">
              <button type="button" className={`toggle-switch ${server.enabled !== false ? 'on' : ''}`}
                aria-label={t('MCP-Server aktivieren')}
                onClick={() => changeServer(server, { enabled: server.enabled === false })}>
                <span className="toggle-knob" />
              </button>
              <div className="mcp-server-summary">
                <strong>
                  {server.name || t('Unbenannter MCP-Server')}
                  {server.source === 'official-preset' && <span className="mcp-official-label">✓ {t('Offiziell')}</span>}
                </strong>
                <span>{server.transport === 'http' ? 'HTTP' : 'stdio'} · {server.transport === 'http' ? (server.url || t('nicht konfiguriert')) : (server.command || t('nicht konfiguriert'))}</span>
              </div>
              <button type="button" className="icon-btn" title={t('Bearbeiten')} onClick={() => setEditingId(isEditing ? null : server.id)}>✏️</button>
              <button type="button" className="icon-btn" title={t('Entfernen')} onClick={() => removeServer(server)}>🗑️</button>
            </div>
            {isEditing && <ServerEditor server={server} onChange={updates => changeServer(server, updates)} />}
            <div className="mcp-test-row">
              <button type="button" className="btn btn-secondary" onClick={() => testServer(server)} disabled={test?.loading}>
                {test?.loading ? t('Werkzeuge werden geladen…') : t('Verbindung testen und Werkzeuge laden')}
              </button>
              {test?.ok && <span className="mcp-test-ok">✓ {t('{count} Werkzeuge gefunden', { count: test.toolCount })}</span>}
              {test?.error && <span className="mcp-test-error">{test.error}</span>}
            </div>
            <ToolPermissionEditor server={server} onChange={updates => changeServer(server, updates)} />
          </div>
        );
      })}

      {!servers.length && <div className="mcp-empty">{t('Noch keine MCP-Server hinzugefügt.')}</div>}
      <button type="button" className="btn btn-secondary mcp-add" onClick={addServer}>+ {t('MCP-Server hinzufügen')}</button>
    </div>
  );
}
