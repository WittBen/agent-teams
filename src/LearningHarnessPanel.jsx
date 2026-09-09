import { useEffect, useState } from 'react';

export default function LearningHarnessPanel({ enabled, onChange }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const api = window.electronAPI?.learningHarness;
  const refresh = () => api?.({ action: 'stats' }).then(setStats).catch(e => setError(e.message));
  useEffect(() => { refresh(); }, []);
  return <div style={{ marginTop: 16 }}>
    <label><input type="checkbox" checked={enabled} onChange={e => onChange(e.target.checked)} /> Aus Projekterfahrungen lernen</label>
    <p style={{ fontSize: 12 }}>Der Harness lernt aus wiederkehrenden Qualitätsprüfungen und ergänzt bis zu drei kurze Prüfhilfen. Er speichert keine Gesprächsinhalte. Geschätzte Tokens sind keine gemessene Einsparung.</p>
    {stats && <div className="quality-stats">
      <span>{stats.runs} Erfahrungen / {stats.projects} Projektbereiche</span>
      <span>{stats.accepted} Prüfungen bestanden</span>
      <span>≈ {stats.harnessTokens} zusätzliche Harness-Tokens</span>
      <button type="button" className="btn btn-secondary" onClick={refresh}>Aktualisieren</button>
      <button type="button" className="btn btn-secondary" onClick={async () => {
        try { await api({ action: 'clear' }); await refresh(); } catch (e) { setError(e.message); }
      }}>Erfahrungen löschen</button>
    </div>}
    {!api && <p>Erfahrungslernen ist in der Desktop-App verfügbar.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
