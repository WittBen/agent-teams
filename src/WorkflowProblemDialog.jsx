import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from './i18n';

/** Shared problem prompt used by both the workflow window and the chat. */
export default function WorkflowProblemDialog({ problem, running = false, onSubmit, onClose }) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState('');
  const textareaRef = useRef(null);

  useEffect(() => {
    setAnswer('');
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [problem?.taskId, problem?.message]);

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!problem) return null;

  const submit = (event, mode = 'runtime-recovery') => {
    event.preventDefault();
    const normalizedAnswer = answer.trim();
    onSubmit?.(problem.taskId, normalizedAnswer, problem, mode);
    onClose?.();
  };

  return <div className="workflow-question-overlay workflow-problem-overlay" onPointerDown={event => event.target === event.currentTarget && onClose?.()}>
    <form className="workflow-question-dialog workflow-problem-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-problem-title" onSubmit={submit}>
      <div className="workflow-question-dialog-head">
        <div><span>!</span><div><strong id="workflow-problem-title">{t('Workflow-Problem lösen')}</strong><small>{problem.taskTitle}</small></div></div>
        <button type="button" onClick={onClose} title={t('Problemfenster schließen')}>×</button>
      </div>
      <p>{problem.message}</p>
      {problem.suggestion && <div className="workflow-problem-suggestion"><strong>{t('Vorschlag')}</strong><span>{problem.suggestion}</span>
        <button type="button" className="btn btn-primary" onClick={() => {
          onSubmit?.(problem.taskId, [String(problem.suggestion).trim(), answer.trim()].filter(Boolean).join('\n\n'), problem, problem.kind === 'execution' ? 'runtime-recovery' : 'plan-revision');
          onClose?.();
        }}>{t('Vorschlag übernehmen')}</button>
      </div>}
      <label htmlFor="workflow-problem-answer">{t('Deine Lösung oder Zusatzinformation (optional)')}</label>
      <textarea
        ref={textareaRef}
        id="workflow-problem-answer"
        value={answer}
        onChange={event => setAnswer(event.target.value)}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submit(event, 'runtime-recovery');
        }}
        placeholder={t('Beschreibe dem PM, wie das Problem gelöst werden soll…')}
        rows={4}
      />
      <div className="workflow-question-dialog-actions">
        <button type="button" onClick={onClose}>{t('Abbrechen')}</button>
        <button
          type="button"
          className="revision"
          onClick={event => submit(event, 'plan-revision')}
          title={t('Der PM erstellt einen neuen Planentwurf. Erst deine Freigabe startet ihn.')}
        >✎ {t('Hauptplan überarbeiten')}</button>
        <button
          type="submit"
          className="answer"
          disabled={problem.kind !== 'execution'}
          title={running
            ? t('Die Recovery wird in den laufenden Workflow eingereiht.')
            : problem.kind === 'execution'
              ? t('Der PM teilt die Ausführung in Recovery-Tickets auf.')
              : t('Dieses Problem erfordert eine Änderung des Planentwurfs oder der Konfiguration.')}
        >🧭 {t('Ausführung reparieren')}</button>
      </div>
    </form>
  </div>;
}
