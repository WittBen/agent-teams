import React from 'react';
import Icon from './Icon';
import { useI18n } from './i18n';

export default function ExpertiseHelpPanel({ items = [], running, onSearch, onCreate, onAssign, onConfigure }) {
  const { t } = useI18n();
  if (!items.length) return null;
  return <section className="expertise-help" aria-label={t('Passende Experten finden')}>
    <header><Icon name="users" /><div><strong>{t('Passende Experten finden')}</strong><p>{t('1. Gruppen prüfen · 2. Experten ausleihen · 3. Bei Bedarf Agent anlegen')}</p></div></header>
    {items.map(item => {
      const canCreate = !item.pending && (!item.targetCount || item.searched || !item.skills.length);
      return <article key={item.taskId}>
        <strong>{item.title}</strong>
        <p>{t('Gesuchte Fähigkeiten')}: {item.skills.join(', ') || t('Noch nicht festgelegt')}</p>
        <p role="status">{t(item.pending ? 'Die freigegebenen Gruppen werden nach einem passenden Experten gefragt.'
          : item.candidates.length ? 'Passende Experten sind verfügbar. Leihe einen nur für diese Aufgabe aus. Die Gruppenmitgliedschaft bleibt unverändert.'
          : !item.targetCount ? 'Es sind keine Zielgruppen für diese Aufgabe freigegeben. Wähle Gruppen aus oder lege einen Experten in einer anderen Stammgruppe an.'
          : item.failed ? 'Mindestens eine Gruppe konnte nicht antworten. Du kannst die Suche wiederholen oder einen Experten zum Ausleihen anlegen.'
          : item.searched ? 'Die angefragten Gruppen haben keinen passenden Experten bestätigt. Du kannst jetzt einen anlegen.'
          : !item.skills.length ? 'Ergänze die benötigten Fähigkeiten beim Anlegen des Agenten.'
          : 'Die Expertensuche startet automatisch.')}</p>
        <div className="expertise-help-actions">
          <button type="button" className="btn btn-secondary" onClick={onConfigure}>{t('Gruppen auswählen')}</button>
          {item.targetCount > 0 && item.skills.length > 0 && <button type="button" className="btn btn-secondary" disabled={item.pending} onClick={() => onSearch(item.taskId)}>{t('Gruppen erneut fragen')}</button>}
          {item.candidates.map(candidate => <button type="button" key={candidate.id} className="btn btn-primary" disabled={running} onClick={() => onAssign(item.taskId, candidate.id)}>{t('Für Aufgabe ausleihen')}: {candidate.name} · {candidate.groupName}</button>)}
          {!item.candidates.length && <button type="button" className="btn btn-primary" disabled={!canCreate} onClick={() => onCreate(item.taskId)}>{t('Passenden Agenten anlegen')}</button>}
        </div>
        {running && item.candidates.length > 0 && <small>{t('Unterbrich den Workflow, bevor du die Aufgabenbesetzung änderst.')}</small>}
      </article>;
    })}
  </section>;
}
