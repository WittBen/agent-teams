import EntityIcon, { entityIconLabel } from './EntityIcon.jsx';
import React, { useState } from 'react';
import { useStore } from './store.jsx';
import { PROVIDER_MODELS } from './llm.js';
import { getProviderModels, getProviderOptions } from './provider-catalog.js';
import { useI18n } from './i18n.jsx';
import McpServerList from './McpConfig.jsx';
import { normalizeReviewEnvironment, parseReviewArguments, validateReviewPreviewUrl } from './review-environment.js';
import { buildGroupCapabilityIndex, normalizeCrossGroupTargetIds } from './delegation.js';


export function GroupModal({ group, groups = [], agents, onClose, onSave, initialTab = 'general' }) {
  const { language, t } = useI18n();
  const { mcpServers: globalMcpServers, providerConnections } = useStore();
  const [activeTab, setActiveTab] = useState(initialTab);
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
  const [reviewEnvironment, setReviewEnvironment] = useState(normalizeReviewEnvironment(group?.reviewEnvironment));
  const [reviewEnvironmentError, setReviewEnvironmentError] = useState('');
  const [qualityMode, setQualityMode] = useState(group?.qualityRouting?.mode || 'inherit');
  const [groupAiEnabled, setGroupAiEnabled] = useState(group?.aiTemplate?.enabled === true);
  const [groupAiProvider, setGroupAiProvider] = useState(group?.aiTemplate?.provider || 'openai');
  const [groupAiModel, setGroupAiModel] = useState(group?.aiTemplate?.model || getProviderModels(group?.aiTemplate?.provider || 'openai', providerConnections, PROVIDER_MODELS)[0] || '');
  const [crossGroupCollaborationEnabled, setCrossGroupCollaborationEnabled] = useState(group?.crossGroupCollaborationEnabled === true);
  const [crossGroupTargetGroupIds, setCrossGroupTargetGroupIds] = useState(normalizeCrossGroupTargetIds(
    group?.crossGroupTargetGroupIds,
    group?.crossGroupTargetGroupId,
  ));
  const capabilityIndexPreview = React.useMemo(() => buildGroupCapabilityIndex({
    id: group?.id || 'group-preview',
    agentIds: selectedAgents,
  }, agents), [agents, group?.id, selectedAgents]);
  const memoryConfigurationInvalid = memoryMode !== 'disabled' && memoryProvider === 'file' && !memoryFilePath.trim();

  React.useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const GROUP_EMOJIS = ['💬', '🧠', '🚀', '🎯', '⚡', '🌐', '🔧', '📊', '🎨', '🔬'];
  const groupTabs = [
    { id: 'general', icon: '●', label: t('Allgemein') },
    { id: 'collaboration', icon: '↗', label: t('Zusammenarbeit') },
    { id: 'workspace', icon: '▣', label: t('Arbeitsbereich') },
    { id: 'tools', icon: '◆', label: t('KI & Tools') },
  ];

  const selectAdjacentTab = (event, tabId) => {
    const currentIndex = groupTabs.findIndex(tab => tab.id === tabId);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % groupTabs.length;
    else if (event.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + groupTabs.length) % groupTabs.length;
    else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = groupTabs.length - 1;
    else return;
    event.preventDefault();
    const nextTab = groupTabs[nextIndex];
    setActiveTab(nextTab.id);
    requestAnimationFrame(() => document.getElementById(`group-tab-${nextTab.id}`)?.focus());
  };

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
    if (groupAiEnabled && !groupAiModel.trim()) { setActiveTab('general'); return; }
    if (!name.trim() || selectedAgents.length === 0) {
      setActiveTab('general');
      return;
    }
    if (memoryConfigurationInvalid) {
      setMemoryFileError(t('Bitte zuerst eine JSON-Memory-Datei auswählen.'));
      setActiveTab('tools');
      return;
    }
    const reviewUrlError = validateReviewPreviewUrl(reviewEnvironment.previewUrl);
    if (reviewUrlError) {
      setReviewEnvironmentError(t(reviewUrlError));
      setActiveTab('workspace');
      return;
    }
    const namespace = memoryNamespace.trim() || name.trim().toLowerCase().replace(/\s+/g, '-');
    onSave({
      name: name.trim(), emoji, agentIds: selectedAgents,
      crossGroupCollaborationEnabled,
      crossGroupTargetGroupIds: crossGroupCollaborationEnabled ? crossGroupTargetGroupIds : [],
      projectPath: projectPath.trim(),
      memory: {
        enabled: memoryMode !== 'disabled',
        namespace,
        provider: memoryProvider,
        ...(memoryProvider === 'file' ? { filePath: memoryFilePath.trim() } : {}),
      },
      mcpServers: groupMcpServers,
      reviewEnvironment: normalizeReviewEnvironment(reviewEnvironment),
      qualityRouting: { ...group?.qualityRouting, mode: qualityMode },
      aiTemplate: { enabled: groupAiEnabled, provider: groupAiProvider, model: groupAiModel.trim() },
    });
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal group-modal">
        <div className="modal-body">
        <div className="modal-title">{group ? t('Gruppe bearbeiten') : t('Neue Gruppe erstellen')}</div>

        <div className="group-modal-tabs" role="tablist" aria-label={t('Gruppenoptionen')}>
          {groupTabs.map(tab => {
            const hasError = (tab.id === 'workspace' && Boolean(reviewEnvironmentError)) ||
              (tab.id === 'tools' && (Boolean(memoryFileError) || memoryConfigurationInvalid));
            return <button
              key={tab.id}
              id={`group-tab-${tab.id}`}
              type="button"
              role="tab"
              className={`${activeTab === tab.id ? 'active' : ''} ${hasError ? 'has-error' : ''}`}
              aria-selected={activeTab === tab.id}
              aria-controls={`group-tab-panel-${tab.id}`}
              aria-invalid={hasError || undefined}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => setActiveTab(tab.id)}
              onKeyDown={event => selectAdjacentTab(event, tab.id)}
            >
              <span aria-hidden="true">{tab.icon}</span>
              {tab.label}
              {hasError && <i aria-hidden="true" title={t('Fehler in diesem Bereich')}>!</i>}
            </button>;
          })}
        </div>

        {activeTab === 'general' && <div id="group-tab-panel-general" className="group-modal-tab-panel" role="tabpanel" aria-labelledby="group-tab-general">

        <div className="form-group quality-config-block">
          <label className="form-label" htmlFor="group-ai-mode">{t('Gemeinsame Gruppen-KI')}</label>
          <select id="group-ai-mode" className="form-select" value={groupAiEnabled ? 'group' : 'individual'} onChange={event => setGroupAiEnabled(event.target.value === 'group')}>
            <option value="individual">{t('Individuelle KI der Agenten verwenden')}</option>
            <option value="group">{t('Gemeinsame KI-Vorlage für alle Mitglieder')}</option>
          </select>
          {groupAiEnabled && <>
            <label className="form-label" htmlFor="group-ai-provider">{t('Provider')}</label>
            <select id="group-ai-provider" className="form-select" value={groupAiProvider} onChange={event => {
              setGroupAiProvider(event.target.value);
              setGroupAiModel(getProviderModels(event.target.value, providerConnections, PROVIDER_MODELS)[0] || '');
            }}>
              {getProviderOptions(providerConnections).map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
            </select>
            <label className="form-label" htmlFor="group-ai-model">{t('Modell')}</label>
            <select id="group-ai-model" className="form-select" value={groupAiModel} onChange={event => setGroupAiModel(event.target.value)}>
              {getProviderModels(groupAiProvider, providerConnections, PROVIDER_MODELS, groupAiModel).map(model => <option key={model} value={model}>{model}</option>)}
            </select>
            <p className="expertise-placement-note">{t('Gilt für alle Mitglieder einschließlich PM bei Aufgaben dieser Gruppe. Rollen und Fähigkeiten bleiben individuell. Quality Cascading und ausdrücklich gewählte Aufgabenmodelle haben weiterhin Vorrang.')}</p>
          </>}
        </div>

        <div className="form-group">
          <label className="form-label">{t('Gruppenname')}</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="z.B. AI Brainstorm" autoFocus />
        </div>

        <div className="form-group">
          <label className="form-label">{t('Icon')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {GROUP_EMOJIS.map(e => (
              <button key={e} type="button" onClick={() => setEmoji(e)}
                aria-label={t(entityIconLabel(e))} aria-pressed={emoji === e}
                style={{
                  width: 36, height: 36, borderRadius: 8,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, cursor: 'pointer',
                  background: emoji === e ? 'var(--surface-selected)' : 'var(--bg-tertiary)',
                  border: emoji === e ? '2px solid var(--accent)' : '2px solid transparent',
                }}
              ><EntityIcon value={e} /></button>
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
                <EntityIcon value={a.emoji} />
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

        <div className="form-group group-capability-index-preview">
          <div className="group-capability-index-heading">
            <label className="form-label">⌕ {t('Semantischer Kompetenzindex')}</label>
            <small>{t('Wird beim Speichern aus Fähigkeiten, Rollen und Profilbeschreibungen der Mitglieder aktualisiert.')}</small>
          </div>
          <div className="group-capability-index-summary">
            <span>{t('{count} explizite Fähigkeiten', { count: capabilityIndexPreview.explicitCapabilities.length })}</span>
            <span>{t('{count} abgeleitete Suchbegriffe', { count: capabilityIndexPreview.derivedCapabilities.length })}</span>
          </div>
          <div className="group-capability-member-list">
            {capabilityIndexPreview.members.map(member => {
              const labels = member.explicitCapabilities.length > 0
                ? member.explicitCapabilities
                : [member.agentRole, ...member.derivedTerms].filter(Boolean).slice(0, 4);
              return <div key={member.agentId}>
                <strong>{member.agentName}</strong>
                <span>{labels.join(' · ') || t('Keine verwertbaren Profildaten')}</span>
                <small>{member.explicitCapabilities.length > 0 ? t('explizit') : t('aus Profil abgeleitet')}</small>
              </div>;
            })}
          </div>
        </div>
        </div>}

        {activeTab === 'collaboration' && <div id="group-tab-panel-collaboration" className="group-modal-tab-panel" role="tabpanel" aria-labelledby="group-tab-collaboration">
        <div className="form-group quality-config-block">
          <label className="form-label">↗ {t('Gruppenübergreifende Zusammenarbeit')}</label>
          <label className="settings-toggle-row">
            <span>
              <strong>{t('Ausgehende Informationsanfragen und Aufgabendelegationen erlauben')}</strong>
              <small>{t('Ausgewählte Zielgruppen dürfen Anfragen empfangen und über denselben Weg antworten.')}</small>
            </span>
            <input type="checkbox" checked={crossGroupCollaborationEnabled} onChange={event => setCrossGroupCollaborationEnabled(event.target.checked)} />
          </label>
          {crossGroupCollaborationEnabled && <div className="cross-group-target-setting">
            <strong>{t('Erreichbare Zielgruppen (optional)')}</strong>
            <small>{t('Nur ausgewählte Gruppen werden dem PM angeboten. Ohne Auswahl kann die Gruppe Anfragen annehmen, aber keine senden.')}</small>
            <div className="cross-group-target-list">
              {groups.filter(candidate => candidate.id !== group?.id).map(candidate => <label key={candidate.id}>
                <input type="checkbox" checked={crossGroupTargetGroupIds.includes(candidate.id)} onChange={event => setCrossGroupTargetGroupIds(current => event.target.checked
                  ? normalizeCrossGroupTargetIds([...current, candidate.id])
                  : current.filter(id => id !== candidate.id))} />
                <span><EntityIcon value={candidate.emoji} group size={18} /> {candidate.name}</span>
              </label>)}
              {groups.filter(candidate => candidate.id !== group?.id).length === 0 && <span>{t('Keine andere Gruppe vorhanden.')}</span>}
            </div>
          </div>}
        </div>
        </div>}

        {activeTab === 'workspace' && <div id="group-tab-panel-workspace" className="group-modal-tab-panel" role="tabpanel" aria-labelledby="group-tab-workspace">
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

        <div className="form-group review-config-block">
          <label className="form-label">🧪 {t('Prüf- und Vorschauumgebung')}</label>
          <div className="review-config-copy">
            {t('Optional: Lege feste Befehle fest, die Prüfer-Agenten mit diesem Gruppenordner als Arbeitsordner ausführen können.')}
          </div>
          <div className="review-config-grid">
            <div className="review-command-card">
              <strong>{t('Automatischer Prüfbefehl')}</strong>
              <label className="form-label">{t('Programm')}</label>
              <input className="form-input" value={reviewEnvironment.test.command}
                onChange={event => setReviewEnvironment(current => ({
                  ...current, test: { ...current.test, command: event.target.value },
                }))}
                placeholder={navigator.platform.startsWith('Win') ? 'npm.cmd' : 'npm'} />
              <label className="form-label">{t('Argumente (eines pro Zeile)')}</label>
              <textarea className="form-textarea review-command-args" rows={3}
                value={(reviewEnvironment.test.args || []).join('\n')}
                onChange={event => setReviewEnvironment(current => ({
                  ...current, test: { ...current.test, args: parseReviewArguments(event.target.value) },
                }))}
                placeholder="test" />
              <label className="form-label">{t('Zeitlimit')}</label>
              <select className="form-select" value={reviewEnvironment.testTimeoutMs}
                onChange={event => setReviewEnvironment(current => ({ ...current, testTimeoutMs: Number(event.target.value) }))}>
                <option value={60000}>60 {t('Sekunden')}</option>
                <option value={120000}>120 {t('Sekunden')}</option>
                <option value={300000}>300 {t('Sekunden')}</option>
              </select>
            </div>
            <div className="review-command-card">
              <strong>{t('Vorschauprozess')}</strong>
              <label className="form-label">{t('Programm')}</label>
              <input className="form-input" value={reviewEnvironment.preview.command}
                onChange={event => setReviewEnvironment(current => ({
                  ...current, preview: { ...current.preview, command: event.target.value },
                }))}
                placeholder={navigator.platform.startsWith('Win') ? 'npm.cmd' : 'npm'} />
              <label className="form-label">{t('Argumente (eines pro Zeile)')}</label>
              <textarea className="form-textarea review-command-args" rows={3}
                value={(reviewEnvironment.preview.args || []).join('\n')}
                onChange={event => setReviewEnvironment(current => ({
                  ...current, preview: { ...current.preview, args: parseReviewArguments(event.target.value) },
                }))}
                placeholder={'run\ndev'} />
              <label className="form-label">{t('Vorschau-URL (optional)')}</label>
              <input className="form-input" value={reviewEnvironment.previewUrl}
                onChange={event => {
                  setReviewEnvironmentError('');
                  setReviewEnvironment(current => ({ ...current, previewUrl: event.target.value }));
                }}
                placeholder="http://localhost:5173" />
              {reviewEnvironmentError && <div className="review-config-error" role="alert">{reviewEnvironmentError}</div>}
            </div>
          </div>
          <div className="review-config-warning">
            {t('Vor der ersten Ausführung zeigt die App den vollständigen Befehl zur Bestätigung. Änderungen am Befehl entziehen diese Freigabe automatisch.')}
            {' '}{t('Freigegebene Prozesse laufen mit deinen Benutzerrechten und sind keine Betriebssystem-Sandbox.')}
          </div>
        </div>
        </div>}

        {activeTab === 'tools' && <div id="group-tab-panel-tools" className="group-modal-tab-panel" role="tabpanel" aria-labelledby="group-tab-tools">
        <div className="form-group quality-config-block">
          <label className="form-label">🧠 {t('Quality Cascading')}</label>
          <p className="expertise-placement-note">{t('Prüft strukturelle Vollständigkeit und konfigurierte Nachweise, nicht die faktische Richtigkeit. Fachliche Prüfung und erforderliche Freigaben bleiben notwendig.')}</p>
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
        </div>}
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>{t('Abbrechen')}</button>
          <button className="btn btn-primary" onClick={handleSave}
            disabled={!name.trim() || selectedAgents.length === 0 || Boolean(reviewEnvironmentError) || memoryConfigurationInvalid || (groupAiEnabled && !groupAiModel.trim())}>
            {group ? t('Speichern') : t('Erstellen')}
          </button>
        </div>
      </div>
    </div>
  );
}
