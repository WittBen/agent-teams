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

  const submit = event => {
    event.preventDefault();
    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer || running) return;
    onSubmit?.(problem.taskId, normalizedAnswer, problem);
    onClose?.();
  };

  return <div className="workflow-question-overlay workflow-problem-overlay" onPointerDown={event => event.target === event.currentTarget && onClose?.()}>
    <form className="workflow-question-dialog workflow-problem-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-problem-title" onSubmit={submit}>
      <div className="workflow-question-dialog-head">
        <div><span>!</span><div><strong id="workflow-problem-title">{t('Workflow-Problem lösen')}</strong><small>{problem.taskTitle}</small></div></div>
        <button type="button" onClick={onClose} title={t('Problemfenster schließen')}>×</button>
      </div>
      <p>{problem.message}</p>
      {problem.suggestion && <div className="workflow-problem-suggestion"><strong>{t('Vorschlag')}</strong><span>{problem.suggestion}</span></div>}
      <label htmlFor="workflow-problem-answer">{t('Deine Lösung oder Zusatzinformation')}</label>
      <textarea
        ref={textareaRef}
        id="workflow-problem-answer"
        value={answer}
        onChange={event => setAnswer(event.target.value)}
        onKeyDown={event => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submit(event);
        }}
        placeholder={t('Beschreibe dem PM, wie das Problem gelöst werden soll…')}
        rows={4}
      />
      <div className="workflow-question-dialog-actions">
        <button type="button" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="submit" className="answer" disabled={!answer.trim() || running}>➤ {t('Lösung an PM senden')}</button>
      </div>
    </form>
  </div>;
}
