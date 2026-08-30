import React, { useEffect, useMemo, useState } from 'react';
import {
  ACCEPTANCE_STATUS,
  inferTaskNodeType,
  isTaskNodeReady,
  projectTaskTree,
  summarizeAcceptance,
  TASK_STATUS,
  validateParallelSelection,
} from './task-graph';
import { useI18n } from './i18n';

const PARALLEL_STATUSES = new Set(['planned', 'queued', 'interrupted']);
const DISABLED_STATUSES = new Set(['blocked', 'timed_out', 'failed']);
const NODE_TYPES = {
  request: { label: 'Anforderung', icon: '🎯', color: '#53bdeb' },
  task: { label: 'Teilaufgabe', icon: '▣', color: '#8696a0' },
  continuation: { label: 'Fortsetzung', icon: '↪', color: '#c084fc' },
  recovery: { label: 'Recovery', icon: '🧭', color: '#fb923c' },
  review: { label: 'PM-Abnahme', icon: '◆', color: '#00a884' },
};

function TaskNodeCard({ node, graph, tree, awaitingSchedule, running, selected, onToggle, onAcceptanceDecision }) {
  const { t } = useI18n();
  const status = TASK_STATUS[node.status] || TASK_STATUS.planned;
  const typeName = inferTaskNodeType(node);
  const nodeType = NODE_TYPES[typeName] || NODE_TYPES.task;
  const metadata = tree.metadataByNode.get(node.id) || { dependencyIds: [], reviewSourceIds: [] };
  const dependencyNodes = metadata.dependencyIds.map(id => tree.nodeById.get(id)).filter(Boolean);
  const reviewNodes = metadata.reviewSourceIds.map(id => tree.nodeById.get(id)).filter(Boolean);
  const waitsForDependency = PARALLEL_STATUSES.has(node.status) && !isTaskNodeReady(graph, node.id);
  const selectable = awaitingSchedule &&
    PARALLEL_STATUSES.has(node.status) &&
    node.executionMode !== 'sequential' &&
    !waitsForDependency &&
    !running;
  const isSelected = selected.includes(node.id);
  const disabled = waitsForDependency || DISABLED_STATUSES.has(node.status);
  const borderColor = isSelected ? 'var(--accent)' : 'var(--border)';

  return (
    <div
      data-task-node={node.id}
      aria-disabled={disabled || undefined}
      onClick={() => selectable && onToggle(node.id)}
      style={{
        position: 'relative', zIndex: 1, padding: '10px 11px 9px', borderRadius: 10,
        background: disabled
          ? 'rgba(134,150,160,.055)'
          : isSelected
          ? 'rgba(0,168,132,.15)'
          : typeName === 'request'
            ? 'rgba(83,189,235,.08)'
            : typeName === 'review'
              ? 'rgba(0,168,132,.08)'
              : 'var(--bg-tertiary)',
        borderTop: `1px solid ${borderColor}`,
        borderRight: `1px solid ${borderColor}`,
        borderBottom: `1px solid ${borderColor}`,
        borderLeft: `3px solid ${nodeType.color}`,
        cursor: selectable ? 'pointer' : 'default',
        opacity: disabled ? 0.58 : 1,
        filter: disabled ? 'saturate(.55)' : 'none',
        boxShadow: typeName === 'review' ? '0 0 0 1px rgba(0,168,132,.05)' : 'none',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        {selectable && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggle(node.id)}
            onClick={event => event.stopPropagation()}
            aria-label={t('{title} parallel auswählen', { title: node.title })}
          />
        )}
        <span style={{ color: nodeType.color, fontSize: 11, fontWeight: 750, letterSpacing: '.04em', textTransform: 'uppercase' }}>
          {nodeType.icon} {t(nodeType.label)}
        </span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 5, color: status.color, fontSize: 10, whiteSpace: 'nowrap' }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: status.color }} />
          {waitsForDependency ? t('Offen · wartet auf Vorgänger') : t(status.label)}
        </span>
      </div>

      <div style={{ fontWeight: 650, fontSize: 12, lineHeight: 1.4, color: 'var(--text-primary)', marginTop: 6, overflowWrap: 'anywhere' }}>
        {node.title}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px', color: 'var(--text-secondary)', fontSize: 10, marginTop: 6 }}>
        <span>👤 {node.agentName || 'System'}</span>
        {node.executionMode === 'parallel' && <span style={{ color: '#53bdeb' }}>⚡ {t('Parallel')}</span>}
        {node.source && typeName !== 'request' && <span style={{ color: 'var(--text-muted)' }}>{t('von {source}', { source: node.source })}</span>}
      </div>

      {dependencyNodes.length > 0 && (
        <div style={{ marginTop: 7, padding: '5px 7px', borderRadius: 6, background: 'rgba(230,162,60,.08)', color: '#e6a23c', fontSize: 9, lineHeight: 1.4 }}>
          ⛓ {t('Abhängig von {tasks}', { tasks: dependencyNodes.map(parent => `${parent.agentName || 'Agent'}: ${parent.title}`).join(' · ') })}
        </div>
      )}

      {disabled && dependencyNodes.length === 0 && (
        <div style={{ marginTop: 7, color: 'var(--text-muted)', fontSize: 9 }}>
          {t('Dieser Schritt bleibt im vollständigen Ablauf sichtbar, ist aktuell aber deaktiviert.')}
        </div>
      )}

      {reviewNodes.length > 0 && (
        <div style={{ marginTop: 7, padding: '5px 7px', borderRadius: 6, background: 'rgba(0,168,132,.09)', color: 'var(--accent)', fontSize: 9, lineHeight: 1.4 }}>
          ✓ {t(
            reviewNodes.length === 1 ? 'Prüft {count} Ergebnis: {agents}' : 'Prüft {count} Ergebnisse: {agents}',
            { count: reviewNodes.length, agents: [...new Set(reviewNodes.map(result => result.agentName || 'Agent'))].join(', ') },
          )}
        </div>
      )}

      {!!node.acceptanceCriteria?.length && (
        <div style={{ marginTop: 8, display: 'grid', gap: 5 }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em' }}>
            🛡️ {t('Abnahmekriterien')}
          </div>
          {node.acceptanceCriteria.map(criterion => {
            const criterionStatus = ACCEPTANCE_STATUS[criterion.status] || ACCEPTANCE_STATUS.open;
            const latestEvidence = (criterion.evidence || []).at(-1);
            const verificationLabels = {
              reviewer: t('Prüfer'),
              automatic: t('Automatisch'),
              user: t('User-Freigabe'),
            };
            return (
              <div key={criterion.id} style={{ padding: '6px 7px', borderRadius: 7, border: '1px solid rgba(134,150,160,.2)', background: 'rgba(13,27,34,.24)' }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: 9, lineHeight: 1.4 }}>
                  <span style={{ color: criterionStatus.color, marginTop: 1 }}>●</span>
                  <span style={{ flex: 1, color: 'var(--text-primary)' }}>{criterion.text}</span>
                  <span style={{ color: criterionStatus.color, whiteSpace: 'nowrap' }}>{t(criterionStatus.label)}</span>
                </div>
                <div style={{ display: 'flex', gap: 7, marginTop: 4, color: 'var(--text-muted)', fontSize: 8 }}>
                  <span>{verificationLabels[criterion.verification] || verificationLabels.reviewer}</span>
                  <span>{criterion.required === false ? t('Optional') : t('Erforderlich')}</span>
                </div>
                {latestEvidence && (
                  <div title={latestEvidence.summary} style={{ marginTop: 4, color: 'var(--text-secondary)', fontSize: 8, lineHeight: 1.35, overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                    📎 {latestEvidence.author}: {latestEvidence.summary}
                  </div>
                )}
                {criterion.verification === 'user' && onAcceptanceDecision && (
                  <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                    <button type="button" className="btn btn-secondary" style={{ padding: '3px 7px', fontSize: 8 }}
                      onClick={event => { event.stopPropagation(); onAcceptanceDecision(node.id, criterion.id, 'passed'); }}>
                      ✓ {t('Bestätigen')}
                    </button>
                    <button type="button" className="btn btn-secondary" style={{ padding: '3px 7px', fontSize: 8 }}
                      onClick={event => { event.stopPropagation(); onAcceptanceDecision(node.id, criterion.id, 'failed'); }}>
                      ✕ {t('Ablehnen')}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskTreeNode({ node, graph, tree, awaitingSchedule, running, selected, onToggle, onAcceptanceDecision }) {
  const children = tree.childrenByParent.get(node.id) || [];
  return (
    <div style={{ position: 'relative' }}>
      <TaskNodeCard
        node={node}
        graph={graph}
        tree={tree}
        awaitingSchedule={awaitingSchedule}
        running={running}
        selected={selected}
        onToggle={onToggle}
        onAcceptanceDecision={onAcceptanceDecision}
      />
      {children.length > 0 && (
        <div style={{ marginLeft: 17, paddingLeft: 24, borderLeft: '1px solid rgba(134,150,160,.42)', paddingTop: 4 }}>
          {children.map((child, index) => (
            <div key={child.id} style={{ position: 'relative', paddingTop: 7 }}>
              <span style={{ position: 'absolute', left: -24, top: 29, width: 20, borderTop: '1px solid rgba(134,150,160,.52)' }} />
              {index === children.length - 1 && (
                <span style={{ position: 'absolute', left: -25, top: 30, bottom: 0, width: 3, background: 'var(--bg-secondary)' }} />
              )}
              <TaskTreeNode
                node={child}
                graph={graph}
                tree={tree}
                awaitingSchedule={awaitingSchedule}
                running={running}
                selected={selected}
                onToggle={onToggle}
                onAcceptanceDecision={onAcceptanceDecision}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function TaskGraphPanel({ graph, running, awaitingSchedule, onClose, onRunParallel, onContinueSequential, onAcceptanceDecision, dragHandleProps = null, closeTitle }) {
  const { t } = useI18n();
  const [selected, setSelected] = useState([]);
  const tree = useMemo(() => projectTaskTree(graph), [graph]);
  const validation = useMemo(() => validateParallelSelection(graph, selected), [graph, selected]);
  const nodes = graph?.nodes || [];
  const completedCount = nodes.filter(node => ['agent_done', 'completed'].includes(node.status)).length;
  const activeCount = nodes.filter(node => ['running', 'waiting_user'].includes(node.status)).length;
  const openCount = Math.max(0, nodes.length - completedCount - activeCount);
  const acceptance = useMemo(() => summarizeAcceptance(graph), [graph]);

  const toggleNode = (nodeId) => {
    setSelected(current => current.includes(nodeId)
      ? current.filter(id => id !== nodeId)
      : [...current, nodeId]);
  };

  useEffect(() => {
    if (!awaitingSchedule) {
      setSelected([]);
      return;
    }
    setSelected(current => current.filter(nodeId => {
      const node = graph?.nodes?.find(candidate => candidate.id === nodeId);
      return node && PARALLEL_STATUSES.has(node.status) && isTaskNodeReady(graph, node.id);
    }));
  }, [awaitingSchedule, graph]);

  return (
    <aside style={{
      width: '100%', minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column',
      background: 'var(--bg-secondary)',
    }}>
      <div
        {...(dragHandleProps || {})}
        className={dragHandleProps ? 'task-window-drag-handle' : undefined}
        title={dragHandleProps ? t('Zum Verschieben ziehen') : undefined}
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '13px 14px', borderBottom: '1px solid var(--border)' }}
      >
        <div style={{ fontSize: 18 }}>🌳</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14 }}>{t('Aufgabenbaum')}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
            {t(
              tree.roots.length === 1
                ? 'Vollständiger Ablauf · {tasks} Aufgaben · {roots} Hauptast'
                : 'Vollständiger Ablauf · {tasks} Aufgaben · {roots} Hauptäste',
              { tasks: nodes.length, roots: tree.roots.length },
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 5, fontSize: 9 }}>
          {acceptance.required > 0 && <span style={{ color: acceptance.ready ? '#00a884' : '#53bdeb', background: acceptance.ready ? 'rgba(0,168,132,.1)' : 'rgba(83,189,235,.1)', padding: '3px 6px', borderRadius: 10 }}>🛡️ {acceptance.passed}/{acceptance.required}</span>}
          <span style={{ color: '#00a884', background: 'rgba(0,168,132,.1)', padding: '3px 6px', borderRadius: 10 }}>✓ {completedCount}</span>
          <span style={{ color: '#e6a23c', background: 'rgba(230,162,60,.1)', padding: '3px 6px', borderRadius: 10 }}>● {activeCount}</span>
          <span style={{ color: '#8696a0', background: 'rgba(134,150,160,.1)', padding: '3px 6px', borderRadius: 10 }}>○ {openCount}</span>
        </div>
        <button className="icon-btn" title={closeTitle || t('Aufgabenbaum schließen')} onClick={onClose}>✕</button>
      </div>

      {awaitingSchedule && (
        <div style={{ margin: 12, padding: '10px 12px', borderRadius: 8, background: 'rgba(83,189,235,.12)', border: '1px solid rgba(83,189,235,.35)', fontSize: 12 }}>
          {t('Wähle mindestens zwei startbereite Aufgaben aus verschiedenen Ästen. Abhängige Aufgaben bleiben gesperrt, bis ihr Vorgänger fertig ist.')}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 14px', borderBottom: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: 9 }}>
        <span><span style={{ color: '#00a884' }}>●</span> {t('erledigt')}</span>
        <span><span style={{ color: '#53bdeb' }}>●</span> {t('startbereit')}</span>
        <span style={{ opacity: .6 }}><span style={{ color: '#8696a0' }}>●</span> {t('offen/deaktiviert')}</span>
        <span style={{ marginLeft: 'auto' }}>{t('Linien zeigen den gesamten Weg')}</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px 24px' }}>
        {tree.roots.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', padding: 30 }}>
            {t('Der Aufgabenbaum entsteht, sobald der PM eine Anforderung plant.')}
          </div>
        )}
        {tree.roots.map((root, index) => (
          <div key={root.id} style={{ marginTop: index === 0 ? 0 : 16, paddingTop: index === 0 ? 0 : 16, borderTop: index === 0 ? 'none' : '1px dashed var(--border)' }}>
            <TaskTreeNode
              node={root}
              graph={graph}
              tree={tree}
              awaitingSchedule={awaitingSchedule}
              running={running}
              selected={selected}
              onToggle={toggleNode}
              onAcceptanceDecision={onAcceptanceDecision}
            />
          </div>
        ))}
      </div>

      {awaitingSchedule && (
        <div style={{ padding: 12, borderTop: '1px solid var(--border)', background: 'var(--bg-secondary)' }}>
          {selected.length > 0 && !validation.ok && (
            <div style={{ color: '#e6a23c', fontSize: 10, marginBottom: 8 }}>
              {t(validation.messageKey || validation.reason, validation.messageValues)}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="run-btn" style={{ flex: 1 }} onClick={() => onContinueSequential?.()} disabled={running}>
              {t('Sequenziell fortsetzen')}
            </button>
            <button className="run-btn" style={{ flex: 1 }} onClick={() => validation.ok && onRunParallel?.(selected)} disabled={running || !validation.ok}>
              {t('Parallel starten ({count})', { count: selected.length })}
            </button>
          </div>
        </div>
      )}
    </aside>
  );
}
