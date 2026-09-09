import EntityIcon from './EntityIcon';
import Icon from './Icon';
import React, { useRef, useState } from 'react';
import { useStore } from './store';
import { useI18n } from './i18n';
import { createTeamExport, normalizeTeamDocument, MAX_TEAM_FILE_BYTES } from './team-portability.mjs';

export default function TeamPortabilityDialog({ onClose }) {
  const { agents, groups, providerConnections, importTeam } = useStore();
  const { t } = useI18n();
  const [tab, setTab] = useState('export');
  const [fileName, setFileName] = useState('');
  const [agentIds, setAgentIds] = useState([]);
  const [groupIds, setGroupIds] = useState([]);
  const [document, setDocument] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);
  React.useEffect(() => {
    const close = event => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  const toggle = (setter, id) => setter(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id]);
  const exportSelection = () => {
    try {
      const data = createTeamExport({ agents, groups, agentIds, groupIds });
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      if (blob.size > MAX_TEAM_FILE_BYTES) throw new Error(t('Die Auswahl ist größer als 2 MB. Exportiere sie in kleineren Teilen.'));
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement('a');
      link.href = url;
      link.download = 'agent-teams-konfiguration.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setMessage(t('Exportdatei erstellt.'));
    } catch (error) { setMessage(error.message); }
  };
  const readFile = async event => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setDocument(null);
    setFileName(file.name);
    setMessage('');
    setBusy(true);
    try {
      if (file.size > MAX_TEAM_FILE_BYTES) throw new Error(t('Die Datei darf höchstens 2 MB groß sein.'));
      setDocument(normalizeTeamDocument(JSON.parse(await file.text())));
    } catch (error) { setMessage(`${t('Import nicht möglich')}: ${error.message}`); }
    finally { setBusy(false); }
  };
  const applyImport = () => {
    try {
      const result = importTeam(document);
      setDocument(null);
      setMessage(`${result.agents} ${t('Agenten')} · ${result.groups} ${t('Gruppen')} ${t('importiert')}`);
    } catch (error) { setMessage(error.message); }
  };
  const knownProviders = new Set(['openai', 'anthropic', 'codex', ...providerConnections.map(provider => provider.id)]);
  const includedAgentIds = new Set([...agentIds, ...groups.filter(group => groupIds.includes(group.id)).flatMap(group => group.agentIds || [])]);
  const tabs = [{ id: 'export', label: t('Exportieren'), icon: '↗' }, { id: 'import', label: t('Importieren'), icon: '↙' }];
  const switchTab = id => { setTab(id); setMessage(''); };
  const handleTabKey = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'export' : event.key === 'End' ? 'import' : tab === 'export' ? 'import' : 'export';
    switchTab(next);
    window.document.getElementById(`team-tab-${next}`)?.focus();
  };
  return <div className="modal-overlay" onClick={event => event.target === event.currentTarget && onClose()}>
    <div className="modal team-transfer-modal" role="dialog" aria-modal="true" aria-labelledby="team-transfer-title">
      <div className="modal-body">
        <div className="modal-title" id="team-transfer-title">{t('Agenten und Gruppen übertragen')}</div>
        <div className="group-modal-tabs team-transfer-tabs" role="tablist" aria-label={t('Übertragung')}>
          {tabs.map(item => <button key={item.id} id={`team-tab-${item.id}`} role="tab" type="button"
            className={tab === item.id ? 'active' : ''} aria-selected={tab === item.id}
            aria-controls={`team-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1}
            onClick={() => switchTab(item.id)} onKeyDown={handleTabKey}>
            <span aria-hidden="true">{item.icon}</span>{item.label}
          </button>)}
        </div>
        <div id={`team-panel-${tab}`} role="tabpanel" aria-labelledby={`team-tab-${tab}`} className="team-transfer-panel">
          {tab === 'export' ? <>
            <div className="team-transfer-summary">
              <div><strong>{t('Auswahl zusammenstellen')}</strong><p>{t('Die Agenten ausgewählter Gruppen werden automatisch mitgenommen.')}</p></div>
              <button className="btn btn-secondary" onClick={() => {
                const allSelected = agentIds.length === agents.length && groupIds.length === groups.length;
                setAgentIds(allSelected ? [] : agents.map(agent => agent.id));
                setGroupIds(allSelected ? [] : groups.map(group => group.id));
              }}>{agentIds.length === agents.length && groupIds.length === groups.length ? t('Auswahl aufheben') : t('Alle auswählen')}</button>
            </div>
            <div className="form-group">
              <div className="form-label">{t('Gruppen')} <span className="team-transfer-count">{groupIds.length} / {groups.length}</span></div>
              <div className="group-agents-selector">
                {groups.map(group => <button type="button" key={group.id} className={`agent-chip ${groupIds.includes(group.id) ? 'selected' : ''}`}
                  aria-pressed={groupIds.includes(group.id)} onClick={() => toggle(setGroupIds, group.id)}>
                  <EntityIcon value={group.emoji} group />{group.name}<span aria-hidden="true">{groupIds.includes(group.id) ? '✓' : '+'}</span>
                </button>)}
                {!groups.length && <p className="team-transfer-note">{t('Keine Gruppen vorhanden.')}</p>}
              </div>
            </div>
            <div className="form-group">
              <div className="form-label">{t('Agenten')} <span className="team-transfer-count">{includedAgentIds.size} / {agents.length}</span></div>
              <div className="group-agents-selector">
                {agents.map(agent => {
                  const automatic = groups.some(group => groupIds.includes(group.id) && group.agentIds?.includes(agent.id));
                  return <button type="button" key={agent.id} className={`agent-chip ${includedAgentIds.has(agent.id) ? 'selected' : ''}`}
                    disabled={automatic} title={automatic ? t('Durch Gruppenauswahl enthalten') : agent.role}
                    aria-pressed={includedAgentIds.has(agent.id)} onClick={() => toggle(setAgentIds, agent.id)}>
                    <EntityIcon value={agent.emoji} />{agent.name}<span aria-hidden="true">{includedAgentIds.has(agent.id) ? '✓' : '+'}</span>
                  </button>;
                })}
                {!agents.length && <p className="team-transfer-note">{t('Keine Agenten vorhanden.')}</p>}
              </div>
            </div>
            <div className="team-transfer-info">{t('Enthalten sind Rollen, Prompts, Fähigkeiten, Modelle und Qualitätsoptionen. Zugangsdaten, Chats und lokale Werkzeug- oder Dateizugriffe bleiben auf diesem Gerät.')}</div>
          </> : <>
            <div className="team-transfer-summary"><div><strong>{t('Konfiguration laden')}</strong><p>{t('Importiere Agenten und Gruppen aus einer exportierten JSON-Datei.')}</p></div></div>
            <input ref={fileRef} hidden type="file" accept=".json,application/json" onChange={readFile} />
            <button className="team-transfer-file" disabled={busy} onClick={() => fileRef.current?.click()}>
              <span className="team-transfer-file-icon" aria-hidden="true"><Icon name="transfer" size={28} /></span>
              <strong>{busy ? t('Datei wird gelesen …') : document ? fileName : t('JSON-Datei auswählen')}</strong>
              <small>{document ? t('Andere Datei auswählen') : t('Bis zu 2 MB · Agenten und Gruppen')}</small>
            </button>
            {document && <div className="team-transfer-preview">
              <div className="form-label">{t('Importvorschau')}</div>
              <div className="team-transfer-preview-row"><span>{t('Agenten')} · {document.agents.length}</span><p>{document.agents.map(agent => agent.name).join(', ') || '–'}</p></div>
              <div className="team-transfer-preview-row"><span>{t('Gruppen')} · {document.groups.length}</span><p>{document.groups.map(group => group.name).join(', ') || '–'}</p></div>
              {document.agents.some(agent => !knownProviders.has(agent.provider)) && <p className="team-transfer-note" role="status">{t('Einige Provider sind hier nicht eingerichtet. Ordne diesen Agenten nach dem Import einen verfügbaren Provider zu.')}</p>}
            </div>}
            <p className="team-transfer-note">{t('Neue Einträge werden angelegt. Bestehende Einträge bleiben erhalten.')}</p>
          </>}
        </div>
        {message && <div className="team-transfer-feedback" role="status">{message}</div>}
      </div>
      <div className="modal-actions">
        <button className="btn btn-secondary" onClick={onClose}>{t('Schließen')}</button>
        {tab === 'export'
          ? <button className="btn btn-primary" disabled={!includedAgentIds.size && !groupIds.length} onClick={exportSelection}>{t('Auswahl exportieren')}</button>
          : <button className="btn btn-primary" disabled={!document || busy} onClick={applyImport}>{t('Importieren')}</button>}
      </div>
    </div>
  </div>;
}
