import React, { useEffect, useState } from 'react';
import TaskGraphPanel from './TaskGraphPanel';
import { createTaskGraph } from './task-graph';
import { useI18n } from './i18n';

const EMPTY_STATE = {
  chatId: '',
  chatName: '',
  graph: createTaskGraph('detached-task-window'),
  running: false,
  activeTaskIds: [],
  pendingQuestions: [],
  workflowProblems: [],
  pendingDelegations: [],
  groupRequests: [],
  resumeMode: false,
  canResumeWorkflow: false,
  resumeRetrySeconds: 0,
  canUndo: false,
  canDeleteWorkflow: false,
  testConfigured: false,
  workflowImport: null,
  workflowFileStatus: { busy: '', message: '', error: '' },
  awaitingSchedule: false,
};

export default function TaskGraphWindow() {
  const { t } = useI18n();
  const [state, setState] = useState(EMPTY_STATE);

  useEffect(() => {
    const detail = String(state.windowTitle || t('Workflow')).replace(
      /^Agent Teams\s*[–—-]\s*/i,
      '',
    );
    document.title = `Agent Teams – ${detail}`;
  }, [state.windowTitle, t]);

  useEffect(() => {
    document.body.classList.add('task-window-mode');
    let active = true;
    let receivedUpdate = false;
    window.electronAPI?.getTaskWindowState?.().then(initialState => {
      if (active && !receivedUpdate && initialState) setState(initialState);
    }).catch(() => null);
    const unsubscribe = window.electronAPI?.onTaskWindowState?.(nextState => {
      if (active && nextState) {
        receivedUpdate = true;
        setState(nextState);
      }
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
        activeTaskIds={state.activeTaskIds || []}
        pendingQuestions={state.pendingQuestions || []}
        workflowProblems={state.workflowProblems || []}
        expertiseHelp={state.expertiseHelp || []}
        onSearchExpert={taskId => sendAction('search-expertise', [], { taskId })}
        onCreateExpert={taskId => sendAction('create-expert', [], { taskId })}
        onAssignExpert={(taskId, agentId) => sendAction('assign-expert-task', [], { taskId, agentId })}
        onConfigureExpertGroups={() => sendAction('configure-expertise-groups')}
        pendingDelegations={state.pendingDelegations || []}
        groupRequests={state.groupRequests || []}
        delegationEnabled={!!state.delegationEnabled}
        groupOptions={state.groupOptions || []}
        resumeMode={!!state.resumeMode}
        canResumeWorkflow={!!state.canResumeWorkflow}
        resumeRetrySeconds={Number(state.resumeRetrySeconds) || 0}
        canUndo={!!state.canUndo}
        canDeleteWorkflow={!!state.canDeleteWorkflow}
        testConfigured={!!state.testConfigured}
        awaitingSchedule={!!state.awaitingSchedule}
        structureEditable={!!state.structureEditable}
        nodesMovable
        canEditWorkflow={!!state.canEditWorkflow}
        preflightError={state.preflightError || ''}
        preflightTaskIds={state.preflightTaskIds || []}
        onRestoreSnapshot={() => sendAction('restore-workflow-snapshot')}
        onUndo={() => sendAction('undo-workflow-change')}
        onDeleteWorkflow={() => sendAction('delete-workflow')}
        workflowImport={state.workflowImport || null}
        workflowFileStatus={state.workflowFileStatus || EMPTY_STATE.workflowFileStatus}
        onWorkflowImport={() => sendAction('import-workflow')}
        onWorkflowExport={() => sendAction('export-workflow')}
        onWorkflowImportMapping={(slotId, agentId) => sendAction('map-workflow-import-slot', [], { slotId, agentId })}
        onWorkflowImportApply={confirmedReplace => sendAction('apply-workflow-import', [], { confirmedReplace })}
        onWorkflowImportCancel={() => sendAction('cancel-workflow-import')}
        onWorkflowFileStatusClear={() => sendAction('clear-workflow-file-status')}
        onQuestionAnswer={(taskId, answer) => sendAction('answer-agent-question', [], { taskId, answer })}
        onProblemResolve={(taskId, answer, problem, mode) => sendAction('resolve-workflow-problem', [], { taskId, answer, problem, mode })}
        onPauseWorkflow={() => sendAction('pause-workflow')}
        onPauseTask={taskId => sendAction('pause-task', [], { taskId })}
        onResumeTask={taskId => sendAction('resume-task', [], { taskId })}
        onResumeWorkflow={() => sendAction('resume-workflow')}
        onEditWorkflow={() => sendAction('edit-workflow')}
        onRetryTask={taskId => sendAction('retry-task', [], { taskId })}
        onTimeoutRepair={taskId => sendAction('repair-timeout-task', [], { taskId })}
        onGroupRequestRetry={requestId => sendAction('retry-group-request', [], { requestId })}
        onDelegationDecision={(taskId, decision, targetCandidateId) => sendAction('resolve-task-delegation', [], { taskId, decision, targetCandidateId })}
        onStartWorkflow={ids => sendAction('start-workflow', ids)}
        onTaskAdd={(position, nodeType) => sendAction('add-task', [], { position, nodeType })}
        onFlowPointAdd={(pointType, position) => sendAction('add-flow-point', [], { pointType, position })}
        onFlowPointDelete={pointId => sendAction('delete-flow-point', [], { pointId })}
        onTaskUpdate={(taskId, updates) => sendAction('update-task', [], { taskId, updates })}
        onTaskDelete={taskId => sendAction('delete-task', [], { taskId })}
        onTaskSplit={taskId => sendAction('split-task', [], { taskId })}
        onTaskMove={(taskId, direction) => sendAction('move-task', [], { taskId, direction })}
        modelOptionsByTask={state.modelOptionsByTask || {}}
        agentOptions={state.agentOptions || []}
        onAgentChange={(taskId, agentId) => sendAction('update-task-agent', [], { taskId, agentId })}
        onModelChange={(taskId, model) => sendAction('update-task-model', [], { taskId, model })}
        onDependencyAdd={(fromTaskId, toTaskId, connectionKind) => sendAction('add-dependency', [], { fromTaskId, toTaskId, connectionKind })}
        onDependencyRemove={(fromTaskId, toTaskId, connectionKind) => sendAction('remove-dependency', [], { fromTaskId, toTaskId, connectionKind })}
        onAcceptanceCriteriaChange={(taskId, criteria) => sendAction('update-acceptance-criteria', [], { taskId, criteria })}
        onNodePositionChange={(taskId, position) => sendAction('update-task-position', [], { taskId, position })}
        onResetLayout={() => sendAction('reset-workflow-layout')}
        onConfigureTests={() => sendAction('configure-acceptance-tests')}
        onOpenPreview={() => sendAction('open-acceptance-preview')}
        onRunAcceptanceTests={taskIds => sendAction('run-acceptance-tests', taskIds)}
        onAcceptanceDecision={(taskId, criterionId, status, note) => sendAction('acceptance-decision', [], {
          taskId, criterionId, status, note,
        })}
      />
    </main>
  );
}
