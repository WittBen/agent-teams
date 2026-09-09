import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { useI18n } from './i18n';
import { messagePlanParts } from './message-plan-parts.mjs';

const LANGUAGE_LABELS = {
  bash: 'Bash',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  html: 'HTML',
  java: 'Java',
  javascript: 'JavaScript',
  js: 'JavaScript',
  json: 'JSON',
  jsx: 'JSX',
  markdown: 'Markdown',
  md: 'Markdown',
  plaintext: 'Text',
  powershell: 'PowerShell',
  ps1: 'PowerShell',
  python: 'Python',
  py: 'Python',
  rust: 'Rust',
  shell: 'Shell',
  sh: 'Shell',
  sql: 'SQL',
  text: 'Text',
  ts: 'TypeScript',
  tsx: 'TSX',
  typescript: 'TypeScript',
  xml: 'XML',
  yaml: 'YAML',
  yml: 'YAML',
};

function nodeText(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join('');
  if (React.isValidElement(node)) return nodeText(node.props.children);
  return '';
}

function languageFromClassName(className = '') {
  const language = String(className).match(/(?:^|\s)language-([^\s]+)/i)?.[1]?.toLowerCase() || '';
  return {
    key: language,
    label: LANGUAGE_LABELS[language] || (language ? language.toUpperCase() : 'Code'),
  };
}

function MarkdownCodeBlock({ children, onCopy, streaming = false }) {
  const { t } = useI18n();
  const [copyState, setCopyState] = useState('idle');
  const resetTimerRef = useRef(null);
  const codeElement = React.Children.toArray(children).find(React.isValidElement);
  const className = codeElement?.props?.className || '';
  const language = languageFromClassName(className);
  const code = nodeText(codeElement?.props?.children ?? children).replace(/\n$/, '');

  useEffect(() => () => window.clearTimeout(resetTimerRef.current), []);

  const handleCopy = async () => {
    const copied = await onCopy?.(code);
    setCopyState(copied ? 'copied' : 'failed');
    window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => setCopyState('idle'), 1800);
  };

  const copyLabel = copyState === 'copied'
    ? t('Code kopiert')
    : copyState === 'failed'
      ? t('Kopieren fehlgeschlagen')
      : t('Code kopieren');

  return (
    <details className={`markdown-code-block markdown-code-disclosure${streaming ? ' is-streaming' : ''}`}>
      <summary>
        <span className="code-activity-dot" aria-hidden="true" />
        <span>{t(streaming ? 'Code wird erstellt …' : 'Code ansehen')}</span>
        <span className="markdown-code-language">{language.label}</span>
      </summary>
      <div className="markdown-code-toolbar">
        <span className="markdown-code-language">{language.label}</span>
        <button
          type="button"
          className={`markdown-code-copy ${copyState}`}
          onClick={handleCopy}
          title={copyLabel}
          aria-label={copyLabel}
        >
          <span aria-hidden="true">{copyState === 'copied' ? '✓' : copyState === 'failed' ? '!' : '⧉'}</span>
          <span>{copyLabel}</span>
        </button>
      </div>
      <pre><code className={language.key ? `language-${language.key}` : undefined}>{code}</code></pre>
    </details>
  );
}

function MarkdownTable({ children }) {
  return (
    <div className="markdown-table-scroll">
      <table>{children}</table>
    </div>
  );
}

function MarkdownLink({ href = '', children }) {
  const isSecureExternal = /^https:\/\//i.test(href);
  if (!isSecureExternal) {
    return <span className="markdown-link-disabled" title={href}>{children}</span>;
  }
  return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
}

/** Safe, shared Markdown renderer for completed and streaming chat messages. */
export default function MarkdownMessage({ children, className = '', onCopy, streaming = false }) {
  const { t } = useI18n();
  const parts = messagePlanParts(children);
  return (
    <div className={`markdown-message ${className}`.trim()}>
      {parts.map((part, index) => part.type === 'plan' ? (
        <section className="message-task-plan" key={index} aria-label={t('Aufgabenplan')}>
          <strong>{t('Aufgabenplan')}</strong>
          <ol>
            {part.tasks.map((task, taskIndex) => (
              <li key={taskIndex}>
                <strong>{String(task.title || task.id || t('Aufgabe'))}</strong>
                {task.agent && <div>{t('Agent')}: {String(task.agent)}</div>}
                {task.description && <MarkdownMessage onCopy={onCopy}>{String(task.description)}</MarkdownMessage>}
                {Array.isArray(task.dependsOn) && task.dependsOn.length > 0 && (
                  <div>{t('Abhängigkeiten')}: {task.dependsOn.map(id => String(part.tasks.find(candidate => candidate.id === id)?.title || id)).join(', ')}</div>
                )}
                {Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0 && (
                  <ul>{task.acceptanceCriteria.map((criterion, criterionIndex) => <li key={criterionIndex}>{String(criterion?.text || criterion || '')}</li>)}</ul>
                )}
              </li>
            ))}
          </ol>
          {!part.complete && <p>{t('Weitere Aufgaben werden vorbereitet …')}</p>}
          {part.complete && !part.tasks.length && <p>{t('Der Aufgabenplan enthält keine lesbaren Aufgaben.')}</p>}
        </section>
      ) : part.type === 'status' ? (
        <p key={index} className="message-protocol-status">{t({ RECOVERY_RESOLVED: 'Agent meldet: Unterbrechung behoben', TASK_DONE: 'Agent meldet: Aufgabe erledigt', PROJECT_DONE: 'Agent meldet: Projekt abgeschlossen' }[part.kind])}</p>
      ) : part.type === 'review' ? (
        <section key={index} className="message-task-plan">
          <strong>{t(part.kind === 'TASK_EVIDENCE' ? 'Nachweise des Agenten' : 'Prüfergebnisse des Agenten')}</strong>
          <ul>{part.items.map((item, itemIndex) => (
            <li key={itemIndex}>
              <strong>{String(item.criterionId || item.taskId || t('Kriterium'))}</strong>
              {part.kind === 'ACCEPTANCE_REVIEW' && <div>{t(
                item.status === 'failed' || item.accepted === false ? 'Nicht erfüllt'
                  : item.status === 'passed' || item.accepted === true ? 'Als erfüllt bewertet'
                    : item.status === 'waived' ? 'Ausnahme vorgeschlagen' : 'Bewertung offen'
              )}</div>}
              <MarkdownMessage onCopy={onCopy}>{String(item.summary || item.note || item.comment || '')}</MarkdownMessage>
            </li>
          ))}</ul>
          {!part.complete && <p>{t('Weitere Angaben werden vorbereitet …')}</p>}
          {part.complete && !part.items.length && <p>{t('Keine lesbaren Einträge vorhanden.')}</p>}
        </section>
      ) : (
      <ReactMarkdown
        key={index}
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
        components={{
          a: MarkdownLink,
          pre: props => <MarkdownCodeBlock {...props} onCopy={onCopy} streaming={streaming} />,
          table: MarkdownTable,
        }}
      >
        {part.text}
      </ReactMarkdown>
      ))}
    </div>
  );
}
