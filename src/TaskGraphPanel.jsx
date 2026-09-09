import { canPauseTask } from './workflow-task-pause.mjs';
import ExpertiseHelpPanel from './ExpertiseHelpPanel';
import { acceptanceTaskState } from './acceptance-scheduling.mjs';
import ChatOptionsMenu from './ChatOptionsMenu';
import EntityIcon from './EntityIcon';
import Icon from './Icon';
import { workflowAttention } from './workflow-attention.mjs';
import MarkdownMessage from './MarkdownMessage';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ACCEPTANCE_STATUS,
  buildWorkflowChangeSet,
  findSafeAutoParallelTaskIds,
  inferTaskNodeType,
  inspectWorkflowPlan,
  isTaskNodeReady,
  summarizeAcceptance,
  TASK_STATUS,
  validateParallelSelection,
  validateTaskDependency,
  validateWorkflowConnection,
} from './task-graph';
import { buildWorkflowLayout, workflowEdgePath, workflowRailPath } from './workflow-layout';
import { useI18n } from './i18n';
import {
  canRetryCrossGroupRequest,
  CROSS_GROUP_REQUEST_STATUS,
  groupRequestColor,
} from './cross-group';
import { normalizeDelegationPolicy } from './delegation';
import { TICKET_PRIORITY, ticketIdForTask } from './task-ticket';
import WorkflowProblemDialog from './WorkflowProblemDialog';

const PLANNABLE_STATUSES = new Set(['planned', 'queued', 'prepared', 'interrupted', 'retryable', 'stale_dependency']);
const RECOVERABLE_STATUSES = new Set(['failed', 'timed_out', 'blocked', 'interrupted', 'waiting_user', 'waiting_pm', 'provider_paused', 'retryable']);
const BLOCKED_REASON_LABELS = {
  'delegation-no-target-expert': 'Es wurde keine erreichbare Zielgruppe mit ausreichender Kompetenzabdeckung gefunden.',
  'cross-group-cancelled': 'Die zugehörige Gruppenanfrage wurde abgebrochen.',
  'pm-consultation': 'Die Aufgabe wartet auf die Einschätzung des PM.',
  'unplanned-handoff': 'Der Agent hat eine nicht im freigegebenen Plan enthaltene Übergabe vorgeschlagen.',
  'acceptance-pending': 'Mindestens ein erforderliches Abnahmekriterium ist noch offen.',
  'acceptance-rework': 'Die unabhängige Prüfung hat mindestens ein erforderliches Kriterium abgelehnt. Das bestehende Ticket wird nachgebessert.',
  'quality-recovery': 'Die Aufgabe erfüllt auch nach der Qualitätseskalation nicht alle automatisch prüfbaren Kriterien und wird deshalb geteilt.',
  'pm-recovery-needs-user': 'Der PM konnte innerhalb des freigegebenen Plans keine sichere Lösung bestätigen und benötigt eine Entscheidung des Users.',
  'upstream-recovery': 'Ein fachlich vorgelagertes Ticket wird repariert. Dieses Ergebnis und seine Abnahme werden danach erneut geprüft.',
  'contract-violation': 'Die angeforderte Ausführung weicht vom freigegebenen Aufgabenplan ab.',
  'repeat-limit': 'Eine wiederholte Übergabe wurde zum Schutz vor einer Schleife blockiert.',
  'scope-repeat': 'Eine bereits erledigte Aufgabe sollte ohne neuen konkreten Defekt erneut ausgeführt werden.',
};
const NODE_TYPES = {
  request: { label: 'Anforderung', icon: 'target', color: 'var(--accent)' },
  task: { label: 'Teilaufgabe', icon: 'plan', color: '#8696a0' },
  continuation: { label: 'Fortsetzung', icon: 'transfer', color: '#c084fc' },
  recovery: { label: 'Recovery', icon: 'workflow', color: '#fb923c' },
  review: { label: 'Prüfung', icon: 'shield', color: 'var(--workflow-success)' },
};
const EDGE_STYLES = {
  delegation: { color: 'var(--text-muted)', dash: '', label: 'Ablauf' },
  dependency: { color: 'var(--workflow-warning)', dash: '7 5', label: 'Abhängigkeit' },
  review: { color: 'var(--workflow-success)', dash: '3 4', label: 'Abnahme' },
  handoff: { color: '#c084fc', dash: '6 4', label: 'Übergabe' },
};

const WORKFLOW_WORKSPACE_TABS = new Set(['workflow', 'tests', 'collaboration']);
const WORKFLOW_TAB_STORAGE_PREFIX = 'agent-teams:workflow-tab:';

function acceptanceCriterionDraft(criteria = []) {
  return criteria.map(criterion => {
    const prefix = criterion.verification === 'automatic'
      ? '[auto] '
      : criterion.verification === 'user' ? '[user] ' : '[review] ';
    return `${prefix}${criterion.text}`;
  }).join('\n');
}

function parseAcceptanceCriterionDraft(value = '') {
  return String(value).split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const match = line.match(/^\[(auto|automatic|user|review|reviewer)\]\s*/i);
    const token = match?.[1]?.toLowerCase();
    return {
      text: match ? line.slice(match[0].length).trim() : line,
      verification: token === 'auto' || token === 'automatic'
        ? 'automatic'
        : token === 'user' ? 'user' : 'reviewer',
      required: true,
    };
  }).filter(criterion => criterion.text);
}

function workflowTabStorageKey(chatId) {
  return `${WORKFLOW_TAB_STORAGE_PREFIX}${String(chatId || 'workflow').slice(0, 200)}`;
}

function readWorkflowWorkspaceTab(chatId) {
  if (typeof window === 'undefined') return 'workflow';
  try {
    const storedTab = window.localStorage.getItem(workflowTabStorageKey(chatId));
    return WORKFLOW_WORKSPACE_TABS.has(storedTab) ? storedTab : 'workflow';
  } catch {
    return 'workflow';
  }
}

function persistWorkflowWorkspaceTab(chatId, tab) {
  if (typeof window === 'undefined' || !WORKFLOW_WORKSPACE_TABS.has(tab)) return;
  try {
    window.localStorage.setItem(workflowTabStorageKey(chatId), tab);
  } catch {
    // The tab still stays selected for this mount if persistent storage is unavailable.
  }
}

const RUNTIME_STEP_LABELS = {
  pm_planning: 'PM plant',
  agent_task: 'Agent bearbeitet',
  group_wait: 'Wartet auf Gruppe',
  pm_synthesis: 'PM fasst zusammen',
};

function visibleGroupRequestTrees(groupRequests) {
  const requests = Array.isArray(groupRequests) ? groupRequests : [];
  const treesByRoot = new Map();
  for (const request of requests) {
    const rootId = request.rootRequestId || request.id;
    if (!treesByRoot.has(rootId)) treesByRoot.set(rootId, []);
    treesByRoot.get(rootId).push(request);
  }
  return [...treesByRoot.entries()]
    .map(([rootId, treeRequests]) => {
      const byParent = new Map();
      treeRequests.forEach(request => {
        const parentId = request.parentRequestId || '';
        if (!byParent.has(parentId)) byParent.set(parentId, []);
        byParent.get(parentId).push(request);
      });
      const root = treeRequests.find(request => request.id === rootId)
        || treeRequests.find(request => !request.parentRequestId)
        || treeRequests[0];
      const latestAt = Math.max(...treeRequests.map(request => request.updatedAt || request.createdAt || 0));
      const active = treeRequests.some(request => !['answered', 'cancelled'].includes(request.status) || !request.deliveredAt);
      return { root, byParent, latestAt, active };
    })
    .filter(tree => tree.root)
    .sort((left, right) => Number(right.active) - Number(left.active) || right.latestAt - left.latestAt)
    .slice(0, 20);
}

function RuntimeStatusIcon({ status }) {
  const { t } = useI18n();
  if (status === 'running') return <i className="workflow-request-spinner" aria-label={t('In Bearbeitung')} />;
  if (status === 'completed') return <i className="workflow-request-step-check" aria-label={t('Erledigt')}>✓</i>;
  if (status === 'waiting_child') return <i className="workflow-request-step-wait" aria-label={t('Wartet')}>…</i>;
  if (['failed', 'timed_out'].includes(status)) return <i className="workflow-request-step-error" aria-label={t('Fehler')}>!</i>;
  if (status === 'cancelled') return <i className="workflow-request-step-cancelled" aria-label={t('Abgebrochen')}>×</i>;
  return <i className="workflow-request-step-planned" aria-label={t('Geplant')}>○</i>;
}

function GroupRequestBranch({ request, byParent, onRetry, visited = new Set() }) {
  const { t } = useI18n();
  if (!request || visited.has(request.id)) return null;
  const nextVisited = new Set(visited);
  nextVisited.add(request.id);
  const children = (byParent.get(request.id) || []).sort((left, right) => left.createdAt - right.createdAt);
  const status = CROSS_GROUP_REQUEST_STATUS[request.status] || CROSS_GROUP_REQUEST_STATUS.queued;
  const color = groupRequestColor({ id: request.targetGroupId, name: request.targetGroupName });
  const steps = request.runtimePlan?.steps || [];
  let displayAnswer = request.answer;
  if (request.delegationReason === 'expertise-discovery' && request.answer) {
    try {
      const response = JSON.parse(request.answer);
      displayAnswer = `${request.targetAgentName || t('Kein passender Experte bestätigt')}\n${response.reason || ''}`;
    } catch { displayAnswer = t('Die Expertenantwort konnte nicht ausgewertet werden.'); }
  }
  const expanded = !['answered', 'cancelled'].includes(request.status) || children.length > 0;
  return <div className="workflow-group-request-branch" style={{ '--group-request-color': color }}>
    <details className={`workflow-group-request ${request.status}`} defaultOpen={expanded}>
      <summary title={request.question}>
        <span className="workflow-group-request-route">{request.sourceGroupName} <b>→</b> {request.targetGroupName}</span>
        <small style={{ color: status.color }}>● {t(status.label)}</small>
        {!request.deliveredAt && canRetryCrossGroupRequest(request) && <button type="button" onClick={event => { event.preventDefault(); event.stopPropagation(); onRetry?.(request.id); }} title={t('Gruppenanfrage erneut starten')}>↻</button>}
      </summary>
      <p title={request.question}>{request.question}</p>
      {steps.length > 0 && <ol className="workflow-request-runtime-plan" aria-label={t('Teilplan der Zielgruppe')}>
        {steps.map(step => <li key={step.id} className={step.status} title={step.error || step.title}>
          <RuntimeStatusIcon status={step.status} />
          <span><b>{step.agentName || step.targetGroupName || t(RUNTIME_STEP_LABELS[step.kind] || 'Teilaufgabe')}</b><small>{t(RUNTIME_STEP_LABELS[step.kind] || 'Teilaufgabe')} · {step.title}</small></span>
        </li>)}
      </ol>}
      {request.answer && <section className="workflow-request-answer">
        <strong>✓ {t('Ergebnis')}</strong>
        <p>{displayAnswer}</p>
      </section>}
      {request.error && <div className="workflow-request-error" role="alert">⚠ {request.error}</div>}
    </details>
    {children.length > 0 && <div className="workflow-group-request-children">
      {children.map(child => <GroupRequestBranch key={child.id} request={child} byParent={byParent} onRetry={onRetry} visited={nextVisited} />)}
    </div>}
  </div>;
}

function GroupWorkView({ trees, onRetry }) {
  const { t } = useI18n();
  const requests = trees.flatMap(tree => [...tree.byParent.values()].flat());
  const activeCount = requests.filter(request => ['queued', 'running', 'waiting_child'].includes(request.status)).length;
  const completedCount = requests.filter(request => request.status === 'answered').length;
  const problemCount = requests.filter(request => ['failed', 'timed_out', 'cancelled'].includes(request.status)).length;
  return <section className="workflow-collaboration-view" role="tabpanel" id="workflow-tabpanel-collaboration" aria-labelledby="workflow-tab-collaboration">
    <header className="workflow-collaboration-head">
      <div><strong><Icon name="users" size={16} /> {t('Gruppenarbeit')}</strong><span>{t('PM-Pläne, Agentenaufgaben und Unteranfragen werden hier vollständig dargestellt.')}</span></div>
      <div className="workflow-collaboration-counts"><span className="active">● {activeCount} {t('aktiv')}</span><span className="done">✓ {completedCount} {t('beantwortet')}</span>{problemCount > 0 && <span className="error">⚠ {problemCount} {t('Probleme')}</span>}</div>
    </header>
    {trees.length === 0 ? <div className="workflow-collaboration-empty"><span><Icon name="users" size={24} /></span><strong>{t('Noch keine Gruppenarbeit')}</strong><p>{t('Sobald eine Aufgabe delegiert oder eine andere Gruppe befragt wird, erscheint der vollständige Ablauf hier.')}</p></div> : (
      <div className="workflow-collaboration-canvas">
        {trees.map(tree => <section className="workflow-collaboration-tree" key={tree.root.id}>
          <header><span>{tree.root.delegationReason === 'expertise-discovery' ? t('Expertensuche') : tree.root.kind === 'task_delegation' ? t('Delegierte Aufgabe') : t('Informationsanfrage')}</span><small>{new Date(tree.root.createdAt).toLocaleString()}</small></header>
          <GroupRequestBranch request={tree.root} byParent={tree.byParent} onRetry={onRetry} />
        </section>)}
      </div>
    )}
  </section>;
}

function AcceptanceTestView({ nodes, testConfigured, onRun, onDecisionRequest, questions, problems, onQuestion, onHelp, onRetry, onConfigure, onPreview, planning, onAcceptSuggestion }) {
  const { t } = useI18n();
  const tickets = (nodes || []).filter(node => (
    inferTaskNodeType(node) !== 'request'
  ));
  const runnable = tickets.filter(node => (
    ['agent_done', 'completed', 'retryable'].includes(node.status) &&
    (node.acceptanceCriteria || []).some(criterion => criterion.verification === 'automatic' && !['passed', 'waived'].includes(criterion.status))
  ));
  const states = { decision: 'Deine Prüfung erforderlich', failed: 'Nachbesserung erforderlich', unavailable: 'Automatische Prüfung nicht verfügbar', running: 'Prüfung läuft', automatic: 'Automatische Prüfung ausstehend', review: 'Fachliche Prüfung ausstehend', waiting: 'Wartet auf Aufgabenabschluss', done: 'Vollständig geprüft' };
  const order = Object.keys(states);
  const sortedTickets = [...tickets].sort((a, b) => order.indexOf(acceptanceTaskState(a)) - order.indexOf(acceptanceTaskState(b)));
  const count = state => tickets.filter(node => acceptanceTaskState(node) === state).length;
  const pending = tickets.filter(node => !['waiting', 'done'].includes(acceptanceTaskState(node))).length;
  return <section className="workflow-test-view" role="tabpanel" id="workflow-tabpanel-tests" aria-labelledby="workflow-tab-tests">
    <header className="workflow-test-head">
      <div><strong><Icon name="test" size={16} /> {t('Prüfungen & Abnahme')}</strong><span>{t('Automatische Prüfungen starten nach dem Aufgabenabschluss. Manuelle Freigaben und fachliche Prüfungen werden separat angezeigt.')}</span></div>
      <button type="button" disabled={!testConfigured || runnable.length === 0 || tickets.some(node => acceptanceTaskState(node) === 'running')} onClick={() => onRun?.(runnable.map(node => node.id))}>▶ {t('Offene Tests starten')}</button>
    </header>
    <div className="workflow-test-summary" role="status">
      <strong>{pending ? t('{count} Aufgaben benötigen eine Prüfung', { count: pending }) : t('Aktuell keine Aufgaben zur Prüfung offen')}</strong>
      <span>{t('Deine Freigabe: {user} · Läuft: {running} · Wartet auf Abschluss: {waiting} · Geprüft: {done}', { user: count('decision'), running: count('running'), waiting: count('waiting'), done: count('done') })}</span>
    </div>
    {!testConfigured && <div className="workflow-test-notice">⚠ {t('Kein automatischer Prüfbefehl konfiguriert. Manuelle und fachliche Abnahmen bleiben verfügbar.')} <button type="button" className="btn btn-secondary" onClick={onConfigure}>{t('Prüfbefehl einrichten')}</button></div>}
    {tickets.length === 0 ? <div className="workflow-collaboration-empty"><span><Icon name="test" size={24} /></span><strong>{t('Noch keine Aufgaben vorhanden')}</strong><p>{t('Sobald der PM Aufgaben erstellt, siehst du hier deren Prüfstatus.')}</p></div> : (
      <div className="workflow-test-grid">{sortedTickets.map(node => {
        const state = acceptanceTaskState(node);
        const question = questions.get(node.id);
        const problem = problems.get(node.id);
        const needsHelp = !!problem || ['failed', 'unavailable'].includes(state) || RECOVERABLE_STATUSES.has(node.status);
        const latestRun = (node.acceptanceTestRuns || []).at(-1);
        const autoCriteria = (node.acceptanceCriteria || []).filter(criterion => criterion.verification === 'automatic');
        const canRun = ['agent_done', 'completed', 'retryable'].includes(node.status) && autoCriteria.some(criterion => !['passed', 'waived'].includes(criterion.status));
        return <article className={`workflow-test-card ${state}`} key={node.id}>
          <header><div><small>{ticketIdForTask(node)}</small><strong>{node.title}</strong></div><span>{t(states[state])}</span></header>
          {!(node.acceptanceCriteria || []).length && <p className="workflow-test-notice">{t('Keine Prüfkriterien definiert. Nach dem Aufgabenabschluss ist eine manuelle Gesamtfreigabe erforderlich.')}</p>}
          <ul>{(node.acceptanceCriteria || []).map(criterion => <li key={criterion.id}><i style={{ background: (ACCEPTANCE_STATUS[criterion.status] || ACCEPTANCE_STATUS.open).color }} /><span>{criterion.text}<small>{t(criterion.verification === 'automatic' ? 'Automatisch' : criterion.verification === 'user' ? 'User-Freigabe' : 'Fachliche Prüfung')} · {t((ACCEPTANCE_STATUS[criterion.status] || ACCEPTANCE_STATUS.open).label)}</small></span>{['agent_done', 'completed', 'retryable', 'blocked'].includes(node.status) && !['passed', 'waived'].includes(criterion.status) && <button type="button" onClick={() => onDecisionRequest?.(node, criterion)}>{criterion.verification === 'user' ? t('Prüfen') : t('Ausnahme')}</button>}</li>)}</ul>
          {(question || needsHelp) && <div className="workflow-test-help">
            <strong>{t(question ? 'Deine Antwort wird benötigt' : 'Nächster Schritt')}</strong>
            <p>{question?.question || problem?.message || t(state === 'unavailable' ? 'Prüfe die Konfiguration oder starte den Test erneut. Falls die Aufgabe selbst fehlerhaft ist, kannst du eine Nachbesserung beauftragen.' : 'Beschreibe, was korrigiert werden soll. Der PM koordiniert die Nachbesserung; anschließend wird erneut geprüft.')}</p>
            <div>
              {problem?.suggestion && <button type="button" className="btn btn-primary" onClick={() => onAcceptSuggestion(node, problem.suggestion, problem)}>{t('Vorschlag übernehmen')}</button>}
              {question && <button type="button" className="btn btn-primary" onClick={() => onQuestion(node.id)}>{t('Rückfrage beantworten')}</button>}
              {needsHelp && !question && state !== 'unavailable' && <button type="button" className="btn btn-primary" onClick={() => onHelp(node, problem)}>{t('Problem lösen')}</button>}
              {state === 'unavailable' && <button type="button" className="btn btn-secondary" onClick={onConfigure}>{t('Prüfkonfiguration öffnen')}</button>}
              {RECOVERABLE_STATUSES.has(node.status) && !planning && !question && <button type="button" className="btn btn-secondary" onClick={() => onRetry(node.id)}>{t('Aufgabe erneut versuchen')}</button>}
            </div>
          </div>}
          {['decision', 'review', 'failed'].includes(state) && <button type="button" className="btn btn-secondary" onClick={onPreview}>{t('Ergebnis / Vorschau öffnen')}</button>}
          {latestRun?.error && <p className="workflow-test-error">{latestRun.error}</p>}
          {latestRun?.output && <details><summary>{t('Letzte Testausgabe')}</summary><pre>{latestRun.output}</pre></details>}
          {autoCriteria.length > 0 && <button type="button" disabled={!testConfigured || !canRun || latestRun?.status === 'running'} onClick={() => onRun?.([node.id])}>↻ {t(latestRun ? 'Tests erneut starten' : 'Tests starten')}</button>}
        </article>;
      })}</div>
    )}
  </section>;
}

function ManualAcceptanceDialog({ request, running, onSubmit, onClose }) {
  const { t } = useI18n();
  const [note, setNote] = useState('');
  if (!request) return null;
  const userCriterion = request.criterion.verification === 'user';
  const submit = status => {
    const normalized = note.trim();
    if (!normalized) return;
    onSubmit?.(status, normalized);
  };
  return <div className="workflow-question-overlay" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onClose?.(); }}>
    <section className="workflow-question-dialog workflow-acceptance-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-acceptance-title">
      <header className="workflow-question-dialog-head"><div><span><Icon name="shield" /></span><div><strong id="workflow-acceptance-title">{t(userCriterion ? 'Manuelle Abnahme' : 'Begründete Ausnahmefreigabe')}</strong><small>{request.node.title}</small></div></div><button type="button" onClick={onClose} aria-label={t('Schließen')}>×</button></header>
      <p>{request.criterion.text}</p>
      <label htmlFor="workflow-acceptance-note">{t('Begründung / Prüfnachweis')}</label>
      <textarea id="workflow-acceptance-note" autoFocus value={note} onChange={event => setNote(event.target.value)} placeholder={t('Was wurde geprüft und warum wird so entschieden?')} />
      <div className="workflow-question-dialog-actions">
        <button type="button" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="button" disabled={running || !note.trim()} onClick={() => submit('failed')}>✕ {t('Nicht bestanden')}</button>
        {!userCriterion && <button type="button" className="waive" disabled={running || !note.trim()} onClick={() => submit('waived')}>⚠ {t('Ausnahme freigeben')}</button>}
        {userCriterion && <button type="button" className="answer" disabled={running || !note.trim()} onClick={() => submit('passed')}>✓ {t('Freigeben')}</button>}
      </div>
    </section>
  </div>;
}

function workflowConnectionPreviewPath(from, to) {
  const bend = Math.max(42, Math.abs(to.x - from.x) * .45);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

function WorkflowQuestionDialog({ question, running, onAnswer, onClose }) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState('');
  const textareaRef = useRef(null);

  useEffect(() => {
    setAnswer('');
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [question.taskId]);

  useEffect(() => {
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const submitAnswer = event => {
    event.preventDefault();
    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer || running) return;
    onAnswer?.(question.taskId, normalizedAnswer);
    onClose();
  };

  return (
    <div className="workflow-question-overlay" onPointerDown={event => event.target === event.currentTarget && onClose()}>
      <form className="workflow-question-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-question-title" onSubmit={submitAnswer}>
        <div className="workflow-question-dialog-head">
          <div><span>?</span><div><strong id="workflow-question-title">{t('Rückfrage von {agent}', { agent: question.agentName || 'Agent' })}</strong><small>{question.taskTitle}</small></div></div>
          <button type="button" onClick={onClose} title={t('Rückfrage schließen')}>×</button>
        </div>
        <p>{question.question || t('Bitte beantworte die Rückfrage des Agenten.')}</p>
        <label htmlFor="workflow-question-answer">{t('Deine Antwort')}</label>
        <textarea
          ref={textareaRef}
          id="workflow-question-answer"
          value={answer}
          onChange={event => setAnswer(event.target.value)}
          onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') submitAnswer(event);
          }}
          placeholder={t('Antwort eingeben…')}
          rows={4}
        />
        <div className="workflow-question-dialog-actions"><button type="button" onClick={onClose}>{t('Abbrechen')}</button><button type="submit" className="answer" disabled={!answer.trim() || running}>➤ {t('Antwort senden')}</button></div>
      </form>
    </div>
  );
}

const WORKFLOW_MAPPING_REASON_LABELS = {
  name: 'Automatisch über den Namen zugeordnet',
  capabilities: 'Automatisch über Fähigkeiten zugeordnet',
  role: 'Automatisch über die Rolle zugeordnet',
  'single-agent': 'Einziger verfügbarer Agent vorgeschlagen',
  manual: 'Manuelle Zuordnung erforderlich',
};

function WorkflowImportDialog({ draft, agentOptions, running, onMappingChange, onApply, onClose }) {
  const { t } = useI18n();
  const firstSelectRef = useRef(null);
  const missingSlots = draft.slots.filter(slot => !draft.mappings?.[slot.id]);

  useEffect(() => {
    window.requestAnimationFrame(() => firstSelectRef.current?.focus());
    const handleKeyDown = event => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [draft.fileName, onClose]);

  const applyImport = () => {
    if (running || missingSlots.length) return;
    const confirmedReplace = !draft.replacesExistingWorkflow || window.confirm(t(
      'Der aktuelle Workflow und sein Fortsetzungsstand werden durch den importierten Planungsentwurf ersetzt. Chatnachrichten und Gruppen bleiben erhalten. Fortfahren?',
    ));
    if (confirmedReplace) onApply?.(draft.replacesExistingWorkflow);
  };

  return <div className="workflow-import-overlay" onPointerDown={event => event.target === event.currentTarget && onClose?.()}>
    <section className="workflow-import-dialog" role="dialog" aria-modal="true" aria-labelledby="workflow-import-title">
      <header>
        <div><Icon name="transfer" size={16} /><div><strong id="workflow-import-title">{t('Workflow-Zuordnung prüfen')}</strong><small>{draft.fileName}</small></div></div>
        <button type="button" onClick={onClose} title={t('Import schließen')}>×</button>
      </header>
      <div className="workflow-import-summary">
        <strong>{draft.title || t('Importierter Workflow')}</strong>
        {draft.description && <p>{draft.description}</p>}
        <span>{t('Externe Agentenrollen müssen lokalen Agenten dieser Gruppe zugeordnet werden.')}</span>
      </div>
      <div className="workflow-import-mappings">
        {draft.slots.map((slot, index) => <label key={slot.id} className={!draft.mappings?.[slot.id] ? 'missing' : ''}>
          <span className="workflow-import-slot">
            <strong>{slot.name}</strong>
            <small>{[slot.role, ...(slot.capabilities || [])].filter(Boolean).join(' · ') || t('Keine Fähigkeiten angegeben')}</small>
            <em>{t(WORKFLOW_MAPPING_REASON_LABELS[slot.suggestionReason] || WORKFLOW_MAPPING_REASON_LABELS.manual)}</em>
          </span>
          <select
            ref={index === 0 ? firstSelectRef : undefined}
            value={draft.mappings?.[slot.id] || ''}
            onChange={event => onMappingChange?.(slot.id, event.target.value)}
          >
            <option value="">{t('Agent auswählen…')}</option>
            {agentOptions.map(agent => <option key={agent.id} value={agent.id}>{agent.name}{agent.role ? ` · ${agent.role}` : ''}</option>)}
          </select>
        </label>)}
      </div>
      {draft.replacesExistingWorkflow && <div className="workflow-import-warning">⚠ {t('Der aktuelle Workflow wird beim Import ersetzt.')}</div>}
      <div className="workflow-import-safety">🔒 {t('Der Import startet keine Agenten. Der Workflow bleibt im Planungsmodus und muss anschließend vom User freigegeben werden.')}</div>
      <footer>
        {missingSlots.length > 0 && <span>{t('{count} Zuordnung(en) fehlen', { count: missingSlots.length })}</span>}
        <button type="button" onClick={onClose}>{t('Abbrechen')}</button>
        <button type="button" className="primary" disabled={running || missingSlots.length > 0} onClick={applyImport}>⇧ {t('Workflow als Entwurf importieren')}</button>
      </footer>
    </section>
  </div>;
}

function FlowNode({ node, position, graph, movable, selected, modelConfig, change, validationHighlighted, workflowProblem, active, pendingQuestion, groupRequests = [], connectionEnabled, connectionSource, connectionTargetState, onSelect, onQuestionOpen, onProblemOpen, onTimeoutRepair, onPauseTask, onResumeTask, onDragStart, onDragMove, onDragEnd, onConnectionStart, onConnectionMove, onConnectionEnd }) {
  const { t } = useI18n();
  const status = TASK_STATUS[node.status] || TASK_STATUS.planned;
  const completed = ['agent_done', 'completed'].includes(node.status);
  const recovering = Boolean(node.recoveryStatus);
  const timedOut = node.status === 'timed_out';
  const staleDependency = node.status === 'stale_dependency';
  const repairable = RECOVERABLE_STATUSES.has(node.status);
  const prepared = node.status === 'prepared';
  const waitingForGroup = node.status === 'waiting_group';
  const waitingForRecoveryDecision = node.recoveryStatus === 'user';
  const answeredGroupRequests = groupRequests.filter(request => request.status === 'answered' && request.answer);
  const activeGroupRequests = groupRequests.filter(request => !['answered', 'cancelled', 'failed', 'timed_out'].includes(request.status));
  const failedGroupRequests = groupRequests.filter(request => ['failed', 'timed_out'].includes(request.status));
  const working = !completed && (active || node.status === 'running' || node.status === 'preparing' || (recovering && !waitingForRecoveryDecision));
  const recoveryStatusText = node.recoveryStatus === 'user'
    ? 'Wartet auf Userentscheidung'
    : node.recoveryStatus === 'pm'
      ? node.recoveryTrigger === 'quality'
        ? 'PM teilt Qualitätsproblem'
        : node.recoveryTrigger === 'error' ? 'PM analysiert Problem' : 'PM analysiert Timeout'
      : 'Recovery-Teilschritt läuft';
  const typeName = inferTaskNodeType(node);
  const nodeType = NODE_TYPES[typeName] || NODE_TYPES.task;
  const ready = isTaskNodeReady(graph, node.id);
  const dependencyCount = (graph?.edges || []).filter(edge => edge.to === node.id && edge.kind === 'dependency').length;
  const executionEntry = [...(graph?.executionLog || [])].reverse().find(entry => entry.taskId === node.id);
  const canStartConnection = connectionEnabled;
  const canReceiveConnection = connectionEnabled && typeName !== 'request';
  const handlePointerDown = event => {
    if (!movable || event.button !== 0 || event.target.closest('button,select,input')) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    onDragStart(node.id, position, event);
  };

  return (
    <article
      className={`workflow-node ${selected ? 'selected' : ''} ${ready ? 'ready' : 'waiting'} ${completed ? 'completed' : ''} ${prepared ? 'prepared' : ''} ${working ? 'working' : ''} ${timedOut ? 'timed-out' : ''} ${staleDependency ? 'stale-dependency' : ''} ${waitingForGroup ? 'cross-group-waiting' : ''} ${pendingQuestion || waitingForRecoveryDecision ? 'has-question' : ''} ${change ? 'change-highlight' : ''} ${validationHighlighted ? 'validation-highlight' : ''} ${connectionSource ? 'connection-source' : ''} ${connectionTargetState ? `connection-target-${connectionTargetState}` : ''}`}
      data-workflow-node={node.id}
      data-workflow-endpoint={node.id}
      aria-busy={working}
      style={{ left: position.x, top: position.y, borderLeftColor: nodeType.color, '--node-status-color': status.color }}
      onClick={event => { event.stopPropagation(); onSelect(node.id); }}
      onPointerDown={handlePointerDown}
      onPointerMove={event => onDragMove(node.id, event)}
      onPointerUp={event => onDragEnd(node.id, event)}
      onPointerCancel={event => onDragEnd(node.id, event, true)}
    >
      {canReceiveConnection && <span className="workflow-connector workflow-connector-in" title={t('Verbindung hier ablegen')} aria-hidden="true" />}
      {canStartConnection && (
        <button
          type="button"
          className="workflow-connector workflow-connector-out"
          title={t('Verbindung zu einer Folgeaufgabe ziehen')}
          aria-label={t('Verbindung von {task} ziehen', { task: node.title })}
          onClick={event => event.stopPropagation()}
          onPointerDown={event => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.setPointerCapture(event.pointerId);
            onConnectionStart(node.id, event);
          }}
          onPointerMove={event => {
            event.preventDefault();
            event.stopPropagation();
            onConnectionMove(event);
          }}
          onPointerUp={event => {
            event.preventDefault();
            event.stopPropagation();
            onConnectionEnd(event);
          }}
          onPointerCancel={event => {
            event.stopPropagation();
            onConnectionEnd(event, true);
          }}
        />
      )}
      <div className="workflow-node-head">
        <span style={{ color: nodeType.color }}><Icon name={nodeType.icon} size={14} /> {t(nodeType.label)}</span>
        {typeName !== 'request' && <span className={`workflow-ticket-priority ${node.priority || 'medium'}`} title={t('Ticket-Priorität')}>{t(TICKET_PRIORITY[node.priority]?.label || TICKET_PRIORITY.medium.label)}</span>}
        {change && <span className="workflow-change-badge">{t(change.type === 'added' ? 'Neu' : 'Änderung')}</span>}
        {validationHighlighted && <span className="workflow-validation-badge">⚠ {t('Problem')}</span>}
        {recovering && <span className="workflow-recovery-badge">🧭 {t('PM-Recovery')}</span>}
        {prepared && <span className="workflow-prepared-badge">◫ {t('Zwischenstand')}</span>}
        <span className="workflow-node-status" style={{ color: status.color }}>
          {working
            ? <i className="workflow-task-spinner" title={t('Agent arbeitet an dieser Aufgabe')} aria-label={t('Agent arbeitet an dieser Aufgabe')} />
            : <i style={{ background: status.color }} />}
          {recovering
            ? t(recoveryStatusText)
            : prepared && !ready ? t('Vorbereitet · wartet') : !ready && PLANNABLE_STATUSES.has(node.status) ? t('wartet') : t(status.label)}
          {graph?.approvedPlan && (canPauseTask(node) || ['paused', 'pausing'].includes(node.status)) && (
            <button type="button" className="workflow-timeout-fix-button"
              disabled={node.status === 'pausing'}
              title={t(node.status === 'paused' ? 'Aufgabe fortsetzen' : 'Aufgabe pausieren')}
              aria-label={t(node.status === 'paused' ? 'Aufgabe fortsetzen' : 'Aufgabe pausieren')}
              onPointerDown={event => event.stopPropagation()}
              onClick={event => { event.stopPropagation(); if (node.status === 'paused') onResumeTask?.(node.id); else onPauseTask?.(node.id); }}
            ><Icon name={node.status === 'paused' ? 'play' : 'pause'} size={14} /></button>
          )}
          {repairable && !recovering && !active && (
            <button
              type="button"
              className="workflow-timeout-fix-button"
              title={t('PM-Recovery für diese Aufgabe starten')}
              aria-label={t('PM-Recovery für diese Aufgabe starten')}
              onPointerDown={event => event.stopPropagation()}
              onClick={event => {
                event.stopPropagation();
                onTimeoutRepair?.(node.id);
              }}
            >↻</button>
          )}
        </span>
      </div>
      <strong className="workflow-node-title" title={node.title}>{node.title}</strong>
      <div className="workflow-node-meta">
        <span>👤 {node.agentName || 'System'}</span>
        {(node.runtimeModel || modelConfig?.currentModel) && <span title={node.runtimeModel || modelConfig?.currentModel}>🧠 {node.runtimeModel || modelConfig?.currentModel}{node.qualityEscalated ? ` · ${t('eskaliert')}` : ''}</span>}
      </div>
      {groupRequests.length > 0 && <div className={`workflow-node-group-wait ${answeredGroupRequests.length > 0 ? 'has-result' : ''} ${failedGroupRequests.length > 0 ? 'has-error' : ''}`} title={groupRequests.map(request => request.answer || request.error || request.question).join('\n')}>
        {activeGroupRequests.length > 0
          ? `↗ ${t('Wartet auf')}: ${activeGroupRequests.slice(-2).map(request => request.targetGroupName).join(', ')}`
          : answeredGroupRequests.length > 0
            ? `✓ ${t('Gruppenergebnis')}: ${answeredGroupRequests.slice(-2).map(request => request.targetGroupName).join(', ')}`
            : `⚠ ${t('Gruppenanfrage mit Problem')}`}
      </div>}
      <div className="workflow-node-foot">
        {!['request', 'review'].includes(typeName) && <span className="workflow-ready-label">{waitingForGroup ? `↗ ${t('Wartet auf Gruppe')}` : ready ? `▶ ${t('Startbereit')}` : `⏳ ${t('Wartet auf Abhängigkeit')}`}</span>}
        {dependencyCount > 0 && <span title={t('Fachliche Abhängigkeiten')}>⛓ {dependencyCount}</span>}
        {!!node.acceptanceCriteria?.length && <span title={t('Abnahmekriterien')}>🛡️ {node.acceptanceCriteria.length}</span>}
        {executionEntry?.compliant != null && <span className={executionEntry.compliant ? 'workflow-compliant' : 'workflow-deviation'} title={t(executionEntry.compliant ? 'Planmäßig ausgeführt' : 'Abweichung vom freigegebenen Plan')}>{executionEntry.compliant ? '✓ Plan' : '⚠ Plan'}</span>}
      </div>
      {pendingQuestion && <button type="button" className="workflow-question-badge" title={t('Rückfrage von {agent}', { agent: pendingQuestion.agentName || node.agentName || 'Agent' })} aria-label={t('Rückfrage öffnen')} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onQuestionOpen(node.id); }}>?</button>}
      {workflowProblem && <button type="button" className={`workflow-problem-badge ${pendingQuestion ? 'beside-question' : ''}`} title={t('Workflow-Problem lösen')} aria-label={t('Workflow-Problem öffnen')} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onProblemOpen(node.id); }}>!</button>}
      {completed && <span className="workflow-completed-check" title={t('Aufgabe erledigt')} aria-label={t('Aufgabe erledigt')}>✓</span>}
    </article>
  );
}

function FlowPoint({ point, position, movable, selected, connectionEnabled, connectionSource, connectionTargetState, onSelect, onDragStart, onDragMove, onDragEnd, onConnectionStart, onConnectionMove, onConnectionEnd }) {
  const { t } = useI18n();
  const label = t(point.type === 'fork' ? 'Fork · Parallelphase beginnt' : 'Join · Parallelphase endet');
  const handlePointerDown = event => {
    if (!movable || event.button !== 0 || event.target.closest('button')) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect?.(point.id);
    event.currentTarget.setPointerCapture(event.pointerId);
    onDragStart(point.id, position, event);
  };
  return (
    <div
      className={`workflow-control-point ${point.type} ${selected ? 'selected' : ''} ${connectionSource ? 'connection-source' : ''} ${connectionTargetState ? `connection-target-${connectionTargetState}` : ''}`}
      data-workflow-flowpoint={point.id}
      data-workflow-endpoint={point.id}
      style={{ left: position.x - 17, top: position.y - 17 }}
      role="group"
      aria-label={label}
      title={`${label} · ${t('Zum Verschieben ziehen')}`}
      onPointerDown={handlePointerDown}
      onPointerMove={event => onDragMove(point.id, event)}
      onPointerUp={event => onDragEnd(point.id, event)}
      onPointerCancel={event => onDragEnd(point.id, event, true)}
    >
      {connectionEnabled && <span className="workflow-connector workflow-connector-in" title={t('Verbindung hier ablegen')} aria-hidden="true" />}
      <span aria-hidden="true">{point.type === 'fork' ? '⑂' : '⑃'}</span>
      {connectionEnabled && <button
        type="button"
        className="workflow-connector workflow-connector-out"
        title={t('Verbindung zu einer Folgeaufgabe ziehen')}
        aria-label={t('Verbindung von {point} ziehen', { point: point.type === 'fork' ? 'Fork' : 'Join' })}
        onPointerDown={event => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          onConnectionStart(point.id, event);
        }}
        onPointerMove={event => { event.preventDefault(); event.stopPropagation(); onConnectionMove(event); }}
        onPointerUp={event => { event.preventDefault(); event.stopPropagation(); onConnectionEnd(event); }}
        onPointerCancel={event => { event.stopPropagation(); onConnectionEnd(event, true); }}
      />}
    </div>
  );
}

function WorkflowDetails({ node, graph, planning, collapsed, pinned, modelConfig, agentOptions, delegationEnabled, groupOptions, groupRequests = [], problems = [], problemSuggestions = [], change, baselineRevision, onTaskUpdate, onTaskDelete, onTaskSplit, onTaskMove, onAgentChange, onModelChange, onDependencyAdd, onDependencyRemove, onAcceptanceCriteriaChange, onAcceptanceDecisionRequest, onRetryTask, onToggleCollapsed, onTogglePinned, onClose, onAcceptSuggestion }) {
  const { t } = useI18n();
  const [dependencyDraft, setDependencyDraft] = useState('');
  const [titleDraft, setTitleDraft] = useState(node.title || '');
  const [objectiveDraft, setObjectiveDraft] = useState(node.objective || node.title || '');
  const [criteriaDraft, setCriteriaDraft] = useState(acceptanceCriterionDraft(node.acceptanceCriteria || []));
  const [capabilitiesDraft, setCapabilitiesDraft] = useState(normalizeDelegationPolicy(node.delegation).requiredCapabilities.join('\n'));
  const typeName = inferTaskNodeType(node);
  const delegation = normalizeDelegationPolicy(node.delegation);
  const taskEditable = planning && typeName !== 'request';
  const incomingDependencies = (graph?.edges || [])
    .filter(edge => edge.to === node.id && edge.kind === 'dependency')
    .map(edge => graph.nodes.find(candidate => candidate.id === edge.from))
    .filter(Boolean);
  const dependencyCandidates = (graph?.nodes || [])
    .filter(candidate => candidate.id !== node.id)
    .map(candidate => ({ node: candidate, validation: validateTaskDependency(graph, candidate.id, node.id) }))
    .filter(item => !item.validation.exists && !(graph?.edges || []).some(edge => edge.from === item.node.id && edge.to === node.id));
  const recoverySteps = (graph?.nodes || [])
    .filter(candidate => candidate.runtimeRecovery && candidate.recovery?.originalGraphNodeId === node.id)
    .sort((left, right) => (left.createdAt || 0) - (right.createdAt || 0));
  const recoveryOriginal = node.runtimeRecovery && node.recovery?.originalGraphNodeId
    ? graph?.nodes?.find(candidate => candidate.id === node.recovery.originalGraphNodeId)
    : null;

  useEffect(() => {
    setDependencyDraft('');
    setTitleDraft(node.title || '');
    setObjectiveDraft(node.objective || node.title || '');
    setCriteriaDraft(acceptanceCriterionDraft(node.acceptanceCriteria || []));
    setCapabilitiesDraft(normalizeDelegationPolicy(node.delegation).requiredCapabilities.join('\n'));
  }, [node]);

  return (
    <aside className={`workflow-details ${collapsed ? 'collapsed' : ''} ${pinned ? 'pinned' : ''}`}>
      <div className="workflow-details-head">
        <div className="workflow-details-title"><span>{t('Aufgabendetails')}</span><strong>{node.title}</strong></div>
        <div className="workflow-details-actions">
          <button type="button" className={`icon-btn ${pinned ? 'active' : ''}`} aria-pressed={pinned} onClick={onTogglePinned} title={t(pinned ? 'Feststellung lösen' : 'Detailfenster feststellen')}>📌</button>
          <button type="button" className="icon-btn" aria-expanded={!collapsed} onClick={onToggleCollapsed} title={t(collapsed ? 'Ausklappen' : 'Einklappen')}>{collapsed ? '◀' : '▶'}</button>
          <button type="button" className="icon-btn" onClick={onClose} title={t('Details schließen')}>✕</button>
        </div>
      </div>
      {collapsed && <button type="button" className="workflow-details-collapsed-label" onClick={onToggleCollapsed} title={t('Ausklappen')}><span>{t('Aufgabendetails')}</span><strong>{node.title}</strong></button>}
      {!collapsed && <div className="workflow-details-scroll">
        {problems.length > 0 && <section className="workflow-problem-details" role="alert">
          <label>⚠ {t('Erkannte Probleme')}</label>
          <ul>{problems.map((problem, index) => <li key={`${problem}-${index}`}>{problem}</li>)}</ul>
          {problemSuggestions.length > 0 && <div className="workflow-problem-suggestions">
            <strong>{t('Mögliche Lösung')}</strong>
            <ul>{problemSuggestions.map((suggestion, index) => <li key={`${suggestion}-${index}`}>{suggestion}<button type="button" className="btn btn-secondary" onClick={() => onAcceptSuggestion(node, suggestion)}>{t('Vorschlag übernehmen')}</button></li>)}</ul>
          </div>}
        </section>}
        {change && (
          <section className="workflow-change-details">
            <label>{t('Änderungen gegenüber Snapshot {version}', { version: baselineRevision || '–' })}</label>
            {change.changes.map((item, index) => (
              <div className="workflow-change-row" key={`${item.field}-${index}`}>
                <strong>{t(item.label)}</strong>
                <span><del>{item.before}</del><b>→</b><ins>{item.after}</ins></span>
              </div>
            ))}
          </section>
        )}
        {typeName !== 'request' && <section>
          <label>{t('Ticket')}</label>
          <div className="workflow-detail-value workflow-ticket-id">#{ticketIdForTask(node)}</div>
        </section>}
        <section>
          <label>{t('Aufgabe')}</label>
          {taskEditable ? <input className="form-input" value={titleDraft} onChange={event => setTitleDraft(event.target.value)} onBlur={() => onTaskUpdate?.(node.id, { title: titleDraft })} /> : <div className="workflow-detail-value">{node.title}</div>}
        </section>
        {taskEditable && <section><label>{t('Aufgabentyp')}</label><select className="form-select" value={typeName === 'review' ? 'review' : 'task'} onChange={event => onTaskUpdate?.(node.id, { nodeType: event.target.value })}><option value="task">{t('Fachaufgabe')}</option><option value="review">{t('Prüfung')}</option></select></section>}
        {typeName !== 'request' && <section>
          <label>{t('Priorität')}</label>
          {taskEditable ? <select className="form-select" value={node.priority || 'medium'} onChange={event => onTaskUpdate?.(node.id, { priority: event.target.value })}>
            {Object.entries(TICKET_PRIORITY).map(([value, config]) => <option key={value} value={value}>{t(config.label)}</option>)}
          </select> : <div className="workflow-detail-value"><span className={`workflow-ticket-priority ${node.priority || 'medium'}`}>{t(TICKET_PRIORITY[node.priority]?.label || TICKET_PRIORITY.medium.label)}</span></div>}
        </section>}
        <section>
          <label>{t('Ziel und erwartetes Ergebnis')}</label>
          {taskEditable ? <textarea className="form-textarea" rows={3} value={objectiveDraft} onChange={event => setObjectiveDraft(event.target.value)} onBlur={() => onTaskUpdate?.(node.id, { objective: objectiveDraft })} /> : <div className="workflow-detail-value">{node.objective || node.title}</div>}
        </section>
        {(node.interimResult || node.preparationError) && <section className="workflow-interim-details">
          <label>◫ {t('Zwischengespeicherter Arbeitsstand')}</label>
          {node.interimResult && <MarkdownMessage className="workflow-detail-value workflow-interim-result">{node.interimResult}</MarkdownMessage>}
          {node.preparedFiles?.length > 0 && <small>{t('Zwischengespeicherte Dateientwürfe')}: {node.preparedFiles.join(', ')}</small>}
          {node.preparationError && <div className="workflow-detail-empty">⚠ {t('Vorbereitung nicht möglich')}: {node.preparationError}</div>}
          {node.interimConsumedAt && <small>✓ {t('Der Zwischenstand wurde in der Hauptausführung berücksichtigt.')}</small>}
        </section>}
        {(recoverySteps.length > 0 || recoveryOriginal) && <section className="workflow-recovery-details">
          <label>🧭 {t('Geteilte Wiederherstellung')}</label>
          {recoveryOriginal && <div className="workflow-detail-value">{t('Gehört zur Timeout-Aufgabe')}: {recoveryOriginal.title}</div>}
          {recoverySteps.map((step, index) => {
            const stepStatus = TASK_STATUS[step.status] || TASK_STATUS.planned;
            return <div className="workflow-recovery-step" key={step.id}>
              <strong>{index + 1}. {step.title}</strong>
              <small style={{ color: stepStatus.color }}>● {t(stepStatus.label)}{step.runtimeModel ? ` · ${step.runtimeModel}` : ''}</small>
            </div>;
          })}
        </section>}
        {node.recoveryNotes?.length > 0 && <section className="workflow-recovery-details">
          <label>📝 {t('Problem- und Recovery-Protokoll')}</label>
          {[...node.recoveryNotes].reverse().map(note => <div className="workflow-recovery-step" key={note.id}>
            <strong>{note.mode === 'plan-revision' ? t('Planrevision') : t('Ausführungs-Recovery')} · {note.author}</strong>
            {note.problem && <span>{note.problem}</span>}
            {note.text && <small>{note.text}</small>}
          </div>)}
        </section>}
        {groupRequests.length > 0 && <section className="workflow-task-group-results">
          <label><Icon name="users" size={16} /> {t('Gruppenarbeit und Ergebnisse')}</label>
          <div className="workflow-task-group-result-list">
            {groupRequests.map(request => {
              const requestStatus = CROSS_GROUP_REQUEST_STATUS[request.status] || CROSS_GROUP_REQUEST_STATUS.queued;
              const result = request.answer || request.interimReply || request.error || '';
              return <article key={request.id} className={request.status}>
                <header><strong>{request.targetGroupEmoji || '💬'} {request.targetGroupName}</strong><small style={{ color: requestStatus.color }}>● {t(requestStatus.label)}</small></header>
                <MarkdownMessage className="workflow-agent-result">{result || t('Die Zielgruppe bearbeitet die Anfrage noch.')}</MarkdownMessage>
                {request.answeredByAgentName && <footer>{t('Beantwortet von {agent}', { agent: request.answeredByAgentName })}</footer>}
              </article>;
            })}
          </div>
        </section>}
        <section>
          <label>{t('Zuständiger Agent')}</label>
          {planning && typeName !== 'request' ? (
            <select className="form-select" value={node.agentId || ''} onChange={event => onAgentChange?.(node.id, event.target.value)}>
              {agentOptions.map(agent => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role}</option>)}
            </select>
          ) : <div className="workflow-detail-value">👤 {node.agentName || 'System'}</div>}
        </section>
        <section>
          <label>{t('Modell für diese Aufgabe')}</label>
          {planning && typeName !== 'request' && modelConfig?.models?.length ? (
            <select className="form-select" value={modelConfig.currentModel} onChange={event => onModelChange?.(node.id, event.target.value)}>
              {modelConfig.models.map(model => <option key={model} value={model}>{model === modelConfig.defaultModel ? `${model} · ${t('Agentenstandard')}` : model}</option>)}
            </select>
          ) : <div className="workflow-detail-value">🧠 {modelConfig?.currentModel || node.model || '–'}</div>}
        </section>
        {node.lastRunMetrics && <section>
          <label>⏱ {t('Letzte Codex-Laufzeit')}</label>
          <div className="workflow-detail-value">
            {t('Gesamt')}: {((node.lastRunMetrics.totalMs || 0) / 1000).toFixed(1)} s
            {Number.isFinite(node.lastRunMetrics.firstEventMs) && <> · {t('Erste Aktivität')}: {(node.lastRunMetrics.firstEventMs / 1000).toFixed(1)} s</>}
            {Number.isFinite(node.lastRunMetrics.firstTextMs) && <> · {t('Erster Text')}: {(node.lastRunMetrics.firstTextMs / 1000).toFixed(1)} s</>}
            <br />
            {t('Denktiefe')}: {node.lastRunMetrics.reasoningEffort || 'medium'}
            {node.lastRunMetrics.resumed ? ` · ${t('Sitzung fortgesetzt')}` : ` · ${t('Neue Sitzung')}`}
            {node.lastRunMetrics.promptCharacters ? ` · ${Math.round(node.lastRunMetrics.promptCharacters / 100) / 10}k ${t('Zeichen')}` : ''}
          </div>
        </section>}
        {typeName === 'task' && <section className="workflow-delegation-config">
          <label><Icon name="users" size={16} /> {t('Gruppenübergreifende Aufgabendelegation')}</label>
          {!delegationEnabled && <div className="workflow-detail-empty">{t('In den Gruppeneinstellungen ist die gruppenübergreifende Zusammenarbeit ausgeschaltet.')}</div>}
          {taskEditable ? <>
            <select className="form-select" disabled={!delegationEnabled} value={delegation.mode} onChange={event => onTaskUpdate?.(node.id, { delegation: { ...delegation, mode: event.target.value } })}>
              <option value="never">{t('Nie delegieren')}</option>
              <option value="ask">{t('Vor Delegation User fragen')}</option>
              <option value="automatic">{t('Automatisch delegieren')}</option>
            </select>
            <label className="workflow-sub-label">{t('Benötigte Fähigkeiten')}</label>
            <textarea className="form-textarea" rows={3} disabled={!delegationEnabled || delegation.mode === 'never'} value={capabilitiesDraft} onChange={event => setCapabilitiesDraft(event.target.value)} onBlur={() => onTaskUpdate?.(node.id, { delegation: { ...delegation, requiredCapabilities: capabilitiesDraft.split('\n') } })} placeholder={t('Eine frei definierbare Fähigkeit pro Zeile')} />
            {delegationEnabled && delegation.mode !== 'never' && <div className="workflow-delegation-targets">
              <strong>{t('Erlaubte Zielgruppen')}</strong>
              <small>{t('Ohne Auswahl dürfen alle erreichbaren Zielgruppen verwendet werden.')}</small>
              {groupOptions.map(group => <label key={group.id}><input type="checkbox" checked={delegation.allowedTargetGroupIds.includes(group.id)} onChange={event => {
                const allowedTargetGroupIds = event.target.checked
                  ? [...delegation.allowedTargetGroupIds, group.id]
                  : delegation.allowedTargetGroupIds.filter(id => id !== group.id);
                onTaskUpdate?.(node.id, { delegation: { ...delegation, allowedTargetGroupIds } });
              }} /> <EntityIcon value={group.emoji} group size={18} /> {group.name}</label>)}
            </div>}
          </> : <div className="workflow-detail-value">{delegation.mode === 'never'
            ? t('Nicht erlaubt')
            : `${t(delegation.mode === 'automatic' ? 'Automatisch' : 'Nach User-Freigabe')} · ${delegation.requiredCapabilities.join(', ') || t('Keine Fähigkeiten angegeben')}`}</div>}
        </section>}
        <section>
          <label>{t('Fachliche Abhängigkeiten')}</label>
          {incomingDependencies.length === 0 && <div className="workflow-detail-empty">{t('Keine zusätzlichen Abhängigkeiten')}</div>}
          {incomingDependencies.map(dependency => (
            <div className="workflow-dependency-row" key={dependency.id}>
              <span title={dependency.title}>⛓ {dependency.title}</span>
              {planning && <button type="button" onClick={() => onDependencyRemove?.(dependency.id, node.id)} title={t('Abhängigkeit entfernen')}>×</button>}
            </div>
          ))}
          {planning && typeName !== 'request' && (
            <div className="workflow-dependency-create">
              <strong>＋ {t('Neue Abhängigkeit')}</strong>
              <small>{t('Diese Aufgabe startet erst, wenn der ausgewählte Vorgänger abgeschlossen ist.')}</small>
              <div className="workflow-dependency-add">
                <select className="form-select" value={dependencyDraft} onChange={event => setDependencyDraft(event.target.value)}>
                  <option value="">{t('Vorgänger auswählen…')}</option>
                  {dependencyCandidates.map(item => (
                    <option key={item.node.id} value={item.node.id} disabled={!item.validation.ok}>
                      {item.node.title}{item.validation.ok ? '' : ` · ${t('würde Zyklus erzeugen')}`}
                    </option>
                  ))}
                </select>
                <button type="button" className="btn btn-secondary" disabled={!dependencyDraft} onClick={() => {
                  if (!dependencyDraft) return;
                  onDependencyAdd?.(dependencyDraft, node.id);
                  setDependencyDraft('');
                }}>＋ {t('Hinzufügen')}</button>
              </div>
            </div>
          )}
        </section>
        <section>
          <label>🛡️ {t('Abnahmekriterien')}</label>
          {taskEditable && <><textarea className="form-textarea" rows={4} value={criteriaDraft} onChange={event => setCriteriaDraft(event.target.value)} onBlur={() => onAcceptanceCriteriaChange?.(node.id, parseAcceptanceCriterionDraft(criteriaDraft))} placeholder={t('[review], [auto] oder [user] · ein Kriterium pro Zeile')} /><small className="workflow-field-help">{t('[auto] nutzt den konfigurierten Prüfbefehl; [review] einen Prüfer; [user] deine manuelle Freigabe.')}</small></>}
          {!node.acceptanceCriteria?.length && <div className="workflow-detail-empty">{t('Keine Abnahmekriterien')}</div>}
          {!taskEditable && (node.acceptanceCriteria || []).map(criterion => {
            const criterionStatus = ACCEPTANCE_STATUS[criterion.status] || ACCEPTANCE_STATUS.open;
            const latestEvidence = (criterion.evidence || []).at(-1);
            return (
              <div className="workflow-criterion" key={criterion.id}>
                <div><i style={{ background: criterionStatus.color }} /><span>{criterion.text}</span></div>
                <small style={{ color: criterionStatus.color }}>{t(criterionStatus.label)}</small>
                {latestEvidence && <p>📎 {latestEvidence.author}: {latestEvidence.summary}</p>}
                {['agent_done', 'completed', 'retryable', 'blocked'].includes(node.status) && !['passed', 'waived'].includes(criterion.status) && onAcceptanceDecisionRequest && (
                  <div className="workflow-criterion-actions">
                    <button type="button" onClick={() => onAcceptanceDecisionRequest(node, criterion)}>{criterion.verification === 'user' ? `🛡 ${t('Manuell prüfen')}` : `⚠ ${t('Ausnahme prüfen')}`}</button>
                  </div>
                )}
              </div>
            );
          })}
        </section>
        {RECOVERABLE_STATUSES.has(node.status) && !planning && <section className="workflow-task-actions workflow-retry-actions"><label>{t('Problembehandlung')}</label><div><button type="button" className="workflow-retry-task" onClick={() => onRetryTask?.(node.id)}>↻ {t('Aufgabe erneut versuchen')}</button></div></section>}
        {taskEditable && <section className="workflow-task-actions"><label>{t('Aufgabe bearbeiten')}</label><div><button type="button" onClick={() => onTaskMove?.(node.id, -1)} title={t('Früher anzeigen')}>←</button><button type="button" onClick={() => onTaskMove?.(node.id, 1)} title={t('Später anzeigen')}>→</button><button type="button" onClick={() => onTaskSplit?.(node.id)}>{t('Teilen')}</button><button type="button" className="danger" onClick={() => onTaskDelete?.(node.id)}>{t('Löschen')}</button></div></section>}
      </div>}
    </aside>
  );
}

export default function TaskGraphPanel({ graph, running, activeTaskIds = [], pendingQuestions = [], pendingDelegations = [], groupRequests = [], workflowProblems = [], expertiseHelp = [], onSearchExpert, onCreateExpert, onAssignExpert, onConfigureExpertGroups, delegationEnabled = false, groupOptions = [], testConfigured = false, resumeMode = false, canResumeWorkflow = false, resumeRetrySeconds = 0, canUndo = false, canDeleteWorkflow, workflowImport = null, workflowFileStatus = {}, awaitingSchedule, structureEditable = awaitingSchedule, canEditWorkflow = false, nodesMovable = true, preflightError = '', preflightTaskIds = [], onRestoreSnapshot, onUndo, onDeleteWorkflow, onWorkflowImport, onWorkflowExport, onWorkflowImportMapping, onWorkflowImportApply, onWorkflowImportCancel, onWorkflowFileStatusClear, onQuestionAnswer, onProblemResolve, onPauseWorkflow, onPauseTask, onResumeTask, onResumeWorkflow, onEditWorkflow, onRetryTask, onTimeoutRepair, onGroupRequestRetry, onDelegationDecision, onStartWorkflow, onTaskAdd, onTaskUpdate, onTaskDelete, onTaskSplit, onTaskMove, onFlowPointAdd, onFlowPointDelete, onRunAcceptanceTests, onAcceptanceDecision, onConfigureTests, onOpenPreview, modelOptionsByTask = {}, agentOptions = [], onAgentChange, onModelChange, onDependencyAdd, onDependencyRemove, onAcceptanceCriteriaChange, onNodePositionChange, onResetLayout, dragHandleProps = null }) {
  const { t } = useI18n();
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const dragRef = useRef(null);
  const panRef = useRef(null);
  const connectionDraftRef = useRef(null);
  const connectionNoticeTimerRef = useRef(null);
  const initiallyFittedChatIdsRef = useRef(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState(null);
  const [selectedFlowPointId, setSelectedFlowPointId] = useState(null);
  const [dragPositions, setDragPositions] = useState({});
  const [scale, setScale] = useState(1);
  const [viewport, setViewport] = useState({ x: 18, y: 18 });
  const [initializedChatId, setInitializedChatId] = useState(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [detailsCollapsed, setDetailsCollapsed] = useState(false);
  const [detailsPinned, setDetailsPinned] = useState(false);
  const [connectionDraft, setConnectionDraft] = useState(null);
  const [connectionNotice, setConnectionNotice] = useState(null);
  const [selectedDependency, setSelectedDependency] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [connectionKind, setConnectionKind] = useState('dependency');
  const [inspectionReport, setInspectionReport] = useState(null);
  const [openQuestionTaskId, setOpenQuestionTaskId] = useState(null);
  const [openProblemTaskId, setOpenProblemTaskId] = useState(null);
  const [acceptanceProblem, setAcceptanceProblem] = useState(null);
  const [acceptanceDecisionRequest, setAcceptanceDecisionRequest] = useState(null);
  const [delegationTargets, setDelegationTargets] = useState({});
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState(() => readWorkflowWorkspaceTab(graph?.chatId || 'workflow'));
  const layout = useMemo(() => buildWorkflowLayout(graph), [graph]);
  const selectedNode = graph?.nodes?.find(node => node.id === selectedNodeId) || null;
  const automaticInspection = useMemo(() => inspectWorkflowPlan(graph), [graph]);
  const nodes = graph?.nodes || [];
  const workflowDeleteEnabled = canDeleteWorkflow ?? (nodes.length > 0);
  const chatId = graph?.chatId || 'workflow';
  const workflowIdentity = nodes.find(node => inferTaskNodeType(node) === 'request')?.id || chatId;
  const workflowFileBusy = Boolean(workflowFileStatus?.busy);
  const hasPortableTasks = nodes.some(node => inferTaskNodeType(node) !== 'request');
  useEffect(() => setActiveWorkspaceTab(readWorkflowWorkspaceTab(chatId)), [chatId]);
  const freeMovementEnabled = nodesMovable && initializedChatId === workflowIdentity;
  const flowPoints = layout.flowPoints || [];
  const selectedFlowPoint = flowPoints.find(point => point.id === selectedFlowPointId) || null;
  const completedCount = nodes.filter(node => ['agent_done', 'completed'].includes(node.status)).length;
  const activeCount = nodes.filter(node => ['running', 'waiting_user', 'waiting_group', 'delegation_pending'].includes(node.status) || node.recoveryStatus).length;
  const openCount = Math.max(0, nodes.length - completedCount - activeCount);
  const acceptance = useMemo(() => summarizeAcceptance(graph), [graph]);
  const attention = workflowAttention(nodes, groupRequests, pendingDelegations);
  const changeSet = useMemo(() => buildWorkflowChangeSet(graph), [graph]);
  const displayedEdges = useMemo(() => [
    ...(graph?.edges || []).map(edge => ({ edge, change: changeSet.edgeChanges[`${edge.kind || 'delegation'}:${edge.from || ''}->${edge.to || ''}`] || null })),
    ...changeSet.removedEdges.map(change => ({ edge: change.edge, change })),
  ], [changeSet, graph]);
  const validationNodeIds = useMemo(() => new Set([
    ...preflightTaskIds,
    ...(inspectionReport?.taskIds || []),
  ]), [inspectionReport, preflightTaskIds]);
  const selectedNodeProblems = useMemo(() => {
    if (!selectedNode) return [];
    const messages = new Set();
    const addEntry = entry => {
      if (!entry?.taskIds?.includes(selectedNode.id)) return;
      messages.add(t(entry.messageKey || entry.reason, entry.messageValues));
    };
    for (const report of [automaticInspection, inspectionReport].filter(Boolean)) {
      report.issues?.forEach(addEntry);
      report.warnings?.forEach(addEntry);
    }
    if (preflightError && preflightTaskIds.includes(selectedNode.id)) messages.add(preflightError);
    if (selectedNode.error) messages.add(String(selectedNode.error));
    if (selectedNode.recoveryError) messages.add(String(selectedNode.recoveryError));
    if (BLOCKED_REASON_LABELS[selectedNode.blockedReason]) messages.add(t(BLOCKED_REASON_LABELS[selectedNode.blockedReason]));
    if (selectedNode.status === 'timed_out' && !selectedNode.error && !selectedNode.recoveryError) {
      messages.add(t('Die Aufgabe hat ihr Zeitlimit überschritten.'));
    }
    if (selectedNode.status === 'failed' && !selectedNode.error) messages.add(t('Die Aufgabe ist ohne genauere Fehlermeldung fehlgeschlagen.'));
    return [...messages].filter(Boolean);
  }, [automaticInspection, inspectionReport, preflightError, preflightTaskIds, selectedNode, t]);
  const selectedNodeProblemSuggestions = useMemo(() => {
    if (!selectedNode) return [];
    const messages = new Set();
    const addEntry = entry => {
      if (!entry?.taskIds?.includes(selectedNode.id)) return;
      messages.add(t(entry.messageKey || entry.reason, entry.messageValues));
    };
    for (const report of [automaticInspection, inspectionReport].filter(Boolean)) report.suggestions?.forEach(addEntry);
    if (preflightError && preflightTaskIds.includes(selectedNode.id) && messages.size === 0) {
      messages.add(t('Prüfe die markierte Aufgabenangabe und die zugehörige Gruppen-, Agenten- oder Provider-Konfiguration.'));
    }
    if (RECOVERABLE_STATUSES.has(selectedNode.status)) {
      messages.add(t('Behebe zuerst die genannte Ursache und starte die Aufgabe anschließend erneut.'));
    }
    return [...messages].filter(Boolean);
  }, [automaticInspection, inspectionReport, preflightError, preflightTaskIds, selectedNode, t]);
  const activeTaskIdSet = useMemo(() => new Set(activeTaskIds || []), [activeTaskIds]);
  const pendingQuestionByTask = useMemo(() => new Map((pendingQuestions || []).map(question => [question.taskId, question])), [pendingQuestions]);
  const workflowProblemByTask = useMemo(() => new Map((workflowProblems || []).map(problem => [problem.taskId, problem])), [workflowProblems]);
  const groupRequestsByTask = useMemo(() => {
    const result = new Map();
    for (const request of groupRequests) {
      if (request.sourceGroupId !== graph?.chatId || !request.sourceTaskId) continue;
      if (!result.has(request.sourceTaskId)) result.set(request.sourceTaskId, []);
      result.get(request.sourceTaskId).push(request);
    }
    return result;
  }, [graph?.chatId, groupRequests]);
  const groupRequestTrees = useMemo(() => visibleGroupRequestTrees(groupRequests), [groupRequests]);
  const openQuestion = openQuestionTaskId ? pendingQuestionByTask.get(openQuestionTaskId) : null;
  const openQuestionNode = openQuestion ? nodes.find(node => node.id === openQuestion.taskId) : null;
  const openProblem = openProblemTaskId ? workflowProblemByTask.get(openProblemTaskId) : null;
  const startableNodeIds = nodes.filter(node =>
    PLANNABLE_STATUSES.has(node.status) &&
    inferTaskNodeType(node) !== 'request' &&
    isTaskNodeReady(graph, node.id)
  ).map(node => node.id);
  const readyParallelNodeIds = useMemo(() => findSafeAutoParallelTaskIds(graph, startableNodeIds.map(graphNodeId => ({ graphNodeId }))), [graph, startableNodeIds]);
  const validation = useMemo(() => validateParallelSelection(graph, readyParallelNodeIds), [graph, readyParallelNodeIds]);
  const canStartWorkflow = readyParallelNodeIds.length < 2 || validation.ok;
  const workflowStartDisabled = !running && (resumeMode
    ? !canResumeWorkflow
    : !awaitingSchedule || !canStartWorkflow || startableNodeIds.length === 0 || !!preflightError);
  const workflowStartTitle = running
    ? t('Laufenden Workflow unterbrechen und Arbeitsstand speichern')
    : resumeMode
      ? (canResumeWorkflow
        ? t('Gespeicherten Workflow im Chat fortsetzen')
        : t('Provider-Limit · Fortsetzen in {seconds}s', { seconds: resumeRetrySeconds }))
      : preflightError || (!awaitingSchedule
      ? t('Der Workflow wartet derzeit nicht auf einen Start.')
      : startableNodeIds.length === 0
        ? t('Keine Aufgabe ist aktuell startbereit.')
        : !canStartWorkflow
          ? t(validation.messageKey || validation.reason, validation.messageValues)
          : t('Workflow und Agenten im Chat starten'));
  const startWorkflow = () => {
    if (workflowStartDisabled) return;
    if (running) onPauseWorkflow?.();
    else if (resumeMode) onResumeWorkflow?.();
    else onStartWorkflow?.(readyParallelNodeIds.length >= 2 ? readyParallelNodeIds : []);
  };
  const centeredViewportForScale = useCallback((nextScale) => {
    const element = canvasRef.current;
    if (!element) return { x: 18, y: 18 };
    const scaledWidth = layout.width * nextScale;
    const scaledHeight = layout.height * nextScale;
    return {
      x: Math.max(18, (element.clientWidth - scaledWidth) / 2),
      y: Math.max(18, (element.clientHeight - scaledHeight) / 2),
    };
  }, [layout.height, layout.width]);
  const fitView = useCallback(() => {
    const element = canvasRef.current;
    if (!element || !layout.width || !layout.height) return;
    const nextScale = Math.min(1, Math.max(.35, Math.min(
      Math.max(1, element.clientWidth - 36) / layout.width,
      Math.max(1, element.clientHeight - 36) / layout.height,
    )));
    setScale(nextScale);
    setViewport(centeredViewportForScale(nextScale));
  }, [centeredViewportForScale, layout.height, layout.width]);
  const zoomBy = useCallback((amount) => {
    const nextScale = Math.min(1.8, Math.max(.35, Number((scale + amount).toFixed(2))));
    const element = canvasRef.current;
    if (element) {
      // Zoom around the current viewport center. Re-centering the graph here
      // would discard a viewport that the user positioned deliberately.
      const centerX = element.clientWidth / 2;
      const centerY = element.clientHeight / 2;
      const ratio = nextScale / scale;
      setViewport(current => ({
        x: centerX - ((centerX - current.x) * ratio),
        y: centerY - ((centerY - current.y) * ratio),
      }));
    }
    setScale(nextScale);
  }, [scale]);

  useEffect(() => {
    if (selectedNodeId && !nodes.some(node => node.id === selectedNodeId)) {
      setSelectedNodeId(null);
      setDetailsPinned(false);
      setDetailsCollapsed(false);
    }
  }, [nodes, selectedNodeId]);

  useEffect(() => {
    if (selectedFlowPointId && !flowPoints.some(point => point.id === selectedFlowPointId)) {
      setSelectedFlowPointId(null);
    }
  }, [flowPoints, selectedFlowPointId]);

  useEffect(() => setInspectionReport(null), [graph]);

  useEffect(() => {
    if (openQuestionTaskId && !pendingQuestionByTask.has(openQuestionTaskId)) setOpenQuestionTaskId(null);
  }, [openQuestionTaskId, pendingQuestionByTask]);

  useEffect(() => () => window.clearTimeout(connectionNoticeTimerRef.current), []);

  useEffect(() => {
    const element = canvasRef.current;
    if (!element || nodes.length === 0) return undefined;
    if (initiallyFittedChatIdsRef.current.has(workflowIdentity)) {
      setInitializedChatId(workflowIdentity);
      return undefined;
    }
    let frame = 0;
    let observer = null;
    // Fit each workflow exactly once, after its canvas has a measurable size.
    // Later graph updates, sidebar changes and window resizes retain the user's
    // viewport. The explicit "fit all" control remains available on demand.
    const performInitialFit = () => {
      frame = 0;
      if (
        initiallyFittedChatIdsRef.current.has(workflowIdentity) ||
        element.clientWidth <= 0 ||
        element.clientHeight <= 0
      ) return;
      fitView();
      initiallyFittedChatIdsRef.current.add(workflowIdentity);
      setInitializedChatId(workflowIdentity);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleInitialFit);
    };
    const scheduleInitialFit = () => {
      if (initiallyFittedChatIdsRef.current.has(workflowIdentity)) return;
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(performInitialFit);
    };
    scheduleInitialFit();
    observer = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleInitialFit) : null;
    observer?.observe(element);
    window.addEventListener('resize', scheduleInitialFit);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', scheduleInitialFit);
    };
  }, [fitView, nodes.length, workflowIdentity]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = event => {
      if (event.type === 'keydown' && event.key !== 'Escape') return;
      setContextMenu(null);
    };
    window.addEventListener('pointerdown', closeMenu);
    window.addEventListener('keydown', closeMenu);
    return () => {
      window.removeEventListener('pointerdown', closeMenu);
      window.removeEventListener('keydown', closeMenu);
    };
  }, [contextMenu]);

  useEffect(() => {
    const draft = connectionDraftRef.current;
    if (!draft) return;
    if (!structureEditable || !nodes.some(node => node.id === draft.sourceId)) {
      connectionDraftRef.current = null;
      setConnectionDraft(null);
    }
  }, [nodes, structureEditable]);

  useEffect(() => {
    if (!selectedDependency) return;
    const stillExists = structureEditable && [...(graph?.edges || []), ...(graph?.flowEdges || [])].some(edge => (
      edge.kind === selectedDependency.kind &&
      edge.from === selectedDependency.from &&
      edge.to === selectedDependency.to
    ));
    if (!stillExists) setSelectedDependency(null);
  }, [graph, selectedDependency, structureEditable]);

  const selectNode = nodeId => {
    setSelectedNodeId(nodeId);
    setSelectedFlowPointId(null);
    setDetailsCollapsed(false);
  };
  const selectFlowPoint = pointId => {
    setSelectedFlowPointId(pointId);
    setSelectedNodeId(null);
    setSelectedDependency(null);
    setDetailsPinned(false);
    setDetailsCollapsed(false);
  };
  const closeDetails = () => {
    setSelectedNodeId(null);
    setDetailsPinned(false);
    setDetailsCollapsed(false);
  };
  const deleteToolbarSelection = () => {
    if (!structureEditable) return;
    if (selectedFlowPoint) {
      onFlowPointDelete?.(selectedFlowPoint.id);
      setSelectedFlowPointId(null);
      return;
    }
    if (selectedNode && inferTaskNodeType(selectedNode) !== 'request') {
      onTaskDelete?.(selectedNode.id);
      closeDetails();
    }
  };
  const canDeleteToolbarSelection = Boolean(
    structureEditable && (selectedFlowPoint || (selectedNode && inferTaskNodeType(selectedNode) !== 'request'))
  );

  const resolvedPosition = nodeId => dragPositions[nodeId] || layout.positions.get(nodeId) || { x: 0, y: 0 };
  const resolvedRailPoint = point => dragPositions[point.id] || point;
  const endpointPosition = (endpointId, side = 'to') => {
    const point = layout.pointById.get(endpointId);
    if (point) {
      const position = resolvedRailPoint(point);
      return { x: position.x, y: position.y };
    }
    const position = resolvedPosition(endpointId);
    return { x: position.x + (side === 'from' ? layout.nodeWidth : 0), y: position.y + layout.nodeHeight / 2 };
  };
  const updateConnectionDraft = draft => {
    connectionDraftRef.current = draft;
    setConnectionDraft(draft);
  };
  const showConnectionNotice = (type, text) => {
    window.clearTimeout(connectionNoticeTimerRef.current);
    setConnectionNotice({ type, text });
    connectionNoticeTimerRef.current = window.setTimeout(() => setConnectionNotice(null), 2400);
  };
  const stagePointFromClient = (clientX, clientY) => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: (clientX - rect.left) / scale, y: (clientY - rect.top) / scale };
  };
  const connectionTargetAt = (clientX, clientY) => document
    .elementFromPoint(clientX, clientY)
    ?.closest?.('[data-workflow-endpoint]')
    ?.getAttribute('data-workflow-endpoint') || null;
  const validateConnectionTarget = (sourceId, targetId) => {
    if (!targetId) return null;
    const sourceNode = nodes.find(node => node.id === sourceId);
    const targetNode = nodes.find(node => node.id === targetId);
    const sourcePoint = flowPoints.find(point => point.id === sourceId);
    const targetPoint = flowPoints.find(point => point.id === targetId);
    if ((!sourceNode && !sourcePoint) || (!targetNode && !targetPoint)) return { ok: false, reason: t('Workflow-Element wurde nicht gefunden.') };
    if (sourceNode && inferTaskNodeType(sourceNode) === 'review') return { ok: false, reason: t('Eine PM-Abnahme kann keine Folgeaufgabe starten.') };
    if (targetNode && inferTaskNodeType(targetNode) === 'request') return { ok: false, reason: t('Die Startanforderung kann keine Folgeaufgabe sein.') };
    const validationResult = validateWorkflowConnection(graph, sourceId, targetId, connectionKind);
    if (validationResult.exists) return { ok: false, exists: true, reason: t('Diese Abhängigkeit besteht bereits.') };
    return validationResult;
  };
  const handleConnectionStart = (sourceId, event) => {
    if (!structureEditable) return;
    const draft = {
      sourceId,
      pointerId: event.pointerId,
      start: endpointPosition(sourceId, 'from'),
      current: stagePointFromClient(event.clientX, event.clientY),
      targetId: null,
      validation: null,
      requestedKind: connectionKind,
    };
    if (nodes.some(node => node.id === sourceId)) selectNode(sourceId);
    else if (flowPoints.some(point => point.id === sourceId)) selectFlowPoint(sourceId);
    setSelectedDependency(null);
    setConnectionNotice(null);
    updateConnectionDraft(draft);
  };
  const handleConnectionMove = event => {
    const draft = connectionDraftRef.current;
    if (!draft || draft.pointerId !== event.pointerId) return;
    const targetId = connectionTargetAt(event.clientX, event.clientY);
    updateConnectionDraft({
      ...draft,
      current: stagePointFromClient(event.clientX, event.clientY),
      targetId,
      validation: validateConnectionTarget(draft.sourceId, targetId),
    });
  };
  const handleConnectionEnd = (event, cancelled = false) => {
    const draft = connectionDraftRef.current;
    if (!draft || draft.pointerId !== event.pointerId) return;
    const targetId = cancelled ? null : connectionTargetAt(event.clientX, event.clientY);
    const validationResult = validateConnectionTarget(draft.sourceId, targetId);
    if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    updateConnectionDraft(null);
    if (!targetId || cancelled) return;
    if (!validationResult?.ok) {
      showConnectionNotice('error', t(validationResult?.messageKey || validationResult?.reason || 'Diese Abhängigkeit ist ungültig.', validationResult?.messageValues));
      return;
    }
    const sourceNode = nodes.find(node => node.id === draft.sourceId);
    const targetNode = nodes.find(node => node.id === targetId);
    const sourcePoint = flowPoints.find(point => point.id === draft.sourceId);
    const targetPoint = flowPoints.find(point => point.id === targetId);
    onDependencyAdd?.(draft.sourceId, targetId, validationResult.kind);
    if (targetNode) selectNode(targetId);
    showConnectionNotice('success', t('{kind} erstellt: {from} → {to}', {
      kind: t(validationResult.kind === 'review' ? 'Abnahme' : validationResult.kind === 'flow' ? 'Ablauf' : 'Abhängigkeit'),
      from: sourceNode?.title || sourcePoint?.title || draft.sourceId,
      to: targetNode?.title || targetPoint?.title || targetId,
    }));
  };
  const connectionPreviewEnd = connectionDraft?.targetId
    ? endpointPosition(connectionDraft.targetId, 'to')
    : connectionDraft?.current;
  const connectionPreviewState = connectionDraft?.targetId
    ? connectionDraft.validation?.ok ? 'valid' : 'invalid'
    : 'pending';
  const selectedDependencyPosition = selectedDependency
    ? (() => {
      const from = endpointPosition(selectedDependency.from, 'from');
      const to = endpointPosition(selectedDependency.to, 'to');
      return {
        x: (from.x + to.x) / 2,
        y: (from.y + to.y) / 2,
      };
    })()
    : null;
  const removeSelectedDependency = () => {
    if (!selectedDependency || !structureEditable) return;
    const fromNode = nodes.find(node => node.id === selectedDependency.from);
    const toNode = nodes.find(node => node.id === selectedDependency.to);
    const fromPoint = flowPoints.find(point => point.id === selectedDependency.from);
    const toPoint = flowPoints.find(point => point.id === selectedDependency.to);
    onDependencyRemove?.(selectedDependency.from, selectedDependency.to, selectedDependency.kind);
    showConnectionNotice('success', t('{kind} gelöst: {from} → {to}', {
      kind: t(selectedDependency.kind === 'review' ? 'Abnahme' : selectedDependency.kind === 'flow' ? 'Ablauf' : 'Abhängigkeit'),
      from: fromNode?.title || fromPoint?.title || selectedDependency.from,
      to: toNode?.title || toPoint?.title || selectedDependency.to,
    }));
    setSelectedDependency(null);
  };
  const railEndpoint = endpointPosition;
  const handleElementDragStart = (elementId, position, event, select = false) => {
    dragRef.current = { nodeId: elementId, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, position };
    if (select) setSelectedNodeId(elementId);
  };
  const handleNodeDragMove = (nodeId, event) => {
    const drag = dragRef.current;
    if (!drag || drag.nodeId !== nodeId || drag.pointerId !== event.pointerId) return;
    const position = { x: Math.max(8, drag.position.x + (event.clientX - drag.startX) / scale), y: Math.max(8, drag.position.y + (event.clientY - drag.startY) / scale) };
    setDragPositions(current => ({ ...current, [nodeId]: position }));
  };
  const handleNodeDragEnd = (nodeId, event, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.nodeId !== nodeId || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget?.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (cancelled) {
      dragRef.current = null;
      setDragPositions(current => {
        const updated = { ...current };
        delete updated[nodeId];
        return updated;
      });
      return;
    }
    const position = {
      x: Math.max(8, drag.position.x + (event.clientX - drag.startX) / scale),
      y: Math.max(8, drag.position.y + (event.clientY - drag.startY) / scale),
    };
    dragRef.current = null;
    setDragPositions(current => ({ ...current, [nodeId]: position }));
    onNodePositionChange?.(nodeId, position);
  };
  const handleCanvasPointerDown = event => {
    if (event.button !== 0 || event.target.closest('.workflow-node,.workflow-details')) return;
    setContextMenu(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, viewport };
    setSelectedDependency(null);
    setSelectedFlowPointId(null);
    if (!detailsPinned) closeDetails();
  };
  const handleCanvasPointerMove = event => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    setViewport({ x: pan.viewport.x + event.clientX - pan.x, y: pan.viewport.y + event.clientY - pan.y });
  };
  const handleCanvasPointerEnd = event => {
    if (panRef.current?.pointerId === event.pointerId) panRef.current = null;
  };
  const handleCanvasContextMenu = event => {
    if (!structureEditable || event.target.closest('.workflow-details')) return;
    event.preventDefault();
    event.stopPropagation();
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const targetPointId = event.target.closest('[data-workflow-flowpoint]')?.getAttribute('data-workflow-flowpoint') || null;
    const targetTaskId = event.target.closest('[data-workflow-node]')?.getAttribute('data-workflow-node') || null;
    if (targetTaskId) selectNode(targetTaskId);
    else if (targetPointId) selectFlowPoint(targetPointId);
    setContextMenu({
      left: event.clientX - (canvasRect?.left || 0) + (canvasRef.current?.scrollLeft || 0),
      top: event.clientY - (canvasRect?.top || 0) + (canvasRef.current?.scrollTop || 0),
      position: stagePointFromClient(event.clientX, event.clientY),
      targetPointId,
      targetTaskId,
    });
  };
  const runContextAction = action => {
    const menu = contextMenu;
    setContextMenu(null);
    if (!menu) return;
    if (action === 'task') onTaskAdd?.(menu.position);
    if (action === 'review-task') onTaskAdd?.(menu.position, 'review');
    if (action === 'delete-task' && menu.targetTaskId) {
      onTaskDelete?.(menu.targetTaskId);
      if (selectedNodeId === menu.targetTaskId) closeDetails();
    }
    if (action === 'fork' || action === 'join') onFlowPointAdd?.(action, menu.position);
    if (action === 'delete-point' && menu.targetPointId) {
      onFlowPointDelete?.(menu.targetPointId);
      if (selectedFlowPointId === menu.targetPointId) setSelectedFlowPointId(null);
    }
    if (action === 'connection-dependency' || action === 'connection-review') setConnectionKind(action.replace('connection-', ''));
  };
  const inspectPlan = () => {
    const report = inspectWorkflowPlan(graph);
    if (report.ok && preflightError) {
      report.ok = false;
      report.issues.push({ messageKey: preflightError, taskIds: preflightTaskIds });
      report.suggestions.push({ messageKey: 'Verbinde den benötigten Provider oder weise die betroffenen Aufgaben einem verfügbaren Agenten zu.', taskIds: preflightTaskIds });
      report.taskIds = [...new Set([...report.taskIds, ...preflightTaskIds])];
    }
    setInspectionReport(report);
  };
  const deleteWorkflow = () => {
    if (!workflowDeleteEnabled) return;
    const confirmed = window.confirm(t(
      'Workflow wirklich löschen? Hauptworkflow, Gruppenarbeit und gespeicherter Fortsetzungsstand werden entfernt. Chatnachrichten und Gruppen bleiben erhalten.',
    ));
    if (confirmed) onDeleteWorkflow?.();
  };
  const selectWorkspaceTab = nextTab => {
    if (!WORKFLOW_WORKSPACE_TABS.has(nextTab)) return;
    setActiveWorkspaceTab(nextTab);
    persistWorkflowWorkspaceTab(chatId, nextTab);
  };
  const handleWorkspaceTabKeyDown = event => {
    const order = ['workflow', 'tests', 'collaboration'];
    const currentIndex = order.indexOf(activeWorkspaceTab);
    let nextTab = '';
    if (event.key === 'ArrowRight') nextTab = order[(currentIndex + 1) % order.length];
    if (event.key === 'ArrowLeft') nextTab = order[(currentIndex - 1 + order.length) % order.length];
    if (event.key === 'Home') nextTab = order[0];
    if (event.key === 'End') nextTab = order.at(-1);
    if (!nextTab) return;
    event.preventDefault();
    const tabList = event.currentTarget.parentElement;
    selectWorkspaceTab(nextTab);
    window.requestAnimationFrame(() => tabList?.querySelector(`[data-workflow-tab="${nextTab}"]`)?.focus());
  };

  const acceptSuggestion = (node, suggestion, existingProblem = null) => {
    const text = String(suggestion || '').trim();
    if (!text) return;
    const canRepair = !structureEditable && RECOVERABLE_STATUSES.has(node.status) && (!existingProblem || existingProblem.kind === 'execution');
    const problem = {
      ...existingProblem, taskId: node.id, taskTitle: node.title,
      kind: canRepair ? 'execution' : 'plan',
      message: existingProblem?.message || text, suggestion: text,
    };
    onProblemResolve?.(node.id, text, problem, canRepair ? 'runtime-recovery' : 'plan-revision');
  };

  return (
    <aside className="workflow-panel">
      <div {...(dragHandleProps || {})} className={dragHandleProps ? 'task-window-drag-handle workflow-header' : 'workflow-header'} title={dragHandleProps ? t('Zum Verschieben ziehen') : undefined}>
        <div className="workflow-header-icon"><Icon name="workflow" size={20} /></div>
        <div className="workflow-header-copy"><strong>{t('Workflow')}</strong><span>{t('{tasks} Aufgaben', { tasks: nodes.length })}{graph?.changeRequest ? ` · ${t('Änderungsentwurf · Version {version}', { version: graph.planRevision })}` : graph?.approvedPlan ? ` · ${t('Freigegebener Plan · Version {version}', { version: graph.approvedPlan.revision })}` : ` · ${t('Planentwurf')}`}</span></div>
        <div className="workflow-header-counts">
          {acceptance.required > 0 && <span className="acceptance"><Icon name="shield" size={14} /> {t('Abnahme')} {acceptance.passed}/{acceptance.required}</span>}
          <span className="done">{completedCount} {t('Erledigt')}</span><span className="active">{activeCount} {t('Aktiv')}</span><span className="open">{openCount} {t('Offen')}</span>
        </div>
        <ChatOptionsMenu label="Datei" icon="folder" showLabel>
          <div className="workflow-file-menu-actions">
        <button
          type="button"
          className="workflow-file-button export"
          onClick={onWorkflowExport}
          disabled={running || workflowFileBusy || !hasPortableTasks}
          title={t('Workflow ohne Laufzeitdaten exportieren')}
          aria-label={t('Workflow exportieren')}
        >
          <Icon name="transfer" size={16} /><b>{t(workflowFileStatus?.busy === 'export' ? 'Exportiere…' : 'Export')}</b>
        </button>

        <button
          type="button"
          className="workflow-file-button import"
          onClick={onWorkflowImport}
          disabled={running || workflowFileBusy}
          title={t('Workflow-Datei als Planungsentwurf importieren')}
          aria-label={t('Workflow importieren')}
        >
          <Icon name="transfer" size={16} /><b>{t(workflowFileStatus?.busy === 'import' ? 'Importiere…' : 'Import')}</b>
        </button>
          </div>
        </ChatOptionsMenu>
        <button
          type="button"
          className="workflow-undo-button"
          onClick={onUndo}
          disabled={running || !structureEditable || !canUndo}
          title={t(canUndo ? 'Letzte Planänderung rückgängig machen' : 'Keine Planänderung zum Rückgängigmachen')}
          aria-label={t('Letzte Planänderung rückgängig machen')}
        >
          <Icon name="undo" size={16} />
          {t('Rückgängig')}
        </button>
        <button
          type="button"
          className={`workflow-play-button ${running ? 'running' : ''} ${resumeMode && !running ? 'resume' : ''}`}
          onClick={startWorkflow}
          disabled={workflowStartDisabled}
          title={workflowStartTitle}
          aria-label={workflowStartTitle}
          aria-pressed={running}
        >
          <Icon name={running ? 'stop' : 'play'} size={16} />
          {t(running ? 'Workflow unterbrechen' : resumeMode ? 'Workflow fortsetzen' : structureEditable ? 'Plan freigeben & starten' : 'Workflow starten')}
        </button>
        <button
          type="button"
          className="workflow-delete-button"
          onClick={deleteWorkflow}
          disabled={!workflowDeleteEnabled}
          title={t(running ? 'Laufenden Workflow stoppen und samt Gruppenarbeit löschen' : 'Workflow, Gruppenarbeit und Fortsetzungsstand löschen')}
          aria-label={t('Workflow löschen')}
        >
          <Icon name="trash" size={16} />
          {t('Löschen')}
        </button>
      </div>
      {(workflowFileStatus?.message || workflowFileStatus?.error || workflowFileBusy) && <div className={`workflow-file-status ${workflowFileStatus?.error ? 'error' : workflowFileBusy ? 'busy' : 'success'}`} role={workflowFileStatus?.error ? 'alert' : 'status'}>
        <span>{workflowFileStatus?.error ? '⚠' : workflowFileBusy ? '◌' : '✓'}</span>
        <strong>{workflowFileStatus?.error || workflowFileStatus?.message || t(workflowFileStatus?.busy === 'export' ? 'Workflow wird exportiert…' : 'Workflow-Datei wird geprüft…')}</strong>
        {!workflowFileBusy && <button type="button" onClick={onWorkflowFileStatusClear} title={t('Hinweis schließen')}>×</button>}
      </div>}
      <div className="workflow-workspace-tabs" role="tablist" aria-label={t('Workflow-Ansicht')}>
        <button type="button" role="tab" id="workflow-tab-main" data-workflow-tab="workflow" aria-controls="workflow-tabpanel-main" aria-selected={activeWorkspaceTab === 'workflow'} tabIndex={activeWorkspaceTab === 'workflow' ? 0 : -1} className={activeWorkspaceTab === 'workflow' ? 'active' : ''} onKeyDown={handleWorkspaceTabKeyDown} onClick={() => selectWorkspaceTab('workflow')}><Icon name="workflow" size={16} /> {t('Hauptworkflow')}</button>
        <button type="button" role="tab" id="workflow-tab-tests" data-workflow-tab="tests" aria-controls="workflow-tabpanel-tests" aria-selected={activeWorkspaceTab === 'tests'} tabIndex={activeWorkspaceTab === 'tests' ? 0 : -1} className={`${activeWorkspaceTab === 'tests' ? 'active' : ''} ${attention.tests.decisions ? 'needs-decision' : attention.tests.open ? 'has-open-work' : ''}`} title={attention.tests.decisions ? t('Entscheidung erforderlich') : attention.tests.open ? t('Offene Aufgaben') : undefined} onKeyDown={handleWorkspaceTabKeyDown} onClick={() => selectWorkspaceTab('tests')}><Icon name="test" size={16} /> {t('Prüfungen')}<span>{attention.tests.open || acceptance.required}</span>{attention.tests.decisions > 0 && <b className="workflow-tab-alert">! {t('Entscheidung')}</b>}</button>
        <button type="button" role="tab" id="workflow-tab-collaboration" data-workflow-tab="collaboration" aria-controls="workflow-tabpanel-collaboration" aria-selected={activeWorkspaceTab === 'collaboration'} tabIndex={activeWorkspaceTab === 'collaboration' ? 0 : -1} className={`${activeWorkspaceTab === 'collaboration' ? 'active' : ''} ${(attention.collaboration.decisions || expertiseHelp.length) ? 'needs-decision' : attention.collaboration.open ? 'has-open-work' : ''}`} title={attention.collaboration.decisions ? t('Entscheidung erforderlich') : attention.collaboration.open ? t('Offene Aufgaben') : undefined} onKeyDown={handleWorkspaceTabKeyDown} onClick={() => selectWorkspaceTab('collaboration')}><Icon name="users" size={16} /> {t('Gruppenarbeit')}<span>{attention.collaboration.open || expertiseHelp.length || groupRequests.length}</span>{(attention.collaboration.decisions > 0 || expertiseHelp.length > 0) && <b className="workflow-tab-alert">! {t('Entscheidung')}</b>}</button>
      </div>
      {pendingDelegations.length > 0 && <div className="workflow-delegation-requests" aria-label={t('Offene Delegationsfreigaben')}>
        <strong><Icon name="users" size={16} /> {t('Delegation freigeben')}</strong>
        <div>{pendingDelegations.map(waiting => {
          const proposal = waiting.proposal || {};
          const candidates = proposal.candidates || [];
          const selectedCandidateId = delegationTargets[waiting.taskId] || proposal.candidate?.candidateId || '';
          return <article key={waiting.taskId}>
            <span title={proposal.taskTitle}>{proposal.taskTitle}</span>
            <select value={selectedCandidateId} onChange={event => setDelegationTargets(current => ({ ...current, [waiting.taskId]: event.target.value }))}>
              {candidates.length === 0 && <option value="">{t('Keine erreichbare Zielgruppe verfügbar')}</option>}
              {candidates.map(candidate => <option key={candidate.candidateId || `${candidate.groupId}:${candidate.agentId}`} value={candidate.candidateId || candidate.agentId}>{candidate.groupEmoji || '💬'} {candidate.groupName} · {candidate.agentName}{candidate.inferred ? ` · ${t('semantisch zugeordnet')}` : ''}</option>)}
            </select>
            <button type="button" className="approve" disabled={running || !selectedCandidateId} onClick={() => onDelegationDecision?.(waiting.taskId, 'delegate', selectedCandidateId)}>✓ {t('Delegieren')}</button>
            <button type="button" disabled={running} onClick={() => onDelegationDecision?.(waiting.taskId, 'local', '')}>{t('Lokal ausführen')}</button>
          </article>;
        })}</div>
      </div>}
      <div className="workflow-main-view" role="tabpanel" id="workflow-tabpanel-main" aria-labelledby="workflow-tab-main" hidden={activeWorkspaceTab !== 'workflow'}>
      {awaitingSchedule && <div className={`workflow-planning-note ${changeSet.active ? 'change-draft' : ''}`}>
        <div>
          <strong>{t(changeSet.active ? 'Änderungsentwurf – rot markierte Bereiche' : structureEditable ? 'Planungsmodus aktiv' : 'Ausführungsplanung pausiert')}</strong>
          <span>{t(changeSet.active
            ? 'Vergleich mit dem freigegebenen Snapshot {version}: {changed} markierte Aufgaben, {removed} entfernte Aufgaben. Laufzeitstatus werden nicht als Planänderung gewertet.'
            : structureEditable
              ? 'Wähle eine Aufgabe für Details. Prüfe den Plan und starte ihn oben mit „Plan freigeben & starten“.'
              : 'Wähle nur die Ausführungsreihenfolge der offenen Aufgaben. Der freigegebene Workflow bleibt unverändert.',
          { version: changeSet.baselineRevision || '–', changed: Object.keys(changeSet.nodeChanges).length, removed: changeSet.removedNodes.length })}</span>
          {changeSet.removedNodes.length > 0 && <span className="workflow-removed-summary">{t('Entfernt')}: {changeSet.removedNodes.map(node => node.title || node.id).join(', ')}</span>}
        </div>
        {structureEditable && <div className="workflow-planning-actions">
          <button type="button" className="workflow-check-plan" onClick={inspectPlan} disabled={running} title={t('Aufgabenplan auf Ausführbarkeit prüfen')}>✓ {t('Prüfen')}</button>
          {changeSet.active && <button type="button" className="workflow-restore-snapshot" disabled={running} onClick={() => {
            if (window.confirm(t('Den Änderungsentwurf verwerfen und Workflow-Snapshot {version} wiederherstellen?', { version: changeSet.baselineRevision || '–' }))) onRestoreSnapshot?.();
          }} title={t('Aufgaben und Verbindungen aus dem letzten freigegebenen Snapshot wiederherstellen')}>↶ {t('Snapshot wiederherstellen')}</button>}
        </div>}
      </div>}
      {!awaitingSchedule && <div className="workflow-guidance">
        <Icon name="info" size={16} />
        <span>{t(running ? 'Der Workflow läuft. Wähle eine Aufgabe, um Fortschritt und Ergebnisse zu sehen.' : structureEditable ? 'Prüfe die Aufgaben und ihre Abhängigkeiten. Mit „Plan freigeben & starten“ beginnt die Ausführung.' : 'Wähle eine Aufgabe für Details. Offene Entscheidungen findest du unter Prüfungen und Gruppenarbeit.')}</span>
      </div>}
      <div className="workflow-toolbar">

        <div className="workflow-view-controls">
          <div className="workflow-tool-group" role="group" aria-label={t('Ansicht')}>
          <b className="workflow-tool-label">{t('Ansicht')}</b>
          <button type="button" onClick={() => setLegendOpen(current => !current)} title={t('Legende anzeigen')}>?</button>
          <button type="button" onClick={() => zoomBy(-.1)} title={t('Verkleinern')}>−</button><span>{Math.round(scale * 100)}%</span><button type="button" onClick={() => zoomBy(.1)} title={t('Vergrößern')}>+</button>
          <button type="button" onClick={fitView} title={t('Alles einpassen')}>⌗</button>
          </div>
          <div className="workflow-tool-group" role="group" aria-label={t('Plan bearbeiten')}>
          <b className="workflow-tool-label">{t('Plan')}</b>
          {canEditWorkflow && !structureEditable && <button type="button" className="workflow-add-task" onClick={onEditWorkflow} disabled={running}>✎ {t('Plan bearbeiten')}</button>}
          {structureEditable && <button type="button" className="workflow-add-task" onClick={() => onTaskAdd?.()} title={t('Aufgabe hinzufügen')}>＋ {t('Aufgabe')}</button>}
          {structureEditable && <button type="button" className="workflow-add-task" onClick={() => onTaskAdd?.(null, 'review')} title={t('Abnahme hinzufügen')}>◆ {t('Abnahme')}</button>}
          {freeMovementEnabled && <button type="button" onClick={() => { setDragPositions({}); onResetLayout?.(); }} title={t('Automatisch anordnen')}>↺</button>}
          {structureEditable && <details className="workflow-advanced-tools">
            <summary>{t('Verbindungen & Verzweigungen')} · {t(connectionKind === 'review' ? 'Abnahme' : 'Abhängigkeit')}</summary>
            <div className="workflow-advanced-content">
              <p>{t('Abhängigkeiten bestimmen die Reihenfolge. Das Verschieben von Karten ändert nur die Darstellung.')}</p>
          {structureEditable && <button type="button" className="workflow-add-flow-point" onClick={() => onFlowPointAdd?.('fork')} title={t('Fork-Punkt erstellen')}>⑂ {t('Verzweigung')}</button>}
          {structureEditable && <button type="button" className="workflow-add-flow-point" onClick={() => onFlowPointAdd?.('join')} title={t('Join-Punkt erstellen')}>⑃ {t('Zusammenführung')}</button>}

          {structureEditable && <button type="button" className={`workflow-connection-tool dependency ${connectionKind === 'dependency' ? 'active' : ''}`} aria-pressed={connectionKind === 'dependency'} onClick={() => setConnectionKind('dependency')} title={t('Neue Verbindungen als Abhängigkeit erstellen')}>⛓ {t('Abhängigkeit')}</button>}
          {structureEditable && <button type="button" className={`workflow-connection-tool review ${connectionKind === 'review' ? 'active' : ''}`} aria-pressed={connectionKind === 'review'} onClick={() => setConnectionKind('review')} title={t('Neue Verbindungen als Abnahme erstellen')}>◆ {t('Abnahme-Verbindung')}</button>}

            </div>
          </details>}
          </div>
          {structureEditable && <button type="button" className="workflow-delete-selection" onClick={deleteToolbarSelection} disabled={!canDeleteToolbarSelection} title={t(canDeleteToolbarSelection ? 'Ausgewählte Aufgabe oder Fork-/Join-Punkt löschen' : 'Wähle zuerst eine löschbare Aufgabe oder einen Fork-/Join-Punkt aus')}>× {t('Auswahl löschen')}</button>}
        </div>
      </div>
      {inspectionReport && <div className={`workflow-inspection-report ${inspectionReport.ok ? 'ok' : 'error'}`} role="status">
        <div className="workflow-inspection-head">
          <strong>{inspectionReport.ok ? `✓ ${t('Aufgabenplan ist ausführbar')}` : `⚠ ${t('Aufgabenplan benötigt Korrekturen')}`}</strong>
          <button type="button" onClick={() => setInspectionReport(null)} title={t('Prüfbericht schließen')}>×</button>
        </div>
        {inspectionReport.issues.length > 0 && <section><b>{t('Probleme')}</b><ul>{inspectionReport.issues.map((issue, index) => <li key={`issue-${index}`}>{t(issue.messageKey, issue.messageValues)}</li>)}</ul></section>}
        {inspectionReport.warnings.length > 0 && <section><b>{t('Hinweise')}</b><ul>{inspectionReport.warnings.map((warning, index) => <li key={`warning-${index}`}>{t(warning.messageKey, warning.messageValues)}</li>)}</ul></section>}
        {inspectionReport.suggestions.length > 0 && <section><b>{t('Vorschläge')}</b><ul>{inspectionReport.suggestions.map((suggestion, index) => <li key={`suggestion-${index}`}>{t(suggestion.messageKey, suggestion.messageValues)}{nodes.length > 0 && <button type="button" className="btn btn-secondary" onClick={() => acceptSuggestion(nodes.find(node => suggestion.taskIds?.includes(node.id)) || nodes[0], t(suggestion.messageKey, suggestion.messageValues), { kind: 'plan' })}>{t('Vorschlag übernehmen')}</button>}</li>)}</ul></section>}
      </div>}
      {legendOpen && <div className="workflow-legend-popover" role="dialog" aria-label={t('Workflow-Legende')}><div className="workflow-legend-head"><strong>{t('Workflow-Legende')}</strong><button type="button" onClick={() => setLegendOpen(false)}>✕</button></div><p>{t('Aufgaben ohne gegenseitige Abhängigkeit liegen auf parallelen Linien. Eine Verbindung verschiebt die Folgeaufgabe in eine spätere Phase.')}</p><div className="workflow-legend-grid"><span><i className="rail" />{t('Hauptlinie')}</span><small>{t('Abhängigkeitsbasierter Gesamtablauf')}</small><span><i className="fork" />{t('Fork / Join')}</span><small>{t('Unabhängige Aufgaben können gleichzeitig laufen')}</small><span><i className="dependency" />{t('Abhängigkeit')}</span><small>{t('Die Zielaufgabe wartet zwingend')}</small><span><i className="review" />{t('Prüfung')}</span><small>{t('Optionaler, frei definierbarer Prüfschritt')}</small><span><i className="change" />{t('Änderung')}</span><small>{t('Neue, vom User freizugebende Planversion')}</small></div><p>{t('Im Bearbeitungsmodus kannst du eine Verbindung vom rechten Anschluss einer Aufgabe auf eine Zielaufgabe ziehen. Die Zielaufgabe wartet anschließend auf den Abschluss des Vorgängers.')}</p><p className="workflow-legend-note">{t('Das Verschieben einer Karte wechselt nur die sichtbare Linie. Ausschließlich Abhängigkeiten bestimmen Reihenfolge und Parallelität.')}</p></div>}
      {connectionNotice && <div className={`workflow-connection-notice ${connectionNotice.type}`} role={connectionNotice.type === 'error' ? 'alert' : 'status'}>{connectionNotice.type === 'error' ? '⚠' : '✓'} {connectionNotice.text}</div>}
      <div className="workflow-body">
        <div ref={canvasRef} className="workflow-canvas" onContextMenu={handleCanvasContextMenu} onPointerDown={handleCanvasPointerDown} onPointerMove={handleCanvasPointerMove} onPointerUp={handleCanvasPointerEnd} onPointerCancel={handleCanvasPointerEnd} onWheel={event => { if (!event.ctrlKey) return; event.preventDefault(); zoomBy(event.deltaY > 0 ? -.08 : .08); }}>
          {nodes.length === 0 ? <div className="workflow-empty"><Icon name="workflow" size={36} /><strong>{t('Noch kein Aufgabenplan')}</strong><p>{t('Beschreibe dein Ziel im Gruppenchat. Der PM erstellt daraus Aufgaben, die du hier prüfen und anschließend freigeben kannst.')}</p></div> : (
            <div ref={stageRef} className="workflow-stage" style={{ width: layout.width, height: layout.height, transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${scale})` }}>
              {layout.layers.map(([rank, layerNodes]) => <span className="workflow-phase-label" key={rank} style={{ left: Math.min(...layerNodes.map(node => resolvedPosition(node.id).x)) + 4, top: Math.max(6, Math.min(...layerNodes.map(node => resolvedPosition(node.id).y)) - 22) }}>{rank === 0 ? t('Start') : t('Phase {phase}', { phase: rank })}</span>)}
              <svg className="workflow-edges" width={layout.width} height={layout.height} aria-hidden="true">
                <defs>
                  {Object.entries(EDGE_STYLES).map(([kind, style]) => <marker key={kind} id={`workflow-arrow-${kind}`} markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill={style.color} /></marker>)}
                  <marker id="workflow-arrow-change" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="var(--workflow-error)" /></marker>
                  <marker id="workflow-arrow-connection-pending" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="var(--accent)" /></marker>
                  <marker id="workflow-arrow-connection-valid" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="var(--workflow-success)" /></marker>
                  <marker id="workflow-arrow-connection-invalid" markerWidth="9" markerHeight="9" refX="8" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L9,3 z" fill="var(--workflow-error)" /></marker>
                </defs>
                {layout.flowEdges.map(edge => <path className="workflow-manual-flow-edge" key={edge.id} d={workflowRailPath(railEndpoint(edge.from, 'from'), railEndpoint(edge.to, 'to'))} fill="none" markerEnd="url(#workflow-arrow-dependency)" />)}
                {displayedEdges.filter(({ edge }) => edge.kind !== 'delegation').map(({ edge, change }) => {
                  const from = resolvedPosition(edge.from);
                  const to = resolvedPosition(edge.to);
                  if (!from || !to) return null;
                  const style = EDGE_STYLES[edge.kind] || EDGE_STYLES.delegation;
                  const markerKind = EDGE_STYLES[edge.kind] ? edge.kind : 'delegation';
                  return <path className={change ? 'workflow-edge-change' : ''} key={`${change?.type || 'current'}:${edge.id || `${edge.kind}:${edge.from}->${edge.to}`}`} d={workflowEdgePath(from, to, layout.nodeWidth, layout.nodeHeight)} fill="none" stroke={change ? 'var(--workflow-error)' : style.color} strokeWidth={change ? '3' : '2'} strokeDasharray={change?.type === 'removed' ? '3 5' : style.dash} opacity={change?.type === 'removed' ? '.68' : '1'} markerEnd={`url(#workflow-arrow-${change ? 'change' : markerKind})`} />;
                })}
                {selectedDependency && (() => {
                  return <path className="workflow-edge-selected" d={workflowRailPath(endpointPosition(selectedDependency.from, 'from'), endpointPosition(selectedDependency.to, 'to'))} fill="none" />;
                })()}
                {structureEditable && (graph?.edges || []).filter(edge => edge.kind === 'dependency' || edge.kind === 'review').map(edge => {
                  const from = resolvedPosition(edge.from);
                  const to = resolvedPosition(edge.to);
                  return <path key={`hit:${edge.id || `${edge.from}->${edge.to}`}`} className="workflow-edge-hit" d={workflowEdgePath(from, to, layout.nodeWidth, layout.nodeHeight)} fill="none" stroke="transparent" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setSelectedDependency({ from: edge.from, to: edge.to, kind: edge.kind }); selectNode(edge.to); }} />;
                })}
                {structureEditable && (graph?.flowEdges || []).map(edge => <path key={`hit:${edge.id}`} className="workflow-edge-hit" d={workflowRailPath(railEndpoint(edge.from, 'from'), railEndpoint(edge.to, 'to'))} fill="none" stroke="transparent" onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); setSelectedDependency({ from: edge.from, to: edge.to, kind: 'flow' }); }} />)}
                {connectionDraft && connectionPreviewEnd && <path className={`workflow-connection-preview ${connectionPreviewState}`} d={workflowConnectionPreviewPath(connectionDraft.start, connectionPreviewEnd)} fill="none" markerEnd={`url(#workflow-arrow-connection-${connectionPreviewState})`} />}
              </svg>
              {flowPoints.map(point => <FlowPoint
                key={point.id}
                point={point}
                position={resolvedRailPoint(point)}
                movable={freeMovementEnabled}
                selected={selectedFlowPointId === point.id}
                connectionEnabled={structureEditable}
                connectionSource={connectionDraft?.sourceId === point.id}
                connectionTargetState={connectionDraft?.targetId === point.id ? connectionPreviewState : ''}
                onSelect={selectFlowPoint}
                onDragStart={handleElementDragStart}
                onDragMove={handleNodeDragMove}
                onDragEnd={handleNodeDragEnd}
                onConnectionStart={handleConnectionStart}
                onConnectionMove={handleConnectionMove}
                onConnectionEnd={handleConnectionEnd}
              />)}
              {selectedDependency && selectedDependencyPosition && structureEditable && <button type="button" className="workflow-edge-remove" style={{ left: selectedDependencyPosition.x, top: selectedDependencyPosition.y }} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); removeSelectedDependency(); }} title={t('Nur die Verbindung entfernen; Aufgaben bleiben erhalten')}>× {t('Verbindung lösen')}</button>}
              {connectionDraft && connectionPreviewEnd && <div className={`workflow-connection-live-label ${connectionPreviewState}`} style={{ left: connectionPreviewEnd.x + 12, top: connectionPreviewEnd.y + 12 }}>{connectionDraft.targetId ? connectionDraft.validation?.ok ? t('Loslassen, um die Abhängigkeit zu erstellen') : t(connectionDraft.validation?.messageKey || connectionDraft.validation?.reason || 'Diese Abhängigkeit ist ungültig.', connectionDraft.validation?.messageValues) : t('Auf eine Zielaufgabe ziehen')}</div>}
              {nodes.map(node => <FlowNode key={node.id} node={node} position={resolvedPosition(node.id)} graph={graph} movable={freeMovementEnabled} selected={selectedNodeId === node.id} modelConfig={modelOptionsByTask[node.id]} change={changeSet.nodeChanges[node.id]} validationHighlighted={validationNodeIds.has(node.id)} workflowProblem={workflowProblemByTask.get(node.id)} active={activeTaskIdSet.has(node.id)} pendingQuestion={pendingQuestionByTask.get(node.id)} groupRequests={groupRequestsByTask.get(node.id) || []} connectionEnabled={structureEditable} connectionSource={connectionDraft?.sourceId === node.id} connectionTargetState={connectionDraft?.targetId === node.id ? connectionPreviewState : ''} onSelect={selectNode} onQuestionOpen={setOpenQuestionTaskId} onProblemOpen={setOpenProblemTaskId} onTimeoutRepair={onTimeoutRepair} onPauseTask={onPauseTask} onResumeTask={onResumeTask} onDragStart={(nodeId, position, event) => handleElementDragStart(nodeId, position, event, true)} onDragMove={handleNodeDragMove} onDragEnd={handleNodeDragEnd} onConnectionStart={handleConnectionStart} onConnectionMove={handleConnectionMove} onConnectionEnd={handleConnectionEnd} />)}
            </div>
          )}
          {contextMenu && <div className="workflow-context-menu" role="menu" style={{ left: contextMenu.left, top: contextMenu.top }} onPointerDown={event => event.stopPropagation()}>
            {contextMenu.targetPointId ? <button type="button" role="menuitem" className="danger" onClick={() => runContextAction('delete-point')}>× {t('Fork-/Join-Punkt löschen')}</button> : contextMenu.targetTaskId ? <>
              {inferTaskNodeType(nodes.find(node => node.id === contextMenu.targetTaskId)) === 'request'
                ? <span className="workflow-context-menu-note">🔒 {t('Die Startanforderung kann nicht gelöscht werden.')}</span>
                : <button type="button" role="menuitem" className="danger" onClick={() => runContextAction('delete-task')}>× {t('Aufgabe löschen')}</button>}
            </> : <>
              <button type="button" role="menuitem" onClick={() => runContextAction('task')}>＋ {t('Neue Aufgabe')}</button>
              <button type="button" role="menuitem" onClick={() => runContextAction('review-task')}>◆ {t('Neue Abnahme')}</button>
              <button type="button" role="menuitem" onClick={() => runContextAction('fork')}>⑂ {t('Fork-Punkt erstellen')}</button>
              <button type="button" role="menuitem" onClick={() => runContextAction('join')}>⑃ {t('Join-Punkt erstellen')}</button>
              <span className="workflow-context-menu-label">{t('Verbindungstyp')}</span>
              <button type="button" role="menuitemradio" aria-checked={connectionKind === 'dependency'} onClick={() => runContextAction('connection-dependency')}>{connectionKind === 'dependency' ? '✓' : '○'} {t('Abhängigkeit')}<small>{t('Ziel wartet auf den Abschluss der Quelle')}</small></button>
              <button type="button" role="menuitemradio" aria-checked={connectionKind === 'review'} onClick={() => runContextAction('connection-review')}>{connectionKind === 'review' ? '✓' : '○'} {t('Abnahme')}<small>{t('Verbindet eine Aufgabe mit einem Prüfschritt')}</small></button>
            </>}
          </div>}
        </div>
        {selectedNode && <WorkflowDetails onAcceptSuggestion={acceptSuggestion} node={selectedNode} graph={graph} planning={structureEditable} collapsed={detailsCollapsed} pinned={detailsPinned} modelConfig={modelOptionsByTask[selectedNode.id]} agentOptions={agentOptions} delegationEnabled={delegationEnabled} groupOptions={groupOptions} groupRequests={groupRequestsByTask.get(selectedNode.id) || []} problems={selectedNodeProblems} problemSuggestions={selectedNodeProblemSuggestions} change={changeSet.nodeChanges[selectedNode.id]} baselineRevision={changeSet.baselineRevision} onTaskUpdate={onTaskUpdate} onTaskDelete={taskId => { onTaskDelete?.(taskId); closeDetails(); }} onTaskSplit={onTaskSplit} onTaskMove={onTaskMove} onAgentChange={onAgentChange} onModelChange={onModelChange} onDependencyAdd={onDependencyAdd} onDependencyRemove={onDependencyRemove} onAcceptanceCriteriaChange={onAcceptanceCriteriaChange} onAcceptanceDecisionRequest={(node, criterion) => setAcceptanceDecisionRequest({ node, criterion })} onRetryTask={onRetryTask} onToggleCollapsed={() => setDetailsCollapsed(current => !current)} onTogglePinned={() => setDetailsPinned(current => !current)} onClose={closeDetails} />}
      </div>
      {awaitingSchedule && workflowStartDisabled && <div className="workflow-footer" role="status"><Icon name="info" size={16} /><span>{workflowStartTitle}</span></div>}
      </div>
      {activeWorkspaceTab === 'tests' && <AcceptanceTestView onAcceptSuggestion={acceptSuggestion} nodes={nodes} testConfigured={testConfigured} onRun={onRunAcceptanceTests} questions={pendingQuestionByTask} problems={workflowProblemByTask} onQuestion={setOpenQuestionTaskId} onConfigure={onConfigureTests} onPreview={onOpenPreview} onRetry={onRetryTask} planning={structureEditable} onHelp={(node, problem) => setAcceptanceProblem(problem ? { ...problem, kind: structureEditable ? 'plan' : problem.kind } : {
        taskId: node.id, taskTitle: node.title, kind: structureEditable ? 'plan' : 'execution',
        message: (node.acceptanceCriteria || []).filter(item => item.status === 'failed').map(item => item.text).join('\n') || node.acceptanceTestRuns?.at(-1)?.error || t('Die Prüfung benötigt eine Nachbesserung.'),
      })} onDecisionRequest={(node, criterion) => setAcceptanceDecisionRequest({ node, criterion })} />}
      {activeWorkspaceTab === 'collaboration' && <div className="expertise-collaboration-view">
        <ExpertiseHelpPanel items={expertiseHelp} running={running} onSearch={onSearchExpert} onCreate={onCreateExpert} onAssign={onAssignExpert} onConfigure={onConfigureExpertGroups} />
        <GroupWorkView trees={groupRequestTrees} onRetry={onGroupRequestRetry} />
      </div>}
      {openQuestion && <WorkflowQuestionDialog question={{ ...openQuestion, taskTitle: openQuestionNode?.title || '' }} running={running} onAnswer={onQuestionAnswer} onClose={() => setOpenQuestionTaskId(null)} />}
      {expertiseHelp.length > 0 && activeWorkspaceTab !== 'collaboration' && <button type="button" className="expertise-shortcut btn btn-secondary" onClick={() => selectWorkspaceTab('collaboration')}><Icon name="users" />{t('Fehlende Expertise klären')} ({expertiseHelp.length})</button>}
      {(acceptanceProblem || openProblem) && <WorkflowProblemDialog problem={acceptanceProblem || openProblem} running={running} onSubmit={onProblemResolve} onClose={() => { setAcceptanceProblem(null); setOpenProblemTaskId(null); }} />}
      {acceptanceDecisionRequest && <ManualAcceptanceDialog request={acceptanceDecisionRequest} running={false} onSubmit={(status, note) => {
        onAcceptanceDecision?.(acceptanceDecisionRequest.node.id, acceptanceDecisionRequest.criterion.id, status, note);
        setAcceptanceDecisionRequest(null);
      }} onClose={() => setAcceptanceDecisionRequest(null)} />}
      {workflowImport && <WorkflowImportDialog draft={workflowImport} agentOptions={agentOptions} running={running} onMappingChange={onWorkflowImportMapping} onApply={onWorkflowImportApply} onClose={onWorkflowImportCancel} />}
    </aside>
  );
}
