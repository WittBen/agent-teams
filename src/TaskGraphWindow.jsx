import React, { useEffect, useState } from 'react';
import TaskGraphPanel from './TaskGraphPanel';
import { createTaskGraph } from './task-graph';
import { useI18n } from './i18n';

const EMPTY_STATE = {
  chatId: '',
  chatName: '',
  graph: createTaskGraph('detached-task-window'),
  running: false,
  awaitingSchedule: false,
};

export default function TaskGraphWindow() {
  const { t } = useI18n();
  const [state, setState] = useState(EMPTY_STATE);

  useEffect(() => {
    const detail = String(state.windowTitle || t('Aufgabenbaum')).replace(
      /^Agent Teams\s*[–—-]\s*/i,
      '',
    );
    document.title = `Agent Teams – ${detail}`;
  }, [state.windowTitle, t]);

  useEffect(() => {
    document.body.classList.add('task-window-mode');
    let active = true;
    window.electronAPI?.getTaskWindowState?.().then(initialState => {
      if (active && initialState) setState(initialState);
    }).catch(() => null);
    const unsubscribe = window.electronAPI?.onTaskWindowState?.(nextState => {
      if (nextState) setState(nextState);
    });
    return () => {
      active = false;
      document.body.classList.remove('task-window-mode');
      unsubscribe?.();
    };
  }, []);

  const sendAction = (type, taskIds = [], details = {}) => {
    window.electronAPI?.sendTaskWindowAction?.({
      type,
      chatId: state.chatId,
      taskIds,
      ...details,
    });
  };

  return (
    <main className="task-window-page">
      <TaskGraphPanel
        graph={state.graph || EMPTY_STATE.graph}
        running={!!state.running}
        awaitingSchedule={!!state.awaitingSchedule}
        onClose={() => window.electronAPI?.closeTaskWindow?.()}
        onRunParallel={ids => sendAction('run-parallel', ids)}
        onContinueSequential={() => sendAction('continue-sequential')}
        onAcceptanceDecision={(taskId, criterionId, status) => sendAction('acceptance-decision', [], {
          taskId, criterionId, status,
        })}
        closeTitle={t('Aufgabenfenster schließen')}
      />
    </main>
  );
}
