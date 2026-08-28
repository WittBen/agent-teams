import React, { useState } from 'react';
import { useStore, uuidv4 } from './store';
import { PROVIDER_MODELS } from './llm';
import {
  PROVIDER_PRESETS,
  createProviderConnection,
  getProviderConnection,
  getProviderModels,
  getProviderOptions,
  normalizeProviderConnections,
  parseProviderModels,
} from './provider-catalog';
import { SUPPORTED_LANGUAGES, useI18n } from './i18n';
import McpServerList from './McpConfig';
import { isRoleUsed, normalizeRoleName } from './agent-roles';
import { normalizeConversationLimits } from './conversation-limits';

const EMOJIS = ['🤖', '💡', '⚙️', '🧠', '🎯', '📊', '🔬', '🎨', '📝', '🚀', '💻', '🌍'];
const COLORS = [0, 1, 2, 3, 4, 5, 6, 7];

function AgentModal({ agent, onClose, onSave }) {
  const { t } = useI18n();
  const { agentRoles, providerConnections } = useStore();
  const [name, setName] = useState(agent?.name || '');
  const [emoji, setEmoji] = useState(agent?.emoji || '🤖');
  const [color, setColor] = useState(agent?.color ?? 0);
  const initialRole = agentRoles.find(item => item.id === agent?.roleId)
    || agentRoles.find(item => normalizeRoleName(item.name).toLowerCase() === normalizeRoleName(agent?.role).toLowerCase())
    || agentRoles[0];
  const [roleId, setRoleId] = useState(initialRole?.id || '');
  const [provider, setProvider] = useState(agent?.provider || 'openai');
  const [model, setModel] = useState(agent?.model || 'gpt-4o-mini');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt || '');
  const [qualityMode, setQualityMode] = useState(agent?.qualityRouting?.mode || 'inherit');
  const [qualityProvider, setQualityProvider] = useState(agent?.qualityRouting?.escalationProvider || 'inherit');
  const [qualityModel, setQualityModel] = useState(agent?.qualityRouting?.escalationModel || '');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(agent?.qualityRouting?.acceptanceCriteria || '');
  const providerOptions = getProviderOptions(providerConnections);
  const selectedConnection = getProviderConnection(provider, providerConnections);
  const modelOptions = getProviderModels(provider, providerConnections, PROVIDER_MODELS, model);

  // ESC closes the modal
  React.useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // When provider changes, reset model to first of that provider
  const handleProviderChange = (p) => {
    setProvider(p);
    setModel(getProviderModels(p, providerConnections, PROVIDER_MODELS)[0] || 'model-name');
  };

  const handleQualityProviderChange = (nextProvider) => {
    setQualityProvider(nextProvider);
    const modelProvider = nextProvider === 'same' ? provider : nextProvider;
    setQualityModel(nextProvider === 'inherit' ? '' : (getProviderModels(modelProvider, providerConnections, PROVIDER_MODELS)[0] || ''));
  };

  const handleSave = () => {
    const selectedRole = agentRoles.find(item => item.id === roleId);
    if (!name.trim() || !selectedRole) return;
    onSave({
      name: name.trim(), emoji, color, roleId: selectedRole.id, role: selectedRole.name, provider, model, systemPrompt: systemPrompt.trim(),
      qualityRouting: {
        mode: qualityMode,
        escalationProvider: qualityProvider === 'inherit' ? '' : qualityProvider,
        escalationModel: qualityProvider === 'inherit' ? '' : qualityModel,
        acceptanceCriteria: acceptanceCriteria.trim(),
      },
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-body">
        <div className="modal-title">{agent ? t('Agent bearbeiten') : t('Neuen Agenten erstellen')}</div>

        <div className="form-group">
          <label className="form-label">{t('Name')}</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="z.B. Alex" autoFocus />
        </div>

        <div className="form-group">
          <label className="form-label">{t('Emoji')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {EMOJIS.map(e => (
              <button key={e} type="button" onClick={() => setEmoji(e)}
                aria-label={`${t('Emoji')} ${e}`} aria-pressed={emoji === e}
                style={{
                  width: 36, height: 36, borderRadius: 8,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, cursor: 'pointer',
                  background: emoji === e ? 'rgba(0,168,132,0.2)' : 'var(--bg-tertiary)',
                  border: emoji === e ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'all 0.1s',
                }}
              >{e}</button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('Farbe')}</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {COLORS.map(c => (
              <button key={c} type="button" onClick={() => setColor(c)}
                aria-label={`${t('Farbe')} ${c}`} aria-pressed={color === c}
                className={`color-${c}`}
                style={{
                  width: 28, height: 28, borderRadius: '50%', cursor: 'pointer',
                  border: color === c ? '3px solid white' : '3px solid transparent',
                  transition: 'border 0.1s',
                }}
              />
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('Rolle')}</label>
          <select className="form-select" value={roleId} onChange={e => setRoleId(e.target.value)}>
            {agentRoles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>
            {t('Rollen werden global in den Einstellungen verwaltet.')}
          </div>
        </div>

        {/* Provider + Model */}
        <div style={{ display: 'flex', gap: 12 }}>
          <div className="form-group" style={{ flex: 1 }}>
            <label className="form-label">{t('Anbieter')}</label>
            <select className="form-select" value={provider} onChange={e => handleProviderChange(e.target.value)}>
              {providerOptions.map(option => (
                <option key={option.id} value={option.id}>{option.emoji} {option.id === 'codex' ? t('Codex (lokal)') : option.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ flex: 2 }}>
            <label className="form-label">{t('Modell')}</label>
            <select className="form-select" value={model} onChange={e => setModel(e.target.value)}>
              {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: -8, marginBottom: 12, padding: '6px 10px', background: 'var(--bg-tertiary)', borderRadius: 6 }}>
          {provider === 'codex'
            ? <>🔵 {t('Codex nutzt die lokale Codex-CLI und deren ChatGPT-Anmeldung. Es wird kein API-Key importiert.')}</>
            : provider === 'anthropic'
              ? <>💡 {t('Nutzt wahlweise die lokale Claude-Code-CLI oder einen Anthropic-API-Key aus den Einstellungen.')}</>
              : selectedConnection
                ? <>🔌 {t('Nutzt den in den globalen Einstellungen konfigurierten API-Anbieter „{name}“.', { name: selectedConnection.name })}</>
                : <>💡 {t('Der OpenAI-API-Key wird aus den Einstellungen oder OPENAI_API_KEY gelesen.')}</>}
        </div>

        <div className="form-group">
          <label className="form-label">{t('System-Prompt')}</label>
          <textarea className="form-textarea" rows={5}
            value={systemPrompt}
            onChange={e => setSystemPrompt(e.target.value)}
            placeholder={t('Beschreibe die Persönlichkeit, das Verhalten und den Fokus dieses Agenten...')}
          />
        </div>

        <div className="form-group quality-config-block">
          <label className="form-label">🧠 {t('Quality Cascading')}</label>
          <select className="form-select" value={qualityMode} onChange={event => setQualityMode(event.target.value)}>
            <option value="inherit">{t('Globale/Gruppen-Einstellung übernehmen')}</option>
            <option value="off">{t('Für diesen Agenten deaktivieren')}</option>
            <option value="auto">{t('Automatisch prüfen und bei Bedarf eskalieren')}</option>
            <option value="strong">{t('Immer starke Modellstufe verwenden')}</option>
          </select>
          {qualityMode !== 'off' && (
            <>
              <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label">{t('Eskalations-Anbieter')}</label>
                  <select className="form-select" value={qualityProvider} onChange={event => handleQualityProviderChange(event.target.value)}>
                    <option value="inherit">{t('Globale Einstellung')}</option>
                    <option value="same">{t('Gleicher Anbieter')}</option>
                    {providerOptions.map(option => (
                      <option key={option.id} value={option.id}>{option.name}</option>
                    ))}
                  </select>
                </div>
                {qualityProvider !== 'inherit' && (
                  <div style={{ flex: 1.4 }}>
                    <label className="form-label">{t('Stärkeres Modell')}</label>
                    <select className="form-select" value={qualityModel} onChange={event => setQualityModel(event.target.value)}>
                      <option value="">{t('Automatisch empfehlen')}</option>
                      {getProviderModels(qualityProvider === 'same' ? provider : qualityProvider, providerConnections, PROVIDER_MODELS, qualityModel).map(option => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <label className="form-label" style={{ marginTop: 10 }}>{t('Zusätzliche Akzeptanzkriterien (optional)')}</label>
              <textarea className="form-textarea" rows={3} value={acceptanceCriteria}
                onChange={event => setAcceptanceCriteria(event.target.value)}
                placeholder={t('z.B. Ergebnis muss Quellen nennen oder eine ausführbare Datei enthalten')} />
            </>
          )}
        </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={!name.trim()}>
            {agent ? t('Speichern') : t('Erstellen')}
          </button>
        </div>
      </div>
    </div>
  );
}

function GroupModal({ group, agents, onClose, onSave }) {
  const { language, t } = useI18n();
  const { mcpServers: globalMcpServers, providerConnections } = useStore();
  const [name, setName] = useState(group?.name || '');
  const [emoji, setEmoji] = useState(group?.emoji || '💬');
  const [selectedAgents, setSelectedAgents] = useState(group?.agentIds || []);
  const [projectPath, setProjectPath] = useState(group?.projectPath || '');
  // Memory Space config
  const [memoryMode, setMemoryMode] = useState(group?.memory?.enabled === false ? 'disabled' : group ? 'existing' : 'new');
  const [memoryNamespace, setMemoryNamespace] = useState(group?.memory?.namespace || '');
  const [memoryProvider, setMemoryProvider] = useState(group?.memory?.provider === 'file' ? 'file' : 'local');
  const [memoryFilePath, setMemoryFilePath] = useState(group?.memory?.provider === 'file' ? (group.memory.filePath || '') : '');
  const [memoryFileError, setMemoryFileError] = useState('');
  const [groupMcpServers, setGroupMcpServers] = useState(Array.isArray(group?.mcpServers) ? group.mcpServers : []);
  const [qualityMode, setQualityMode] = useState(group?.qualityRouting?.mode || 'inherit');

  React.useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const GROUP_EMOJIS = ['💬', '🧠', '🚀', '🎯', '⚡', '🌐', '🔧', '📊', '🎨', '🔬'];

  const toggleAgent = (id) => {
    setSelectedAgents(prev => prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]);
  };

  const pickFolder = async () => {
    const result = await window.electronAPI?.pickFolder(t('Projekt-Ordner für diese Gruppe'));
    if (result) setProjectPath(result);
  };

  const pickMemoryFile = async () => {
    setMemoryFileError('');
    if (!window.electronAPI?.pickMemoryFile) {
      setMemoryFileError(t('Die Dateiauswahl ist nur in der Desktop-App verfügbar.'));
      return;
    }
    const namespace = memoryNamespace.trim() || name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!namespace) {
      setMemoryFileError(t('Bitte zuerst einen Gruppennamen oder Namespace eingeben.'));
      return;
    }
    const result = await window.electronAPI.pickMemoryFile({
      mode: memoryMode === 'new' ? 'new' : 'existing',
      currentPath: memoryFilePath,
      defaultName: namespace,
      namespace,
      language,
      newTitle: language === 'en' ? 'Create new shared memory file' : 'Neue Shared-Memory-Datei anlegen',
      existingTitle: language === 'en' ? 'Select existing shared memory file' : 'Bestehende Shared-Memory-Datei auswählen',
    });
    if (result?.error) {
      setMemoryFileError(result.error);
      return;
    }
    if (result?.filePath) setMemoryFilePath(result.filePath);
  };

  const handleMemoryProviderChange = async (event) => {
    const nextProvider = event.target.value;
    setMemoryProvider(nextProvider);
    setMemoryFileError('');
    if (nextProvider === 'file' && !memoryFilePath) {
      await pickMemoryFile();
    }
  };

  const handleSave = () => {
    if (!name.trim() || selectedAgents.length === 0) return;
    if (memoryMode !== 'disabled' && memoryProvider === 'file' && !memoryFilePath.trim()) {
      setMemoryFileError(t('Bitte zuerst eine JSON-Memory-Datei auswählen.'));
      return;
    }
    const namespace = memoryNamespace.trim() || name.trim().toLowerCase().replace(/\s+/g, '-');
    onSave({
      name: name.trim(), emoji, agentIds: selectedAgents,
      projectPath: projectPath.trim(),
      memory: {
        enabled: memoryMode !== 'disabled',
        namespace,
        provider: memoryProvider,
        ...(memoryProvider === 'file' ? { filePath: memoryFilePath.trim() } : {}),
      },
      mcpServers: groupMcpServers,
      qualityRouting: { mode: qualityMode },
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-body">
        <div className="modal-title">{group ? t('Gruppe bearbeiten') : t('Neue Gruppe erstellen')}</div>

        <div className="form-group">
          <label className="form-label">{t('Gruppenname')}</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="z.B. AI Brainstorm" autoFocus />
        </div>

        <div className="form-group">
          <label className="form-label">{t('Emoji')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {GROUP_EMOJIS.map(e => (
              <button key={e} type="button" onClick={() => setEmoji(e)}
                aria-label={`${t('Emoji')} ${e}`} aria-pressed={emoji === e}
                style={{
                  width: 36, height: 36, borderRadius: 8,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, cursor: 'pointer',
                  background: emoji === e ? 'rgba(0,168,132,0.2)' : 'var(--bg-tertiary)',
                  border: emoji === e ? '2px solid var(--accent)' : '2px solid transparent',
                }}
              >{e}</button>
            ))}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('Agenten auswählen')}</label>
          <div className="group-agents-selector">
            {agents.map(a => (
              <div key={a.id}
                className={`agent-chip ${selectedAgents.includes(a.id) ? 'selected' : ''}`}
                onClick={() => !a.isSystemAgent && toggleAgent(a.id)}
                style={a.isSystemAgent ? { opacity: 0.7, cursor: 'default' } : {}}
              >
                <span>{a.emoji}</span>
                <span>{a.name}</span>
                <span style={{ fontSize: 10, opacity: 0.7, marginLeft: 2 }}>
                  {getProviderOptions(providerConnections).find(option => option.id === a.provider)?.emoji || '🔌'}
                </span>
                {a.isSystemAgent && <span style={{ fontSize: 10, color: 'var(--accent)' }}>★</span>}
              </div>
            ))}
          </div>
          {agents.length === 0 && <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 8 }}>{t('Keine Agenten vorhanden.')}</div>}
        </div>

        <div className="form-group">
          <label className="form-label">{t('📁 Zielordner für Ausgaben')}</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input className="form-input" value={projectPath} onChange={e => setProjectPath(e.target.value)}
              placeholder={t('Noch kein Ordner gewählt')} style={{ flex: 1, fontSize: 12 }} readOnly />
            <button className="btn btn-primary" style={{ flexShrink: 0, padding: '9px 14px' }} onClick={pickFolder}>
              📂
            </button>
          </div>
          {projectPath && (
            <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
              ✓ {projectPath}
              <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11, marginLeft: 'auto' }}
                onClick={() => setProjectPath('')}>✕</button>
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            {t('Agenten können hier Dateien für dieses Projekt ablegen.')}
          </div>
          {!projectPath && (
            <div className="project-folder-form-warning" role="status">
              {t('Noch kein Zielordner eingerichtet. Datei-Aufgaben können erst zuverlässig ausgeführt werden, nachdem du einen Ordner ausgewählt hast.')}
            </div>
          )}
        </div>

        <div className="form-group quality-config-block">
          <label className="form-label">🧠 {t('Quality Cascading')}</label>
          <select className="form-select" value={qualityMode} onChange={event => setQualityMode(event.target.value)}>
            <option value="inherit">{t('Globale Einstellung übernehmen')}</option>
            <option value="off">{t('Für diese Gruppe deaktivieren')}</option>
            <option value="auto">{t('Automatisch prüfen und bei Bedarf eskalieren')}</option>
            <option value="strong">{t('Immer starke Modellstufe verwenden')}</option>
          </select>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.4 }}>
            {t('Agenten können diese Auswahl in ihrer eigenen Konfiguration überschreiben.')}
          </div>
        </div>

        {/* Memory Space */}
        <div className="form-group">
          <label className="form-label">{t('🧠 Shared Memory Space')}</label>
          <select className="form-select" value={memoryMode} onChange={e => setMemoryMode(e.target.value)} style={{ marginBottom: 8 }}>
            <option value="new">{t('Neuen Memory Space erstellen')}</option>
            <option value="existing">{t('Bestehenden Memory Space verwenden')}</option>
            <option value="disabled">{t('Shared Memory deaktivieren')}</option>
          </select>
          {memoryMode !== 'disabled' && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <div style={{ flex: 2 }}>
                  <div className="form-label" style={{ fontSize: 10 }}>Namespace (memory://...)</div>
                  <input className="form-input" value={memoryNamespace}
                    onChange={e => setMemoryNamespace(e.target.value)}
                    placeholder={name ? name.toLowerCase().replace(/\s+/g, '-') : 'mein-projekt'}
                    style={{ fontSize: 12 }} />
                </div>
                <div style={{ flex: 1 }}>
                  <div className="form-label" style={{ fontSize: 10 }}>{t('Speicherort')}</div>
                  <select className="form-select" value={memoryProvider} onChange={handleMemoryProviderChange} style={{ fontSize: 12 }}>
                    <option value="local">{t('💾 App-Speicher')}</option>
                    <option value="file">{t('📄 JSON-Datei')}</option>
                  </select>
                </div>
              </div>
              {memoryProvider === 'file' && (
                <div style={{ marginBottom: 8 }}>
                  <div className="form-label" style={{ fontSize: 10 }}>{t('Memory-Datei')}</div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <input className="form-input" value={memoryFilePath} readOnly
                      placeholder={t('Noch keine JSON-Datei gewählt')} style={{ flex: 1, fontSize: 12 }} />
                    <button type="button" className="btn btn-primary" onClick={pickMemoryFile}
                      style={{ flexShrink: 0, padding: '9px 12px' }}>
                      {memoryMode === 'new' ? t('Neu/auswählen') : t('Öffnen')}
                    </button>
                  </div>
                  {memoryFileError && (
                    <div style={{ fontSize: 11, color: '#f15c6d', marginTop: 5 }}>{memoryFileError}</div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.4 }}>
                    {t('Versioniertes JSON mit getrennten Namespaces. Mehrere Gruppen dürfen dieselbe Datei verwenden.')}
                  </div>
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
                {memoryMode === 'new' ? t('Die Gruppe erstellt bzw. verwendet') : t('Die Gruppe verwendet')} <code style={{ background: 'var(--bg-tertiary)', padding: '1px 4px', borderRadius: 3 }}>memory://{memoryNamespace || (name || 'namespace').toLowerCase().replace(/\s+/g, '-')}</code>. {t('Mehrere Gruppen können denselben Space nutzen.')}
              </div>
            </div>
          )}
        </div>

        <div className="form-group">
          <label className="form-label">{t('🧩 MCP-Server für diese Gruppe')}</label>
          <div className="mcp-section-copy">
            {t('Füge beliebig viele eigene MCP-Server hinzu. Globale Verbindungen werden automatisch ergänzt.')}
          </div>
          <McpServerList
            servers={groupMcpServers}
            onChange={setGroupMcpServers}
            inheritedServers={globalMcpServers || []}
            compact
          />
        </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button>
          <button className="btn btn-primary" onClick={handleSave}
            disabled={!name.trim() || selectedAgents.length === 0 || (memoryMode !== 'disabled' && memoryProvider === 'file' && !memoryFilePath.trim())}>
            {group ? t('Speichern') : t('Erstellen')}
          </button>
        </div>
      </div>
    </div>
  );
}

// KeyInput must be defined OUTSIDE SettingsPanel to avoid remount on every state change
function KeyInput({ label, value, onChange, show, setShow, placeholder, envVar, configured = false, source = '', onRemove }) {
  const { t } = useI18n();
  return (
    <div className="form-group">
      <label className="form-label">{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          className="form-input"
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={configured ? t('Neuen Schlüssel eingeben, um den gespeicherten zu ersetzen') : placeholder}
          autoComplete="off"
          style={{ paddingRight: 40 }}
        />
        <button
          type="button"
          onClick={e => { e.stopPropagation(); setShow(!show); }}
          style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 14 }}>
          {show ? '🙈' : '👁️'}
        </button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
        {envVar && <>{t('Umgebungsvariable:')} <code style={{ background: 'var(--bg-tertiary)', padding: '1px 5px', borderRadius: 3 }}>{envVar}</code></>}
        {value.trim()
          ? <span style={{ color: 'var(--accent)', marginLeft: envVar ? 8 : 0 }}>✓ {t('Key gesetzt')}</span>
          : configured
            ? <span style={{ color: 'var(--accent)', marginLeft: envVar ? 8 : 0 }}>✓ {t('Sicher konfiguriert')}{source ? ` (${source})` : ''}</span>
            : <span style={{ color: '#e67e22', marginLeft: envVar ? 8 : 0 }}>{t('Nicht konfiguriert')}</span>}
        {configured && source !== 'environment' && onRemove && (
          <button type="button" className="btn btn-secondary" onClick={onRemove} style={{ marginLeft: 8, padding: '2px 7px', fontSize: 10 }}>
            {t('Schlüssel entfernen')}
          </button>
        )}
      </div>
    </div>
  );
}

function SettingsPanel({ onClose }) {
  const { language, setLanguage, t } = useI18n();
  const {
    apiKeys, setApiKeys, kbPath, setKbPath, mcpServers, setMcpServers,
    agents, agentRoles, setAgentRoles,
    providerConnections, setProviderConnections,
    conversationLimits, setConversationLimits,
    qualityRouting, setQualityRouting, qualityStats, clearQualityStats,
  } = useStore();
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [showOpenai, setShowOpenai] = useState(false);
  const [showAnthropic, setShowAnthropic] = useState(false);
  const [localProviderConnections, setLocalProviderConnections] = useState(
    normalizeProviderConnections(providerConnections),
  );
  const [providerKeyDrafts, setProviderKeyDrafts] = useState({});
  const [visibleProviderKeys, setVisibleProviderKeys] = useState({});
  const [removedProviderIds, setRemovedProviderIds] = useState([]);
  const [providerPresetId, setProviderPresetId] = useState('openrouter');
  const [cliStatus, setCliStatus] = useState(apiKeys?.claudeCli
    ? { claudeCli: true, connected: true, subscriptionType: apiKeys.claudeSubscriptionType }
    : null);
  const [codexStatus, setCodexStatus] = useState(null);
  const [credentialError, setCredentialError] = useState('');
  const [externalApi, setExternalApi] = useState({ enabled: false, port: 3001, allowedOrigins: [], running: false, token: '' });
  const [dataActionMessage, setDataActionMessage] = useState('');
  const [localKbPath, setLocalKbPath] = useState(kbPath || '');
  const [localMcpServers, setLocalMcpServers] = useState(Array.isArray(mcpServers) ? mcpServers : []);
  const [localAgentRoles, setLocalAgentRoles] = useState((agentRoles || []).map(role => ({ ...role })));
  const [localConversationLimits, setLocalConversationLimits] = useState(
    normalizeConversationLimits(conversationLimits),
  );
  const [localQualityRouting, setLocalQualityRouting] = useState({
    enabled: false,
    strategy: 'balanced',
    maxEscalations: 1,
    escalationProvider: 'same',
    escalationModel: '',
    ...(qualityRouting || {}),
  });
  const [activeTab, setActiveTab] = useState('general');
  const normalizedLocalRoleNames = localAgentRoles.map(role => normalizeRoleName(role.name).toLowerCase());
  const hasInvalidRoles = localAgentRoles.length === 0
    || normalizedLocalRoleNames.some(name => !name)
    || new Set(normalizedLocalRoleNames).size !== normalizedLocalRoleNames.length;
  const hasInvalidProviders = localProviderConnections.some(provider => (
    !provider.name.trim() || !provider.baseUrl.trim() || parseProviderModels(provider.models).length === 0
  ));

  React.useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const refreshCodexStatus = React.useCallback(async () => {
    if (!window.electronAPI?.codexStatus) {
      setCodexStatus({ installed: false, connected: false, error: t('Nur in der Electron-App verfügbar.') });
      return;
    }
    setCodexStatus(current => ({ ...current, loading: true }));
    const status = await window.electronAPI.codexStatus();
    setCodexStatus(status);
  }, [t]);

  const refreshClaudeStatus = React.useCallback(async () => {
    if (!window.electronAPI?.claudeStatus) return;
    setCliStatus(current => ({ ...current, loading: true, error: '' }));
    try {
      const status = await window.electronAPI.claudeStatus();
      const enabled = !!apiKeys?.claudeCli;
      setCliStatus(current => ({
        ...current,
        ...status,
        loading: false,
        available: status.connected,
        connected: status.connected && enabled,
        claudeCli: status.connected && enabled,
      }));
    } catch (error) {
      setCliStatus(current => ({ ...current, loading: false, error: error.message }));
    }
  }, [apiKeys?.claudeCli]);

  React.useEffect(() => {
    refreshCodexStatus();
    refreshClaudeStatus();
    window.electronAPI?.externalApiStatus?.().then(status => setExternalApi(current => ({ ...current, ...status }))).catch(() => undefined);
  }, [refreshCodexStatus, refreshClaudeStatus]);

  const handleImportClaudeCLI = async () => {
    setCliStatus({ loading: true });
    try {
      const status = await window.electronAPI?.claudeStatus();
      if (!status?.installed) { setCliStatus({ error: status?.error || t('Claude Code CLI nicht gefunden.') }); return; }
      if (!status.connected) { setCliStatus({ error: t('Claude Code ist nicht angemeldet. Bitte zuerst `claude` starten und anmelden.') }); return; }
      await setApiKeys({ claudeCli: true, claudeSubscriptionType: status.subscriptionType || '' });
      setCliStatus({ ...status, claudeCli: true });
    } catch (e) { setCliStatus({ error: e.message }); }
  };

  const handleImportOpenAICLI = async () => {
    try {
      const status = await window.electronAPI?.importOpenAICredentials();
      if (status) await setApiKeys({});
    } catch (error) { setCredentialError(error.message); }
  };

  const handleCodexLogin = async () => {
    setCodexStatus(current => ({ ...current, loading: true }));
    const result = await window.electronAPI?.codexLogin();
    if (!result?.ok) {
      setCodexStatus(current => ({ ...current, loading: false, error: result?.error || t('Anmeldung konnte nicht gestartet werden.') }));
      return;
    }
    setCodexStatus(current => ({ ...current, loading: false, loginStarted: true, status: result.message }));
  };

  const handleSave = async () => {
    if (hasInvalidRoles || hasInvalidProviders) return;
    setCredentialError('');
    try {
      await setProviderConnections(localProviderConnections);
      const credentialUpdates = {};
      if (openaiKey.trim()) credentialUpdates.openai = openaiKey.trim();
      if (anthropicKey.trim()) credentialUpdates.anthropic = anthropicKey.trim();
      const providerUpdates = Object.fromEntries([
        ...Object.entries(providerKeyDrafts).filter(([, value]) => String(value || '').trim()),
        ...removedProviderIds.map(id => [id, '']),
      ]);
      if (Object.keys(providerUpdates).length) credentialUpdates.providers = providerUpdates;
      if (Object.keys(credentialUpdates).length) await setApiKeys(credentialUpdates);
    } catch (error) {
      setCredentialError(error.message);
      setActiveTab('providers');
      return;
    }
    setKbPath(localKbPath.trim());
    setMcpServers(localMcpServers);
    setAgentRoles(localAgentRoles);
    setConversationLimits(localConversationLimits);
    setQualityRouting(localQualityRouting);
    onClose();
  };

  const removeCredential = async (provider) => {
    setCredentialError('');
    try {
      await setApiKeys({ [provider]: '' });
      if (provider === 'openai') setOpenaiKey('');
      if (provider === 'anthropic') setAnthropicKey('');
    } catch (error) { setCredentialError(error.message); }
  };

  const removeProviderCredential = async (providerId) => {
    setCredentialError('');
    try {
      await setApiKeys({ providers: { [providerId]: '' } });
      setProviderKeyDrafts(current => ({ ...current, [providerId]: '' }));
    } catch (error) { setCredentialError(error.message); }
  };

  const addProviderConnection = () => {
    const connection = createProviderConnection(providerPresetId, `api-${uuidv4()}`);
    if (!connection) return;
    setLocalProviderConnections(current => [...current, connection]);
  };

  const updateProviderConnection = (providerId, updates) => {
    setLocalProviderConnections(current => current.map(provider => (
      provider.id === providerId ? { ...provider, ...updates } : provider
    )));
  };

  const removeProviderConnection = (providerId) => {
    const usedByAgent = agents.some(agent => agent.provider === providerId);
    const usedForEscalation = localQualityRouting.escalationProvider === providerId
      || agents.some(agent => agent.qualityRouting?.escalationProvider === providerId);
    if (usedByAgent || usedForEscalation) return;
    setLocalProviderConnections(current => current.filter(provider => provider.id !== providerId));
    setRemovedProviderIds(current => [...new Set([...current, providerId])]);
  };

  const configureExternalApi = async (updates) => {
    try {
      const result = await window.electronAPI?.externalApiConfigure?.({
        enabled: updates.enabled ?? externalApi.enabled,
        port: updates.port ?? externalApi.port,
        allowedOrigins: updates.allowedOrigins ?? externalApi.allowedOrigins,
      });
      if (result) setExternalApi(current => ({ ...current, ...result }));
    } catch (error) {
      setExternalApi(current => ({ ...current, error: error.message, running: false }));
    }
  };

  const addGlobalRole = () => {
    const id = `role-custom-${Date.now().toString(36)}-${localAgentRoles.length + 1}`;
    setLocalAgentRoles(current => [...current, { id, name: '' }]);
  };

  const updateGlobalRole = (id, name) => {
    setLocalAgentRoles(current => current.map(role => role.id === id ? { ...role, name } : role));
  };

  const removeGlobalRole = (role) => {
    if (isRoleUsed(role, agents)) return;
    setLocalAgentRoles(current => current.filter(item => item.id !== role.id));
  };

  const handleGlobalEscalationProvider = (nextProvider) => {
    const recommendedModel = {
      openai: 'o1-mini',
      anthropic: 'claude-opus-4-5',
      codex: 'gpt-5.6-sol',
    }[nextProvider] || getProviderModels(nextProvider, localProviderConnections, PROVIDER_MODELS).at(-1) || '';
    setLocalQualityRouting(current => ({
      ...current,
      escalationProvider: nextProvider,
      escalationModel: recommendedModel,
    }));
  };

  // Reusable card style
  const card = {
    background: 'var(--bg-tertiary)', borderRadius: 10,
    border: '1px solid var(--border)', padding: '14px 16px', marginBottom: 12,
  };

  const tabStyle = (active) => ({
    flex: 1, padding: '8px 0', background: 'none', border: 'none',
    borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
    color: active ? 'var(--accent)' : 'var(--text-secondary)',
    cursor: 'pointer', fontSize: 13, fontWeight: active ? 600 : 400,
    transition: 'all 0.15s',
  });

  return (
    <div className="settings-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="settings-panel">
        {/* Header */}
        <div className="settings-header">
          <button className="icon-btn" onClick={onClose} style={{ fontSize: 16 }}>←</button>
          <div className="settings-title">⚙️ {t('Einstellungen')}</div>
        </div>

        {/* Tab Bar */}
        <div className="settings-tabs">
          <button style={tabStyle(activeTab === 'general')} onClick={() => setActiveTab('general')}>🌐 {t('Allgemein')}</button>
          <button style={tabStyle(activeTab === 'roles')} onClick={() => setActiveTab('roles')}>👥 {t('Rollen')}</button>
          <button style={tabStyle(activeTab === 'providers')} onClick={() => setActiveTab('providers')}>🔑 {t('API-Zugang')}</button>
          <button style={tabStyle(activeTab === 'folders')} onClick={() => setActiveTab('folders')}>📁 {t('Ordner')}</button>
          <button style={tabStyle(activeTab === 'mcp')} onClick={() => setActiveTab('mcp')}>🧩 MCP</button>
          <button style={tabStyle(activeTab === 'security')} onClick={() => setActiveTab('security')}>🛡️ {t('Sicherheit')}</button>
          <button style={tabStyle(activeTab === 'info')} onClick={() => setActiveTab('info')}>ℹ️ {t('Info')}</button>
        </div>

        <div className="settings-content">

          {/* ── TAB: General ─────────────────────────────────────────── */}
          {activeTab === 'general' && (
            <>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 20 }}>🌐</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('App-Sprache')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t('Die Sprache wird sofort angewendet und für den nächsten Start gespeichert.')}
                  </div>
                </div>
              </div>
              <label className="form-label">{t('Sprache')}</label>
              <select className="form-select" value={language} onChange={event => setLanguage(event.target.value)}>
                {SUPPORTED_LANGUAGES.map(option => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </div>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 20 }}>🔁</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('Gruppenchat-Limits')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t('Begrenzt einen automatischen Lauf, nicht den gespeicherten Chat. Beim Fortsetzen beginnt ein neues geprüftes Laufsegment.')}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label">{t('Agenten-Tasks pro Lauf')}</label>
                  <input
                    className="form-input"
                    type="number"
                    min="3"
                    max="50"
                    value={localConversationLimits.maxTurns}
                    onChange={event => setLocalConversationLimits(current => normalizeConversationLimits({
                      ...current,
                      maxTurns: event.target.value,
                    }))}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <label className="form-label">{t('Tasks je Agent und Lauf')}</label>
                  <input
                    className="form-input"
                    type="number"
                    min="1"
                    max={localConversationLimits.maxTurns}
                    value={localConversationLimits.maxTurnsPerAgent}
                    onChange={event => setLocalConversationLimits(current => normalizeConversationLimits({
                      ...current,
                      maxTurnsPerAgent: event.target.value,
                    }))}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
                <button type="button" role="switch"
                  aria-checked={localConversationLimits.pmReviewOnLimit}
                  aria-label={t('PM prüft beim Erreichen des Limits')}
                  className={`toggle-switch ${localConversationLimits.pmReviewOnLimit ? 'on' : ''}`}
                  onClick={() => setLocalConversationLimits(current => ({
                    ...current,
                    pmReviewOnLimit: !current.pmReviewOnLimit,
                  }))}
                >
                  <div className="toggle-knob" />
                </button>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{t('PM prüft beim Erreichen des Limits')}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t('Der PM darf abschließen oder den nächsten Schritt verkleinern; offene Arbeit bleibt fortsetzbar.')}
                  </div>
                </div>
              </div>
            </div>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 20 }}>🧠</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('Quality Cascading')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t('Beginnt günstig und wechselt höchstens einmal auf eine stärkere Modellstufe, wenn belastbare Qualitätsregeln dies verlangen.')}
                  </div>
                </div>
                <button type="button" role="switch" aria-checked={localQualityRouting.enabled}
                  aria-label={t('Quality Cascading')}
                  className={`toggle-switch ${localQualityRouting.enabled ? 'on' : ''}`}
                  onClick={() => setLocalQualityRouting(current => ({ ...current, enabled: !current.enabled }))}>
                  <div className="toggle-knob" />
                </button>
              </div>
              <label className="form-label">{t('Strategie')}</label>
              <select className="form-select" value={localQualityRouting.strategy}
                onChange={event => setLocalQualityRouting(current => ({ ...current, strategy: event.target.value }))}
                disabled={!localQualityRouting.enabled}>
                <option value="cost">{t('Kostenfokus – immer günstig beginnen')}</option>
                <option value="balanced">{t('Ausgewogen – riskante Aufgaben direkt stark')}</option>
                <option value="quality">{t('Qualitätsfokus – direkt starke Modellstufe')}</option>
              </select>
              <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                <div style={{ flex: 1 }}>
                  <label className="form-label">{t('Eskalations-Anbieter')}</label>
                  <select className="form-select" value={localQualityRouting.escalationProvider}
                    onChange={event => handleGlobalEscalationProvider(event.target.value)} disabled={!localQualityRouting.enabled}>
                    <option value="same">{t('Gleicher Anbieter')}</option>
                    {getProviderOptions(localProviderConnections).map(option => (
                      <option key={option.id} value={option.id}>{option.name}</option>
                    ))}
                  </select>
                </div>
                {localQualityRouting.escalationProvider !== 'same' && (
                  <div style={{ flex: 1.25 }}>
                    <label className="form-label">{t('Stärkeres Modell')}</label>
                    <select className="form-select" value={localQualityRouting.escalationModel}
                      onChange={event => setLocalQualityRouting(current => ({ ...current, escalationModel: event.target.value }))}
                      disabled={!localQualityRouting.enabled}>
                      {getProviderModels(localQualityRouting.escalationProvider, localProviderConnections, PROVIDER_MODELS, localQualityRouting.escalationModel).map(option => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.45 }}>
                {t('Pro Agenten-Task ist maximal eine Eskalation erlaubt. Im Chat kann dies mit Schnell, Automatisch oder Gründlich überschrieben werden.')}
              </div>
              <div className="quality-stats">
                <span>{t('Läufe')}: {qualityStats?.runs || 0}</span>
                <span>{t('Eskalationen')}: {qualityStats?.escalations || 0}</span>
                <span>{t('Direkt stark')}: {qualityStats?.directStrong || 0}</span>
                <span>≈ {(qualityStats?.estimatedInputTokens || 0) + (qualityStats?.estimatedOutputTokens || 0)} {t('Tokens')}</span>
                <button type="button" className="btn btn-secondary" onClick={clearQualityStats}>{t('Statistik löschen')}</button>
              </div>
            </div>
            </>
          )}

          {/* ── TAB: Agent roles ────────────────────────────────────── */}
          {activeTab === 'roles' && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 20 }}>👥</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('Globale Agentenrollen')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t('Agenten wählen ihre Rolle aus diesem zentralen Katalog. Umbenennungen gelten automatisch überall.')}
                  </div>
                </div>
              </div>
              <div className="role-catalog-list">
                {localAgentRoles.map(role => {
                  const used = isRoleUsed(role, agents);
                  const usageCount = agents.filter(agent => agent.roleId === role.id).length;
                  return (
                    <div className="role-catalog-row" key={role.id}>
                      <input
                        className="form-input"
                        value={role.name}
                        onChange={event => updateGlobalRole(role.id, event.target.value)}
                        aria-label={t('Rollenname')}
                      />
                      {used && <span className="role-usage">{t('{count} Agent(en)', { count: usageCount })}</span>}
                      <button
                        type="button"
                        className="btn btn-secondary role-delete-btn"
                        onClick={() => removeGlobalRole(role)}
                        disabled={used}
                        title={used ? t('Diese Rolle wird noch verwendet und kann nicht gelöscht werden.') : t('Rolle löschen')}
                      >🗑️</button>
                    </div>
                  );
                })}
              </div>
              <button type="button" className="btn btn-secondary" onClick={addGlobalRole}>＋ {t('Rolle hinzufügen')}</button>
              {hasInvalidRoles && (
                <div className="role-catalog-error">{t('Jede Rolle benötigt einen eindeutigen Namen.')}</div>
              )}
            </div>
          )}

          {/* ── TAB: Providers ───────────────────────────────────────── */}
          {activeTab === 'providers' && (<>

            {/* Anthropic API + CLI */}
            <div style={card} data-testid="anthropic-auth-group">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 18 }}>🟣</span>
                <span style={{ fontWeight: 600, fontSize: 14 }}>Anthropic</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span>🔑</span>
                    <strong style={{ fontSize: 13 }}>Anthropic API-Key</strong>
                  </div>
                  <KeyInput label={t('API Key (manuell)')} value={anthropicKey} onChange={setAnthropicKey}
                    show={showAnthropic} setShow={setShowAnthropic} placeholder="sk-ant-..." envVar="ANTHROPIC_API_KEY"
                    configured={apiKeys?.anthropicConfigured} source={apiKeys?.anthropicSource}
                    onRemove={() => removeCredential('anthropic')} />
                </div>

                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span>⌨️</span>
                    <strong style={{ fontSize: 13 }}>Claude Code CLI</strong>
                    {cliStatus?.connected && <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 11 }}>✓ {t('Verbunden')}</span>}
                  </div>
                  <div style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: '8px 10px', fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 10 }}>
                    {t('Anmeldung: Öffne ein Terminal, starte')} <code>claude</code> {t('und wähle beim ersten Start dein Claude.ai- oder Anthropic-Console-Konto. Schließe die Anmeldung im Browser ab und prüfe danach hier den Status.')}
                  </div>
                  {cliStatus?.connected ? (
                    <>
                      <div style={{ fontSize: 11, color: 'var(--accent)', marginBottom: 8 }}>
                        {cliStatus.version || cliStatus.subscriptionType || t('angemeldet')}
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-secondary" style={{ flex: 1, fontSize: 11 }}
                          onClick={() => {
                            setApiKeys({ claudeCli: false, claudeSubscriptionType: '' });
                            setCliStatus(null);
                          }}>{t('Trennen')}</button>
                        <button className="btn btn-secondary" style={{ flex: 1, fontSize: 11 }}
                          onClick={refreshClaudeStatus} disabled={cliStatus?.loading}>
                          {cliStatus?.loading ? `⏳ ${t('Prüfe…')}` : `↻ ${t('Status prüfen')}`}
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="btn btn-primary" style={{ flex: 1, fontSize: 11 }}
                          onClick={handleImportClaudeCLI} disabled={cliStatus?.loading}>
                          {cliStatus?.loading ? `⏳ ${t('Prüfe Anmeldung…')}` : `🔗 ${t('Claude Code CLI verbinden')}`}
                        </button>
                        <button className="btn btn-secondary" style={{ flex: 1, fontSize: 11 }}
                          onClick={refreshClaudeStatus} disabled={cliStatus?.loading}>
                          {cliStatus?.loading ? `⏳ ${t('Prüfe…')}` : `↻ ${t('Status prüfen')}`}
                        </button>
                      </div>
                      {cliStatus?.error && <div style={{ color: '#e88', fontSize: 11, marginTop: 8 }}>{cliStatus.error}</div>}
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* OpenAI API + CLI */}
            <div style={card} data-testid="openai-auth-group">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 18 }}>🟢</span>
                <span style={{ fontWeight: 600, fontSize: 14 }}>OpenAI</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 10 }}>
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span>🔑</span>
                    <strong style={{ fontSize: 13 }}>OpenAI API-Key</strong>
                  </div>
                  <KeyInput label={t('API Key (manuell)')} value={openaiKey} onChange={setOpenaiKey}
                    show={showOpenai} setShow={setShowOpenai} placeholder="sk-..." envVar="OPENAI_API_KEY"
                    configured={apiKeys?.openaiConfigured} source={apiKeys?.openaiSource}
                    onRemove={() => removeCredential('openai')} />
                  <button className="btn btn-secondary" style={{ fontSize: 11, marginTop: -4, width: '100%' }} onClick={handleImportOpenAICLI}>
                    🔍 {t('Aus Umgebungsvariable laden')}
                  </button>
                </div>

                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <span>⌨️</span>
                    <strong style={{ fontSize: 13 }}>{t('Codex (lokal)')}</strong>
                    {codexStatus?.connected && <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontSize: 11 }}>✓ {t('Angemeldet')}</span>}
                  </div>
                  <div style={{ background: 'var(--bg-primary)', borderRadius: 6, padding: '8px 10px', fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 10 }}>
                    {t('Anmeldung: Öffne ein Terminal, führe')} <code>codex login</code> {t('aus und schließe die ChatGPT-Anmeldung im geöffneten Browser ab. Prüfe danach hier den Status.')}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.45, marginBottom: 8 }}>
                    {t('Nutzt codex exec mit der lokalen codex login-Sitzung. Zugangsdaten bleiben bei der Codex-CLI.')}
                  </div>
                  {codexStatus?.version && <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 6 }}>{codexStatus.version}</div>}
                  {(codexStatus?.status || codexStatus?.error) && (
                    <div style={{ fontSize: 11, color: codexStatus.connected ? 'var(--accent)' : '#e6a23c', marginBottom: 8 }}>
                      {codexStatus.error || codexStatus.status}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    {!codexStatus?.connected && (
                      <button className="btn btn-primary" style={{ flex: 1, fontSize: 11 }} onClick={handleCodexLogin}
                        disabled={codexStatus?.loading || codexStatus?.installed === false}>
                        🔗 {t('Mit Codex anmelden')}
                      </button>
                    )}
                    <button className="btn btn-secondary" style={{ flex: 1, fontSize: 11 }} onClick={refreshCodexStatus} disabled={codexStatus?.loading}>
                      {codexStatus?.loading ? `⏳ ${t('Prüfe…')}` : `↻ ${t('Status prüfen')}`}
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 18 }}>🔌</span>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{t('Weitere API-Anbieter')}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.45, marginBottom: 12 }}>
                {t('Füge vorkonfigurierte oder eigene Anbieter hinzu. API-Schlüssel bleiben getrennt von der Provider-Konfiguration verschlüsselt gespeichert.')}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <select className="form-select" value={providerPresetId} onChange={event => setProviderPresetId(event.target.value)} style={{ flex: 1 }}>
                  {PROVIDER_PRESETS.map(preset => (
                    <option key={preset.id} value={preset.id}>{preset.emoji} {t(preset.name)}</option>
                  ))}
                </select>
                <button type="button" className="btn btn-primary" onClick={addProviderConnection}>{t('Anbieter hinzufügen')}</button>
              </div>
            </div>

            {localProviderConnections.map(connection => {
              const usedBy = agents.filter(agent => agent.provider === connection.id);
              const usedForEscalation = localQualityRouting.escalationProvider === connection.id
                || agents.some(agent => agent.qualityRouting?.escalationProvider === connection.id);
              const providerInUse = usedBy.length > 0 || usedForEscalation;
              const keyConfigured = Boolean(apiKeys?.providerConfigured?.[connection.id]);
              return (
                <div key={connection.id} style={card}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                    <span style={{ fontSize: 18 }}>{connection.emoji || '🔌'}</span>
                    <strong style={{ flex: 1 }}>{connection.name || t('Unbenannter Anbieter')}</strong>
                    <button type="button" className="btn btn-secondary"
                      disabled={providerInUse}
                      title={usedBy.length
                        ? t('Dieser Anbieter wird noch von {count} Agent(en) verwendet.', { count: usedBy.length })
                        : usedForEscalation
                          ? t('Dieser Anbieter wird noch für Quality Cascading verwendet.')
                          : t('Anbieter entfernen')}
                      onClick={() => removeProviderConnection(connection.id)}>
                      {t('Entfernen')}
                    </button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">{t('Anzeigename')}</label>
                      <input className="form-input" value={connection.name}
                        onChange={event => updateProviderConnection(connection.id, { name: event.target.value })} />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">{t('API-Protokoll')}</label>
                      <select className="form-select" value={connection.protocol}
                        onChange={event => updateProviderConnection(connection.id, { protocol: event.target.value })}>
                        <option value="openai">{t('OpenAI-kompatibel')}</option>
                        <option value="anthropic">Anthropic Messages</option>
                        <option value="gemini">Google Gemini</option>
                      </select>
                    </div>
                  </div>
                  <div className="form-group" style={{ marginTop: 10 }}>
                    <label className="form-label">{t('API-Base-URL')}</label>
                    <input className="form-input" value={connection.baseUrl}
                      placeholder="https://api.example.com/v1"
                      onChange={event => updateProviderConnection(connection.id, { baseUrl: event.target.value })} />
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>
                      {t('HTTPS ist erforderlich; HTTP ist nur für localhost erlaubt.')}
                    </div>
                  </div>
                  <div className="form-group">
                    <label className="form-label">{t('Modelle (eine Zeile je Modell)')}</label>
                    <textarea className="form-textarea" rows={Math.min(5, Math.max(2, connection.models.length))}
                      value={connection.models.join('\n')}
                      onChange={event => updateProviderConnection(connection.id, { models: parseProviderModels(event.target.value) })} />
                  </div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>
                    <input type="checkbox" checked={connection.requiresApiKey !== false}
                      onChange={event => updateProviderConnection(connection.id, { requiresApiKey: event.target.checked })} />
                    {t('API-Key erforderlich')}
                  </label>
                  <KeyInput label={t('API Key (manuell)')}
                    value={providerKeyDrafts[connection.id] || ''}
                    onChange={value => setProviderKeyDrafts(current => ({ ...current, [connection.id]: value }))}
                    show={Boolean(visibleProviderKeys[connection.id])}
                    setShow={value => setVisibleProviderKeys(current => ({ ...current, [connection.id]: value }))}
                    placeholder={connection.requiresApiKey === false ? t('Optional, falls der lokale Server einen Token verlangt') : 'sk-…'}
                    configured={keyConfigured}
                    onRemove={() => removeProviderCredential(connection.id)} />
                  {usedBy.length > 0 && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: -8 }}>
                      {t('Verwendet von: {names}', { names: usedBy.map(agent => agent.name).join(', ') })}
                    </div>
                  )}
                </div>
              );
            })}
            {hasInvalidProviders && <div className="role-catalog-error">{t('Jeder API-Anbieter benötigt einen Namen, eine Base-URL und mindestens ein Modell.')}</div>}
            {credentialError && <div className="role-catalog-error">{credentialError}</div>}
            {!apiKeys?.encryptionAvailable && window.electronAPI && (
              <div className="role-catalog-error">{t('Der Betriebssystem-Schlüsselspeicher ist nicht verfügbar. Manuelle Schlüssel werden aus Sicherheitsgründen nicht unverschlüsselt gespeichert.')}</div>
            )}

          </>)}

          {/* ── TAB: Folders ─────────────────────────────────────────── */}
          {activeTab === 'folders' && (<>

            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 20 }}>📚</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('Wissensbasis')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{t('Ordner mit Markdown- oder Textdateien (global für alle Gruppen)')}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="form-input" value={localKbPath} onChange={e => setLocalKbPath(e.target.value)}
                  placeholder={t('Noch kein Ordner gewählt')} style={{ flex: 1, fontSize: 12 }} readOnly />
                <button className="btn btn-primary" style={{ flexShrink: 0 }}
                  onClick={async () => { const r = await window.electronAPI?.pickFolder(t('Wissensbasis-Ordner')); if (r) setLocalKbPath(r); }}>
                  📂 {t('Wählen')}
                </button>
              </div>
              {localKbPath && (
                <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  ✓ {localKbPath}
                  <button style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 11, marginLeft: 'auto' }}
                    onClick={() => setLocalKbPath('')}>✕ {t('Entfernen')}</button>
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, lineHeight: 1.5 }}>
                {t('Agenten durchsuchen .md und .txt Dateien automatisch. Projekt-Ordner werden pro Gruppe im Gruppen-Modal konfiguriert.')}
              </div>
            </div>
          </>)}

          {/* ── TAB: Global MCP ─────────────────────────────────────── */}
          {activeTab === 'mcp' && (
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 20 }}>🧩</span>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('Globale MCP-Server')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t('Aktive Server stehen automatisch allen Gruppen und deren Agenten zur Verfügung.')}
                  </div>
                </div>
              </div>
              <McpServerList servers={localMcpServers} onChange={setLocalMcpServers} compact />
            </div>
          )}

          {/* ── TAB: Security ───────────────────────────────────────── */}
          {activeTab === 'security' && (<>
            <div style={card}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 20 }}>🔐</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('Externe REST-API')}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {t('Standardmäßig deaktiviert. Bei Aktivierung ist für jeden Zugriff ein geheimes Bearer-Token erforderlich.')}
                  </div>
                </div>
                <button
                  type="button"
                  className={`toggle-switch ${externalApi.enabled ? 'on' : ''}`}
                  role="switch"
                  aria-checked={externalApi.enabled}
                  onClick={() => configureExternalApi({ enabled: !externalApi.enabled })}
                >
                  <span className="toggle-knob" />
                </button>
              </div>
              <label className="form-label">{t('Lokaler Port')}</label>
              <input className="form-input" type="number" min="1024" max="65535" value={externalApi.port}
                onChange={event => setExternalApi(current => ({ ...current, port: Number(event.target.value) }))}
                disabled={externalApi.enabled} />
              <label className="form-label" style={{ marginTop: 10 }}>{t('Erlaubte Browser-Origins (optional, eine pro Zeile)')}</label>
              <textarea className="form-input" rows="3"
                value={(externalApi.allowedOrigins || []).join('\n')}
                onChange={event => setExternalApi(current => ({ ...current, allowedOrigins: event.target.value.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }))}
                disabled={externalApi.enabled}
                placeholder="http://127.0.0.1:8080" />
              {!externalApi.enabled && (
                <button type="button" className="btn btn-secondary" style={{ marginTop: 10 }} onClick={() => configureExternalApi({ enabled: false })}>
                  {t('API-Konfiguration speichern')}
                </button>
              )}
              <div style={{ fontSize: 11, color: externalApi.running ? 'var(--accent)' : 'var(--text-muted)', marginTop: 10 }}>
                {externalApi.enabled
                  ? externalApi.running ? `✓ ${t('API läuft auf')} http://127.0.0.1:${externalApi.port}` : `⚠ ${externalApi.error || t('API konnte nicht gestartet werden')}`
                  : t('API ist deaktiviert')}
              </div>
              {externalApi.enabled && (
                <button type="button" className="btn btn-secondary" style={{ marginTop: 10 }}
                  onClick={async () => {
                    const result = await window.electronAPI?.externalApiRegenerateToken?.();
                    if (result) setExternalApi(current => ({ ...current, ...result }));
                  }}>
                  {t('Neues Zugriffstoken erzeugen')}
                </button>
              )}
              {externalApi.token && (
                <div style={{ marginTop: 10 }}>
                  <label className="form-label">{t('Zugriffstoken – jetzt kopieren, es wird später nicht erneut angezeigt')}</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input className="form-input" value={externalApi.token} readOnly />
                    <button type="button" className="btn btn-primary" onClick={() => navigator.clipboard.writeText(externalApi.token)}>{t('Kopieren')}</button>
                  </div>
                </div>
              )}
            </div>
            <div style={card}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 6 }}>🗂️ {t('Lokale Daten')}</div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5, marginBottom: 10 }}>
                {t('Der Export enthält keine API-Schlüssel oder Zugriffstoken. Externe Projektdateien und separat ausgewählte Memory-Dateien werden nicht verändert.')}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <button type="button" className="btn btn-secondary" onClick={async () => {
                  const result = await window.electronAPI?.exportUserData?.();
                  if (result?.ok) setDataActionMessage(t('Export gespeichert: {path}', { path: result.filePath }));
                  else if (result?.error) setDataActionMessage(result.error);
                }}>{t('Daten exportieren')}</button>
                <button type="button" className="btn btn-secondary" onClick={() => window.electronAPI?.openUserDataFolder?.()}>{t('Speicherordner öffnen')}</button>
                <button type="button" className="btn btn-danger" onClick={() => window.electronAPI?.deleteAllUserData?.()}>{t('Alle lokalen App-Daten löschen')}</button>
              </div>
              {dataActionMessage && <div style={{ fontSize: 11, color: 'var(--accent)', marginTop: 10, wordBreak: 'break-all' }}>{dataActionMessage}</div>}
            </div>
          </>)}

          {/* ── TAB: Info ────────────────────────────────────────────── */}
          {activeTab === 'info' && (<>
            <div style={card}>
              <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>🤖 Agent Teams</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.7 }}>
                <p>{t('Lokale Desktop-App für KI-Agenten-Teams. Manuell gespeicherte API-Schlüssel werden mit dem Betriebssystem-Schlüsselspeicher geschützt und ausschließlich für direkte Anfragen an den gewählten Anbieter verwendet.')}</p>
                <br />
                <p><strong>{t('Externe API:')}</strong> {externalApi.enabled ? t('aktiviert und token-geschützt') : t('deaktiviert')}</p>
                <br />
                <p style={{ fontSize: 11 }}>
                  <strong>{t('Umgebungsvariablen:')}</strong><br />
                  <code>OPENAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>
                </p>
              </div>
            </div>
          </>)}

        </div>

        <div className="settings-actions">
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={onClose}>{t('Abbrechen')}</button>
          <button className="btn btn-primary" style={{ flex: 2 }} onClick={handleSave} disabled={hasInvalidRoles || hasInvalidProviders}>💾 {t('Speichern')}</button>
        </div>
      </div>
    </div>
  );
}

export { AgentModal, GroupModal, SettingsPanel };
