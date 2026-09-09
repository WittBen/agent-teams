import EntityIcon, { entityIconLabel } from './EntityIcon.jsx';
import React, { useState } from 'react';
import { useStore } from './store.jsx';
import { PROVIDER_MODELS } from './llm.js';
import { getProviderConnection, getProviderModels, getProviderOptions } from './provider-catalog.js';
import { useI18n } from './i18n.jsx';
import { normalizeRoleName } from './agent-roles.js';


export const EMOJIS = ['🤖', '💡', '⚙️', '🧠', '🎯', '📊', '🔬', '🎨', '📝', '🚀', '💻', '🌍'];

export const COLORS = [0, 1, 2, 3, 4, 5, 6, 7];

export function AgentModal({ agent, draft, onClose, onSave }) {
  const { t } = useI18n();
  const initial = agent || draft;
  const [homeGroupId, setHomeGroupId] = useState(draft?.homeGroups?.[0]?.id || 'new');
  const [newGroupName, setNewGroupName] = useState('Expertengruppe');
  const [saveError, setSaveError] = useState('');
  const { agentRoles, providerConnections } = useStore();
  const roleOptions = draft?.role && !agentRoles.some(role => role.name === draft.role)
    ? [...agentRoles, { id: 'suggested-expert-role', name: draft.role }] : agentRoles;
  const [name, setName] = useState(initial?.name || '');
  const [emoji, setEmoji] = useState(initial?.emoji || '🤖');
  const [color, setColor] = useState(initial?.color ?? 0);
  const initialRole = roleOptions.find(item => item.id === initial?.roleId)
    || roleOptions.find(item => normalizeRoleName(item.name).toLowerCase() === normalizeRoleName(initial?.role).toLowerCase())
    || roleOptions[0];
  const [roleId, setRoleId] = useState(initialRole?.id || '');
  const [capabilities, setCapabilities] = useState((initial?.capabilities || []).join('\n'));
  const [provider, setProvider] = useState(initial?.provider || 'openai');
  const [model, setModel] = useState(initial?.model || 'gpt-4o-mini');
  const [systemPrompt, setSystemPrompt] = useState(initial?.systemPrompt || '');
  const [qualityMode, setQualityMode] = useState(initial?.qualityRouting?.mode || 'inherit');
  const [qualityProvider, setQualityProvider] = useState(initial?.qualityRouting?.escalationProvider || 'inherit');
  const [qualityModel, setQualityModel] = useState(initial?.qualityRouting?.escalationModel || '');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(initial?.qualityRouting?.acceptanceCriteria || '');
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
    const selectedRole = roleOptions.find(item => item.id === roleId);
    if (!name.trim() || !selectedRole || (draft && homeGroupId === 'new' && !newGroupName.trim())) return;
    try { onSave({
      name: name.trim(), emoji, color, roleId: selectedRole.id === 'suggested-expert-role' ? undefined : selectedRole.id, role: selectedRole.name,
      capabilities, provider, model, systemPrompt: systemPrompt.trim(),
      qualityRouting: {
        mode: qualityMode,
        escalationProvider: qualityProvider === 'inherit' ? '' : qualityProvider,
        escalationModel: qualityProvider === 'inherit' ? '' : qualityModel,
        acceptanceCriteria: acceptanceCriteria.trim(),
      },
    }, draft ? { homeGroupId, newGroupName: newGroupName.trim() } : undefined);
    } catch (error) { setSaveError(error.message); return; }
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-body">
        <div className="modal-title">{agent ? t('Agent bearbeiten') : t('Neuen Agenten erstellen')}</div>
        {saveError && <p role="alert">{saveError}</p>}

        {draft && <div className="expertise-draft-notice"><strong>{t('Passender Agent vorgeschlagen')}</strong><p>{t('Name, Rolle und Fähigkeiten sind vorausgefüllt. Prüfe den Vorschlag und den Provider. Der Agent bleibt in seiner Stammgruppe und wird anschließend nur für die Aufgabe ausgeliehen.')}</p></div>}
        {draft && <div className="form-group">
          <label className="form-label">{t('Stammgruppe des neuen Agenten')}</label>
          <select className="form-select" value={homeGroupId} onChange={event => setHomeGroupId(event.target.value)}>
            {(draft.homeGroups || []).map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            <option value="new">{t('Neue Expertengruppe erstellen')}</option>
          </select>
          {homeGroupId === 'new' && <input aria-label={t('Name der neuen Expertengruppe')} className="form-input" value={newGroupName} onChange={event => setNewGroupName(event.target.value)} />}
          <p className="expertise-placement-note">{t('Beim Erstellen wird diese Stammgruppe für Anfragen der aktuellen Gruppe freigegeben. Der Agent wird nicht Mitglied der aktuellen Gruppe.')}</p>
        </div>}
        <div className="form-group">
          <label className="form-label">{t('Name')}</label>
          <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="z.B. Alex" autoFocus />
        </div>

        <div className="form-group">
          <label className="form-label">{t('Icon')}</label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {EMOJIS.map(e => (
              <button key={e} type="button" onClick={() => setEmoji(e)}
                aria-label={t(entityIconLabel(e))} aria-pressed={emoji === e}
                style={{
                  width: 36, height: 36, borderRadius: 8,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, cursor: 'pointer',
                  background: emoji === e ? 'var(--surface-selected)' : 'var(--bg-tertiary)',
                  border: emoji === e ? '2px solid var(--accent)' : '2px solid transparent',
                  transition: 'all 0.1s',
                }}
              ><EntityIcon value={e} /></button>
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
            {roleOptions.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>
            {t('Rollen werden global in den Einstellungen verwaltet.')}
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('Fähigkeiten')}</label>
          <textarea className="form-textarea" rows={3} value={capabilities} onChange={event => setCapabilities(event.target.value)} placeholder={t('Eine frei definierbare Fähigkeit pro Zeile')} />
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 5 }}>
            {t('Diese Angaben werden ausschließlich für die generische Aufgabendelegation verwendet.')}
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
          <p className="expertise-placement-note">{t('Prüft strukturelle Vollständigkeit und konfigurierte Nachweise, nicht die faktische Richtigkeit. Fachliche Prüfung und erforderliche Freigaben bleiben notwendig.')}</p>
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
