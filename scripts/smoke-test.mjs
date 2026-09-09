import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const electronMainSource = await fs.readFile(path.join(root, 'electron/main.js'), 'utf8');
const apiServerSource = await fs.readFile(path.join(root, 'electron/api-server.js'), 'utf8');
const codexMainSource = await fs.readFile(path.join(root, 'electron/codex-main.js'), 'utf8');
const llmStreamSource = await fs.readFile(path.join(root, 'electron/llm-stream.js'), 'utf8');
const taskTicketStoreSource = await fs.readFile(path.join(root, 'electron/task-ticket-store.js'), 'utf8');
const preloadSource = await fs.readFile(path.join(root, 'electron/preload.js'), 'utf8');
const appSource = await fs.readFile(path.join(root, 'src/App.jsx'), 'utf8');
const crossGroupCoordinatorSource = (await Promise.all(['src/cross-group-coordination.mjs', 'src/CrossGroupCoordinator.jsx'].map(file => fs.readFile(path.join(root, file), 'utf8')))).join('\n');
const chatParts = await Promise.all(['src/chat-workflow-helpers.mjs', 'src/chat-view-ui.jsx', 'src/ChatView.jsx', 'src/useConversationRunner.js'].map(file => fs.readFile(path.join(root, file), 'utf8')));
const chatViewSource = chatParts.slice(0, 2).join('\n') + '\n' + chatParts[2].replace(/const runAgents = useConversationRunner\([\s\S]*?\);/, () => chatParts[3]);
const modalsSource = (await Promise.all(['src/AgentModal.jsx', 'src/GroupModal.jsx', 'src/SettingsPanel.jsx'].map(file => fs.readFile(path.join(root, file), 'utf8')))).join('\n');
const i18nSource = await fs.readFile(path.join(root, 'src/i18n.jsx'), 'utf8');
const storeSource = await fs.readFile(path.join(root, 'src/store.jsx'), 'utf8');
const mcpConfigSource = await fs.readFile(path.join(root, 'src/McpConfig.jsx'), 'utf8');
const indexCssSource = await fs.readFile(path.join(root, 'src/index.css'), 'utf8');
const rendererEntrySource = await fs.readFile(path.join(root, 'src/main.jsx'), 'utf8');
const taskGraphWindowSource = await fs.readFile(path.join(root, 'src/TaskGraphWindow.jsx'), 'utf8');
const taskGraphPanelSource = await fs.readFile(path.join(root, 'src/TaskGraphPanel.jsx'), 'utf8');
const workflowProblemDialogSource = await fs.readFile(path.join(root, 'src/WorkflowProblemDialog.jsx'), 'utf8');
const workflowLayoutSource = await fs.readFile(path.join(root, 'src/workflow-layout.js'), 'utf8');
const workflowPortabilitySource = await fs.readFile(path.join(root, 'src/workflow-portability.js'), 'utf8');
const taskTicketSource = await fs.readFile(path.join(root, 'src/task-ticket.js'), 'utf8');
const memoryProviderSource = await fs.readFile(path.join(root, 'src/memory-provider.js'), 'utf8');
const reviewWindowSource = await fs.readFile(path.join(root, 'src/ReviewWindow.jsx'), 'utf8');
const reviewEnvironmentSource = await fs.readFile(path.join(root, 'src/review-environment.js'), 'utf8');
const artifactSandboxSource = await fs.readFile(path.join(root, 'electron/artifact-sandbox.js'), 'utf8');
const reviewRunnerSource = await fs.readFile(path.join(root, 'electron/review-runner.js'), 'utf8');
const indexSource = await fs.readFile(path.join(root, 'index.html'), 'utf8');
const packageJson = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const hiddenStarterSource = await fs.readFile(path.join(root, 'start.vbs'), 'utf8');
assert.match(electronMainSource, /let taskWindow;/);
assert.match(apiServerSource, /language: this\.store\.get\('language'\) \|\| 'de'/);
assert.match(chatViewSource, /requestId: agentRequestId,\s+language,/);
assert.match(
  chatViewSource,
  /import\s*\{[\s\S]*?\bTASK_STATUS\b[\s\S]*?\}\s*from '\.\/task-graph(?:\.js)?';/,
  'ChatView must import TASK_STATUS before rendering workflow problem details',
);
assert.match(chatViewSource, /TASK_STATUS\[problemNode\.status\]/);
assert.match(electronMainSource, /if \(taskWindow && !taskWindow\.isDestroyed\(\)\)[\s\S]*taskWindow\.focus\(\)/);
assert.match(electronMainSource, /taskWindow = new BrowserWindow\(/);
assert.match(electronMainSource, /taskWindow\.loadFile\(distFile, \{ query: \{ taskWindow: '1' \} \}\)/);
assert.match(preloadSource, /openTaskWindow:[\s\S]*onTaskWindowAction:/);
assert.match(preloadSource, /onLlmProgress:[\s\S]*llm-progress/);
assert.match(preloadSource, /codexStatus: \(options = \{\}\)[\s\S]*codex-status/);
assert.match(modalsSource, /codexStatus\(\{ force: true \}\)[\s\S]*codexLoginStartedAtRef[\s\S]*>= 120000[\s\S]*loginPending/);
assert.match(electronMainSource, /sendLlmProgress[\s\S]*llm-progress/);
assert.match(chatViewSource, /onLlmProgress[\s\S]*partialText/);
assert.match(chatViewSource, /TypingBubble[\s\S]*typing-stream-preview/);
assert.match(indexCssSource, /\.typing-stream-preview[\s\S]*\.typing-stream-cursor/);
assert.match(llmStreamSource, /function createTextProgress[\s\S]*function postEventStream/);
assert.match(taskTicketStoreSource, /\.agent-teams'[\s\S]*tickets[\s\S]*atomicWriteJson[\s\S]*history\.jsonl/);
assert.match(preloadSource, /reconcileTaskTickets:[\s\S]*saveTaskTickets:[\s\S]*archiveTaskTickets:/);
assert.match(storeSource, /migrateGraphTickets[\s\S]*reconcileTaskTickets[\s\S]*saveTaskTickets/);
assert.match(taskGraphPanelSource, /workflow-ticket-priority[\s\S]*Priorität/);
assert.match(taskGraphPanelSource, /Letzte Codex-Laufzeit[\s\S]*firstTextMs[\s\S]*reasoningEffort/);
assert.match(chatViewSource, /buildTaskTicketContext[\s\S]*UNABHÄNGIGE TICKET-PRÜFUNG/);
assert.match(rendererEntrySource, /isTaskWindow[\s\S]*<TaskGraphWindow \/>/);
assert.doesNotMatch(chatViewSource, /createPortal|FloatingTaskGraphWindow|floating-task-window/);
assert.equal((chatViewSource.match(/openTaskGraphWindow\(/g) || []).length, 2);
assert.ok(
  chatViewSource.indexOf('const chatAgents =') < chatViewSource.indexOf('const openTaskGraphWindow ='),
  'chatAgents must be initialized before the workflow-window callback reads it',
);
assert.match(chatViewSource, /title=\{t\('Workflow'\)\}[\s\S]*onClick=\{\(\) => openTaskGraphWindow\(\)\}/);
assert.match(appSource, /groups\.map\(group =>[\s\S]*<ChatView[\s\S]*onEditGroup=\{\(editedGroup, options = \{\}\) =>/);
assert.match(appSource, /<CrossGroupCoordinator \/>/);
assert.match(appSource, /chat-view-slot[\s\S]*active=\{activeChat\?\.id === group\.id\}/);
assert.match(chatViewSource, /chat\.type === 'group' && !projectPath[\s\S]*project-folder-notice[\s\S]*Zielordner auswählen/);
assert.match(modalsSource, /📁 Zielordner für Ausgaben[\s\S]*project-folder-form-warning/);
assert.match(i18nSource, /'Zielordner auswählen': 'Choose output folder'/);
assert.match(chatViewSource, /function MemoryBadge\(\{ count, onOpen \}\)/);
assert.match(chatViewSource, /memoryAPI\.subscribe[\s\S]*refreshMemoryState\(\{ updateOpenViewer: true \}\)/);
assert.match(chatViewSource, /data-memory-count=\{count\}[\s\S]*aria-live="polite"/);
assert.match(chatViewSource, /Memory-Eintrag löschen[\s\S]*Alle Memory-Einträge löschen/);
assert.match(chatViewSource, /window\.confirm\(t\('Alle Einträge dieses Gruppen-Memorys wirklich löschen\?'\)\)/);
assert.match(hiddenStarterSource, /shell\.Run launchCommand, 1, False/);
assert.doesNotMatch(hiddenStarterSource, /shell\.Run launchCommand, 0, False/);
assert.match(electronMainSource, /requestSingleInstanceLock\(\)[\s\S]*second-instance[\s\S]*mainWindow\.show\(\)[\s\S]*mainWindow\.focus\(\)/);
assert.match(indexSource, /<title>Agent Teams<\/title>/);
assert.equal(packageJson.build.productName, 'Agent Teams');
assert.equal(packageJson.scripts.lint, 'oxlint . --deny-warnings');
assert.match(electronMainSource, /const PRODUCT_NAME = 'Agent Teams'/);
assert.match(electronMainSource, /prepareCliAttachmentParams[\s\S]*assertConfiguredProjectPath\(requestedCwd\)/);
assert.match(codexMainSource, /--sandbox', cwd \? 'workspace-write' : 'read-only'/);
assert.match(electronMainSource, /ensureOfficialMcpPreset\(store\)/);
assert.match(electronMainSource, /brandedWindowTitle\(nextState\.windowTitle \|\| 'Workflow'\)/);
assert.match(taskGraphWindowSource, /document\.title = `Agent Teams – \$\{detail\}`/);
assert.match(taskGraphWindowSource, /acceptance-decision/);
assert.match(taskGraphWindowSource, /run-acceptance-tests/);
assert.match(taskGraphPanelSource, /AcceptanceTestView[\s\S]*workflow-tab-tests/);
assert.match(taskGraphPanelSource, /ManualAcceptanceDialog[\s\S]*Begründung \/ Prüfnachweis/);
assert.match(chatViewSource, /runAcceptanceTests[\s\S]*reviewRun\(chat\.id, 'test'\)[\s\S]*allowManualOverride/);
assert.match(taskGraphPanelSource, /Abnahmekriterien[\s\S]*criterion\.verification === 'user'[\s\S]*onAcceptanceDecision/);
assert.match(taskGraphPanelSource, /workflow-canvas/);
assert.match(taskGraphPanelSource, /centeredViewportForScale[\s\S]*element\.clientWidth - scaledWidth[\s\S]*element\.clientHeight - scaledHeight/);
assert.match(taskGraphPanelSource, /workflowIdentity[\s\S]*performInitialFit[\s\S]*initiallyFittedChatIdsRef\.current\.add\(workflowIdentity\)/);
assert.match(taskGraphPanelSource, /freeMovementEnabled = nodesMovable && initializedChatId === workflowIdentity[\s\S]*setInitializedChatId\(workflowIdentity\)/);
assert.match(taskGraphPanelSource, /movable=\{freeMovementEnabled\}/);
assert.match(taskGraphPanelSource, /onPointerCancel=\{event => onDragEnd\(node\.id, event, true\)\}/);
assert.match(taskGraphWindowSource, /structureEditable=\{!!state\.structureEditable\}[\s\S]*nodesMovable/);
assert.match(taskGraphPanelSource, /ResizeObserver\(scheduleInitialFit\)[\s\S]*observer\?\.observe\(element\)/);
assert.match(taskGraphPanelSource, /Zoom around the current viewport center[\s\S]*centerX - \(\(centerX - current\.x\) \* ratio\)/);
assert.match(taskGraphPanelSource, /const fitView = useCallback[\s\S]*setViewport\(centeredViewportForScale\(nextScale\)\)/);
assert.match(taskGraphPanelSource, /workflowEdgePath/);
assert.match(taskGraphPanelSource, /workflowRailPath[\s\S]*workflow-manual-flow-edge/);
assert.match(taskGraphPanelSource, /onContextMenu=\{handleCanvasContextMenu\}[\s\S]*Neue Aufgabe[\s\S]*Fork-Punkt erstellen[\s\S]*Join-Punkt erstellen/);
assert.match(taskGraphPanelSource, /workflow-view-controls[\s\S]*onFlowPointAdd\?\.\('fork'\)[\s\S]*onFlowPointAdd\?\.\('join'\)/);
assert.match(taskGraphPanelSource, /workflow-connection-tool dependency[\s\S]*setConnectionKind\('dependency'\)[\s\S]*workflow-connection-tool review[\s\S]*setConnectionKind\('review'\)/);
assert.match(taskGraphPanelSource, /workflow-delete-selection[\s\S]*deleteToolbarSelection[\s\S]*Auswahl löschen/);
assert.match(taskGraphPanelSource, /selectedFlowPointId[\s\S]*selected=\{selectedFlowPointId === point\.id\}[\s\S]*onSelect=\{selectFlowPoint\}/);
assert.match(indexCssSource, /\.workflow-control-point\.selected/);
assert.match(indexCssSource, /\.workflow-delete-selection/);
assert.match(taskGraphPanelSource, /review-task[\s\S]*Neue Abnahme/);
assert.match(taskGraphPanelSource, /Verbindungstyp[\s\S]*connection-dependency[\s\S]*connection-review/);
assert.match(taskGraphPanelSource, /targetTaskId[\s\S]*delete-task[\s\S]*Aufgabe löschen/);
assert.match(taskGraphPanelSource, /data-workflow-flowpoint[\s\S]*workflow-connector-in[\s\S]*workflow-connector-out/);
assert.match(taskGraphPanelSource, /completed[\s\S]*workflow-completed-check[\s\S]*Aufgabe erledigt/);
assert.match(taskGraphPanelSource, /node\.status === 'running'[\s\S]*aria-busy=\{working\}[\s\S]*workflow-task-spinner/);
assert.match(indexCssSource, /\.workflow-task-spinner[\s\S]*workflow-task-spin[\s\S]*prefers-reduced-motion/);
assert.match(taskGraphPanelSource, /working \? 'working'[\s\S]*aria-busy=\{working\}/);
assert.match(indexCssSource, /\.workflow-node\.working[\s\S]*workflow-working-pulse[\s\S]*prefers-reduced-motion/);
assert.match(taskGraphPanelSource, /completed \? 'completed'[\s\S]*timedOut \? 'timed-out'/);
assert.match(indexCssSource, /\.workflow-node\.completed[\s\S]*\.workflow-node\.timed-out[\s\S]*workflow-timeout-pulse/);
assert.match(taskGraphPanelSource, /pendingQuestion \|\| waitingForRecoveryDecision \? 'has-question'/);
assert.match(indexCssSource, /\.workflow-node\.has-question[\s\S]*border-left-color: #a855f7/);
assert.match(chatViewSource, /getActiveWorkflowTaskIds[\s\S]*activeAgentRunRef\.current\.values\(\)[\s\S]*graphNodeId/);
assert.match(chatViewSource, /activeTaskIds: getActiveWorkflowTaskIds\(activeTaskGraph\)/);
assert.match(taskGraphWindowSource, /activeTaskIds=\{state\.activeTaskIds \|\| \[\]\}/);
assert.match(taskGraphPanelSource, /activeTaskIdSet\.has\(node\.id\)/);
assert.match(taskGraphPanelSource, /workflow-play-button[\s\S]*onClick=\{startWorkflow\}[\s\S]*Workflow starten/);
assert.match(taskGraphPanelSource, /if \(running\) onPauseWorkflow\?\.\(\)[\s\S]*Workflow unterbrechen/);
assert.match(taskGraphWindowSource, /onPauseWorkflow=\{\(\) => sendAction\('pause-workflow'\)\}/);
assert.match(chatViewSource, /action\.type === 'pause-workflow'[\s\S]*handleCancelRun\(\)/);
assert.match(chatViewSource, /onSnapshot: activeTasks => \{[\s\S]*runIdRef\.current !== myRunId/);
assert.match(chatViewSource, /else if \(pm && agent\.id !== pm\.id\)[\s\S]*problemTrigger[\s\S]*buildTimeoutRecoveryTask[\s\S]*recoveryStatus: 'pm'/);
assert.match(chatViewSource, /task\.runtimeRecovery && pm && agent\.id === pm\.id[\s\S]*buildRecoveryUserQuestion[\s\S]*recoveryStatus: 'user'/);
assert.match(chatViewSource, /shouldStartQualityRecovery[\s\S]*isTaskComplexityFailure[\s\S]*const problemTrigger[\s\S]*trigger: problemTrigger/);
assert.match(chatViewSource, /recoveredOriginalNodeId[\s\S]*approveAgentDoneTasks[\s\S]*PM hat die Recovery abgeschlossen/);
assert.match(taskGraphPanelSource, /recoveryStatus[\s\S]*PM analysiert Timeout/);
assert.match(taskGraphPanelSource, /recovering && <span className="workflow-recovery-badge"/);
assert.match(taskGraphPanelSource, /repairable && !recovering && !active[\s\S]*workflow-timeout-fix-button[\s\S]*onTimeoutRepair/);
assert.match(taskGraphWindowSource, /onTimeoutRepair=\{taskId => sendAction\('repair-timeout-task'/);
assert.match(chatViewSource, /const startWorkflowRecovery[\s\S]*buildTimeoutRecoveryTask[\s\S]*invalidateTaskRecoveryBranch[\s\S]*recoveryStatus: 'pm'/);
assert.match(chatViewSource, /action\.type === 'repair-timeout-task'[\s\S]*startWorkflowRecovery/);
assert.match(workflowProblemDialogSource, /Hauptplan überarbeiten[\s\S]*Ausführung reparieren/);
assert.match(taskGraphWindowSource, /resolve-workflow-problem'[\s\S]*mode/);
assert.match(indexCssSource, /\.workflow-timeout-fix-button[\s\S]*\.workflow-timeout-fix-button:hover/);
assert.match(taskGraphPanelSource, /startWorkflow[\s\S]*onStartWorkflow\?\.\(readyParallelNodeIds\.length >= 2 \? readyParallelNodeIds : \[\]\)/);
assert.match(indexCssSource, /\.workflow-play-button[\s\S]*linear-gradient[\s\S]*\.workflow-play-button\.running/);
assert.match(chatViewSource, /RESUMABLE_CHECKPOINT_STATUSES[\s\S]*canResumeConversation[\s\S]*resumeMode/);
assert.match(chatViewSource, /action\.type === 'resume-workflow'[\s\S]*handleRunNow\(\)/);
assert.match(taskGraphWindowSource, /canResumeWorkflow=\{!!state\.canResumeWorkflow\}[\s\S]*onResumeWorkflow=\{\(\) => sendAction\('resume-workflow'\)\}/);
assert.match(taskGraphPanelSource, /resumeMode[\s\S]*onResumeWorkflow\?\.\(\)[\s\S]*Workflow fortsetzen/);
assert.match(indexCssSource, /\.workflow-play-button\.resume:not\(:disabled\)/);
assert.match(chatViewSource, /workflowUndoStackRef[\s\S]*commitUndoableGraphChange[\s\S]*undo-workflow-change[\s\S]*\.pop\(\)/);
assert.match(taskGraphWindowSource, /canUndo=\{!!state\.canUndo\}[\s\S]*onUndo=\{\(\) => sendAction\('undo-workflow-change'\)\}/);
assert.match(taskGraphPanelSource, /workflow-undo-button[\s\S]*onClick=\{onUndo\}[\s\S]*Rückgängig/);
assert.match(indexCssSource, /\.workflow-undo-button[\s\S]*\.workflow-undo-button:disabled/);
assert.match(taskGraphPanelSource, /const deleteWorkflow[\s\S]*window\.confirm[\s\S]*onDeleteWorkflow/);
assert.match(taskGraphPanelSource, /workflow-delete-button[\s\S]*onClick=\{deleteWorkflow\}/);
assert.match(taskGraphWindowSource, /onDeleteWorkflow=\{\(\) => sendAction\('delete-workflow'\)\}/);
assert.match(taskGraphWindowSource, /canDeleteWorkflow=\{!!state\.canDeleteWorkflow\}/);
assert.match(chatViewSource, /canDeleteWorkflow: Boolean\(conversationCheckpoint \|\| activeTaskGraph\.nodes\.length > 0 \|\| chatGroupRequests\.length > 0\)/);
assert.match(chatViewSource, /handleDeleteWorkflow[\s\S]*preserveProgress: false[\s\S]*discardConversationCheckpoint\(\)[\s\S]*clearTaskGraph\(chat\.id\)[\s\S]*workflowUndoStackRef\.current = \[\]/);
assert.match(chatViewSource, /handleDeleteWorkflow[\s\S]*groupRequestIds = groupRequestTreeIds[\s\S]*cancelAndRemoveGroupRequests\(groupRequestIds/);
assert.match(chatViewSource, /relatedRequestIds[\s\S]*status: 'cancelled'[\s\S]*finishRequestRuntimePlan[\s\S]*deliveredAt: cancelledAt/);
assert.match(chatViewSource, /Object\.entries\(userRequestQueues \|\| \{\}\)[\s\S]*queuedRequest\.kind === 'cross-group-answer'[\s\S]*removeUserRequest\(queueChatId, queuedRequest\.id\)/);
assert.match(chatViewSource, /action\.type === 'delete-workflow'[\s\S]*handleDeleteWorkflow\(\)/);
assert.match(indexCssSource, /\.workflow-delete-button[\s\S]*\.workflow-delete-button:disabled/);
assert.doesNotMatch(taskGraphPanelSource, /workflow-group-work-delete|onDeleteGroupWork/);
assert.doesNotMatch(taskGraphWindowSource, /onDeleteGroupWork|delete-group-work/);
assert.doesNotMatch(chatViewSource, /handleDeleteGroupWork|delete-group-work/);
assert.doesNotMatch(indexCssSource, /workflow-group-work-delete/);
assert.match(storeSource, /request\.parentRequestId[\s\S]*!previous\[request\.parentRequestId\][\s\S]*status === 'cancelled'/);
assert.match(crossGroupCoordinatorSource, /const usableResults = specialistResults\.filter\(Boolean\);[\s\S]*!requestsRef\.current\?\.\[request\.id\][\s\S]*const childBatchId/);
assert.match(storeSource, /removeCrossGroupRequestsMap[\s\S]*persist\('crossGroupRequests', updated\)/);
assert.match(crossGroupCoordinatorSource, /!requestsRef\.current\?\.\[request\.id\][\s\S]*status === 'cancelled'/);
assert.match(chatViewSource, /The first active view of an unused group starts in planning mode[\s\S]*activatePlanningMode\(\)/);
assert.match(chatViewSource, /workflowResetRequired[\s\S]*Beginne die Planung vollständig neu[\s\S]*keine Aufgaben, IDs, Abhängigkeiten, Status oder Annahmen/);
assert.match(chatViewSource, /activatePlanningMode\(\{ fresh: true, resetRequired: true \}\)[\s\S]*workflowReset: true/);
assert.match(chatViewSource, /workflow-reset-input-required-[\s\S]*gelöschte Workflow wird nicht aus dem alten Chat rekonstruiert/);
assert.match(preloadSource, /exportWorkflowFile:[\s\S]*workflow-file-export[\s\S]*importWorkflowFile:[\s\S]*workflow-file-import/);
assert.match(electronMainSource, /MAX_WORKFLOW_FILE_BYTES = 1024 \* 1024[\s\S]*handleIpc\('workflow-file-export'[\s\S]*handleIpc\('workflow-file-import'/);
assert.match(taskGraphPanelSource, /workflow-file-button export[\s\S]*onWorkflowExport[\s\S]*workflow-file-button import[\s\S]*onWorkflowImport/);
assert.match(taskGraphPanelSource, /WorkflowImportDialog[\s\S]*workflow-import-mappings[\s\S]*Workflow als Entwurf importieren/);
assert.match(taskGraphWindowSource, /import-workflow[\s\S]*export-workflow[\s\S]*map-workflow-import-slot[\s\S]*apply-workflow-import/);
assert.match(chatViewSource, /createWorkflowExportDocument[\s\S]*suggestWorkflowAgentMappings[\s\S]*createImportedTaskGraph/);
assert.match(chatViewSource, /action\.type === 'export-workflow'[\s\S]*action\.type === 'import-workflow'[\s\S]*action\.type === 'apply-workflow-import'/);
assert.match(indexCssSource, /\.workflow-file-button[\s\S]*\.workflow-file-status[\s\S]*\.workflow-import-overlay[\s\S]*\.workflow-import-dialog/);
assert.doesNotMatch(workflowPortabilitySource, /executionLog|approvedPlan|previousApprovedPlan|deliveredAt|childResponses/);
assert.doesNotMatch(taskGraphPanelSource, /closeTitle|Workflowfenster schließen/);
assert.match(chatViewSource, /getPendingWorkflowQuestions[\s\S]*askingGraphNodeId[\s\S]*pendingQuestions: getPendingWorkflowQuestions\(conversationCheckpoint\)/);
assert.match(chatViewSource, /containsUserDirective[\s\S]*extractUserQuestions\(storedQuestion\)[\s\S]*keine konkrete Rückfrage formuliert/);
assert.match(chatViewSource, /const userQuestions = task\.outOfBand \|\| task\.preparationOnly \? \[\] : extractUserQuestions\(rawReply\);[\s\S]*let asksUser = userQuestions\.length > 0/);
assert.doesNotMatch(chatViewSource, /pauseQuestion[\s\S]{0,180}displayReply\.slice\(-700\)/);
assert.match(chatViewSource, /answer-agent-question[\s\S]*sendUserMessage\(answer, \[\], messageQualityMode\)[\s\S]*runAgents\(\[\.\.\.chatMessagesRef\.current, userMessage\], answer\)/);
assert.match(taskGraphWindowSource, /pendingQuestions=\{state\.pendingQuestions \|\| \[\]\}[\s\S]*answer-agent-question/);
assert.match(taskGraphPanelSource, /WorkflowQuestionDialog[\s\S]*workflow-question-answer/);
assert.match(taskGraphPanelSource, /pendingQuestion[\s\S]*workflow-question-badge[\s\S]*onQuestionOpen/);
assert.match(indexCssSource, /\.workflow-question-badge[\s\S]*\.workflow-question-overlay[\s\S]*\.workflow-question-dialog textarea/);
assert.match(workflowProblemDialogSource, /WorkflowProblemDialog[\s\S]*workflow-problem-answer[\s\S]*Hauptplan überarbeiten[\s\S]*Ausführung reparieren/);
assert.match(taskGraphPanelSource, /workflowProblem[\s\S]*workflow-problem-badge[\s\S]*onProblemOpen/);
assert.match(taskGraphWindowSource, /workflowProblems=\{state\.workflowProblems \|\| \[\]\}[\s\S]*resolve-workflow-problem/);
assert.match(chatViewSource, /collectWorkflowProblems[\s\S]*workflowProblemKey[\s\S]*Workflow-Problem bei/);
assert.match(chatViewSource, /resolveWorkflowProblem[\s\S]*startWorkflowRecovery[\s\S]*beginPMPlanRevision[\s\S]*planningOnly: true/);
assert.match(chatViewSource, /messageWorkflowProblem[\s\S]*label: t\('Lösen'\)[\s\S]*setOpenWorkflowProblem/);
assert.match(indexCssSource, /\.workflow-problem-badge[\s\S]*\.workflow-problem-dialog/);
assert.match(indexCssSource, /\.system-message-action\.problem/);
assert.match(taskGraphPanelSource, /detailsCollapsed[\s\S]*detailsPinned/);
assert.match(taskGraphPanelSource, /aria-pressed=\{pinned\}[\s\S]*aria-expanded=\{!collapsed\}/);
assert.match(taskGraphPanelSource, /if \(!detailsPinned\) closeDetails\(\)/);
assert.match(taskGraphPanelSource, /Workflow-Legende[\s\S]*Fork \/ Join/);
assert.match(taskGraphPanelSource, /onTaskAdd[\s\S]*onTaskSplit[\s\S]*onTaskMove/);
assert.match(taskGraphPanelSource, /workflow-connector-out[\s\S]*setPointerCapture\(event\.pointerId\)[\s\S]*onConnectionStart/);
assert.match(taskGraphPanelSource, /connectionTargetAt[\s\S]*elementFromPoint[\s\S]*validateConnectionTarget/);
assert.match(taskGraphPanelSource, /validateWorkflowConnection\(graph, sourceId, targetId, connectionKind\)[\s\S]*onDependencyAdd\?\.\(draft\.sourceId, targetId, validationResult\.kind\)/);
assert.match(taskGraphPanelSource, /workflow-connection-preview/);
assert.match(taskGraphPanelSource, /connection-target-/);
assert.match(taskGraphPanelSource, /connectionEnabled=\{structureEditable\}/);
assert.match(indexCssSource, /\.workflow-connector[\s\S]*\.workflow-connection-preview\.valid[\s\S]*\.workflow-connection-preview\.invalid/);
assert.match(taskGraphPanelSource, /filter\(edge => edge\.kind === 'dependency' \|\| edge\.kind === 'review'\)[\s\S]*workflow-edge-hit/);
assert.match(taskGraphPanelSource, /workflow-edge-remove[\s\S]*removeSelectedDependency/);
assert.match(taskGraphPanelSource, /onDependencyRemove\?\.\(selectedDependency\.from, selectedDependency\.to, selectedDependency\.kind\)/);
assert.match(taskGraphPanelSource, /Nur die Verbindung entfernen; Aufgaben bleiben erhalten/);
assert.match(indexCssSource, /\.workflow-edge-hit[\s\S]*pointer-events: stroke[\s\S]*\.workflow-edge-remove/);
assert.doesNotMatch(taskGraphPanelSource, /Lösungstipp|workflow-solution/);
assert.match(taskGraphPanelSource, /workflow-check-plan[\s\S]*Aufgabenplan auf Ausführbarkeit prüfen/);
assert.match(taskGraphPanelSource, /workflow-planning-actions[\s\S]*workflow-check-plan/);
assert.doesNotMatch(taskGraphPanelSource, /PM komplett übernehmen|workflow-pm-takeover|workflow-restore-origin/);
assert.match(taskGraphPanelSource, /inspectWorkflowPlan[\s\S]*workflow-inspection-report[\s\S]*Vorschläge/);
assert.match(indexCssSource, /\.workflow-inspection-report[\s\S]*\.workflow-inspection-report\.error/);
assert.match(taskGraphPanelSource, /onRestoreSnapshot[\s\S]*Snapshot wiederherstellen/);
assert.match(taskGraphPanelSource, /Neue Abhängigkeit[\s\S]*Vorgänger auswählen…[\s\S]*Hinzufügen/);
assert.match(taskGraphPanelSource, /validationHighlighted[\s\S]*workflow-validation-badge[\s\S]*Problem/);
assert.match(taskGraphPanelSource, /problems\.length > 0[\s\S]*Erkannte Probleme[\s\S]*Mögliche Lösung/);
assert.match(taskGraphPanelSource, /const selectedNodeProblems = useMemo[\s\S]*BLOCKED_REASON_LABELS/);
assert.match(taskGraphPanelSource, /problems=\{selectedNodeProblems\}[\s\S]*problemSuggestions=\{selectedNodeProblemSuggestions\}/);
assert.match(indexCssSource, /\.workflow-problem-details[\s\S]*\.workflow-problem-suggestions/);
assert.match(taskGraphWindowSource, /preflightTaskIds=\{state\.preflightTaskIds \|\| \[\]\}/);
assert.match(taskGraphWindowSource, /restore-workflow-snapshot/);
assert.doesNotMatch(chatViewSource, /workflowSolution|solution-tip/);
assert.doesNotMatch(chatViewSource, /pm-plan-takeover|restore-pm-plan-origin|beginPmPlanOverride|restorePmPlanOrigin/);
assert.match(taskGraphPanelSource, /workflow-node/);
assert.match(workflowLayoutSource, /buildWorkflowLayout[\s\S]*workflowPosition[\s\S]*workflowEdgePath/);
assert.match(chatViewSource, /className="input-area"[\s\S]*className="composer-plan-actions"[\s\S]*handleScheduleChoice[\s\S]*disabled=\{workflowStartDisabled\}[\s\S]*Plan freigeben & starten/,
  'Planfreigabe muss mit bestehenden Freigabeprüfungen direkt beim Eingabefeld stehen.');
assert.match(chatViewSource, /handleDeactivatePlanningMode[\s\S]*planningSuspended: true[\s\S]*discardConversationCheckpoint/);
assert.match(chatViewSource, /currentGraph\?\.planningSuspended[\s\S]*suspendedPlanningCheckpoint[\s\S]*workflowState: 'planning'/);
assert.match(chatViewSource, /planning-mode-close[\s\S]*Planungsmodus deaktivieren/);
assert.match(indexCssSource, /\.planning-mode-close[\s\S]*\.planning-mode-close:hover/);
assert.match(chatViewSource, /mode: 'planning'[\s\S]*pendingTasks: \[\]/);
assert.match(chatViewSource, /if \(planningOnly\)[\s\S]*planningPause[\s\S]*status: planningPause \? 'awaiting-user' : groupPauseExecutions\.length > 0 \? 'awaiting-group' : 'planning'/);
assert.match(chatViewSource, /if \(asksUser && !groupPauseRequested\)[\s\S]*pauseRequested = true/);
assert.match(chatViewSource, /buildPlanningPendingTasks[\s\S]*CLAIMABLE_PLAN_STATUSES[\s\S]*isTaskNodeReady/);
assert.match(chatViewSource, /shouldRunAsWorkflowSideConversation[\s\S]*outOfBand: sideConversation/);
assert.match(chatViewSource, /candidate\.outOfBand[\s\S]*mode: 'side-conversation'[\s\S]*validateApprovedTaskExecution/);
assert.match(chatViewSource, /if \(!task\.outOfBand\)[\s\S]*recordTaskExecutionEvent\(graph, task, task\.preparationOnly \? 'preparation-failed' : 'failed'/);
assert.match(chatViewSource, /action\.type === 'update-task-model'[\s\S]*modelOverride/);
assert.match(chatViewSource, /action\.type === 'update-task-agent'[\s\S]*action\.type === 'add-dependency'[\s\S]*action\.type === 'remove-dependency'/);
assert.match(chatViewSource, /validateApprovedTaskExecution[\s\S]*status: 'needs-attention'[\s\S]*Der Plan blieb unverändert/);
assert.match(chatViewSource, /source: runtimeRecovery \? plannedNode\.source : 'approved-workflow'/);
assert.match(chatViewSource, /checkpoint\.mode === 'planning' \? lockTaskGraphPlan\(scheduledGraph\) : scheduledGraph|checkpoint\.mode !== 'planning'/);
assert.match(chatViewSource, /action\.type === 'update-task-position'[\s\S]*updateWorkflowViewPosition/);
assert.match(taskGraphPanelSource, /Modell für diese Aufgabe[\s\S]*Plan freigeben & starten/);
assert.match(taskGraphPanelSource, /Plan bearbeiten/);
assert.match(taskGraphPanelSource, /Aufgabe erneut versuchen/);
assert.match(taskGraphPanelSource, /workflow-retry-actions[\s\S]*workflow-retry-task[\s\S]*onRetryTask/);
assert.match(indexCssSource, /\.workflow-task-actions\.workflow-retry-actions > div[\s\S]*grid-template-columns: minmax\(0, 1fr\)[\s\S]*\.workflow-retry-task/);
assert.match(taskGraphWindowSource, /edit-workflow[\s\S]*retry-task/);
assert.match(chatViewSource, /action\.type === 'retry-task'[\s\S]*if \(planningActive\) return;[\s\S]*if \(running\)[\s\S]*nächsten freien passenden Agenten vorgemerkt/);
assert.doesNotMatch(taskGraphPanelSource, /executionMode|Sequenziell/);
assert.match(electronMainSource, /let reviewWindow;/);
assert.match(electronMainSource, /reviewWindow = new BrowserWindow\([\s\S]*sandbox: true/);
assert.match(electronMainSource, /review-window-open[\s\S]*review-list[\s\S]*review-run/);
assert.match(electronMainSource, /ensureReviewCommandTrusted[\s\S]*trustedReviewCommands/);
assert.match(electronMainSource, /'trustedReviewCommands'[\s\S]*'trustedFileSystemPaths'/);
assert.match(preloadSource, /openReviewWindow:[\s\S]*reviewInspect:[\s\S]*reviewRun:/);
assert.match(preloadSource, /memoryLocalOperation:[\s\S]*memory-local-operation/);
assert.match(rendererEntrySource, /isReviewWindow[\s\S]*<ReviewWindow \/>/);
assert.match(reviewWindowSource, /review-word-preview/);
assert.match(reviewWindowSource, /reviewSnapshots/);
assert.match(reviewWindowSource, /reviewRun/);
assert.match(reviewEnvironmentSource, /validateReviewPreviewUrl/);
assert.match(artifactSandboxSource, /assertNoSymlinkTraversal[\s\S]*loadBoundedDocx[\s\S]*createSnapshot[\s\S]*replaceWordText/);
assert.match(reviewRunnerSource, /safeChildEnvironment[\s\S]*shell: false[\s\S]*commandFingerprint/);
assert.match(electronMainSource, /before-quit[\s\S]*hasActiveRuns\(\)[\s\S]*Promise\.all\(\[reviewRunner\.stopAll\(\), mcpManager\.closeAll\(\)\]\)/);
assert.match(modalsSource, /Prüf- und Vorschauumgebung[\s\S]*Automatischer Prüfbefehl[\s\S]*Vorschauprozess/);
assert.match(chatViewSource, /shouldRunConfiguredReview[\s\S]*reviewRun\(chat\.id, 'test'\)/);
assert.match(chatViewSource, /normalizeAcceptanceCriteria\(task\.acceptanceCriteria[\s\S]*vollständig und überprüfbar/);
assert.match(chatViewSource, /acceptanceReady: acceptanceSummary\.ready/);
assert.match(chatViewSource, /reviewStop\(chat\.id, 'test'\)/);
assert.match(chatViewSource, /memAPI\.handoff\(memoryNamespace, handoff\)/);
assert.match(memoryProviderSource, /createCrossGroupResultEntry[\s\S]*dedupeKey: `cross-group-result:\$\{normalizedRequestId\}`[\s\S]*async writeOnce/);
assert.match(crossGroupCoordinatorSource, /persistCrossGroupResultMemory[\s\S]*destinationsByKey[\s\S]*\.writeOnce\([\s\S]*memoryStoredAt:/);
assert.equal((chatViewSource.match(/openReviewWindow\(/g) || []).length, 2);
assert.match(chatViewSource, /typing-agent-name[\s\S]*agent\?\.name[\s\S]*typing-agent-role[\s\S]*agent\?\.role[\s\S]*typing-indicator/);
assert.match(chatViewSource, /buildRelevantConversationHistory\(\{[\s\S]*includeGroupContext: isOrchestrator && task\.source === 'user'/);
assert.match(chatViewSource, /onCreateEntry=\{handleCreateMemoryEntry\}/);
const messageComposerTextarea = chatViewSource.match(/<textarea(?:(?!<textarea)[\s\S])*?className="message-input"[\s\S]*?\/>/)?.[0] || '';
assert.match(messageComposerTextarea, /autoFocus/);
assert.doesNotMatch(messageComposerTextarea, /disabled=\{running\}/);
assert.doesNotMatch(indexCssSource, /body\s*\{[^}]*user-select:\s*none/);
assert.match(indexCssSource, /input, textarea, \[contenteditable="true"\][\s\S]*-webkit-user-select: text;[\s\S]*user-select: text;/);
assert.match(indexCssSource, /\.message-input \{[\s\S]*pointer-events: auto;[\s\S]*user-select: text;/);
assert.match(appSource, /className="app-shell"/);
assert.match(chatViewSource, /className="composer-message-row"[\s\S]*className="message-input"[\s\S]*className="send-btn"/);
assert.match(indexCssSource, /#root, \.app-shell[\s\S]*min-height: 0;[\s\S]*\.app-layout[\s\S]*min-width: 0;[\s\S]*min-height: 0;/);
assert.match(indexCssSource, /\.chat-area[\s\S]*min-width: 0;[\s\S]*\.composer-message-row[\s\S]*min-width: 0;/);
assert.match(indexCssSource, /\.message-input \{[\s\S]*width: 0;[\s\S]*min-width: 0;[\s\S]*overflow-y: auto;/);
assert.match(indexCssSource, /@media \(max-width: 720px\)[\s\S]*\.sidebar:not\(\.collapsed\)[\s\S]*\.input-area[\s\S]*flex-direction: column/);
assert.match(indexCssSource, /@media \(max-width: 520px\) and \(max-height: 520px\)[\s\S]*\.project-folder-notice \{ display: none; \}[\s\S]*\.planning-mode-bar[\s\S]*max-height: 100px/);
assert.match(chatViewSource, /input \? Math\.min\(textarea\.scrollHeight, 120\) : 40[\s\S]*new ResizeObserver\(scheduleResize\)/);
assert.match(chatViewSource, /const selectionStart = textarea\.selectionStart;[\s\S]*textarea\.focus\(\{ preventScroll: true \}\);[\s\S]*textarea\.setSelectionRange\(selectionStart, selectionEnd\)/);
const messageComposerSendButton = chatViewSource.match(/<button(?:(?!<button)[\s\S])*?className="send-btn"[\s\S]*?<\/button>/)?.[0] || '';
assert.match(messageComposerSendButton, /disabled=\{!input\.trim\(\) && !pendingAttachments\.length\}/);
assert.doesNotMatch(messageComposerSendButton, /disabled=\{[^}]*running/);
assert.match(chatViewSource, /queueBehindActiveRun[\s\S]*enqueueUserRequest/);
assert.match(chatViewSource, /buildQueuedRequestHistory[\s\S]*await runAgents[\s\S]*removeUserRequest/);
assert.match(chatViewSource, /\[chat\.id, running, memoryViewer\.open, mcpApproval, focusComposer\]/);
assert.match(chatViewSource, /window\.addEventListener\('focus', restoreComposerFocus\)/);
assert.match(chatViewSource, /function MessageCopyButton\(\{ text \}\)[\s\S]*navigator\.clipboard|function copyText\(text\)[\s\S]*navigator\.clipboard/);
assert.match(chatViewSource, /message-bubble[\s\S]*MessageCopyButton text=\{msgText\}/);
assert.match(chatViewSource, /system-message-bubble[\s\S]*MessageCopyButton text=\{text\}/);
assert.match(indexCssSource, /\.message-bubble[\s\S]*user-select: text/);
assert.match(chatViewSource, /function McpPermissionPrompt\(\{ request, onDecision \}\)/);
assert.match(chatViewSource, /mcp-inline-permission-actions[\s\S]*onDecision\('deny'\)[\s\S]*Verweigern[\s\S]*onDecision\('allow-once'\)[\s\S]*Zulassen/);
assert.match(chatViewSource, /typingAgents[\s\S]*mcpApproval && <McpPermissionPrompt request=\{mcpApproval\}/);
assert.doesNotMatch(chatViewSource, /mcp-permission-overlay|McpPermissionDialog/);
assert.match(indexCssSource, /\.mcp-inline-permission[\s\S]*\.mcp-inline-permission-actions/);
assert.match(chatViewSource, /requestPermission: request =>[\s\S]*requestMcpPermission\(request\)/);
assert.match(chatViewSource, /onPermissionConsumed: handleMcpPermissionConsumed/);
assert.doesNotMatch(chatViewSource, /mcpChatPermissionGrants/);
assert.match(chatViewSource, /savedGrant\?\.scope === 'chat'/);
assert.match(chatViewSource, /savedGrant\?\.scope === 'once'[\s\S]*savedGrant\.expiresAt/);
assert.match(chatViewSource, /MCP-Freigaben löschen \(\{count\}\)/);
assert.match(chatViewSource, /globalDecision === 'allow'[\s\S]*scope: 'global'/);
assert.match(chatViewSource, /globalDecision === 'deny'[\s\S]*globale Einstellung blockiert/);
assert.match(storeSource, /appStateGet\('mcpPermissions'\)/);
assert.match(storeSource, /appStateGet\('userRequestQueues'\)/);
assert.match(storeSource, /appStateGet\('crossGroupRequests'\)/);
assert.match(storeSource, /persist\('userRequestQueues', updated\)/);
assert.match(storeSource, /persist\('crossGroupRequests', updated\)/);
assert.match(storeSource, /persist\('mcpPermissions', updated\)/);
assert.doesNotMatch(preloadSource, /storeGet|storeSet|storeDelete/);
assert.match(preloadSource, /providerCredentialsStatus/);
assert.match(storeSource, /appStateGet\('providerConnections'\)/);
assert.match(electronMainSource, /findProviderConnection\(store\.get\('providerConnections'\), provider\)/);
assert.match(electronMainSource, /sandbox: true/);
assert.match(indexSource, /Content-Security-Policy/);
assert.match(storeSource, /grantMcpPermission[\s\S]*consumeMcpPermission[\s\S]*clearMcpPermissions/);
assert.match(mcpConfigSource, /Verbindung testen und Werkzeuge laden/);
assert.match(mcpConfigSource, /Alle gefundenen erlauben[\s\S]*Nur lesende erlauben[\s\S]*Alle wieder nachfragen/);
assert.match(mcpConfigSource, /Erlauben[\s\S]*Nachfragen[\s\S]*Blockieren/);
assert.match(indexCssSource, /\.settings-panel\s*\{[\s\S]*?width:\s*100%/);
assert.match(indexCssSource, /\.settings-content\s*\{[\s\S]*?padding:\s*24px/);
assert.match(chatViewSource, /chat\.type === 'group' \? chat\.mcpServers : \[\]/);
assert.match(chatViewSource, /msg\.diagram && <ExcalidrawDiagram/);
assert.match(modalsSource, /Globale Agentenrollen/);
assert.match(modalsSource, /setAgentRoles\(localAgentRoles\)/);
assert.match(modalsSource, /Weitere API-Anbieter/);
assert.match(modalsSource, /data-testid="anthropic-auth-group"/);
assert.match(modalsSource, /data-testid="openai-auth-group"/);
assert.match(modalsSource, /onClick=\{refreshClaudeStatus\}/);
assert.match(modalsSource, /onClick=\{refreshCodexStatus\}/);
assert.match(modalsSource, /Codex CLI verbinden/);
assert.match(modalsSource, /setApiKeys\(\{ codexCli: false \}\)/);
assert.match(electronMainSource, /Codex CLI wurde in den Einstellungen getrennt/);
assert.match(modalsSource, /<code>claude<\/code>/);
assert.match(modalsSource, /<code>codex login<\/code>/);
assert.equal((modalsSource.match(/Claude Code CLI verbinden/g) || []).length, 1);
assert.match(modalsSource, /OpenAI-kompatibel[\s\S]*Anthropic Messages[\s\S]*Google Gemini/);

const delegationSource = await fs.readFile(path.join(root, 'src/delegation.js'), 'utf8');
const delegationUrl = `data:text/javascript;base64,${Buffer.from(delegationSource).toString('base64')}`;
const taskTicketUrl = `data:text/javascript;base64,${Buffer.from(taskTicketSource).toString('base64')}`;
const taskTicket = await import(taskTicketUrl);

async function importSource(relativePath) {
  if (relativePath === 'src/quality-cascade.js') return import(pathToFileURL(path.join(root, 'electron/quality-cascade.mjs')).href);
  const source = (await fs.readFile(path.join(root, relativePath), 'utf8'))
    .replace("from './streaming-plan.mjs';", `from '${pathToFileURL(path.join(root, 'src/streaming-plan.mjs')).href}';`)
    .replace(/from '\.\/delegation(?:\.js)?';/g, `from '${delegationUrl}';`)
    .replace(/from '\.\/task-ticket';/g, `from '${taskTicketUrl}';`);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

const orchestration = await importSource('src/orchestrator.js');
const streamedTicket = { id: 'live-1', title: 'Erstes Ticket', agent: 'Coder', description: 'Liste: {a} und "b"', acceptanceCriteria: ['Prüfbar'] };
const planPrefix = `[[TASK_PLAN]]\n{"version":2,"tasks":[${JSON.stringify(streamedTicket)}`;
assert.equal(orchestration.extractStreamingTaskPlan(planPrefix.slice(0, -1)), null);
assert.equal(orchestration.extractStreamingTaskPlan(`${planPrefix},{"id":"live-2","title":"Halb` ).tasks.length, 1);
assert.equal(orchestration.extractStreamingTaskPlan(planPrefix).tasks[0].description, streamedTicket.description);
assert.equal(orchestration.extractStreamingTaskPlan('Kein Plan'), null);
assert.equal(orchestration.extractStreamingTaskPlan(`${planPrefix}]}[[/TASK_PLAN]]`).tasks.length, 1);
const agentRuntime = await importSource('src/agent-runtime.js');
const memoryRules = await importSource('src/memory.js');
const taskGraphUrl = pathToFileURL(path.join(root, 'src/task-graph.js')).href;
const taskGraph = await import(taskGraphUrl);
const workflowPortabilityPreparedSource = workflowPortabilitySource
  .replace(/from '\.\/task-graph';/g, `from '${taskGraphUrl}';`)
  .replace(/from '\.\/delegation(?:\.js)?';/g, `from '${delegationUrl}';`);
const workflowPortability = await import(`data:text/javascript;base64,${Buffer.from(workflowPortabilityPreparedSource).toString('base64')}`);
const workflowLayout = await importSource('src/workflow-layout.js');
const llm = await importSource('src/llm.js');
const mcp = await importSource('src/mcp.js');
const excalidraw = await importSource('src/excalidraw.js');
const quality = await importSource('src/quality-cascade.js');
const agentRoles = await importSource('src/agent-roles.js');
const conversationLimits = await importSource('src/conversation-limits.js');
const userRequestQueue = await importSource('src/user-request-queue.js');
const providerCatalog = await importSource('src/provider-catalog.js');
const crossGroup = await importSource('src/cross-group.js');
const delegation = await import(delegationUrl);
assert.equal(llm.normalizeConversationLanguage('en'), 'en');
assert.equal(llm.normalizeConversationLanguage('de'), 'de');
assert.equal(llm.normalizeConversationLanguage('fr'), 'de');
assert.equal(agentRuntime.shouldEnableProjectTools({ projectPath: 'C:\\Project', objective: 'Warum ist die Antwort langsam?', source: 'user' }), false);
assert.equal(agentRuntime.shouldEnableProjectTools({ projectPath: 'C:\\Project', objective: 'Ändere die React-Komponente', source: 'user' }), true);
assert.equal(agentRuntime.shouldEnableProjectTools({ projectPath: 'C:\\Project', objective: 'Plane die Änderung', planningOnly: true }), false);
assert.equal(agentRuntime.shouldEnableProjectTools({ projectPath: 'C:\\Project', objective: 'Task', source: 'approved-workflow' }), true);
assert.equal(agentRuntime.codexReasoningEffortForTask({ planningOnly: true, complexity: 'high' }), 'low');
assert.equal(agentRuntime.codexReasoningEffortForTask({ complexity: 'low' }), 'low');
assert.equal(agentRuntime.codexReasoningEffortForTask({ complexity: 'medium' }), 'medium');
assert.equal(agentRuntime.codexReasoningEffortForTask({ complexity: 'high' }), 'high');
assert.equal(agentRuntime.codexReasoningEffortForTask({ runtimeRecovery: true, qualityMode: 'fast' }), 'high');
assert.equal(agentRuntime.codexReasoningEffortForTask({ escalated: true }), 'high');
assert.match(llm.buildResponseLanguageInstruction('en'), /Write every user-visible sentence in English/);
assert.match(llm.buildResponseLanguageInstruction('en'), /PM plans[\s\S]*@Agent delegations[\s\S]*final answers/);
assert.match(llm.buildResponseLanguageInstruction('de'), /jeden für den User sichtbaren Satz auf Deutsch/);
const electronMcpPreset = require(path.join(root, 'electron/mcp-preset.js'));
const pm = { id: 'pm', name: 'PM', role: 'Projektleiter', isSystemAgent: true };
const coder = { id: 'coder', name: 'Max', role: 'Developer' };
const coderTwo = { id: 'coder-two', name: 'Alex', role: 'Developer' };
const tester = { id: 'tester', name: 'Lisa', role: 'QA' };

const portableWorkflowFixture = {
  format: workflowPortability.WORKFLOW_FILE_FORMAT,
  schemaVersion: workflowPortability.WORKFLOW_FILE_SCHEMA_VERSION,
  title: 'Portable React App',
  description: 'Build and review a small React application.',
  slots: [{ id: 'builder', name: 'Max', role: 'Developer', capabilities: ['react'] }],
  nodes: [
    { id: 'root', type: 'request', title: 'React App', objective: 'Create the application.' },
    {
      id: 'implementation', type: 'task', slotId: 'builder', title: 'Implement UI',
      objective: 'Implement the React UI.', order: 1,
      acceptanceCriteria: [{ id: 'ui-ready', text: 'The UI is usable.', required: true, verification: 'agent' }],
      delegation: { mode: 'allow', requiredCapabilities: ['react'] },
      position: { x: 420, y: 180 },
    },
  ],
  points: [],
  connections: [{ from: 'root', to: 'implementation', kind: 'delegation' }],
};
const portableAgents = [{ ...coder, provider: 'openai', model: 'gpt-test', capabilities: ['react'] }];
const portablePreview = workflowPortability.suggestWorkflowAgentMappings(portableWorkflowFixture, portableAgents);
assert.equal(portablePreview.mappings.builder, coder.id);
assert.equal(portablePreview.slots[0].suggestionReason, 'name');
const importedPortable = workflowPortability.createImportedTaskGraph(portablePreview.document, {
  chatId: 'portable-chat', chatName: 'Portable', agents: portableAgents, mappings: portablePreview.mappings,
});
assert.equal(importedPortable.graph.workflowState, 'planning');
assert.equal(importedPortable.graph.planOwner, 'user');
assert.equal(importedPortable.graph.approvedPlan, null);
const importedPortableTask = importedPortable.graph.nodes.find(node => node.nodeType === 'task');
assert.equal(importedPortableTask.status, 'planned');
assert.equal(importedPortableTask.agentId, coder.id);
assert.deepEqual(importedPortableTask.acceptanceCriteria[0].evidence, []);
assert.equal(taskGraph.validateWorkflowPlan(importedPortable.graph).ok, true);
const exportedPortable = workflowPortability.createWorkflowExportDocument({
  ...importedPortable.graph,
  executionLog: [{ output: 'must not leave this app' }],
  approvedPlan: { revision: 99 },
  nodes: importedPortable.graph.nodes.map(node => ({
    ...node,
    status: node.nodeType === 'task' ? 'completed' : node.status,
    error: 'local runtime error',
  })),
}, { agents: portableAgents });
const exportedPortableText = JSON.stringify(exportedPortable);
assert.equal(exportedPortable.format, 'agent-teams-workflow');
assert.doesNotMatch(exportedPortableText, /must not leave this app|local runtime error|portable-chat/);
assert.equal(exportedPortable.nodes.find(node => node.type === 'task').slotId, 'slot-1');
assert.throws(() => workflowPortability.createImportedTaskGraph(portableWorkflowFixture, {
  chatId: 'portable-chat', agents: portableAgents, mappings: {},
}), /noch nicht zugeordnet/);
assert.throws(() => workflowPortability.normalizeWorkflowDocument({
  ...portableWorkflowFixture, schemaVersion: 999,
}), /Schemaversion/);
assert.throws(() => workflowPortability.normalizeWorkflowDocument({
  ...portableWorkflowFixture,
  nodes: portableWorkflowFixture.nodes.map(node => node.id === 'implementation' ? { ...node, type: 'script' } : node),
}), /unbekannten Typ/);
const cyclicPortableWorkflow = {
  ...portableWorkflowFixture,
  nodes: [
    ...portableWorkflowFixture.nodes,
    { ...portableWorkflowFixture.nodes[1], id: 'verification', title: 'Verify UI', order: 2 },
  ],
  connections: [
    ...portableWorkflowFixture.connections,
    { from: 'implementation', to: 'verification', kind: 'dependency' },
    { from: 'verification', to: 'implementation', kind: 'dependency' },
  ],
};
assert.throws(() => workflowPortability.createImportedTaskGraph(cyclicPortableWorkflow, {
  chatId: 'portable-chat', agents: portableAgents, mappings: { builder: coder.id },
}), /Abhängigkeitszyklus|nicht ausführbar/);

const openRouterConnection = providerCatalog.createProviderConnection('openrouter', 'api-openrouter-test');
assert.equal(openRouterConnection.baseUrl, 'https://openrouter.ai/api/v1');
assert.equal(openRouterConnection.protocol, 'openai');
assert.equal(providerCatalog.getProviderModels(openRouterConnection.id, [openRouterConnection], {}, '').length >= 2, true);
assert.equal(providerCatalog.getProviderOptions([openRouterConnection]).at(-1).name, 'OpenRouter');
assert.equal(providerCatalog.PROVIDER_PRESETS.some(provider => provider.id === 'gemini' && provider.protocol === 'gemini'), true);

assert.deepEqual(conversationLimits.normalizeConversationLimits({
  maxTurns: 100,
  maxTurnsPerAgent: 90,
  pmReviewOnLimit: false,
}), { maxTurns: 50, maxTurnsPerAgent: 50, pmReviewOnLimit: false });
assert.deepEqual(conversationLimits.normalizeConversationLimits({ maxTurns: 2, maxTurnsPerAgent: 0 }), {
  maxTurns: 3,
  maxTurnsPerAgent: 0,
  pmReviewOnLimit: true,
});
assert.deepEqual(conversationLimits.normalizeConversationLimits({ maxTurns: 0, maxTurnsPerAgent: 0 }), {
  maxTurns: 0,
  maxTurnsPerAgent: 0,
  pmReviewOnLimit: true,
});
assert.match(chatViewSource, /maxTurns: conversationLimits\.maxTurns/);
assert.match(chatViewSource, /source === 'turn-limit-review'/);
assert.match(chatViewSource, /status: 'limit-reached'/);
assert.doesNotMatch(chatViewSource, /maxTurns: 12/);
assert.doesNotMatch(chatViewSource, /500 \+ Math\.min\(taskQueue\.turns/);
assert.match(chatViewSource, /findSafeAutoParallelTaskIds[\s\S]*taskQueue\.prioritize/);
assert.match(chatViewSource, /runWorkConservingApprovedBatch[\s\S]*runTaskPool/);
assert.match(chatViewSource, /enqueueReadyApprovedWorkflowTasks[\s\S]*isTaskNodeReady/);
assert.match(chatViewSource, /nextMatching[\s\S]*!activeAgentIds\.has\(candidate\.agent\.id\)/);
assert.match(chatViewSource, /enqueueDependencyPreparationTasks[\s\S]*findDependencyPreparationCandidateIds/);
assert.match(chatViewSource, /preparationOnly[\s\S]*Zwischengespeicherte Vorarbeit dieser Aufgabe/);
assert.match(chatViewSource, /interimResult: execution\.interimResult/);
assert.match(chatViewSource, /useLeanFastPath[\s\S]*skipFastFinalReview/);
assert.match(chatViewSource, /extractGroupMentions\(rawReply[\s\S]*status: 'awaiting-group'/);
assert.match(chatViewSource, /waiting_group[\s\S]*Unabhängige Aufgaben laufen weiter/);
assert.match(chatViewSource, /function ErrorBubble[\s\S]*system-message-action/);
assert.match(chatViewSource, /delegationTaskId[\s\S]*pendingDelegations\.find[\s\S]*resolve-task-delegation/);
assert.match(chatViewSource, /targetCandidateId: delegationCandidate\.candidateId \|\| delegationCandidate\.agentId/);
assert.match(indexCssSource, /\.system-message-action[\s\S]*rgba\(192,132,252/);
assert.match(crossGroupCoordinatorSource, /MAX_PARALLEL_GROUP_REQUESTS[\s\S]*getGroupPMAgent[\s\S]*status: 'answered'/);
assert.match(crossGroupCoordinatorSource, /enqueueUserRequest[\s\S]*kind: 'cross-group-answer'/);
assert.match(crossGroupCoordinatorSource, /parentRequestId: request\.id[\s\S]*status: 'waiting_child'/);
assert.match(crossGroupCoordinatorSource, /childResponses[\s\S]*resumeCount[\s\S]*status: 'queued'/);
assert.match(crossGroupCoordinatorSource, /requestGroupPath[\s\S]*MAX_CROSS_GROUP_REQUEST_DEPTH/);
assert.match(crossGroupCoordinatorSource, /getUnprocessedChildResponses\(request\)[\s\S]*processedChildResponseIds[\s\S]*Nur neu eingetroffene Ergebnisse der Unteranfragen/);
assert.match(crossGroupCoordinatorSource, /requestContextIds[\s\S]*targetHistory[\s\S]*processedContextSummary/);
assert.match(crossGroupCoordinatorSource, /executeQualityCall[\s\S]*runQualityCascade[\s\S]*specialistResults = await Promise\.all/);
assert.match(crossGroupCoordinatorSource, /specialistResults = await Promise\.all[\s\S]*executeQualityCall[\s\S]*cross-group-specialist-input/);
assert.match(crossGroupCoordinatorSource, /final-synthesis[\s\S]*executeQualityCall[\s\S]*cross-group-synthesis-input/);
assert.match(crossGroupCoordinatorSource, /qualityMode: request\.qualityMode \|\| 'auto'/);
assert.match(crossGroupCoordinatorSource, /requireQueryMatch: true[\s\S]*groupLimit: 6[\s\S]*maxCharacters: 12000/);
assert.match(chatViewSource, /workflowDependencyAncestorIds\(currentGraph, plannedNode\.id\)[\s\S]*relevantResults\.map\(item =>/);
assert.doesNotMatch(chatViewSource, /findings: delegatedResults\.map\(item => `\$\{item\.agent\}: \$\{item\.result\}`\)/);
assert.match(chatViewSource, /kbSearch\(\{ query: objective[\s\S]*buildRelevantProjectInventoryContext[\s\S]*relevantPlanNodeIds/);
assert.doesNotMatch(chatViewSource, /projectResult\.files\.slice\(0, 100\)/);
assert.doesNotMatch(chatViewSource, /projectContext \+=/);
assert.match(chatViewSource, /const executeAgentTask = async[\s\S]*resolveQualityPolicy[\s\S]*runWorkConservingApprovedBatch[\s\S]*executeAgentTask\(nextTask\)/);
assert.match(chatViewSource, /callWithoutTools[\s\S]*MCP side effects must never be repeated[\s\S]*usedMcp[\s\S]*callWithoutTools/);
assert.doesNotMatch(crossGroupCoordinatorSource, /gruppenübergreifende Ketten werden[\s\S]*nicht automatisch erzeugt/);
assert.match(taskGraphWindowSource, /groupRequests=\{state\.groupRequests \|\| \[\]\}[\s\S]*retry-group-request/);
assert.match(taskGraphPanelSource, /GroupRequestBranch[\s\S]*runtimePlan\?\.steps[\s\S]*GroupWorkView[\s\S]*workflow-workspace-tabs[\s\S]*onGroupRequestRetry/);
assert.match(taskGraphPanelSource, /workflow-tab-main[\s\S]*workflow-tab-collaboration[\s\S]*workflow-main-view/);
assert.match(taskGraphPanelSource, /function GroupWorkView[\s\S]*workflow-collaboration-view/);
assert.doesNotMatch(taskGraphPanelSource, /remote \? 'remote' : 'local'/);
assert.doesNotMatch(indexCssSource, /\.workflow-group-request\.remote/);
assert.match(taskGraphPanelSource, /WORKFLOW_TAB_STORAGE_PREFIX[\s\S]*readWorkflowWorkspaceTab[\s\S]*localStorage\.getItem[\s\S]*persistWorkflowWorkspaceTab[\s\S]*localStorage\.setItem/);
assert.match(taskGraphPanelSource, /useEffect\(\(\) => setActiveWorkspaceTab\(readWorkflowWorkspaceTab\(chatId\)\), \[chatId\]\)[\s\S]*selectWorkspaceTab/);
assert.match(taskGraphPanelSource, /workflow-task-group-results[\s\S]*request\.answer[\s\S]*groupRequests=\{groupRequestsByTask\.get\(selectedNode\.id\)/);
assert.match(indexCssSource, /\.workflow-node\.cross-group-waiting[\s\S]*\.workflow-group-request/);
assert.match(modalsSource, /crossGroupCollaborationEnabled[\s\S]*crossGroupTargetGroupIds[\s\S]*Erreichbare Zielgruppen/);
assert.match(modalsSource, /Ausgehende Informationsanfragen und Aufgabendelegationen erlauben/);
assert.match(modalsSource, /buildGroupCapabilityIndex[\s\S]*Semantischer Kompetenzindex/);
assert.match(storeSource, /capabilityIndex: buildGroupCapabilityIndex/);
assert.match(modalsSource, /role="tablist"[\s\S]*group-tab-general[\s\S]*group-tab-collaboration[\s\S]*group-tab-workspace[\s\S]*group-tab-tools/);
assert.match(modalsSource, /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/);
assert.match(chatViewSource, /reachableCrossGroupIds\.includes\(group\.id\)/);
assert.match(crossGroupCoordinatorSource, /requestExecutionKey[\s\S]*group:\$\{request\.targetGroupId\}/);
assert.match(crossGroupCoordinatorSource, /const leadAgent = pm[\s\S]*pm_planning[\s\S]*extractUnknownDirectedMentions[\s\S]*-correction/);
assert.match(crossGroupCoordinatorSource, /specialistHandoffs[\s\S]*persistRuntimePlan\('executing'[\s\S]*group_wait[\s\S]*finishRequestRuntimePlan/);
assert.match(taskGraphPanelSource, /pendingDelegations[\s\S]*Delegation freigeben[\s\S]*Lokal ausführen/);

const queuedRequestOne = { id: 'request-1', messageId: 'message-1', createdAt: 1 };
const queuedRequestTwo = { id: 'request-2', messageId: 'message-2', createdAt: 2 };
let userQueues = userRequestQueue.enqueueUserRequest({}, 'chat-1', queuedRequestOne);
userQueues = userRequestQueue.enqueueUserRequest(userQueues, 'chat-1', queuedRequestTwo);
assert.deepEqual(userQueues['chat-1'].map(item => item.id), ['request-1', 'request-2']);
assert.deepEqual(userRequestQueue.buildQueuedRequestHistory([
  { id: 'message-1', agentId: 'user', text: 'Erste Folgefrage' },
  { id: 'agent-result', agentId: 'agent', text: 'Aktueller Lauf beendet' },
  { id: 'message-2', agentId: 'user', text: 'Zweite Folgefrage' },
], userQueues['chat-1'], 'request-1').map(message => message.id), ['message-1', 'agent-result']);
userQueues = userRequestQueue.removeUserRequest(userQueues, 'chat-1', 'request-1');
assert.deepEqual(userQueues['chat-1'].map(item => item.id), ['request-2']);
assert.deepEqual(userRequestQueue.clearUserRequests(userQueues, 'chat-1'), {});
const crossGroupQueue = userRequestQueue.enqueueUserRequest({}, 'chat-1', {
  id: 'cross-answer', messageId: 'answer-message', kind: 'cross-group-answer', crossGroupBatchId: 'batch-1', createdAt: 3,
});
assert.equal(crossGroupQueue['chat-1'][0].kind, 'cross-group-answer');
assert.equal(crossGroupQueue['chat-1'][0].crossGroupBatchId, 'batch-1');

const sourceGroup = { id: 'dev', name: 'Dev', crossGroupCollaborationEnabled: true, crossGroupTargetGroupIds: ['product', 'qa'], agentIds: ['coder'] };
const productGroup = { id: 'product', name: 'Produkt Design', emoji: '🎨', crossGroupCollaborationEnabled: true, agentIds: ['designer'] };
const qaGroup = { id: 'qa', name: 'QA', crossGroupCollaborationEnabled: true, agentIds: ['tester'] };
const operationsGroup = { id: 'operations', name: 'Operations', crossGroupCollaborationEnabled: true, agentIds: [] };
assert.deepEqual(
  crossGroup.extractGroupMentions('Bitte @Produkt Design: Welche Farben sind freigegeben?', [sourceGroup, productGroup, qaGroup], { sourceGroupId: sourceGroup.id, userAuthored: true })
    .map(item => [item.group.id, item.question]),
  [['product', 'Welche Farben sind freigegeben?']],
);
assert.deepEqual(
  crossGroup.extractGroupMentions('Status.\n@QA: Ist der Ablauf geprüft?', [sourceGroup, productGroup, qaGroup], { sourceGroupId: sourceGroup.id })
    .map(item => item.group.id),
  ['qa'],
);
assert.equal(crossGroup.extractGroupMentions('```\n@QA: nur Beispiel\n```', [qaGroup], {}).length, 0);
assert.deepEqual(
  crossGroup.extractUnknownDirectedMentions('@Mira: Entwurf\n@Noah: Umsetzung\n@Produkt Design: Rückfrage', ['Noah', 'Produkt Design']),
  ['Mira'],
);
assert.deepEqual(crossGroup.extractUnknownDirectedMentions('```\n@Mira: nur Beispiel\n```', []), []);
const groupRequest = crossGroup.createCrossGroupRequest({
  sourceGroup,
  targetGroup: productGroup,
  sourceAgent: coder,
  sourceTask: { graphNodeId: 'task-1', objective: 'UI bauen' },
  question: 'Welche Farben gelten?',
  batchId: 'batch-1',
  qualityMode: 'deep',
});
assert.equal(groupRequest.status, 'queued');
assert.equal(groupRequest.qualityMode, 'deep');
assert.equal(groupRequest.runtimePlan.status, 'queued');
assert.deepEqual(groupRequest.runtimePlan.steps, []);
assert.equal(groupRequest.sourceTaskId, 'task-1');
assert.deepEqual(groupRequest.groupPath, ['dev', 'product']);
assert.equal(groupRequest.parentRequestId, '');
assert.equal(crossGroup.createCrossGroupRequest({
  sourceGroup,
  targetGroup: qaGroup,
  question: 'Darf diese zweite konfigurierte Gruppe angesprochen werden?',
})?.status, 'queued');
assert.equal(crossGroup.createCrossGroupRequest({
  sourceGroup,
  targetGroup: operationsGroup,
  question: 'Darf eine nicht konfigurierte Gruppe angesprochen werden?',
}), null);
const techGroup = { id: 'tech', name: 'Tech', crossGroupCollaborationEnabled: true, crossGroupTargetGroupIds: ['design', 'dev'] };
const receivingOnlyDesignGroup = { id: 'design', name: 'Design', crossGroupCollaborationEnabled: false };
const devToTechRequest = crossGroup.createCrossGroupRequest({
  sourceGroup: { ...sourceGroup, crossGroupTargetGroupIds: ['tech'] },
  targetGroup: techGroup,
  question: 'Implementiert die Anwendung.',
});
const techToDesignRequest = crossGroup.createCrossGroupRequest({
  sourceGroup: techGroup,
  targetGroup: receivingOnlyDesignGroup,
  question: 'Welche Gestaltung wird benötigt?',
  parentRequestId: devToTechRequest.id,
  rootRequestId: devToTechRequest.id,
  groupPath: devToTechRequest.groupPath,
  depth: 1,
});
assert.equal(techToDesignRequest.status, 'queued', 'a configured target may receive without an outbound route of its own');
assert.equal(techToDesignRequest.parentRequestId, devToTechRequest.id);
assert.deepEqual(techToDesignRequest.groupPath, ['dev', 'tech', 'design']);
assert.equal(crossGroup.createCrossGroupRequest({
  sourceGroup: receivingOnlyDesignGroup,
  targetGroup: techGroup,
  question: 'Eine reine Empfängergruppe darf keine neue Anfrage beginnen.',
}), null);
const waitingNestedRequests = crossGroup.normalizeCrossGroupRequests({
  [devToTechRequest.id]: {
    ...devToTechRequest,
    status: 'waiting_child',
    childRequestIds: [techToDesignRequest.id],
  },
  [techToDesignRequest.id]: techToDesignRequest,
});
assert.deepEqual(
  crossGroup.requestsForChat(waitingNestedRequests, 'dev').map(request => request.id),
  [devToTechRequest.id, techToDesignRequest.id],
  'the source group sees the complete nested request tree',
);
assert.deepEqual(
  crossGroup.requestsForChat(waitingNestedRequests, 'design').map(request => request.id),
  [devToTechRequest.id, techToDesignRequest.id],
  'a nested target sees the request ancestry as context',
);
assert.equal(crossGroup.resolveChildRequestBatch(waitingNestedRequests, devToTechRequest.id), null);
const removedNestedRequests = crossGroup.removeCrossGroupRequestsMap(
  waitingNestedRequests,
  [devToTechRequest.id, techToDesignRequest.id],
);
assert.deepEqual(removedNestedRequests, {}, 'deleting group work removes the complete visible request tree');
const recoveredNestedRequests = crossGroup.normalizeCrossGroupRequests({
  ...waitingNestedRequests,
  [techToDesignRequest.id]: { ...techToDesignRequest, status: 'running' },
}, { recoverRunning: true });
assert.equal(recoveredNestedRequests[devToTechRequest.id].status, 'waiting_child');
assert.equal(recoveredNestedRequests[techToDesignRequest.id].status, 'queued');
const answeredNestedRequests = crossGroup.updateCrossGroupRequestMap(
  waitingNestedRequests,
  techToDesignRequest.id,
  { status: 'answered', answer: 'Verwendet dieses Designsystem.' },
);
const nestedResolution = crossGroup.resolveChildRequestBatch(answeredNestedRequests, devToTechRequest.id);
assert.equal(nestedResolution.parent.id, devToTechRequest.id);
assert.deepEqual(nestedResolution.visitedGroupIds, ['dev', 'tech', 'design']);
assert.deepEqual(nestedResolution.responses.map(response => [response.groupId, response.status, response.answer]), [
  ['design', 'answered', 'Verwendet dieses Designsystem.'],
]);
const deltaParent = crossGroup.normalizeCrossGroupRequests({
  [devToTechRequest.id]: {
    ...devToTechRequest,
    childResponses: [
      ...nestedResolution.responses,
      {
        requestId: 'second-child',
        groupId: 'qa',
        groupName: 'QA',
        question: 'Ist das Ergebnis geprüft?',
        status: 'answered',
        answer: 'Erste, überholte Antwort.',
      },
      {
        requestId: 'second-child',
        groupId: 'qa',
        groupName: 'QA',
        question: 'Ist das Ergebnis geprüft?',
        status: 'answered',
        answer: 'Ja, die Prüfung ist abgeschlossen.',
      },
    ],
    processedChildResponseIds: [techToDesignRequest.id],
    processedContextSummary: 'Die Designantwort wurde bereits verarbeitet.',
  },
})[devToTechRequest.id];
assert.deepEqual(
  crossGroup.getUnprocessedChildResponses(deltaParent).map(response => [response.requestId, response.answer]),
  [['second-child', 'Ja, die Prüfung ist abgeschlossen.']],
  'only the latest representation of a not-yet-consumed child response is returned',
);
assert.equal(deltaParent.processedContextSummary, 'Die Designantwort wurde bereits verarbeitet.');
const failedNestedRequests = crossGroup.updateCrossGroupRequestMap(
  waitingNestedRequests,
  techToDesignRequest.id,
  { status: 'timed_out', error: 'Design antwortete nicht rechtzeitig.' },
);
assert.deepEqual(crossGroup.resolveChildRequestBatch(failedNestedRequests, devToTechRequest.id).responses.map(response => [response.status, response.error]), [
  ['timed_out', 'Design antwortete nicht rechtzeitig.'],
]);
assert.equal(crossGroup.createCrossGroupRequest({
  sourceGroup: techGroup,
  targetGroup: sourceGroup,
  question: 'Diese Kette würde zur bereits besuchten Dev-Gruppe zurücklaufen.',
  groupPath: devToTechRequest.groupPath,
  depth: 1,
}), null, 'the persisted request path blocks cycles');
assert.equal(crossGroup.createCrossGroupRequest({
  sourceGroup: techGroup,
  targetGroup: receivingOnlyDesignGroup,
  question: 'Dieselbe Zielgruppe darf in der Anfragekette nicht erneut befragt werden.',
  groupPath: devToTechRequest.groupPath,
  visitedGroupIds: nestedResolution.visitedGroupIds,
  depth: 1,
}), null, 'groups visited by completed child branches remain cycle-protected');
assert.equal(crossGroup.createCrossGroupRequest({
  sourceGroup: techGroup,
  targetGroup: receivingOnlyDesignGroup,
  question: 'Diese Kette ist zu tief.',
  groupPath: ['one', 'two', 'three', 'tech'],
  depth: crossGroup.MAX_CROSS_GROUP_REQUEST_DEPTH + 1,
}), null);
let groupRequestMap = crossGroup.normalizeCrossGroupRequests({ [groupRequest.id]: { ...groupRequest, status: 'running' } }, { recoverRunning: true });
assert.equal(groupRequestMap[groupRequest.id].status, 'queued');
let runtimePlan = crossGroup.updateRequestRuntimePlan(groupRequest.runtimePlan, {
  status: 'planning',
  steps: [{ id: 'pm-plan-1', kind: 'pm_planning', title: 'Teilplan erstellen', agentId: 'pm', agentName: 'PM', status: 'running' }],
});
runtimePlan = crossGroup.updateRequestRuntimePlan(runtimePlan, {
  status: 'executing',
  steps: [
    { id: 'pm-plan-1', status: 'completed', completedAt: Date.now() },
    { id: 'expert-1', kind: 'agent_task', title: 'Fachaufgabe lösen', agentId: 'expert', agentName: 'Expertin', status: 'running' },
  ],
});
assert.deepEqual(runtimePlan.steps.map(step => [step.id, step.status]), [['pm-plan-1', 'completed'], ['expert-1', 'running']]);
const recoveredRuntimeRequest = crossGroup.normalizeCrossGroupRequests({
  [groupRequest.id]: { ...groupRequest, status: 'running', runtimePlan },
}, { recoverRunning: true })[groupRequest.id];
assert.equal(recoveredRuntimeRequest.runtimePlan.status, 'queued');
assert.equal(recoveredRuntimeRequest.runtimePlan.steps.find(step => step.id === 'expert-1').status, 'planned');
const failedRuntimePlan = crossGroup.finishRequestRuntimePlan(runtimePlan, 'timed_out', 'Zeitlimit');
assert.equal(failedRuntimePlan.status, 'timed_out');
assert.equal(failedRuntimePlan.steps.find(step => step.id === 'expert-1').status, 'timed_out');
groupRequestMap = crossGroup.updateCrossGroupRequestMap(groupRequestMap, groupRequest.id, { status: 'timed_out', runtimePlan: failedRuntimePlan });
groupRequestMap = crossGroup.retryCrossGroupRequestMap(groupRequestMap, groupRequest.id);
assert.equal(groupRequestMap[groupRequest.id].status, 'queued');
assert.equal(groupRequestMap[groupRequest.id].attempt, 2);
assert.equal(groupRequestMap[groupRequest.id].runtimePlan.status, 'queued');
const reroutedRequests = crossGroup.cancelRequestsOutsideSourceRoutes(groupRequestMap, sourceGroup.id, [qaGroup.id]);
assert.equal(reroutedRequests[groupRequest.id].status, 'cancelled');
groupRequestMap = crossGroup.cancelRequestsForGroup(groupRequestMap, productGroup.id);
assert.equal(groupRequestMap[groupRequest.id].status, 'cancelled');

const genericAgents = [
  { id: 'local-generalist', name: 'Mira', capabilities: ['Moderation'] },
  { id: 'ceramics-expert', name: 'Noah', capabilities: ['Porzellan-Brennen', 'Glasurprüfung'] },
  { id: 'music-expert', name: 'Iris', capabilities: ['Harmonielehre'] },
];
const genericGroups = [
  { id: 'source-any-domain', name: 'Team Alpha', agentIds: ['local-generalist'], crossGroupCollaborationEnabled: true, crossGroupTargetGroupIds: ['ceramics', 'music'] },
  { id: 'ceramics', name: 'Werkstatt Sieben', agentIds: ['ceramics-expert'], crossGroupCollaborationEnabled: true },
  { id: 'music', name: 'Klanglabor', agentIds: ['music-expert'], crossGroupCollaborationEnabled: true },
];
const automaticDelegation = delegation.evaluateTaskDelegation({
  taskNode: { delegation: { mode: 'automatic', requiredCapabilities: ['Glasurprüfung'], allowedTargetGroupIds: [] } },
  sourceGroup: genericGroups[0],
  groups: genericGroups,
  agents: genericAgents,
});
assert.equal(automaticDelegation.action, 'delegate');
assert.equal(automaticDelegation.candidate.agentId, 'ceramics-expert');
assert.equal(delegation.evaluateTaskDelegation({
  taskNode: { delegation: { mode: 'ask', requiredCapabilities: ['Harmonielehre'] } },
  sourceGroup: genericGroups[0],
  groups: genericGroups,
  agents: genericAgents,
}).action, 'ask', 'the router considers every target persisted in the source group route list');
assert.equal(delegation.evaluateTaskDelegation({
  taskNode: { delegation: { mode: 'automatic', requiredCapabilities: ['Glasurprüfung'], allowedTargetGroupIds: ['music'] } },
  sourceGroup: genericGroups[0],
  groups: genericGroups,
  agents: genericAgents,
}).action, 'unavailable', 'the immutable task contract may further restrict the group route list');
assert.equal(delegation.evaluateTaskDelegation({
  taskNode: { delegation: { mode: 'automatic', requiredCapabilities: ['Moderation'] } },
  sourceGroup: genericGroups[0],
  groups: genericGroups,
  agents: genericAgents,
}).reason, 'local-expert');
assert.equal(delegation.evaluateTaskDelegation({
  taskNode: { delegation: { mode: 'automatic', requiredCapabilities: ['Glasurprüfung'] } },
  sourceGroup: { ...genericGroups[0], crossGroupCollaborationEnabled: false },
  groups: genericGroups,
  agents: genericAgents,
}).reason, 'group-disabled');
assert.equal(delegation.findDelegationCandidates({
  sourceGroupId: genericGroups[0].id,
  groups: genericGroups.map(group => group.id === 'ceramics' ? { ...group, crossGroupCollaborationEnabled: false } : group),
  agents: genericAgents,
  policy: { mode: 'automatic', requiredCapabilities: ['Glasurprüfung'] },
}).length, 1, 'the source route authorizes a receiving-only target group');

const semanticAgents = [
  { id: 'semantic-pm', name: 'PM', role: 'Coordinator', systemPrompt: 'Coordinates work.' },
  {
    id: 'semantic-developer',
    name: 'Robin',
    role: 'Senior Developer',
    systemPrompt: 'Experienced full-stack developer.\n• Frontend: React, Vue\n• Backend: Node.js',
  },
  { id: 'researcher', name: 'Sam', role: 'Researcher', capabilities: ['Qualitative Research'] },
  { id: 'statistician', name: 'Lee', role: 'Statistician', capabilities: ['Statistical Analysis'] },
];
const semanticSource = {
  id: 'semantic-source',
  name: 'Source',
  agentIds: ['semantic-pm'],
  crossGroupCollaborationEnabled: true,
  crossGroupTargetGroupIds: ['semantic-tech', 'semantic-research'],
};
const semanticTech = { id: 'semantic-tech', name: 'Tech', agentIds: ['semantic-pm', 'semantic-developer'] };
semanticTech.capabilityIndex = delegation.buildGroupCapabilityIndex(semanticTech, semanticAgents);
assert.equal(semanticTech.capabilityIndex.members.length, 2);
assert.equal(semanticTech.capabilityIndex.explicitCapabilities.length, 0);
assert.equal(delegation.evaluateTaskDelegation({
  taskNode: { delegation: { mode: 'automatic', requiredCapabilities: ['Game Development', 'Frontend Development'] } },
  sourceGroup: semanticSource,
  groups: [semanticSource, semanticTech],
  agents: semanticAgents,
}).candidate.agentId, 'semantic-developer', 'role and profile terms feed the persisted semantic group index');

const semanticResearch = { id: 'semantic-research', name: 'Research', agentIds: ['researcher', 'statistician'] };
semanticResearch.capabilityIndex = delegation.buildGroupCapabilityIndex(semanticResearch, semanticAgents);
const teamDelegation = delegation.evaluateTaskDelegation({
  taskNode: { delegation: { mode: 'automatic', requiredCapabilities: ['Qualitative Research', 'Statistical Analysis'], allowedTargetGroupIds: ['semantic-research'] } },
  sourceGroup: semanticSource,
  groups: [semanticSource, semanticTech, semanticResearch],
  agents: semanticAgents,
});
assert.equal(teamDelegation.action, 'delegate');
assert.equal(teamDelegation.candidate.team, true, 'a group may combine members to cover all required capabilities');
assert.deepEqual(new Set(teamDelegation.candidate.agentIds), new Set(['researcher', 'statistician']));
const teamRequest = crossGroup.createCrossGroupRequest({
  sourceGroup: semanticSource,
  targetGroup: semanticResearch,
  targetAgent: semanticAgents.find(agent => agent.id === teamDelegation.candidate.agentId),
  targetAgents: teamDelegation.candidate.agentIds.map(agentId => semanticAgents.find(agent => agent.id === agentId)),
  question: 'Research and analyze the result.',
  kind: 'task_delegation',
  requiredCapabilities: ['Qualitative Research', 'Statistical Analysis'],
});
assert.deepEqual(new Set(teamRequest.targetAgentIds), new Set(['researcher', 'statistician']));
assert.deepEqual(
  new Set(crossGroup.normalizeCrossGroupRequests({ [teamRequest.id]: teamRequest })[teamRequest.id].targetAgentIds),
  new Set(['researcher', 'statistician']),
  'delegated expert teams survive request persistence',
);
assert.equal(delegation.findDelegationCandidates({
  sourceGroupId: semanticSource.id,
  groups: [semanticSource, semanticTech, semanticResearch],
  agents: semanticAgents,
  policy: { mode: 'automatic', requiredCapabilities: ['Qualitative Research'], allowedTargetGroupIds: ['semantic-tech'] },
}).length, 0, 'semantic search never escapes the task and source-group route restrictions');

const migratedRoles = agentRoles.normalizeAgentRoleState([
  { id: 'role-dev', name: 'Developer' },
  { id: 'role-dev-duplicate', name: ' developer ' },
], [{ id: 'legacy', name: 'Ada', role: 'DEVELOPER' }]);
assert.equal(migratedRoles.roles.length, 1);
assert.equal(migratedRoles.agents[0].roleId, 'role-dev');
assert.equal(migratedRoles.agents[0].role, 'Developer');
const renamedRoles = agentRoles.normalizeAgentRoleState(
  [{ id: 'role-dev', name: 'Entwicklung' }],
  [{ ...migratedRoles.agents[0], role: 'Developer' }],
);
assert.equal(renamedRoles.agents[0].role, 'Entwicklung');
assert.equal(agentRoles.isRoleUsed(renamedRoles.roles[0], renamedRoles.agents), true);

const qualityAgent = { ...coder, provider: 'anthropic', model: 'claude-haiku-4-5' };
const highComplexity = quality.assessTaskComplexity({ objective: 'Prüfe Security, OAuth-Berechtigungen und eine parallele Production-Migration.' });
assert.equal(highComplexity.level, 'high');
const balancedPolicy = quality.resolveQualityPolicy({
  globalConfig: { enabled: true, strategy: 'balanced', maxEscalations: 1, escalationProvider: 'same' },
  groupConfig: { mode: 'inherit' },
  agentConfig: { mode: 'inherit' },
  messageMode: 'auto',
  complexity: highComplexity,
  agent: qualityAgent,
});
assert.equal(balancedPolicy.directStrong, true);
assert.equal(balancedPolicy.escalationAgent.model, 'claude-sonnet-4-5');
assert.equal(quality.resolveQualityPolicy({
  globalConfig: { enabled: false }, messageMode: 'deep', complexity: { level: 'low' }, agent: qualityAgent,
}).directStrong, true);
assert.equal(quality.resolveQualityPolicy({
  globalConfig: { enabled: true }, groupConfig: { mode: 'off' }, messageMode: 'auto', complexity: highComplexity, agent: qualityAgent,
}).enabled, false);
assert.equal(quality.resolveQualityPolicy({
  globalConfig: { enabled: true }, messageMode: 'fast', complexity: highComplexity, agent: qualityAgent,
}).mode, 'off');
assert.equal(quality.getEscalationAgent(qualityAgent, { escalationProvider: 'openai', escalationModel: 'o1-mini' }).provider, 'openai');
assert.equal(quality.getEscalationAgent(
  { ...coder, provider: 'api-openrouter-test', model: 'cheap-model' },
  { escalationProvider: 'same', escalationModel: 'strong-model' }, {},
  { 'api-openrouter-test': ['cheap-model', 'strong-model'] },
).model, 'strong-model');
assert.deepEqual(quality.evaluateResponseQuality({
  reply: 'Ich koordiniere die Umsetzung.', objective: 'Baue die App.', isOrchestrator: true,
  requiresInitialPlan: true, parsedTaskPlan: null, projectPath: 'C:\\project', complexity: { level: 'medium' },
}).reasons, ['missing-task-plan']);
assert.match(quality.evaluateResponseQuality({
  reply: 'Die Implementierung ist fertig.', objective: 'Erstelle eine CMD-Datei.', isOrchestrator: false,
  projectPath: 'C:\\project', projectFiles: [], complexity: { level: 'low' },
}).reasons.join(','), /missing-requested-artifact/);
assert.equal(quality.evaluateResponseQuality({
  reply: 'Die Analyse ist vollständig und enthält ein direkt nutzbares Ergebnis.',
  objective: 'Analysiere die Optionen.', complexity: { level: 'low' },
}).accepted, true);
const qualityStats = quality.updateQualityStats({}, { outcome: 'escalated', unresolved: false, estimatedInputTokens: 100, estimatedOutputTokens: 25 });
assert.equal(qualityStats.escalations, 1);
assert.equal(qualityStats.estimatedInputTokens + qualityStats.estimatedOutputTokens, 125);
const qualityCallPhases = [];
const cascadedQualityResult = await quality.runQualityCascade({
  agent: qualityAgent,
  policy: {
    enabled: true,
    directStrong: false,
    maxEscalations: 1,
    escalationAgent: { ...qualityAgent, model: 'claude-sonnet-4-5' },
    acceptanceCriteria: 'Liefere ein vollständiges Ergebnis.',
  },
  history: [{ agentId: 'user', text: 'Analysiere die Migration.' }],
  objective: 'Analysiere die Migration vollständig.',
  complexity: { level: 'high' },
  call: async ({ agent, phase }) => {
    qualityCallPhases.push([phase, agent.model]);
    return phase === 'baseline'
      ? 'Kurz.'
      : 'Die Migration wurde vollständig analysiert und enthält Risiken, Maßnahmen und eine überprüfbare Abschlussbewertung.';
  },
});
assert.deepEqual(qualityCallPhases, [
  ['baseline', 'claude-haiku-4-5'],
  ['escalated', 'claude-sonnet-4-5'],
]);
assert.equal(cascadedQualityResult.outcome, 'escalated');
assert.equal(cascadedQualityResult.unresolved, false);
assert.match(chatViewSource, /quality-mode-select[\s\S]*Schnell[\s\S]*Automatisch[\s\S]*Gründlich/);

const browserAttachments = [
  { id: 'readme', name: 'README.md', kind: 'markdown', mimeType: 'text/markdown', size: 12, content: '# Kontext' },
  { id: 'image', name: 'screen.png', kind: 'image', mimeType: 'image/png', size: 4, dataUrl: 'data:image/png;base64,AAAA' },
  { id: 'pdf', name: 'spec.pdf', kind: 'pdf', mimeType: 'application/pdf', size: 4, dataUrl: 'data:application/pdf;base64,JVBERg==' },
  { id: 'archive', name: 'data.zip', kind: 'file', mimeType: 'application/zip', size: 4, dataUrl: 'data:application/zip;base64,UEs=' },
];
assert.equal(llm.collectChatAttachments([
  { agentId: 'user', attachments: browserAttachments.slice(0, 2) },
  { agentId: 'user', attachments: [browserAttachments[0], browserAttachments[2]] },
]).length, 3);
assert.deepEqual(llm.collectChatAttachments(Array.from({ length: 10 }, (_, index) => ({
  agentId: 'user', attachments: [{ id: `attachment-${index}`, name: `${index}.bin` }],
}))).map(item => item.id), Array.from({ length: 8 }, (_, index) => `attachment-${index + 2}`));
const browserOpenAIMessages = llm.prepareBrowserAttachmentMessages([{ role: 'user', content: 'Analysiere.' }], browserAttachments, 'openai');
assert.match(browserOpenAIMessages[0].content.find(part => part.type === 'text').text, /README\.md/);
assert.equal(browserOpenAIMessages[0].content.filter(part => part.type === 'image_url').length, 1);
assert.deepEqual(browserOpenAIMessages[0].content.filter(part => part.type === 'file').map(part => part.file.filename), ['spec.pdf', 'data.zip']);
const browserAnthropicMessages = llm.prepareBrowserAttachmentMessages([{ role: 'user', content: 'Analysiere.' }], browserAttachments, 'anthropic');
assert.equal(browserAnthropicMessages[0].content.filter(part => part.type === 'image').length, 1);
assert.equal(browserAnthropicMessages[0].content.filter(part => part.type === 'document').length, 1);
assert.match(browserAnthropicMessages[0].content.find(part => part.type === 'text').text, /data\.zip/);

let claudeCallCount = 0;
let directAnthropicCallCount = 0;
globalThis.window = {
  electronAPI: {
    claudeCall: async params => {
      claudeCallCount += 1;
      assert.equal(params.model, 'claude-opus-4-5');
      assert.equal(params.requestId, 'claude-test-request');
      assert.equal(params.attachments?.[0]?.name, 'README.md');
      assert.match(params.systemContent, /RESPONSE LANGUAGE \(MANDATORY\)/);
      assert.match(params.systemContent, /Write every user-visible sentence in English/);
      assert.doesNotMatch(params.systemContent, /Sprich Deutsch/);
      return { text: 'Claude-CLI-Antwort' };
    },
    llmCall: async params => {
      directAnthropicCallCount += 1;
      assert.equal(params.provider, 'anthropic');
      assert.equal(Object.prototype.hasOwnProperty.call(params, 'auth'), false);
      assert.match(params.systemContent, /ANTWORTSPRACHE \(VERBINDLICH\)/);
      assert.doesNotMatch(params.systemContent, /Sprich Deutsch/);
      return { text: 'Anthropic-API-Antwort' };
    },
  },
};
const claudeAgent = { ...coder, provider: 'anthropic', model: 'claude-opus-4-5' };
assert.equal(await llm.callLLM({
  apiKeys: { claudeCli: true },
  agent: claudeAgent,
  history: [{ agentId: 'user', senderName: 'User', text: 'Teste den CLI-Weg.', attachments: [browserAttachments[0]] }],
  requestId: 'claude-test-request',
  language: 'en',
}), 'Claude-CLI-Antwort');
assert.equal(claudeCallCount, 1);
assert.equal(directAnthropicCallCount, 0);
assert.equal(await llm.callLLM({
  apiKeys: { anthropicConfigured: true },
  agent: claudeAgent,
  history: [{ agentId: 'user', senderName: 'User', text: 'Teste den API-Weg.' }],
}), 'Anthropic-API-Antwort');
assert.equal(directAnthropicCallCount, 1);
window.electronAPI.codexCall = async params => {
  assert.equal(params.reasoningEffort, 'low');
  return { error: 'Codex ist nicht angemeldet.', status: 401 };
};
await assert.rejects(
  () => llm.callLLM({
    apiKeys: { codexCli: true },
    agent: { ...coder, provider: 'codex', model: 'gpt-5.6-sol' },
    history: [{ agentId: 'user', senderName: 'User', text: 'Plane den Task.' }],
    reasoningEffort: 'low',
  }),
  error => error.status === 401 && /nicht angemeldet/i.test(error.message),
);
delete window.electronAPI.codexCall;
window.electronAPI.llmCall = async params => {
  assert.equal(params.provider, 'api-openrouter-test');
  assert.equal(params.model, '~openai/gpt-latest');
  return { text: 'OpenRouter-Antwort' };
};
assert.equal(await llm.callLLM({
  apiKeys: { providerConfigured: { 'api-openrouter-test': true } },
  providerConnections: [openRouterConnection],
  agent: { ...coder, provider: 'api-openrouter-test', model: '~openai/gpt-latest' },
  history: [{ agentId: 'user', senderName: 'User', text: 'Teste den eigenen Provider.' }],
}), 'OpenRouter-Antwort');

const globalMcp = { id: 'global-mcp', name: 'Global', enabled: true, transport: 'http', url: 'https://example.com/mcp' };
const groupMcp = { id: 'group-mcp', name: 'Group', enabled: true, transport: 'stdio', command: 'node' };
const disabledMcp = { id: 'disabled-mcp', name: 'Disabled', enabled: false, transport: 'stdio', command: 'node' };
assert.deepEqual(mcp.getEffectiveMcpServers([globalMcp, disabledMcp], [groupMcp]).map(server => server.id), ['global-mcp', 'group-mcp']);
const presetState = mcp.applyOfficialMcpPresets([], 0);
assert.equal(presetState.changed, true);
assert.equal(presetState.presetVersion, mcp.MCP_PRESET_VERSION);
assert.deepEqual(presetState.servers[0], mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER);
assert.equal(presetState.servers[0].enabled, false);
assert.deepEqual(presetState.servers[1], mcp.OFFICIAL_PERPLEXITY_MCP_SERVER);
assert.equal(presetState.servers[1].enabled, false);
assert.equal(presetState.servers[1].url, 'https://api.perplexity.ai/mcp');
assert.deepEqual(presetState.servers[1].headers, { Authorization: '' });
assert.deepEqual(mcp.applyOfficialMcpPresets([], mcp.MCP_PRESET_VERSION).servers, []);
const migratedOfficialPreset = mcp.applyOfficialMcpPresets([
  { ...mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER, enabled: true },
], 1);
assert.equal(migratedOfficialPreset.changed, true);
assert.equal(migratedOfficialPreset.servers[0].enabled, false);
assert.deepEqual(migratedOfficialPreset.servers[1], mcp.OFFICIAL_PERPLEXITY_MCP_SERVER);
assert.deepEqual(mcp.applyOfficialMcpPresets([], 2).servers, [mcp.OFFICIAL_PERPLEXITY_MCP_SERVER]);
const customExcalidrawServer = {
  id: 'custom-excalidraw', name: 'Eigenes Excalidraw', enabled: true,
  transport: 'http', url: mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER.url,
};
assert.equal(mcp.applyOfficialMcpPresets([customExcalidrawServer], 1).servers[0].enabled, true);
assert.equal(mcp.applyOfficialMcpPresets([
  { ...mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER, enabled: true },
], mcp.MCP_PRESET_VERSION).servers[0].enabled, true);
assert.deepEqual(electronMcpPreset.OFFICIAL_EXCALIDRAW_MCP_SERVER, mcp.OFFICIAL_EXCALIDRAW_MCP_SERVER);
assert.deepEqual(electronMcpPreset.OFFICIAL_PERPLEXITY_MCP_SERVER, mcp.OFFICIAL_PERPLEXITY_MCP_SERVER);
const customPerplexityServer = {
  id: 'custom-perplexity', name: 'Eigenes Perplexity', enabled: true,
  transport: 'http', url: `${mcp.OFFICIAL_PERPLEXITY_MCP_SERVER.url}/`, headers: {},
};
const customPerplexityMigration = mcp.applyOfficialMcpPresets([customPerplexityServer], 2);
assert.equal(customPerplexityMigration.servers.length, 1);
assert.equal(customPerplexityMigration.servers[0].enabled, true);
const presetStoreData = new Map();
const presetStore = {
  get: key => presetStoreData.get(key),
  set: (key, value) => presetStoreData.set(key, value),
};
assert.equal(electronMcpPreset.ensureOfficialMcpPreset(presetStore).changed, true);
assert.equal(presetStoreData.get('mcpServers')[0].id, 'mcp-official-excalidraw');
assert.equal(presetStoreData.get('mcpServers')[0].enabled, false);
assert.equal(presetStoreData.get('mcpServers')[1].id, 'mcp-official-perplexity');
assert.equal(presetStoreData.get('mcpServers')[1].enabled, false);
assert.equal(presetStoreData.get('mcpPresetVersion'), electronMcpPreset.MCP_PRESET_VERSION);
presetStoreData.set('mcpServers', []);
assert.equal(electronMcpPreset.ensureOfficialMcpPreset(presetStore).changed, false);
assert.deepEqual(presetStoreData.get('mcpServers'), []);
assert.equal(mcp.isModelVisibleMcpTool({ _meta: { ui: { visibility: ['app'] } } }), false);
assert.equal(mcp.isModelVisibleMcpTool({ _meta: { ui: { visibility: ['model', 'app'] } } }), true);
assert.equal(mcp.classifyMcpToolRisk({ annotations: { readOnlyHint: true } }), 'read-only');
assert.equal(mcp.classifyMcpToolRisk({ annotations: { destructiveHint: true } }), 'destructive');
assert.deepEqual(mcp.parseKeyValueLines('TOKEN=abc\n# ignored\nMODE=test=value'), { TOKEN: 'abc', MODE: 'test=value' });
const permissionConfiguredServer = mcp.normalizeMcpServers([{
  ...globalMcp,
  toolCatalog: [
    { name: 'read', description: 'Read data', risk: 'read-only' },
    { name: 'write', description: 'Write data', risk: 'write' },
  ],
  toolPermissions: { read: 'allow', write: 'deny', invalid: 'unsupported' },
}])[0];
assert.deepEqual(permissionConfiguredServer.toolPermissions, { read: 'allow', write: 'deny' });
assert.equal(permissionConfiguredServer.toolCatalog.length, 2);
assert.equal(mcp.getMcpToolPermissionDecision(permissionConfiguredServer, 'read'), 'allow');
assert.equal(mcp.getMcpToolPermissionDecision(permissionConfiguredServer, 'write'), 'deny');
assert.equal(mcp.getMcpToolPermissionDecision(permissionConfiguredServer, 'new-tool'), 'ask');
assert.deepEqual(mcp.createMcpToolCatalog([
  { name: 'safe', description: 'Safe', annotations: { readOnlyHint: true } },
  { name: 'danger', description: 'Danger', annotations: { destructiveHint: true } },
]).map(tool => [tool.name, tool.risk]), [['safe', 'read-only'], ['danger', 'destructive']]);
assert.equal(mcp.extractMcpCalls('[[MCP_CALL]]{"server":"server_1","tool":"echo","arguments":{"value":"ok"}}[[/MCP_CALL]]').calls[0].tool, 'echo');
assert.equal(mcp.isMcpPermissionHallucination('Klicke im Berechtigungsdialog auf Allow.'), true);
assert.equal(mcp.isMcpPermissionHallucination('Ich benötige weiterhin deine Berechtigung für das Werkzeug.'), true);
assert.equal(mcp.isMcpPermissionHallucination('Bitte erlaube den Zugriff auf das Excalidraw `create_view` Tool im erscheinenden Dialog.'), true);
assert.equal(mcp.isMcpPermissionHallucination('Please allow access to the create_view tool in the permission dialog.'), true);
assert.equal(mcp.isMcpPermissionHallucination('Hier ist das fertige Diagramm.'), false);
assert.match(mcp.buildMcpInstructions([{ serverId: 'x', serverName: 'X', name: 'draw' }]), /Berechtigung niemals im Fließtext/);
assert.deepEqual(mcp.parseMcpArgumentsJson('```json\n{"value":"ok"}\n```'), { value: 'ok' });
assert.deepEqual(mcp.parseMcpArgumentsJson('Ausgabe: {"arguments":{"value":"ok"}}'), { value: 'ok' });
const excalidrawElements = excalidraw.parseExcalidrawElements(JSON.stringify([
  { id: 'box', type: 'rectangle', x: 10, y: 20, width: 160, height: 80 },
  { id: 'label', type: 'text', x: 35, y: 45, width: 80, height: 25, text: 'Start' },
]));
assert.equal(excalidrawElements.length, 2);
assert.ok(excalidraw.excalidrawElementBounds(excalidrawElements).width >= 160);
assert.equal(excalidraw.createExcalidrawDocument(excalidrawElements).type, 'excalidraw');

let mcpModelRound = 0;
let mcpToolCalls = 0;
let mcpPermissionRequests = 0;
let mcpToolResults = 0;
let mcpPermissionConsumptions = 0;
globalThis.window.electronAPI.mcpListTools = async () => ({
  tools: [{ serverId: 'group-mcp', serverName: 'Group', name: 'echo', description: 'Echo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }],
  errors: [],
});
globalThis.window.electronAPI.mcpCallTool = async params => {
  mcpToolCalls += 1;
  assert.equal(params.server.id, 'group-mcp');
  assert.deepEqual(params.arguments, { value: 'ok' });
  return { serverName: 'Group', name: 'echo', isError: false, text: 'echo:ok' };
};
const mcpReply = await mcp.callLLMWithMcp({
  servers: [groupMcp],
  history: [],
  agent: coder,
  requestPermission: async request => {
    mcpPermissionRequests += 1;
    assert.equal(request.risk, 'read-only');
    assert.equal(request.tool.name, 'echo');
    return { allowed: true, scope: 'once' };
  },
  onToolResult: ({ result }) => {
    mcpToolResults += 1;
    assert.equal(result.text, 'echo:ok');
  },
  onPermissionConsumed: ({ tool, permission }) => {
    mcpPermissionConsumptions += 1;
    assert.equal(tool.name, 'echo');
    assert.equal(permission.scope, 'once');
  },
  call: async ({ history, extraContext }) => {
    mcpModelRound += 1;
    assert.match(extraContext, /MCP-WERKZEUGE/);
    if (mcpModelRound === 1) return '[[MCP_CALL]]\n{"server":"server_1","tool":"echo","arguments":{"value":"ok"}}\n[[/MCP_CALL]]';
    assert.match(history.at(-1).text, /echo:ok/);
    return 'Werkzeug erfolgreich verwendet.';
  },
});
assert.equal(mcpReply, 'Werkzeug erfolgreich verwendet.');
assert.equal(mcpToolCalls, 1);
assert.equal(mcpPermissionRequests, 1);
assert.equal(mcpToolResults, 1);
assert.equal(mcpPermissionConsumptions, 1);

let correctionMainRounds = 0;
let correctionPlannerRounds = 0;
let correctionPermissionRequests = 0;
let correctionPermissionConsumptions = 0;
const correctedMcpReply = await mcp.callLLMWithMcp({
  servers: [groupMcp],
  history: [],
  agent: coder,
  requestPermission: async request => {
    correctionPermissionRequests += 1;
    assert.equal(request.tool.name, 'echo');
    assert.equal(request.pendingArguments, true);
    return { allowed: true, scope: 'once' };
  },
  call: async () => {
    correctionMainRounds += 1;
    if (correctionMainRounds === 1) return 'Bitte erlaube den Zugriff auf das Excalidraw `create_view` Tool im erscheinenden Dialog.';
    throw new Error('Nach dem UI-Werkzeug darf kein weiterer Hauptmodell-Aufruf nötig sein.');
  },
  callRecovery: async ({ history, extraContext }) => {
    correctionPlannerRounds += 1;
    assert.equal(history.length, 1);
    assert.match(history[0].text, /JSON-ARGUMENTOBJEKT/);
    assert.doesNotMatch(history[0].text, /MCP_CALL|bereits freigegeben/);
    assert.match(extraContext, /MCP-WERKZEUGE/);
    return '```json\n{"value":"ok"}\n```';
  },
  onToolResult: () => 'UI-Werkzeug erfolgreich abgeschlossen.',
  onPermissionConsumed: ({ permission }) => {
    correctionPermissionConsumptions += 1;
    assert.equal(permission.scope, 'recovered-once');
  },
});
assert.equal(correctedMcpReply, 'UI-Werkzeug erfolgreich abgeschlossen.');
assert.equal(mcpToolCalls, 2);
assert.equal(correctionPermissionRequests, 1);
assert.equal(correctionPlannerRounds, 1);
assert.equal(correctionMainRounds, 1);
assert.equal(correctionPermissionConsumptions, 1);

let timedOutPermissionRequests = 0;
let timedOutPermissionConsumptions = 0;
await assert.rejects(
  () => mcp.callLLMWithMcp({
    servers: [groupMcp],
    history: [],
    agent: coder,
    requestPermission: async () => {
      timedOutPermissionRequests += 1;
      return { allowed: true, scope: 'once' };
    },
    call: async () => 'Bitte erlaube den Zugriff im Berechtigungsdialog.',
    callRecovery: async () => { throw new Error('Planner timeout'); },
    onPermissionConsumed: () => { timedOutPermissionConsumptions += 1; },
  }),
  /Planner timeout/,
);
assert.equal(timedOutPermissionRequests, 1);
assert.equal(timedOutPermissionConsumptions, 0);

let deniedRound = 0;
const deniedReply = await mcp.callLLMWithMcp({
  servers: [groupMcp],
  history: [],
  agent: coder,
  requestPermission: async () => ({ allowed: false, scope: 'none' }),
  call: async ({ history }) => {
    deniedRound += 1;
    if (deniedRound === 1) return '[[MCP_CALL]]{"server":"server_1","tool":"echo","arguments":{"value":"denied"}}[[/MCP_CALL]]';
    assert.match(history.at(-1).text, /Vom User abgelehnt/);
    return 'Werkzeug wurde nicht ausgeführt.';
  },
});
assert.equal(deniedReply, 'Werkzeug wurde nicht ausgeführt.');
assert.equal(mcpToolCalls, 2);

let reportedConnectionError = null;
globalThis.window.electronAPI.mcpListTools = async () => ({
  tools: [],
  errors: [{ serverId: 'group-mcp', serverName: 'Group', message: 'offline' }],
});
assert.equal(await mcp.callLLMWithMcp({
  servers: [groupMcp],
  history: [],
  agent: coder,
  onConnectionError: error => { reportedConnectionError = error; },
  call: async ({ extraContext }) => {
    assert.equal(extraContext, '');
    return 'Fallback ohne MCP.';
  },
}), 'Fallback ohne MCP.');
assert.equal(reportedConnectionError.message, 'offline');

globalThis.window.electronAPI.claudeCall = async () => ({
  error: 'rate limit', status: 429, rateLimited: true, retryable: true, retryAfterMs: 2000,
});
await assert.rejects(
  () => llm.callLLM({
    apiKeys: { claudeCli: true },
    agent: claudeAgent,
    history: [{ agentId: 'user', senderName: 'User', text: 'Rate-Limit testen.' }],
  }),
  error => error.rateLimited === true && error.retryAfterMs === 2000 && /Arbeitsstand/.test(error.message),
);

let graph = taskGraph.createTaskGraph('chat-1', 'App-Projekt');
graph = taskGraph.upsertTaskNode(graph, { id: 'plan', title: 'Projekt planen', agentId: pm.id, agentName: pm.name, source: 'user', nodeType: 'request', status: 'agent_done' });
graph = taskGraph.upsertTaskNode(graph, { id: 'frontend', title: 'Frontend bauen', objective: 'Bearbeite src/App.jsx', agentId: coder.id, agentName: coder.name, source: 'PM', parentNodeId: 'plan', status: 'planned' });
graph = taskGraph.upsertTaskNode(graph, { id: 'qa', title: 'Testplan erstellen', objective: 'Erstelle den unabhängigen Testplan', agentId: tester.id, agentName: tester.name, source: 'PM', parentNodeId: 'plan', status: 'planned' });
graph = taskGraph.addTaskEdge(graph, { from: 'plan', to: 'frontend', kind: 'delegation' });
graph = taskGraph.addTaskEdge(graph, { from: 'plan', to: 'qa', kind: 'delegation' });
assert.equal(taskGraph.validateParallelSelection(graph, ['frontend', 'qa']).ok, true);
const flowLayout = workflowLayout.buildWorkflowLayout(graph);
assert.equal(flowLayout.positions.get('frontend').x, flowLayout.positions.get('qa').x);
assert.notEqual(flowLayout.positions.get('frontend').y, flowLayout.positions.get('qa').y);
assert.ok(flowLayout.positions.get('frontend').x > flowLayout.positions.get('plan').x);
assert.deepEqual(flowLayout.flowPoints, []);
assert.deepEqual(flowLayout.flowEdges, []);
const statusChangedLayout = workflowLayout.buildWorkflowLayout(
  taskGraph.updateTaskNodeStatus(graph, 'frontend', 'running'),
);
assert.deepEqual([...statusChangedLayout.positions], [...flowLayout.positions]);
assert.deepEqual(statusChangedLayout.flowEdges, flowLayout.flowEdges);
assert.match(workflowLayout.workflowEdgePath(
  flowLayout.positions.get('plan'),
  flowLayout.positions.get('frontend'),
), /^M /);
const manuallyPositionedGraph = taskGraph.updateWorkflowViewPosition(graph, 'frontend', { x: 880, y: 340 });
assert.deepEqual(manuallyPositionedGraph.viewState.positions.frontend, { x: 880, y: 340 });
assert.deepEqual(workflowLayout.buildWorkflowLayout(manuallyPositionedGraph).positions.get('frontend'), { x: 880, y: 340 });
assert.equal(taskGraph.updateWorkflowViewPosition(graph, '__fork-1', { x: 300, y: 410 }), graph);
assert.equal(taskGraph.updateWorkflowViewPosition(graph, '__unknown-1', { x: 10, y: 10 }), graph);
assert.equal(taskGraph.resetWorkflowViewState(manuallyPositionedGraph).viewState.positions.frontend, undefined);
let explicitFlowGraph = taskGraph.upsertTaskNode(graph, { id: 'release', title: 'Release vorbereiten', objective: 'Release vorbereiten', agentId: pm.id, agentName: pm.name, source: 'PM', parentNodeId: 'plan', status: 'planned' });
explicitFlowGraph = taskGraph.addWorkflowPoint(explicitFlowGraph, { type: 'fork', position: { x: 320, y: 210 }, rootNodeId: 'plan' });
explicitFlowGraph = taskGraph.addWorkflowPoint(explicitFlowGraph, { type: 'join', position: { x: 760, y: 210 }, rootNodeId: 'plan' });
const explicitForkId = explicitFlowGraph.flowPoints.find(point => point.type === 'fork').id;
const explicitJoinId = explicitFlowGraph.flowPoints.find(point => point.type === 'join').id;
explicitFlowGraph = taskGraph.addTaskDependency(explicitFlowGraph, 'plan', explicitForkId);
explicitFlowGraph = taskGraph.addTaskDependency(explicitFlowGraph, explicitForkId, 'frontend');
explicitFlowGraph = taskGraph.addTaskDependency(explicitFlowGraph, explicitForkId, 'qa');
explicitFlowGraph = taskGraph.addTaskDependency(explicitFlowGraph, 'frontend', explicitJoinId);
explicitFlowGraph = taskGraph.addTaskDependency(explicitFlowGraph, 'qa', explicitJoinId);
explicitFlowGraph = taskGraph.addTaskDependency(explicitFlowGraph, explicitJoinId, 'release');
assert.equal(taskGraph.validateWorkflowPlan(explicitFlowGraph).ok, true);
assert.equal(explicitFlowGraph.flowEdges.length, 6);
assert.equal(taskGraph.isTaskNodeReady(explicitFlowGraph, 'frontend'), true);
assert.equal(taskGraph.isTaskNodeReady(explicitFlowGraph, 'release'), false);
explicitFlowGraph = taskGraph.updateTaskNodeStatus(explicitFlowGraph, 'frontend', 'completed');
explicitFlowGraph = taskGraph.updateTaskNodeStatus(explicitFlowGraph, 'qa', 'completed');
assert.equal(taskGraph.isTaskNodeReady(explicitFlowGraph, 'release'), true);
assert.equal(taskGraph.validateTaskDependency(explicitFlowGraph, 'release', explicitForkId).ok, false);
assert.deepEqual(workflowLayout.buildWorkflowLayout(explicitFlowGraph).flowPoints.map(point => point.type), ['fork', 'join']);
const lockedExplicitFlowGraph = taskGraph.lockTaskGraphPlan(explicitFlowGraph);
assert.equal(lockedExplicitFlowGraph.approvedPlan.flowPoints.length, 2);
assert.equal(lockedExplicitFlowGraph.approvedPlan.flowEdges.length, 6);
const repairedCompletedFlowGraph = taskGraph.updateTaskNodeStatus({
  ...lockedExplicitFlowGraph,
  edges: [],
  flowEdges: [],
}, 'release', 'completed');
assert.deepEqual(repairedCompletedFlowGraph.edges, lockedExplicitFlowGraph.approvedPlan.edges);
assert.deepEqual(repairedCompletedFlowGraph.flowEdges, lockedExplicitFlowGraph.approvedPlan.flowEdges);
assert.equal(workflowLayout.buildWorkflowLayout(repairedCompletedFlowGraph).flowEdges.length, 6);
const removedExplicitFlowGraph = taskGraph.removeWorkflowPoint(explicitFlowGraph, explicitJoinId);
assert.equal(removedExplicitFlowGraph.flowPoints.some(point => point.id === explicitJoinId), false);
assert.equal(removedExplicitFlowGraph.flowEdges.some(edge => edge.from === explicitJoinId || edge.to === explicitJoinId), false);
let typedConnectionGraph = taskGraph.upsertTaskNode(graph, { id: 'manual-review', title: 'Manuelle Abnahme', objective: 'Ergebnisse prüfen', agentId: pm.id, agentName: pm.name, nodeType: 'review', status: 'planned' });
assert.equal(taskGraph.validateWorkflowConnection(typedConnectionGraph, 'frontend', 'qa', 'review').ok, false);
typedConnectionGraph = taskGraph.addWorkflowConnection(typedConnectionGraph, 'frontend', 'manual-review', 'review');
assert.equal(typedConnectionGraph.edges.some(edge => edge.from === 'frontend' && edge.to === 'manual-review' && edge.kind === 'review'), true);
typedConnectionGraph = taskGraph.removeWorkflowConnection(typedConnectionGraph, 'frontend', 'manual-review', 'review');
assert.equal(typedConnectionGraph.edges.some(edge => edge.from === 'frontend' && edge.to === 'manual-review' && edge.kind === 'review'), false);
let editableDependencyGraph = taskGraph.addTaskDependency(graph, 'frontend', 'qa');
assert.equal(editableDependencyGraph.edges.some(edge => edge.kind === 'dependency' && edge.from === 'frontend' && edge.to === 'qa'), true);
assert.equal(taskGraph.validateTaskDependency(editableDependencyGraph, 'qa', 'frontend').ok, false);
assert.ok(
  workflowLayout.buildWorkflowLayout(editableDependencyGraph).positions.get('qa').x >
  workflowLayout.buildWorkflowLayout(editableDependencyGraph).positions.get('frontend').x,
);
editableDependencyGraph = taskGraph.removeTaskDependency(editableDependencyGraph, 'frontend', 'qa');
assert.equal(editableDependencyGraph.edges.some(edge => edge.kind === 'dependency' && edge.from === 'frontend' && edge.to === 'qa'), false);
assert.equal(
  workflowLayout.buildWorkflowLayout(editableDependencyGraph).positions.get('qa').x,
  workflowLayout.buildWorkflowLayout(editableDependencyGraph).positions.get('frontend').x,
);
assert.equal(taskGraph.graphNodeDepths(graph).get('frontend'), 0);
const baseTree = taskGraph.projectTaskTree(graph);
assert.deepEqual(baseTree.roots.map(node => node.id), ['plan']);
assert.deepEqual(baseTree.childrenByParent.get('plan').map(node => node.id), ['frontend', 'qa']);
assert.deepEqual(
  taskGraph.orderTasksForParallelSelection([
    { graphNodeId: 'later', agent: pm },
    { graphNodeId: 'frontend', agent: coder },
    { graphNodeId: 'qa', agent: tester },
  ], ['frontend', 'qa']).map(task => task.graphNodeId),
  ['frontend', 'qa', 'later'],
);

const parallelStarts = [];
let releaseParallelTasks;
const parallelGate = new Promise(resolve => { releaseParallelTasks = resolve; });
const parallelRun = taskGraph.runTaskBatch([
  { graphNodeId: 'frontend' },
  { graphNodeId: 'qa' },
], async task => {
  parallelStarts.push(task.graphNodeId);
  await parallelGate;
  return `${task.graphNodeId}-done`;
});
assert.deepEqual(parallelStarts, ['frontend', 'qa']);
releaseParallelTasks();
assert.deepEqual(await parallelRun, ['frontend-done', 'qa-done']);

const dependentGraph = taskGraph.updateTaskNodeStatus(graph, 'plan', 'planned');
assert.equal(taskGraph.isTaskNodeReady(dependentGraph, 'frontend'), true);
assert.match(taskGraph.validateParallelSelection(dependentGraph, ['plan', 'frontend']).reason, /keine parallel ausführbare/);
assert.equal(taskGraph.inferHandoffDependency('Prüfe danach die Umsetzung von Max.', [
  { graphNodeId: 'frontend', agent: coder },
]), 'frontend');
assert.equal(taskGraph.inferHandoffDependency('Erstelle parallel einen unabhängigen Testplan.', [
  { graphNodeId: 'frontend', agent: coder },
]), null);
let sequentialGraph = taskGraph.upsertTaskNode(graph, { id: 'regression', title: 'Regression prüfen', agentId: tester.id, agentName: tester.name, source: 'PM', parentNodeId: 'plan', status: 'planned' });
sequentialGraph = taskGraph.addTaskEdge(sequentialGraph, { from: 'plan', to: 'regression', kind: 'delegation' });
sequentialGraph = taskGraph.addTaskEdge(sequentialGraph, { from: 'frontend', to: 'regression', kind: 'dependency' });
assert.equal(taskGraph.isTaskNodeReady(sequentialGraph, 'regression'), false);
assert.match(taskGraph.validateParallelSelection(sequentialGraph, ['regression', 'qa']).reason, /wartet noch/);
const sequentialTree = taskGraph.projectTaskTree(sequentialGraph);
assert.equal(sequentialTree.primaryParentByNode.get('regression'), 'plan');
assert.deepEqual(sequentialTree.metadataByNode.get('regression').dependencyIds, ['frontend']);

let reviewGraph = taskGraph.updateTaskNodeStatus(graph, 'frontend', 'agent_done');
reviewGraph = taskGraph.updateTaskNodeStatus(reviewGraph, 'qa', 'agent_done');
reviewGraph = taskGraph.upsertTaskNode(reviewGraph, { id: 'review', title: 'Ergebnisse final prüfen', agentId: pm.id, agentName: pm.name, source: 'team-synthesis', nodeType: 'review', status: 'planned' });
reviewGraph = taskGraph.addTaskEdge(reviewGraph, { from: 'frontend', to: 'review', kind: 'review' });
reviewGraph = taskGraph.addTaskEdge(reviewGraph, { from: 'qa', to: 'review', kind: 'review' });
const reviewTree = taskGraph.projectTaskTree(reviewGraph);
assert.equal(reviewTree.primaryParentByNode.get('review'), 'plan');
assert.deepEqual(reviewTree.metadataByNode.get('review').reviewSourceIds.sort(), ['frontend', 'qa']);
assert.equal(reviewTree.childrenByParent.get('plan').at(-1).id, 'review');

let plannedGraph = taskGraph.createTaskGraph('chat-planned', 'Vollständiger PM-Plan');
plannedGraph = taskGraph.upsertTaskNode(plannedGraph, {
  id: 'plan-root', title: 'CMD-Anwendung liefern', agentId: pm.id, agentName: pm.name,
  source: 'user', nodeType: 'request', status: 'agent_done',
});
plannedGraph = taskGraph.materializeTaskPlan(plannedGraph, {
  rootNodeId: 'plan-root',
  tasks: [
    { id: 'implement', title: 'CMD implementieren', agentId: coder.id, agentName: coder.name, type: 'task', dependsOn: [], order: 0 },
    { id: 'docs', title: 'Nutzung dokumentieren', agentId: tester.id, agentName: tester.name, type: 'task', dependsOn: [], order: 1 },
    { id: 'qa', title: 'CMD testen', agentId: tester.id, agentName: tester.name, type: 'task', dependsOn: ['implement'], order: 2 },
    { id: 'final-review', title: 'Finale PM-Abnahme', agentId: pm.id, agentName: pm.name, type: 'review', dependsOn: ['docs', 'qa'], order: 3 },
  ],
});
const plannedIds = Object.fromEntries(plannedGraph.nodes
  .filter(node => node.planTaskId)
  .map(node => [node.planTaskId, node.id]));
assert.equal(taskGraph.projectTaskTree(plannedGraph).roots[0].id, 'plan-root');
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds.implement), true);
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds.docs), true);
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds.qa), false);
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds['final-review']), false);
assert.equal(taskGraph.validateParallelSelection(plannedGraph, [plannedIds.implement, plannedIds.docs]).ok, true);
assert.deepEqual([...taskGraph.workflowDependencyAncestorIds(plannedGraph, plannedIds.implement)], []);
assert.deepEqual([...taskGraph.workflowDependencyAncestorIds(plannedGraph, plannedIds.qa)], [plannedIds.implement]);
assert.deepEqual(
  [...taskGraph.workflowDependencyAncestorIds(plannedGraph, plannedIds['final-review'])].sort(),
  [plannedIds.docs, plannedIds.implement, plannedIds.qa].sort(),
  'a review task receives results from direct and transitive dependencies only',
);
assert.equal(plannedGraph.edges.some(edge => edge.kind === 'delegation' && edge.from === 'plan-root'), false);
const completedContractGraph = taskGraph.updateTaskNodeStatus(plannedGraph, plannedIds.implement, 'completed');
const unchangedContractGraph = taskGraph.materializeTaskPlan(completedContractGraph, {
  rootNodeId: 'plan-root',
  tasks: [{ id: 'implement', title: 'CMD implementieren', agentId: coder.id, agentName: coder.name, type: 'task', dependsOn: [], order: 0 }],
});
assert.equal(unchangedContractGraph.nodes.find(node => node.id === plannedIds.implement).status, 'completed');
const changedContractGraph = taskGraph.materializeTaskPlan(completedContractGraph, {
  rootNodeId: 'plan-root',
  tasks: [{ id: 'implement', title: 'CMD grundlegend anders implementieren', agentId: coder.id, agentName: coder.name, type: 'task', dependsOn: [], order: 0 }],
});
assert.equal(changedContractGraph.nodes.find(node => node.id === plannedIds.implement).status, 'planned');
const completedBeforePmChange = taskGraph.updateTaskNodeStatus(plannedGraph, plannedIds.implement, 'completed');
const deduplicatedPmChange = taskGraph.materializeTaskPlan(completedBeforePmChange, {
  rootNodeId: 'plan-root',
  replace: true,
  tasks: [
    { id: 'implement-v2', title: 'Task 1: CMD implementieren', agentId: coder.id, agentName: coder.name, type: 'task', dependsOn: [], order: 0 },
    { id: 'implement-copy', title: 'CMD implementieren', agentId: coder.id, agentName: coder.name, type: 'task', dependsOn: [], order: 1 },
    { id: 'final-review-v2', title: 'Finale PM-Abnahme', agentId: pm.id, agentName: pm.name, type: 'review', dependsOn: ['implement-v2', 'implement-copy'], order: 2 },
  ],
});
const deduplicatedPlanNodes = deduplicatedPmChange.nodes.filter(node => node.planRootId === 'plan-root');
assert.equal(deduplicatedPlanNodes.filter(node => node.nodeType !== 'review').length, 1);
assert.equal(deduplicatedPmChange.nodes.some(node => node.planTaskId === 'implement-v2'), false);
assert.equal(deduplicatedPmChange.nodes.find(node => node.id === plannedIds.implement).status, 'completed');
assert.equal(deduplicatedPmChange.edges.filter(edge => edge.from === plannedIds.implement && edge.to === plannedIds['final-review']).length, 1);
let userEditedPlan = taskGraph.addPlanningTask(plannedGraph, { rootNodeId: 'plan-root', agent: coder, title: 'Manuelle Aufgabe' });
const invalidDelegationPlan = taskGraph.updatePlanningTask(plannedGraph, plannedIds.implement, {
  delegation: { mode: 'automatic', requiredCapabilities: [] },
});
assert.equal(taskGraph.validateWorkflowPlan(invalidDelegationPlan).messageKey, '„{title}“ benötigt für die Delegation mindestens eine Fähigkeit.');
const invalidDelegationInspection = taskGraph.inspectWorkflowPlan(invalidDelegationPlan);
assert.ok(invalidDelegationInspection.suggestions.some(suggestion => suggestion.taskIds?.includes(plannedIds.implement)));
const validDelegationPlan = taskGraph.updatePlanningTask(invalidDelegationPlan, plannedIds.implement, {
  delegation: { mode: 'ask', requiredCapabilities: ['Frei definierte Fähigkeit'], allowedTargetGroupIds: ['ceramics'] },
});
assert.equal(taskGraph.validateWorkflowPlan(validDelegationPlan).ok, true);
assert.equal(validDelegationPlan.nodes.find(node => node.id === plannedIds.implement).delegation.mode, 'ask');
const manualTask = userEditedPlan.nodes.find(node => node.source === 'User-Plan');
assert.ok(manualTask);
assert.equal(userEditedPlan.edges.some(edge => edge.from === manualTask.id || edge.to === manualTask.id), false);
userEditedPlan = taskGraph.addPlanningTask(userEditedPlan, { rootNodeId: 'plan-root', agent: pm, nodeType: 'review' });
const manualReview = userEditedPlan.nodes.find(node => node.source === 'User-Plan' && taskGraph.inferTaskNodeType(node) === 'review');
assert.equal(manualReview.title, 'Neue Abnahme');
assert.deepEqual(manualReview.acceptanceCriteria, []);
assert.equal(userEditedPlan.edges.some(edge => edge.from === manualReview.id || edge.to === manualReview.id), false);
userEditedPlan = taskGraph.updatePlanningTask(userEditedPlan, manualTask.id, { title: 'Vom User geändert', objective: 'Klares Ergebnis' });
assert.equal(userEditedPlan.nodes.find(node => node.id === manualTask.id).objective, 'Klares Ergebnis');
const orderBeforeMove = userEditedPlan.nodes.find(node => node.id === manualTask.id).planOrder;
userEditedPlan = taskGraph.movePlanningTask(userEditedPlan, manualTask.id, -1);
assert.ok(userEditedPlan.nodes.find(node => node.id === manualTask.id).planOrder < orderBeforeMove);
userEditedPlan = taskGraph.splitPlanningTask(userEditedPlan, manualTask.id);
assert.equal(userEditedPlan.nodes.filter(node => node.source === 'User-Plan' && taskGraph.inferTaskNodeType(node) === 'task').length, 2);
const splitSuccessor = userEditedPlan.nodes.find(node => node.source === 'User-Plan' && taskGraph.inferTaskNodeType(node) === 'task' && node.id !== manualTask.id);
assert.notEqual(splitSuccessor.ticketId, userEditedPlan.nodes.find(node => node.id === manualTask.id).ticketId);
assert.equal(userEditedPlan.edges.some(edge => edge.kind === 'dependency' && edge.from === manualTask.id && edge.to === splitSuccessor.id), true);
const splitFixture = { nodes: [
  { id: 'before', nodeType: 'task' },
  { id: 'original', ticketId: 'original-ticket', planTaskId: 'original-ticket', title: 'Arbeit', nodeType: 'task', planRootId: 'root' },
  { id: 'after', nodeType: 'task' },
], edges: [{ id: 'in', from: 'before', to: 'original', kind: 'dependency' }, { id: 'out', from: 'original', to: 'after', kind: 'review' }],
  flowPoints: [{ id: 'junction' }], flowEdges: [{ id: 'manual-out', from: 'original', to: 'junction' }] };
const splitGraph = taskGraph.splitPlanningTask(splitFixture, 'original');
const secondPart = splitGraph.nodes.find(node => !splitFixture.nodes.some(old => old.id === node.id));
assert.ok(splitGraph.edges.some(edge => edge.from === 'before' && edge.to === 'original'));
assert.ok(splitGraph.edges.some(edge => edge.from === 'original' && edge.to === secondPart.id && edge.kind === 'dependency'));
assert.ok(splitGraph.edges.some(edge => edge.from === secondPart.id && edge.to === 'after' && edge.kind === 'review'));
assert.ok(splitGraph.flowEdges.some(edge => edge.from === secondPart.id && edge.to === 'junction'));
assert.ok(splitGraph.edges.every(edge => Boolean(edge.id)));
assert.notEqual(secondPart.ticketId, 'original-ticket');
userEditedPlan = taskGraph.removePlanningTask(userEditedPlan, splitSuccessor.id);
assert.equal(userEditedPlan.nodes.some(node => node.id === splitSuccessor.id), false);
const revisedPlannedGraph = taskGraph.materializeTaskPlan(plannedGraph, {
  rootNodeId: 'plan-root',
  replace: true,
  tasks: [
    { id: 'implement', title: 'CMD neu implementieren', agentId: coder.id, agentName: coder.name, type: 'task', dependsOn: [], order: 0 },
    { id: 'final-review', title: 'Finale PM-Abnahme', agentId: pm.id, agentName: pm.name, type: 'review', dependsOn: ['implement'], order: 1 },
  ],
});
assert.equal(revisedPlannedGraph.nodes.some(node => node.planTaskId === 'docs'), false);
assert.equal(revisedPlannedGraph.nodes.some(node => node.planTaskId === 'qa'), false);
assert.equal(revisedPlannedGraph.nodes.find(node => node.planTaskId === 'implement').title, 'CMD neu implementieren');
assert.equal(revisedPlannedGraph.planRevision, 1);
assert.deepEqual(
  revisedPlannedGraph.edges
    .filter(edge => edge.planRootId === 'plan-root')
    .map(edge => `${edge.kind}:${edge.from}->${edge.to}`),
  [`review:${plannedIds.implement}->${plannedIds['final-review']}`],
);
const approvedPlannedGraph = taskGraph.lockTaskGraphPlan(revisedPlannedGraph);
assert.equal(approvedPlannedGraph.workflowState, 'executing');
assert.equal(approvedPlannedGraph.planOwner, 'user');
assert.equal(approvedPlannedGraph.approvedPlan.revision, 1);
assert.equal(approvedPlannedGraph.approvedPlan.approvedBy, 'user');
assert.notEqual(approvedPlannedGraph.approvedPlan.nodes, approvedPlannedGraph.nodes);
assert.equal(taskGraph.materializeTaskPlan(approvedPlannedGraph, {
  rootNodeId: 'plan-root',
  replace: true,
  allowPlanningRevision: true,
  tasks: [{ id: 'intruder', title: 'Nicht freigegebene PM-Aufgabe', agentId: pm.id, agentName: pm.name, type: 'task', dependsOn: [], order: 0 }],
}), approvedPlannedGraph);
const movedApprovedGraph = taskGraph.updateWorkflowViewPosition(approvedPlannedGraph, plannedIds.implement, { x: 640, y: 420 });
assert.equal(movedApprovedGraph.approvedPlan, approvedPlannedGraph.approvedPlan);
assert.deepEqual(movedApprovedGraph.viewState.positions[plannedIds.implement], { x: 640, y: 420 });
const finishedApprovedGraph = taskGraph.updateTaskNodeStatus(movedApprovedGraph, plannedIds.implement, 'agent_done', {
  completedAt: Date.now(),
});
const statusOnlyDraft = taskGraph.beginUserPlanEdit(finishedApprovedGraph);
const statusOnlyChanges = taskGraph.buildWorkflowChangeSet(statusOnlyDraft);
assert.equal(statusOnlyChanges.active, true);
assert.equal(statusOnlyChanges.hasContractChanges, false);
assert.deepEqual(statusOnlyChanges.nodeChanges, {});
assert.equal(statusOnlyDraft.changeRequest.reason, 'user-edit');
assert.equal(statusOnlyDraft.planRevision, approvedPlannedGraph.planRevision + 1);
assert.deepEqual(finishedApprovedGraph.viewState.positions[plannedIds.implement], { x: 640, y: 420 });
const damagedDraft = taskGraph.removePlanningTask(statusOnlyDraft, plannedIds.implement);
assert.equal(damagedDraft.nodes.some(node => node.id === plannedIds.implement), false);
const restoredSnapshot = taskGraph.restoreTaskGraphSnapshot(damagedDraft);
assert.equal(restoredSnapshot.nodes.find(node => node.id === plannedIds.implement).status, 'agent_done');
assert.equal(restoredSnapshot.nodes.find(node => node.id === plannedIds.implement).title, approvedPlannedGraph.approvedPlan.nodes.find(node => node.id === plannedIds.implement).title);
assert.equal(restoredSnapshot.edges.some(edge => edge.kind === 'review' && edge.from === plannedIds.implement && edge.to === plannedIds['final-review']), true);
assert.deepEqual(restoredSnapshot.viewState.positions[plannedIds.implement], { x: 640, y: 420 });
assert.equal(restoredSnapshot.changeRequest.reason, 'snapshot-restored');
assert.equal(taskGraph.buildWorkflowChangeSet(restoredSnapshot).hasContractChanges, false);
assert.equal(restoredSnapshot.approvedPlan, null);
const editedRestoredSnapshot = taskGraph.upsertTaskNode(restoredSnapshot, {
  id: plannedIds.implement,
  title: 'Nach Snapshot sichtbar geändert',
});
assert.equal(taskGraph.buildWorkflowChangeSet(editedRestoredSnapshot).nodeChanges[plannedIds.implement].type, 'changed');
const requestedDraft = taskGraph.beginUserPlanEdit(finishedApprovedGraph);
const changedAgentDraft = taskGraph.upsertTaskNode(requestedDraft, {
  id: plannedIds.implement,
  agentId: coderTwo.id,
  agentName: coderTwo.name,
});
const changedAgentSet = taskGraph.buildWorkflowChangeSet(changedAgentDraft);
assert.equal(changedAgentSet.hasContractChanges, true);
assert.equal(changedAgentSet.nodeChanges[plannedIds.implement].changes.some(change => change.field === 'agentId'), true);
const changedDependencyDraft = taskGraph.addTaskDependency(changedAgentDraft, plannedIds.implement, plannedIds['final-review']);
const changedDependencySet = taskGraph.buildWorkflowChangeSet(changedDependencyDraft);
assert.equal(Object.values(changedDependencySet.edgeChanges).some(change => change.type === 'added'), true);
assert.equal(taskGraph.validateWorkflowPlan(revisedPlannedGraph).ok, true);
const planWithoutReview = taskGraph.removePlanningTask(revisedPlannedGraph, plannedIds['final-review']);
assert.equal(planWithoutReview.nodes.some(node => taskGraph.inferTaskNodeType(node) === 'review'), false);
assert.equal(taskGraph.validateWorkflowPlan(planWithoutReview).ok, true);
const reviewlessInspection = taskGraph.inspectWorkflowPlan(planWithoutReview);
assert.equal(reviewlessInspection.ok, true);
assert.equal(reviewlessInspection.warnings.some(entry => entry.messageKey === 'Es ist keine abschließende Abnahme eingeplant.'), true);
let disconnectedProposalGraph = taskGraph.upsertTaskNode(revisedPlannedGraph, {
  id: 'proposed-review', title: 'Zusatzprüfung', objective: 'Ergebnis zusätzlich prüfen',
  agentId: pm.id, agentName: pm.name, source: 'User-Plan', nodeType: 'review',
  status: 'planned', planRootId: 'plan-root',
});
const disconnectedValidation = taskGraph.validateWorkflowPlan(disconnectedProposalGraph);
assert.equal(disconnectedValidation.ok, false);
assert.deepEqual(disconnectedValidation.taskIds, ['proposed-review']);
const disconnectedInspection = taskGraph.inspectWorkflowPlan(disconnectedProposalGraph);
assert.equal(disconnectedInspection.ok, false);
assert.deepEqual(disconnectedInspection.taskIds, ['proposed-review']);
assert.equal(disconnectedInspection.suggestions.some(entry => entry.messageKey.includes('Verbinde die Abnahme')), true);
assert.equal(taskGraph.validateApprovedTaskExecution(approvedPlannedGraph, {
  graphNodeId: plannedIds.implement,
  agent: coder,
}).ok, true);
assert.equal(taskGraph.validateApprovedTaskExecution(approvedPlannedGraph, {
  graphNodeId: 'unapproved-extra-task',
  agent: coder,
}).ok, false);
assert.equal(taskGraph.validateApprovedTaskExecution(approvedPlannedGraph, {
  graphNodeId: plannedIds.implement,
  agent: coder,
  objective: 'Anderes, nicht freigegebenes Ziel',
}).ok, false);
assert.equal(taskGraph.validateApprovedTaskExecution(approvedPlannedGraph, {
  graphNodeId: plannedIds.implement,
  agent: coder,
  objective: 'Fortsetzung nach einer User-Antwort',
  approvedContinuation: true,
}).ok, true);
const approvedRecovery = {
  runtimeRecovery: true,
  source: 'timeout-recovery',
  graphNodeId: 'runtime-recovery-review',
  agent: pm,
  recovery: {
    originalGraphNodeId: plannedIds.implement,
    originalAgentId: coder.id,
    originalAgentName: coder.name,
    pmAgentId: pm.id,
  },
};
const approvedRecoveryGraph = taskGraph.updateTaskNodeStatus(approvedPlannedGraph, plannedIds.implement, 'timed_out', {
  recoveryStatus: 'pm',
});
assert.equal(taskGraph.validateApprovedTaskExecution(approvedRecoveryGraph, approvedRecovery).mode, 'timeout-recovery');
assert.equal(taskGraph.validateApprovedTaskExecution(approvedRecoveryGraph, {
  ...approvedRecovery,
  source: 'timeout-recovery-step',
  agent: coder,
}).ok, true);
assert.equal(taskGraph.validateApprovedTaskExecution(approvedRecoveryGraph, {
  ...approvedRecovery,
  source: 'timeout-recovery-step',
  agent: tester,
}).ok, false);
assert.equal(taskGraph.validateApprovedTaskExecution(approvedRecoveryGraph, {
  ...approvedRecovery,
  source: 'timeout-recovery-step',
  agent: tester,
  recovery: { ...approvedRecovery.recovery, allowedAgentIds: [coder.id, tester.id] },
}).ok, true);
assert.equal(taskGraph.validateApprovedTaskExecution(approvedRecoveryGraph, {
  ...approvedRecovery,
  runtimeRecovery: false,
}).ok, false);
assert.equal(taskGraph.validateApprovedTaskExecution(taskGraph.createTaskGraph('free-mode'), {
  graphNodeId: 'dynamic-task',
  agent: coder,
}).mode, 'free');
const notedRecoveryGraph = taskGraph.appendTaskRecoveryNote(approvedRecoveryGraph, plannedIds.implement, {
  text: 'Prüfe zuerst die Parsergrenze.',
  problem: 'Ausgabe bleibt leer.',
});
assert.equal(notedRecoveryGraph.nodes.find(node => node.id === plannedIds.implement).recoveryNotes.length, 1);
const invalidatedRecoveryGraph = taskGraph.invalidateTaskRecoveryBranch(notedRecoveryGraph, plannedIds.implement, {
  recoveryAttempt: 1,
  reason: 'Ausgabe bleibt leer.',
});
assert.equal(invalidatedRecoveryGraph.nodes.find(node => node.id === plannedIds['final-review']).status, 'stale_dependency');
assert.equal(invalidatedRecoveryGraph.nodes.find(node => node.id === plannedIds.implement).recoveryAttempt, 1);
const recoveryDag = taskGraph.materializeRuntimeRecoveryPlan(invalidatedRecoveryGraph, {
  rootNodeId: 'plan-root',
  controllerNodeId: 'runtime-recovery-review',
  recovery: {
    ...approvedRecovery.recovery,
    attempt: 1,
    batchId: 'batch-1',
    planRootId: 'plan-root',
  },
  tasks: [
    { id: 'analyse', title: 'Ursache analysieren', agentId: coder.id, agentName: coder.name, dependsOn: [], order: 0 },
    { id: 'fix', title: 'Korrektur prüfen', agentId: tester.id, agentName: tester.name, dependsOn: ['analyse'], order: 1 },
  ],
});
const recoveryAnalyseId = `${plannedIds.implement}:recovery:1:analyse`;
const recoveryFixId = `${plannedIds.implement}:recovery:1:fix`;
assert.equal(taskGraph.isTaskNodeReady(recoveryDag, recoveryAnalyseId), true);
assert.equal(taskGraph.isTaskNodeReady(recoveryDag, recoveryFixId), false);
assert.equal(recoveryDag.edges.some(edge => edge.from === recoveryAnalyseId && edge.to === recoveryFixId && edge.kind === 'dependency'), true);
assert.equal(recoveryDag.nodes.find(node => node.id === plannedIds.implement).recoveryPlan.batchId, 'batch-1');
const pmRevisionDraft = taskGraph.beginPMPlanRevision(approvedRecoveryGraph, {
  taskId: plannedIds.implement,
  note: 'Architektur ändern',
  problem: 'Der Plan ist strukturell falsch.',
});
assert.equal(pmRevisionDraft.workflowState, 'planning');
assert.equal(pmRevisionDraft.revisionStatus, 'revision_required');
assert.equal(pmRevisionDraft.changeRequest.reason, 'pm-proposed-revision');
assert.deepEqual(pmRevisionDraft.changeRequest.taskIds, [plannedIds.implement]);
let preparationGraph = taskGraph.lockTaskGraphPlan(plannedGraph);
preparationGraph = taskGraph.updateTaskNodeStatus(preparationGraph, plannedIds.implement, 'running');
assert.deepEqual(taskGraph.findDependencyPreparationCandidateIds(preparationGraph, {
  activeNodeIds: [plannedIds.implement],
}), [plannedIds.qa]);
const dependencyPreparation = {
  graphNodeId: plannedIds.qa,
  agent: tester,
  objective: 'Nur unabhängige Vorarbeit durchführen',
  source: 'dependency-preparation',
  preparationOnly: true,
  approvedContinuation: true,
};
assert.equal(taskGraph.validateApprovedTaskExecution(preparationGraph, dependencyPreparation).mode, 'dependency-preparation');
preparationGraph = taskGraph.updateTaskNodeStatus(preparationGraph, plannedIds.qa, 'prepared', {
  preparationAttemptedAt: Date.now(),
  preparationCompletedAt: Date.now(),
  interimResult: 'Testgerüst ohne Annahmen vorbereitet.',
});
assert.equal(taskGraph.isTaskNodeReady(preparationGraph, plannedIds.qa), false);
assert.deepEqual(taskGraph.findDependencyPreparationCandidateIds(preparationGraph, {
  activeNodeIds: [plannedIds.implement],
}), []);
preparationGraph = taskGraph.updateTaskNodeStatus(preparationGraph, plannedIds.implement, 'agent_done');
assert.equal(taskGraph.isTaskNodeReady(preparationGraph, plannedIds.qa), true);
const changeRequestGraph = taskGraph.beginUserPlanEdit(approvedPlannedGraph);
assert.equal(changeRequestGraph.approvedPlan, null);
assert.equal(changeRequestGraph.workflowState, 'planning');
assert.equal(changeRequestGraph.changeRequest.reason, 'user-edit');
assert.deepEqual(changeRequestGraph.changeRequest.taskIds, []);
assert.equal(taskGraph.materializeTaskPlan(changeRequestGraph, {
  rootNodeId: 'plan-root',
  replace: true,
  tasks: [{ id: 'intruder', title: 'Nicht freigegebene PM-Aufgabe', agentId: pm.id, agentName: pm.name, type: 'task', dependsOn: [], order: 0 }],
}), changeRequestGraph);
const pmRevisedChangeRequestGraph = taskGraph.materializeTaskPlan(changeRequestGraph, {
  rootNodeId: 'plan-root',
  replace: true,
  allowPlanningRevision: true,
  tasks: [{
    id: 'implement',
    title: 'CMD nach User-Rückmeldung anpassen',
    agentId: coder.id,
    agentName: coder.name,
    type: 'task',
    dependsOn: [],
    order: 0,
  }],
});
assert.equal(pmRevisedChangeRequestGraph.nodes.some(node => node.planTaskId === 'final-review'), false);
assert.equal(pmRevisedChangeRequestGraph.nodes.find(node => node.planTaskId === 'implement').title, 'CMD nach User-Rückmeldung anpassen');
assert.equal(pmRevisedChangeRequestGraph.planOwner, 'user');
assert.equal(pmRevisedChangeRequestGraph.approvedPlan, null);
assert.equal(pmRevisedChangeRequestGraph.previousApprovedPlan, changeRequestGraph.previousApprovedPlan);
const relockedGraph = taskGraph.lockTaskGraphPlan(changeRequestGraph);
assert.equal(relockedGraph.approvedPlan.revision, approvedPlannedGraph.approvedPlan.revision + 1);
assert.equal(relockedGraph.planHistory.some(plan => plan.revision === approvedPlannedGraph.approvedPlan.revision), true);
const failedApprovedGraph = taskGraph.updateTaskNodeStatus(approvedPlannedGraph, plannedIds.implement, 'failed', {
  error: 'Provider vorübergehend nicht verfügbar',
});
const retriedApprovedGraph = taskGraph.retryTaskNode(failedApprovedGraph, plannedIds.implement);
assert.equal(retriedApprovedGraph.nodes.find(node => node.id === plannedIds.implement).status, 'planned');
assert.equal(retriedApprovedGraph.nodes.find(node => node.id === plannedIds.implement).error, undefined);
assert.equal(retriedApprovedGraph.approvedPlan, approvedPlannedGraph.approvedPlan);
const retriedRecoveryGraph = taskGraph.retryTaskNode(approvedRecoveryGraph, plannedIds.implement);
assert.equal(retriedRecoveryGraph.nodes.find(node => node.id === plannedIds.implement).status, 'planned');
assert.equal(retriedRecoveryGraph.nodes.find(node => node.id === plannedIds.implement).recoveryStatus, null);
const initialUserDraft = taskGraph.beginUserPlanEdit(taskGraph.createTaskGraph('initial-user-plan'));
assert.equal(initialUserDraft.planRevision, 1);
assert.equal(initialUserDraft.planOwner, 'user');
const executionLoggedGraph = taskGraph.recordTaskExecutionEvent(approvedPlannedGraph, {
  graphNodeId: plannedIds.implement, agent: coder,
}, 'started');
assert.equal(executionLoggedGraph.executionLog.at(-1).compliant, true);
const freeExecutionLog = taskGraph.recordTaskExecutionEvent(taskGraph.createTaskGraph('free-log'), {
  graphNodeId: 'dynamic-task', agent: coder,
}, 'started');
assert.equal(freeExecutionLog.executionLog.at(-1).compliant, null);
const cyclicWorkflow = taskGraph.addTaskEdge(revisedPlannedGraph, {
  from: revisedPlannedGraph.nodes.find(node => node.planTaskId === 'final-review').id,
  to: plannedIds.implement,
  kind: 'dependency',
});
assert.equal(taskGraph.validateWorkflowPlan(cyclicWorkflow).ok, false);
assert.ok(taskGraph.validateWorkflowPlan(cyclicWorkflow).taskIds.includes(plannedIds.implement));
const danglingWorkflow = taskGraph.addTaskEdge(revisedPlannedGraph, {
  from: 'missing-task',
  to: plannedIds['final-review'],
  kind: 'dependency',
});
const danglingValidation = taskGraph.validateWorkflowPlan(danglingWorkflow);
assert.equal(danglingValidation.ok, false);
assert.match(danglingValidation.reason, /nicht vorhandenen Aufgabe/);
assert.deepEqual(taskGraph.findSafeAutoParallelTaskIds(plannedGraph, [
  { graphNodeId: plannedIds.implement },
  { graphNodeId: plannedIds.docs },
  { graphNodeId: plannedIds.qa },
]), [plannedIds.implement, plannedIds.docs]);
assert.match(taskGraph.validateParallelSelection(plannedGraph, [plannedIds.qa, plannedIds.docs]).reason, /wartet noch/);
plannedGraph = taskGraph.updateTaskNodeStatus(plannedGraph, plannedIds.implement, 'agent_done');
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds.qa), true);
plannedGraph = taskGraph.updateTaskNodeStatus(plannedGraph, plannedIds.docs, 'agent_done');
plannedGraph = taskGraph.updateTaskNodeStatus(plannedGraph, plannedIds.qa, 'agent_done');
assert.equal(taskGraph.isTaskNodeReady(plannedGraph, plannedIds['final-review']), true);
assert.equal(plannedGraph.nodes.find(node => node.id === plannedIds.implement).acceptanceCriteria.length, 1);

assert.equal(taskGraph.normalizeAcceptanceCriteria([], {
  taskId: 'fallback-task', fallbackText: 'Das erwartete Ergebnis ist überprüfbar vorhanden.',
})[0].id, 'fallback-task-result');
let acceptanceGraph = taskGraph.createTaskGraph('generic-acceptance', 'Generische Abnahme');
acceptanceGraph = taskGraph.upsertTaskNode(acceptanceGraph, {
  id: 'acceptance-root', title: 'Ergebnis liefern', agentId: pm.id, agentName: pm.name,
  source: 'user', nodeType: 'request', status: 'agent_done',
});
acceptanceGraph = taskGraph.materializeTaskPlan(acceptanceGraph, {
  rootNodeId: 'acceptance-root',
  tasks: [{
    id: 'deliverable', title: 'Fachliches Ergebnis erstellen', agentId: coder.id, agentName: coder.name,
    type: 'task', dependsOn: [], order: 0,
    acceptanceCriteria: [
      { id: 'quality', text: 'Das Ergebnis erfüllt die fachlichen Anforderungen.', verification: 'reviewer', required: true },
      { id: 'user-release', text: 'Der User gibt das Ergebnis frei.', verification: 'user', required: true },
    ],
  }],
});
const deliverableNodeId = taskGraph.taskPlanGraphNodeId('acceptance-root', 'deliverable');
acceptanceGraph = taskGraph.updateTaskNodeStatus(acceptanceGraph, deliverableNodeId, 'agent_done');
acceptanceGraph = taskGraph.submitTaskEvidence(acceptanceGraph, deliverableNodeId, [{
  criterionId: 'quality', summary: 'Das vollständige Ergebnis und seine Herleitung liegen vor.', kind: 'result',
}], { author: 'Max' });
let acceptanceSummary = taskGraph.summarizeAcceptance(acceptanceGraph, 'acceptance-root');
assert.equal(acceptanceSummary.ready, false);
assert.equal(acceptanceSummary.submitted, 1);
assert.equal(acceptanceSummary.userPending, 1);
acceptanceGraph = taskGraph.applyAcceptanceDecisions(acceptanceGraph, [
  { taskId: 'deliverable', criterionId: 'quality', status: 'passed', note: 'Fachlich geprüft.' },
  { taskId: 'deliverable', criterionId: 'user-release', status: 'passed', note: 'PM darf dies nicht freigeben.' },
], { reviewer: 'PM' });
assert.equal(taskGraph.summarizeAcceptance(acceptanceGraph, 'acceptance-root').userPending, 1);
acceptanceGraph = taskGraph.applyAcceptanceDecisions(acceptanceGraph, [
  { taskId: deliverableNodeId, criterionId: 'user-release', status: 'passed', note: 'Vom User geprüft.' },
], { reviewer: 'User', userOnly: true });
acceptanceSummary = taskGraph.summarizeAcceptance(acceptanceGraph, 'acceptance-root');
assert.equal(acceptanceSummary.ready, true);
assert.equal(acceptanceSummary.passed, 2);
assert.equal(acceptanceGraph.nodes.find(node => node.id === deliverableNodeId).status, 'completed');

let manualAcceptanceGraph = taskGraph.createTaskGraph('manual-acceptance', 'Manuelle Freigabe');
manualAcceptanceGraph = taskGraph.upsertTaskNode(manualAcceptanceGraph, {
  id: 'manual-result', title: 'Ergebnis ohne AC', agentId: coder.id, agentName: coder.name,
  source: 'PM', nodeType: 'task', status: 'agent_done', acceptanceCriteria: [],
});
manualAcceptanceGraph = taskGraph.approveAgentDoneTasks(manualAcceptanceGraph);
assert.equal(manualAcceptanceGraph.nodes[0].status, 'agent_done', 'a ticket without AC must not auto-complete');
assert.equal(taskGraph.summarizeAcceptance(manualAcceptanceGraph).ready, false, 'missing AC require user approval');
manualAcceptanceGraph = taskGraph.ensureManualAcceptanceCriterion(manualAcceptanceGraph, 'manual-result', { requestedBy: 'Sarah' });
assert.equal(manualAcceptanceGraph.nodes[0].acceptanceCriteria[0].verification, 'user');
assert.equal(manualAcceptanceGraph.nodes[0].manualAcceptanceRequestedBy, 'Sarah');
manualAcceptanceGraph = taskGraph.applyAcceptanceDecisions(manualAcceptanceGraph, [{
  taskId: 'manual-result', criterionId: 'manual-result-manual-release', status: 'passed', note: 'Vom User vollständig geprüft.',
}], { reviewer: 'User', userOnly: true, allowManualOverride: true });
assert.equal(manualAcceptanceGraph.nodes[0].status, 'completed');

let automaticAcceptanceGraph = taskGraph.createTaskGraph('automatic-acceptance', 'Automatische Prüfung');
automaticAcceptanceGraph = taskGraph.upsertTaskNode(automaticAcceptanceGraph, {
  id: 'automatic-result', title: 'Automatisch prüfen', agentId: coder.id, agentName: coder.name,
  source: 'PM', nodeType: 'task', status: 'agent_done',
  acceptanceCriteria: taskGraph.normalizeAcceptanceCriteria([{
    id: 'lint-clean', text: 'Der Linter meldet keine Fehler.', verification: 'automatic', required: true,
  }], { taskId: 'automatic-result' }),
});
automaticAcceptanceGraph = taskGraph.updateAcceptanceTestRun(automaticAcceptanceGraph, ['automatic-result'], {
  id: 'run-1', status: 'running', sourceRevision: 2,
});
automaticAcceptanceGraph = taskGraph.updateAcceptanceTestRun(automaticAcceptanceGraph, ['automatic-result'], {
  id: 'run-1', status: 'passed', command: 'npm test', output: 'ok',
});
assert.deepEqual(automaticAcceptanceGraph.nodes[0].acceptanceTestRuns.map(run => run.status), ['passed']);
automaticAcceptanceGraph = taskGraph.applyAcceptanceDecisions(automaticAcceptanceGraph, [{
  taskId: 'automatic-result', criterionId: 'lint-clean', status: 'passed', note: 'npm test: ok',
}], { reviewer: 'Automatischer Prüflauf' });
assert.equal(automaticAcceptanceGraph.nodes[0].status, 'completed');

let overrideGraph = taskGraph.createTaskGraph('manual-override', 'Ausnahmefreigabe');
overrideGraph = taskGraph.upsertTaskNode(overrideGraph, {
  id: 'override-result', title: 'Extern prüfen', agentId: coder.id, nodeType: 'task', status: 'retryable',
  acceptanceCriteria: taskGraph.normalizeAcceptanceCriteria([{
    id: 'external-ok', text: 'Externer Nachweis liegt vor.', verification: 'automatic', required: true, status: 'failed',
  }], { taskId: 'override-result' }),
});
overrideGraph = taskGraph.applyAcceptanceDecisions(overrideGraph, [{
  taskId: 'override-result', criterionId: 'external-ok', status: 'waived', note: 'Externer Bericht wurde manuell geprüft.',
}], { reviewer: 'User', userOnly: true, allowManualOverride: true });
assert.equal(overrideGraph.nodes[0].status, 'completed');
assert.equal(overrideGraph.nodes[0].acceptanceCriteria[0].evidence.at(-1).kind, 'user-override');

let agentHandoffGraph = taskGraph.upsertTaskNode(graph, { id: 'qa-fix', title: 'Spezialprüfung', agentId: tester.id, agentName: tester.name, source: 'Max', parentNodeId: 'frontend', status: 'planned' });
agentHandoffGraph = taskGraph.addTaskEdge(agentHandoffGraph, { from: 'frontend', to: 'qa-fix', kind: 'delegation' });
assert.equal(taskGraph.projectTaskTree(agentHandoffGraph).primaryParentByNode.get('qa-fix'), 'frontend');

let legacyGraph = taskGraph.upsertTaskNode(graph, { id: 'legacy-qa', title: 'Legacy QA danach', agentId: tester.id, agentName: tester.name, source: 'PM', parentNodeId: 'frontend', status: 'planned' });
legacyGraph = taskGraph.addTaskEdge(legacyGraph, { from: 'frontend', to: 'legacy-qa', kind: 'handoff' });
const migratedLegacyTree = taskGraph.projectTaskTree(legacyGraph);
assert.equal(migratedLegacyTree.primaryParentByNode.get('legacy-qa'), 'plan');
assert.deepEqual(migratedLegacyTree.metadataByNode.get('legacy-qa').dependencyIds, ['frontend']);
let conflictingGraph = taskGraph.createTaskGraph('chat-conflict');
conflictingGraph = taskGraph.upsertTaskNode(conflictingGraph, { id: 'one', title: 'App ändern', objective: 'Ändere src/App.jsx', agentId: coder.id, status: 'planned' });
conflictingGraph = taskGraph.upsertTaskNode(conflictingGraph, { id: 'two', title: 'App testen', objective: 'Prüfe src/App.jsx', agentId: tester.id, status: 'planned' });
assert.match(taskGraph.validateParallelSelection(conflictingGraph, ['one', 'two']).reason, /Dateikonflikt/);
const approvedGraph = taskGraph.approveAgentDoneTasks(graph);
assert.equal(approvedGraph.nodes.find(node => node.id === 'plan').status, 'completed');
assert.equal(JSON.parse(JSON.stringify(approvedGraph)).nodes.length, 3);

assert.equal(orchestration.isPMAgent(pm), true);
assert.equal(orchestration.isPMAgent({ id: 'pm-role', role: 'PM' }), true);
assert.equal(orchestration.isPMAgent({ id: 'developer', role: 'Development' }), false);
assert.equal(orchestration.getGroupPMAgent('direct', [pm, coder]), null);
assert.equal(orchestration.getGroupPMAgent('group', [coder, pm]), pm);

assert.deepEqual(
  orchestration.orchestrate({ request: '@Max prüfen', chatAgents: [pm, coder, tester], isEveryone: false, explicitMentions: [coder] }).agents,
  [coder],
);
assert.deepEqual(
  orchestration.orchestrate({ request: '@everyone prüfen', chatAgents: [pm, coder, tester], isEveryone: true }).agents,
  [pm],
);
assert.equal(orchestration.hasUserDirectedMention('Bitte @Max prüfe den Fehler.', 'Max'), true);
assert.equal(orchestration.hasUserDirectedMention('```text\nBitte @Max nur als Beispiel\n```', 'Max'), false);
assert.equal(orchestration.shouldRunAsWorkflowSideConversation({
  chatType: 'group',
  triggerText: 'Bitte @Max prüfe den Fehler.',
  chatAgents: [pm, coder, tester],
  continuation: { mode: 'planning', status: 'awaiting-schedule' },
}), true);
assert.equal(orchestration.shouldRunAsWorkflowSideConversation({
  chatType: 'group',
  triggerText: '@PM ändere den Plan.',
  chatAgents: [pm, coder, tester],
  continuation: { mode: 'planning' },
}), false);
assert.equal(orchestration.shouldMaterializeTaskPlan({
  isOrchestrator: true, planningOnly: true, taskSource: 'user', hasApprovedPlan: true,
}), false);
assert.equal(orchestration.shouldMaterializeTaskPlan({
  isOrchestrator: true, planningOnly: true, taskSource: 'user', hasApprovedPlan: false,
}), true);
assert.equal(orchestration.shouldMaterializeTaskPlan({
  isOrchestrator: true, planningOnly: true, taskSource: 'user', hasApprovedPlan: false, userOwnedPlan: true,
}), true);
assert.equal(orchestration.shouldMaterializeTaskPlan({
  isOrchestrator: true, planningOnly: false, taskSource: 'team-synthesis', hasApprovedPlan: true,
}), false);
const directBubbleSortHistory = [
  { id: 'd1', agentId: 'user', senderName: 'User', text: 'Kannst du mir Bubble Sort erklären?' },
  { id: 'd2', agentId: coder.id, senderName: coder.name, text: 'Bubble Sort vergleicht benachbarte Werte.' },
  { id: 'd3', agentId: 'user', senderName: 'User', text: 'Erstelle daraus ein Diagramm.' },
  { id: 'd4', agentId: coder.id, senderName: coder.name, text: 'Welche Art von Diagramm?' },
  { id: 'd5', agentId: 'user', senderName: 'User', text: 'Flowchart' },
];
const selectedDirectContext = orchestration.buildRelevantConversationHistory({
  history: directBubbleSortHistory,
  agent: coder,
  chatType: 'direct',
});
assert.equal(selectedDirectContext.length, 5);
assert.match(selectedDirectContext[0].text, /Bubble Sort/);
assert.equal(selectedDirectContext.at(-1).text, 'Flowchart');

const groupContextSource = [
  { id: 'old', agentId: 'user', text: 'Sehr alter Kontext' },
  ...Array.from({ length: 13 }, (_, index) => ({
    id: `g${index}`,
    agentId: index % 3 === 0 ? 'user' : (index % 3 === 1 ? pm.id : coder.id),
    senderName: index % 3 === 0 ? 'User' : (index % 3 === 1 ? pm.name : coder.name),
    text: `Gruppennachricht ${index}`,
  })),
  { id: 'system', agentId: 'system', text: 'Interner Systemstatus' },
  { id: 'memory-only', agentId: 'user', text: '#fact Nur Memory', memoryOnly: true },
];
const selectedGroupContext = orchestration.buildRelevantConversationHistory({
  history: groupContextSource,
  agent: coder,
  chatType: 'group',
  includeGroupContext: true,
});
assert.equal(selectedGroupContext.length, 8);
assert.equal(selectedGroupContext[0].text, 'Gruppennachricht 5');
assert.equal(selectedGroupContext.at(-1).text, 'Gruppennachricht 12');
assert.deepEqual(orchestration.buildRelevantConversationHistory({
  history: groupContextSource,
  agent: coder,
  chatType: 'group',
  includeGroupContext: false,
}), []);
const requestRelevantContext = orchestration.buildRelevantConversationHistory({
  history: [
    { id: 'architecture', agentId: pm.id, text: 'Die OAuth-Architektur verwendet PKCE und kurzlebige Tokens.' },
    { id: 'design', agentId: coder.id, text: 'Das Designsystem verwendet violette Schaltflächen.' },
    { id: 'unrelated', agentId: tester.id, text: 'Der Termin für das Teammeeting steht fest.' },
  ],
  agent: pm,
  chatType: 'group',
  includeGroupContext: true,
  query: 'Welche OAuth-Token-Architektur wird verwendet?',
  requireQueryMatch: true,
  groupLimit: 6,
  maxCharacters: 1000,
});
assert.deepEqual(requestRelevantContext.map(message => message.id), ['architecture']);
const relevantProjectInventory = orchestration.buildRelevantProjectInventoryContext({
  files: [{ name: 'src/auth/oauth-client.js' }, { name: 'src/design/colors.css' }, { name: 'README.md' }],
  objective: 'Prüfe den OAuth Client.',
});
assert.match(relevantProjectInventory, /oauth-client\.js/);
assert.doesNotMatch(relevantProjectInventory, /colors\.css|README\.md/);

assert.equal(orchestration.shouldRequestPMFinalReview({
  pm, agent: coder, taskSource: 'user', routeMode: 'explicit', explicitMentionCount: 1,
  explicitlyAddressedAgentId: coder.id, handoffCount: 0,
}), false);
assert.equal(orchestration.shouldRequestPMFinalReview({
  pm, agent: coder, taskSource: 'user', routeMode: 'explicit', explicitMentionCount: 2,
  explicitlyAddressedAgentId: coder.id, handoffCount: 0,
}), true);
assert.equal(orchestration.shouldRequestPMFinalReview({
  pm, agent: coder, taskSource: 'user', routeMode: 'explicit', explicitMentionCount: 1,
  explicitlyAddressedAgentId: coder.id, handoffCount: 1,
}), true);
assert.equal(orchestration.shouldRequestPMFinalReview({
  pm, agent: coder, taskSource: 'PM', useLeanFastPath: true, requiresAcceptanceReview: true,
}), true);

const accidentalMemoryReply = '#Informationsarchitektur\n\n1. **Header:** Quicksort verstehen.\n#Accessibility Zustände sind erkennbar.';
assert.deepEqual(memoryRules.extractMemoryCommands(accidentalMemoryReply), []);
assert.deepEqual(memoryRules.extractKnowledgeFromReply(accidentalMemoryReply, coder.id, coder.name), []);
assert.deepEqual(memoryRules.extractMemoryCommands('Im Fließtext steht #fact nur als Beispiel.'), []);
const explicitMemoryCommands = memoryRules.extractMemoryCommands([
  '#decision PostgreSQL wird für das Projekt verwendet.',
  '#fact #Max Bubble Sort vergleicht benachbarte Elemente.',
].join('\n'));
assert.deepEqual(explicitMemoryCommands.map(command => command.commandTag), ['decision', 'fact']);
assert.deepEqual(explicitMemoryCommands[1].tags, ['fact', 'max']);
assert.equal(memoryRules.isMemoryCommandOnly('#fact Bubble Sort ist stabil.'), true);
assert.equal(memoryRules.isMemoryCommandOnly('#fact Bubble Sort ist stabil.\n@Max Nutze diese Information.'), false);
const multilineMemory = memoryRules.extractMemoryCommands('#constraint\nDie Anwendung muss offline starten.\nKeine Anmeldung erzwingen.');
assert.equal(multilineMemory.length, 1);
assert.match(multilineMemory[0].text, /Keine Anmeldung erzwingen/);
const capsule = orchestration.buildTaskCapsule({
  agentName: 'Max', agentRole: 'Developer', objective: 'Feature prüfen',
  context: ['memory://shared'], requestedOutput: ['Ergebnis'],
  acceptanceCriteria: [{ id: 'fachlich-richtig', text: 'Das Ergebnis ist fachlich richtig.', required: true, verification: 'reviewer' }],
});
assert.match(capsule, /Feature prüfen/);
assert.match(capsule, /Verbindliche Abnahmekriterien[\s\S]*fachlich-richtig[\s\S]*TASK_EVIDENCE/);
assert.doesNotMatch(capsule, /UNERLAUBTER_VOLLER_VERLAUF/);
const sessionA = orchestration.buildAgentSession({ agent: coder, taskCapsule: capsule });
const sessionB = orchestration.buildAgentSession({ agent: coder, taskCapsule: capsule });
assert.notEqual(sessionA.sessionId, sessionB.sessionId);
assert.equal(sessionA.messages.length, 1);
assert.equal(orchestration.buildAgentSession({ agent: coder, taskCapsule: capsule, lastUserMessage: 'Feature prüfen' }).messages.length, 1);
const boundedCapsule = orchestration.buildTaskCapsule({ agentName: 'Max', agentRole: 'Developer',
  objective: 'MANDATORY_OBJECTIVE', acceptanceCriteria: [{ id: 'required', text: 'MANDATORY_CRITERION' }],
  handoff: { from: 'PM', summary: 'x'.repeat(10000), findings: Array(100).fill('y'.repeat(10000)), openQuestions: ['Wichtige Rückfrage'] },
});
assert.ok(boundedCapsule.length < 12000);
assert.match(boundedCapsule, /MANDATORY_OBJECTIVE/);
assert.match(boundedCapsule, /MANDATORY_CRITERION/);
assert.match(boundedCapsule, /Wichtige Rückfrage/);
assert.match(boundedCapsule, /gekürzt/);

const handoffs = orchestration.extractHandoffsFromReply(
  '@Max: Implementiere die Seite.\n@Lisa: Prüfe danach die Navigation.\n@user: Optionales Feedback.',
  pm,
  [pm, coder, tester],
);
assert.deepEqual(handoffs.map(handoff => handoff.to), ['Max', 'Lisa']);
assert.match(handoffs[0].summary, /Implementiere die Seite/);
assert.match(handoffs[1].summary, /Prüfe danach die Navigation/);

assert.equal(orchestration.hasDirectedMention('@Max: Starte.', 'Max'), true);
assert.equal(orchestration.hasDirectedMention('Bitte stimme dich mit @Max ab.', 'Max'), false);
assert.equal(orchestration.hasDirectedMention('  @Max: Nur eingerückter Text.', 'Max'), false);
assert.equal(orchestration.hasDirectedMention('```text\n@Max: Beispiel\n```', 'Max'), false);
const nonActionableMentions = [
  'Im Fließtext wurde @Max nur erwähnt.',
  '  @Max: Diese eingerückte Zeile ist keine Übergabe.',
  '@Lisa: Nur diese linkbündige Zeile ist eine Übergabe.',
].join('\n');
assert.deepEqual(
  orchestration.extractHandoffsFromReply(nonActionableMentions, pm, [pm, coder, tester]).map(handoff => handoff.to),
  ['Lisa'],
);
const normalizedNonActionableMentions = orchestration.normalizeAgentMentionLayout(nonActionableMentions, pm, [pm, coder, tester]);
assert.match(normalizedNonActionableMentions, /^Im Fließtext wurde @Max/m);
assert.match(normalizedNonActionableMentions, /^  @Max:/m);
assert.deepEqual(
  orchestration.extractHandoffsFromReply(normalizedNonActionableMentions, pm, [pm, coder, tester]).map(handoff => handoff.to),
  ['Lisa'],
);

const layoutReply = [
  'Die Analyse ist abgeschlossen.',
  '@Max: Implementiere die Startseite.',
  '@Lisa: Prüfe anschließend die Navigation.',
  'Weitere Details stehen im Bericht.',
].join('\n');
const normalizedLayout = orchestration.normalizeAgentMentionLayout(layoutReply, pm, [pm, coder, tester]);
const normalizedLines = normalizedLayout.split('\n');
assert.deepEqual(normalizedLines.slice(-2), [
  '@Max: Implementiere die Startseite.',
  '@Lisa: Prüfe anschließend die Navigation.',
]);
assert.equal(normalizedLines.slice(-2).every(line => line.startsWith('@')), true);
assert.match(normalizedLayout, /Weitere Details stehen im Bericht\.\n\n@Max/);

const codeMentionReply = '```js\nconst owner = "@Max";\n```\n@Lisa: Teste den Code.';
assert.deepEqual(orchestration.extractHandoffsFromReply(codeMentionReply, pm, [pm, coder, tester]).map(handoff => handoff.to), ['Lisa']);
assert.match(orchestration.normalizeAgentMentionLayout(codeMentionReply, pm, [pm, coder, tester]), /const owner = "@Max"/);
const nestedFenceMentionReply = [
  '````file:README.md',
  '# Beispiel',
  '```text',
  '@Lisa: Diese Beispielzeile darf keine Übergabe auslösen.',
  '```',
  '@Max: Auch normaler Text in der Datei bleibt inaktiv.',
  '````',
].join('\n');
assert.deepEqual(
  orchestration.extractHandoffsFromReply(nestedFenceMentionReply, pm, [pm, coder, tester]),
  [],
);

const userQuestionReply = [
  'Die technische Planung ist abgeschlossen.',
  '@user Welche Hauptfarbe soll verwendet werden? Soll ein vorhandenes Logo eingebunden werden?',
].join('\n');
assert.deepEqual(orchestration.extractUserQuestions(userQuestionReply), [
  'Welche Hauptfarbe soll verwendet werden?',
  'Soll ein vorhandenes Logo eingebunden werden?',
]);
assert.deepEqual(orchestration.extractUserQuestions('Ergebnis vollständig geliefert.\n@user'), []);
assert.deepEqual(orchestration.extractUserQuestions('@user\nWelche Variante soll verwendet werden?'), []);
assert.deepEqual(orchestration.extractUserQuestions('```js\nconst owner = "@user";\n```'), []);
assert.deepEqual(orchestration.extractUserQuestions('Im Fließtext steht @user: Soll das pausieren?'), []);
assert.deepEqual(orchestration.extractUserQuestions('  @user Soll das eingerückt pausieren?'), []);

const taskQueue = new orchestration.AgentTaskQueue({ maxTurns: 8, maxTurnsPerAgent: 3 });
assert.equal(taskQueue.enqueue({ agent: pm, objective: 'Plane das Projekt', source: 'user' }), true);
assert.equal(taskQueue.next().agent.name, 'PM');

const priorityQueue = new orchestration.AgentTaskQueue({ maxTurns: 8, maxTurnsPerAgent: 3 });
priorityQueue.enqueue({ agent: tester, objective: 'Bereits wartende QA-Aufgabe', source: 'user' });
assert.equal(priorityQueue.prepend([
  { agent: coder, objective: 'Direkt angesprochene Implementierung', source: 'PM' },
  { agent: pm, objective: 'Direkt danach planen', source: 'Max' },
]), 2);
assert.deepEqual(
  [priorityQueue.next().agent.name, priorityQueue.next().agent.name, priorityQueue.next().agent.name],
  ['Max', 'PM', 'Lisa'],
);
const autoParallelQueue = new orchestration.AgentTaskQueue({ maxTurns: 8, maxTurnsPerAgent: 3 });
autoParallelQueue.enqueue({ agent: tester, objective: 'Sequenziell', graphNodeId: 'sequential' });
autoParallelQueue.enqueue({ agent: coder, objective: 'Parallel A', graphNodeId: 'parallel-a' });
autoParallelQueue.enqueue({ agent: pm, objective: 'Parallel B', graphNodeId: 'parallel-b' });
autoParallelQueue.prioritize(['parallel-a', 'parallel-b']);
assert.deepEqual(
  [autoParallelQueue.next().graphNodeId, autoParallelQueue.next().graphNodeId, autoParallelQueue.next().graphNodeId],
  ['parallel-a', 'parallel-b', 'sequential'],
);
const availableAgentQueue = new orchestration.AgentTaskQueue({ maxTurns: 8, maxTurnsPerAgent: 3 });
availableAgentQueue.enqueue({ agent: coder, objective: 'Max arbeitet bereits', graphNodeId: 'max-busy' });
availableAgentQueue.enqueue({ agent: tester, objective: 'Lisa kann nachrücken', graphNodeId: 'lisa-ready' });
assert.equal(
  availableAgentQueue.nextMatching(candidate => candidate.agent.id !== coder.id).graphNodeId,
  'lisa-ready',
);
assert.equal(availableAgentQueue.next().graphNodeId, 'max-busy');
const providerRetryQueue = new orchestration.AgentTaskQueue({ maxTurns: 2, maxTurnsPerAgent: 1 });
providerRetryQueue.enqueue({ agent: coder, objective: 'Temporär begrenzter Task', source: 'PM' });
const limitedTask = providerRetryQueue.next();
assert.equal(providerRetryQueue.retry(limitedTask), true);
assert.equal(providerRetryQueue.next().objective, 'Temporär begrenzter Task');
assert.equal(providerRetryQueue.reachedLimit, false);
const unlimitedQueue = new orchestration.AgentTaskQueue({ maxTurns: 0, maxTurnsPerAgent: 0 });
for (let index = 0; index < 60; index += 1) {
  unlimitedQueue.enqueue({ agent: coder, objective: `Unbegrenzter Task ${index}`, source: 'PM' });
}
let unlimitedTaskCount = 0;
while (unlimitedQueue.next()) unlimitedTaskCount += 1;
assert.equal(unlimitedTaskCount, 60);
assert.equal(unlimitedQueue.reachedLimit, false);
const repeatedFileQueue = new orchestration.AgentTaskQueue({ maxSuccessfulScopeRepeats: 2 });
const readmeTask = summary => ({
  agent: tester,
  objective: summary,
  handoff: { from: 'PM', summary },
  source: 'PM',
});
assert.equal(repeatedFileQueue.enqueue(readmeTask('Erstelle README.md vollständig.')), true);
const firstReadmeTask = repeatedFileQueue.next();
repeatedFileQueue.markSuccessful(firstReadmeTask);
assert.equal(repeatedFileQueue.enqueue(readmeTask('Überarbeite die vollständige Datei README.md.')), true);
const secondReadmeTask = repeatedFileQueue.next();
repeatedFileQueue.markSuccessful(secondReadmeTask);
assert.equal(repeatedFileQueue.prepend([readmeTask('Lege README.md mit kompletter Dokumentation neu an.')]), 0);
assert.equal(repeatedFileQueue.getLastPrependResult().rejected[0].reason, 'repeat-limit');
const restoredFileQueue = new orchestration.AgentTaskQueue({ guardState: repeatedFileQueue.guardState() });
assert.equal(restoredFileQueue.enqueue(readmeTask('Schreibe README.md bitte erneut.')), false);
assert.equal(orchestration.shouldDeferHandoffToPM({ fromAgent: coder, targetAgent: pm, pm }), true);
assert.equal(orchestration.shouldDeferHandoffToPM({ fromAgent: pm, targetAgent: coder, pm }), false);
assert.equal(orchestration.isAgentTimeoutError({ isAgentTimeout: true }), true);
assert.equal(orchestration.isAgentTimeoutError({ message: 'Codex-Aufruf nach 120s ohne Aktivität abgebrochen.' }), true);
assert.equal(orchestration.isAgentTimeoutError({ message: 'Normaler Modellfehler' }), false);
const timeoutRecoveryTask = orchestration.buildTimeoutRecoveryTask({
  pm,
  originalAgent: coder,
  objective: 'Implementiere die gesamte Anwendung in einem Schritt.',
  errorMessage: '120s ohne Aktivität',
  originalGraphNodeId: 'approved-original-task',
  planRootId: 'approved-plan-root',
});
assert.equal(timeoutRecoveryTask.agent.name, 'PM');
assert.equal(timeoutRecoveryTask.source, 'timeout-recovery');
assert.equal(timeoutRecoveryTask.recovery.originalAgentName, 'Max');
assert.equal(timeoutRecoveryTask.recovery.originalGraphNodeId, 'approved-original-task');
assert.equal(timeoutRecoveryTask.recovery.pmAgentId, pm.id);
assert.equal(timeoutRecoveryTask.runtimeRecovery, true);
assert.equal(timeoutRecoveryTask.planRootId, 'approved-plan-root');
assert.match(timeoutRecoveryTask.handoff.summary, /Recovery-Teilplan/);
assert.match(timeoutRecoveryTask.handoff.summary, /Versuch 1\/2/);
assert.equal(orchestration.buildTimeoutRecoveryTask({
  pm,
  originalAgent: coder,
  objective: 'Noch ein Versuch',
  previousRecovery: { ...timeoutRecoveryTask.recovery, attempt: orchestration.MAX_PM_RECOVERY_ATTEMPTS },
}), null);
const qualityRecoveryTask = orchestration.buildTimeoutRecoveryTask({
  pm,
  originalAgent: coder,
  objective: 'Eine fachlich zu große Aufgabe.',
  errorMessage: 'Qualitätskriterien nach Eskalation nicht erfüllt',
  originalGraphNodeId: 'approved-quality-task',
  planRootId: 'approved-plan-root',
  trigger: 'quality',
});
assert.equal(qualityRecoveryTask.recovery.trigger, 'quality');
assert.equal(qualityRecoveryTask.recovery.originalStatus, 'blocked');
assert.match(qualityRecoveryTask.handoff.summary, /Qualitäts-Recovery/);
const problemRecoveryTask = orchestration.buildTimeoutRecoveryTask({
  pm,
  originalAgent: coder,
  objective: 'Eine Aufgabe ist mit einem Ausführungsfehler abgebrochen.',
  errorMessage: 'Werkzeug lieferte kein verwertbares Ergebnis',
  originalGraphNodeId: 'approved-problem-task',
  planRootId: 'approved-plan-root',
  trigger: 'error',
});
assert.equal(problemRecoveryTask.recovery.trigger, 'error');
assert.equal(problemRecoveryTask.recovery.originalStatus, 'blocked');
assert.match(problemRecoveryTask.handoff.summary, /Problem-Recovery/);
assert.match(problemRecoveryTask.handoff.findings.join('\n'), /@user/);
const timeoutPriorityQueue = new orchestration.AgentTaskQueue();
timeoutPriorityQueue.enqueue({ agent: tester, objective: 'Wartende QA-Aufgabe', source: 'PM' });
timeoutPriorityQueue.prepend([timeoutRecoveryTask]);
assert.deepEqual([timeoutPriorityQueue.next().agent.name, timeoutPriorityQueue.next().agent.name], ['PM', 'Lisa']);
const timeoutReviewTask = orchestration.buildTimeoutRecoveryReviewTask({
  pm,
  recovery: { ...timeoutRecoveryTask.recovery, mode: 'step', currentStep: 'Baue das Grundgerüst.' },
  stepObjective: 'Baue das Grundgerüst.',
  result: 'Grundgerüst fertig.',
});
assert.equal(timeoutReviewTask.agent.name, 'PM');
assert.equal(timeoutReviewTask.runtimeRecovery, true);
assert.equal(timeoutReviewTask.recovery.originalGraphNodeId, 'approved-original-task');
assert.match(timeoutReviewTask.handoff.findings.join(' '), /Grundgerüst fertig/);
const workflowRecoveryPrompt = orchestration.buildIsolatedSystemPrompt({
  agent: pm,
  groupName: 'Recovery-Team',
  groupAgents: [pm, coder],
  isOrchestrator: true,
  userOwnedWorkflow: true,
  recoveryMode: true,
});
assert.match(workflowRecoveryPrompt, /automatisch ausgelöste Ausführungs-Recovery/);
assert.match(workflowRecoveryPrompt, /\[\[RECOVERY_PLAN\]\]/);
assert.match(workflowRecoveryPrompt, /Schritte ohne gegenseitige Abhängigkeit werden parallel gestartet/);
assert.match(workflowRecoveryPrompt, /freigegebene User-Plan bleibt unverändert/);
const turnLimitReviewTask = orchestration.buildTurnLimitReviewTask({
  pm,
  initialObjective: 'Baue und teste die Anwendung.',
  maxTurns: 16,
  pendingTasks: [{ agent: tester, objective: 'Regression testen' }],
  delegatedResults: [{ agent: 'Max', objective: 'Implementieren', result: 'Feature fertig' }],
});
assert.equal(turnLimitReviewTask.agent.name, 'PM');
assert.equal(turnLimitReviewTask.source, 'turn-limit-review');
assert.match(turnLimitReviewTask.handoff.summary, /höchstens EINEN kleinen/);
assert.match(turnLimitReviewTask.handoff.findings.join(' '), /Regression testen/);
assert.equal(orchestration.shouldCompleteProject({
  isOrchestrator: true,
  source: 'turn-limit-review',
  reply: 'Alles geprüft. [[PROJECT_DONE]]',
  handoffCount: 0,
  pendingTaskCount: 3,
  asksUser: false,
}), true);

const checkpointSourceQueue = new orchestration.AgentTaskQueue();
checkpointSourceQueue.enqueue({ agent: pm, objective: 'Plane das Projekt', source: 'user' });
assert.equal(checkpointSourceQueue.next().agent.name, 'PM');
checkpointSourceQueue.enqueue({ agent: coder, objective: 'Implementiere den offenen Teil', source: 'PM' });
checkpointSourceQueue.enqueue({ agent: tester, objective: 'Prüfe anschließend', source: 'PM' });
const serializedCheckpoint = JSON.parse(JSON.stringify({
  version: 1,
  status: 'running',
  initialObjective: 'Baue das Projekt',
  pendingTasks: checkpointSourceQueue.pendingTasks(),
  delegatedResults: [{ agent: 'PM', result: 'Planung abgeschlossen' }],
  successfulTasks: 1,
}));
const interruptedCheckpoint = { ...serializedCheckpoint, status: 'interrupted', interruptedAgentId: 'coder' };
assert.equal(['running', 'interrupted'].includes(interruptedCheckpoint.status), true);
assert.equal(interruptedCheckpoint.interruptedAgentId, 'coder');
const restoredCheckpointQueue = new orchestration.AgentTaskQueue();
for (const pendingTask of serializedCheckpoint.pendingTasks) restoredCheckpointQueue.enqueue(pendingTask);
assert.deepEqual(
  [restoredCheckpointQueue.next().agent.name, restoredCheckpointQueue.next().agent.name],
  ['Max', 'Lisa'],
);
assert.equal(serializedCheckpoint.successfulTasks, 1);
assert.equal(serializedCheckpoint.delegatedResults[0].result, 'Planung abgeschlossen');
assert.equal(
  orchestration.summarizeTaskActivity({ objective: 'Implementiere die Navigation und prüfe alle Links.', source: 'user' }),
  'Arbeitet an: Implementiere die Navigation und prüfe alle Links.',
);
assert.equal(
  orchestration.summarizeTaskActivity({ objective: 'Final-Review: Prüfe gegen die ursprüngliche User-Anforderung "Baue eine responsive Navigation".', source: 'team-synthesis' }),
  'Prüft den Abschluss für: Baue eine responsive Navigation',
);
assert.match(
  orchestration.summarizeTaskActivity({ objective: 'x'.repeat(300), source: 'user' }),
  /^Arbeitet an: .{132}…$/,
);
assert.equal(taskQueue.enqueue({ agent: coder, objective: 'Implementiere', handoff: { from: 'PM', summary: 'Implementiere' } }), true);
assert.equal(taskQueue.enqueue({ agent: tester, objective: 'Prüfe', handoff: { from: 'PM', summary: 'Prüfe' } }), true);
assert.equal(taskQueue.enqueue({ agent: coder, objective: 'Korrigiere QA-Fund', handoff: { from: 'Lisa', summary: 'Korrigiere QA-Fund' } }), true);
assert.equal(taskQueue.enqueue({ agent: coder, objective: 'Korrigiere QA-Fund', handoff: { from: 'Lisa', summary: 'Korrigiere QA-Fund' } }), false);
assert.deepEqual([taskQueue.next().agent.name, taskQueue.next().agent.name, taskQueue.next().agent.name], ['Max', 'Lisa', 'Max']);
assert.equal(taskQueue.enqueue({ agent: pm, objective: 'Fasse zusammen', handoff: { from: 'Team-Runde-1', summary: 'Fasse zusammen' } }), true);
assert.equal(taskQueue.next().agent.name, 'PM');

const dialogueQueue = new orchestration.AgentTaskQueue({ maxTurns: 8, maxTurnsPerAgent: 3 });
dialogueQueue.enqueue({ agent: pm, objective: 'Baue und prüfe die Seite', source: 'user' });
const dialogueSequence = [];
const scriptedReplies = [
  '@Max: Implementiere die Seite.',
  '@Lisa: Prüfe die Implementierung.',
  '@Max: Korrigiere den gefundenen Navigationsfehler.',
  'Korrektur abgeschlossen.',
];
let dialogueTask;
while ((dialogueTask = dialogueQueue.next()) && dialogueSequence.length < scriptedReplies.length) {
  dialogueSequence.push(dialogueTask.agent.name);
  const reply = scriptedReplies[dialogueSequence.length - 1];
  for (const handoff of orchestration.extractHandoffsFromReply(reply, dialogueTask.agent, [pm, coder, tester])) {
    const target = [pm, coder, tester].find(agent => agent.name === handoff.to);
    dialogueQueue.enqueue({ agent: target, objective: handoff.summary, handoff, source: dialogueTask.agent.name });
  }
}
assert.deepEqual(dialogueSequence, ['PM', 'Max', 'Lisa', 'Max']);

const pausedQueue = new orchestration.AgentTaskQueue();
pausedQueue.enqueue({ agent: tester, objective: 'Prüfe nach der User-Antwort', source: 'PM' });
const savedPendingTasks = pausedQueue.pendingTasks();
const resumedQueue = new orchestration.AgentTaskQueue();
const answerTask = orchestration.buildUserAnswerTask({
  askingAgent: coder,
  question: '@user Welche Farbe soll verwendet werden?',
  answer: 'Verwende Blau.',
});
assert.equal(answerTask.handoff.from, 'user');
assert.match(answerTask.objective, /Verwende Blau/);
resumedQueue.enqueue(answerTask);
for (const pendingTask of savedPendingTasks) resumedQueue.enqueue(pendingTask);
assert.deepEqual([resumedQueue.next().agent.name, resumedQueue.next().agent.name], ['Max', 'Lisa']);

const artifactReply = [
  'Die Basisdateien sind fertig.',
  '```file:src/app.js',
  "console.log('ok');",
  '```',
  '````file:README.md',
  '# Testprojekt',
  '',
  '```bash',
  'npm start',
  '```',
  '',
  '## Bedienung',
  'Die Datei bleibt auch hinter dem inneren Codeblock vollständig.',
  '````',
  '[[PROJECT_DONE]]',
].join('\n');
const parsedArtifacts = orchestration.extractProjectFiles(artifactReply);
assert.deepEqual(parsedArtifacts.map(file => file.filename), ['src/app.js', 'README.md']);
assert.match(parsedArtifacts[1].content, /## Bedienung/);
assert.match(parsedArtifacts[1].content, /```bash\nnpm start\n```/);
assert.equal(orchestration.hasProjectDoneSignal(artifactReply), true);
assert.doesNotMatch(orchestration.cleanAgentReply(artifactReply), /console\.log|PROJECT_DONE/);
assert.doesNotMatch(orchestration.cleanAgentReply(artifactReply), /README\.mdbash|npm start/);
assert.doesNotMatch(orchestration.cleanAgentReply('Gelöst. [[RECOVERY_RESOLVED]]'), /RECOVERY_RESOLVED/);
const reviewEvidence = orchestration.buildProjectReviewEvidence({
  displayReply: orchestration.cleanAgentReply(artifactReply),
  projectFiles: parsedArtifacts,
  savedProjectFiles: ['src/app.js', 'README.md'],
});
assert.match(reviewEvidence, /README\.md \| \d+ Zeichen \| vollständig gespeichert/);
assert.match(reviewEvidence, /## Bedienung/);
const structuredPlanReply = [
  '[[TASK_PLAN]]',
  '{"tasks":[',
  '{"id":"implement","title":"CMD implementieren","description":"Startskript robust umsetzen","priority":"high","agent":"Max","type":"task","parentId":null,"dependsOn":[],"acceptanceCriteria":[{"id":"starts","text":"Die CMD-Datei startet den vorgesehenen Ablauf.","required":true,"verification":"automatic"}]},',
  '{"id":"qa","title":"CMD testen","agent":"Lisa","type":"task","parentId":null,"dependsOn":["implement"]},',
  '{"id":"final-review","title":"Finale PM-Abnahme","agent":"PM","type":"review","parentId":null,"dependsOn":["qa"]}',
  ']}',
  '[[/TASK_PLAN]]',
  'Der vollständige Weg ist geplant.',
  '@Max: Implementiere die CMD-Datei.',
].join('\n');
const structuredPlan = orchestration.extractTaskPlan(structuredPlanReply);
assert.deepEqual(structuredPlan.tasks.map(task => task.id), ['implement', 'qa', 'final-review']);
assert.deepEqual(structuredPlan.tasks[1].dependsOn, ['implement']);
assert.equal(structuredPlan.tasks[0].description, 'Startskript robust umsetzen');
assert.equal(structuredPlan.tasks[0].priority, 'high');
assert.deepEqual(structuredPlan.tasks[0].acceptanceCriteria, [{
  id: 'starts', text: 'Die CMD-Datei startet den vorgesehenen Ablauf.', required: true, verification: 'automatic',
}]);
assert.doesNotMatch(orchestration.cleanAgentReply(structuredPlanReply), /TASK_PLAN|"dependsOn"/);
assert.match(orchestration.cleanAgentReply(structuredPlanReply), /vollständige Weg/);
const structuredRecoveryReply = [
  '[[RECOVERY_PLAN]]',
  '{"tasks":[',
  '{"id":"analyse","title":"Ursache isolieren","agent":"Max","dependsOn":[]},',
  '{"id":"fix","title":"Korrektur umsetzen","agent":"Lisa","dependsOn":["analyse"],"acceptanceCriteria":[{"id":"regression","text":"Der Fehler ist reproduzierbar behoben."}]}',
  ']}',
  '[[/RECOVERY_PLAN]]',
].join('\n');
const structuredRecovery = orchestration.extractRecoveryPlan(structuredRecoveryReply);
assert.deepEqual(structuredRecovery.tasks.map(task => task.id), ['analyse', 'fix']);
assert.deepEqual(structuredRecovery.tasks[1].dependsOn, ['analyse']);
assert.doesNotMatch(orchestration.cleanAgentReply(structuredRecoveryReply), /RECOVERY_PLAN|Ursache isolieren/);
assert.equal(orchestration.extractRecoveryPlan([
  '[[RECOVERY_PLAN]]',
  '{"tasks":[{"id":"a","title":"A","agent":"Max","dependsOn":["b"]},{"id":"b","title":"B","agent":"Lisa","dependsOn":["a"]}]}',
  '[[/RECOVERY_PLAN]]',
].join('\n')), null);
const genericPlan = orchestration.extractTaskPlan([
  '[[TASK_PLAN]]',
  '{"tasks":[',
  '{"id":"research","title":"Marktbericht erstellen","agent":"Max","type":"task","acceptanceCriteria":[{"id":"sources","text":"Alle Kernaussagen sind mit nachvollziehbaren Quellen belegt.","verification":"reviewer"}]},',
  '{"id":"campaign","title":"Kampagnentext erstellen","agent":"Lisa","type":"task","acceptanceCriteria":[{"id":"audience","text":"Der Text spricht die festgelegte Zielgruppe verständlich an.","verification":"user"}]}',
  ']}',
  '[[/TASK_PLAN]]',
].join('\n'));
assert.deepEqual(genericPlan.tasks.map(task => task.acceptanceCriteria[0].id), ['sources', 'audience']);
assert.equal(genericPlan.tasks[1].acceptanceCriteria[0].verification, 'user');
assert.deepEqual([
  { priority: 'low', planOrder: 0 },
  { priority: 'critical', planOrder: 4 },
  { priority: 'medium', planOrder: 1 },
].sort(taskTicket.compareTicketPriority).map(task => task.priority), ['critical', 'medium', 'low']);
const evidenceReply = [
  'Ergebnis fertig.',
  '[[TASK_EVIDENCE]]',
  '{"evidence":[{"criterionId":"sources","summary":"Drei Primärquellen sind mit Fundstellen aufgeführt.","kind":"sources"}]}',
  '[[/TASK_EVIDENCE]]',
].join('\n');
assert.deepEqual(orchestration.extractTaskEvidence(evidenceReply), [{
  criterionId: 'sources', summary: 'Drei Primärquellen sind mit Fundstellen aufgeführt.', kind: 'sources',
}]);
const acceptanceReviewReply = [
  'Die Nachweise wurden geprüft.',
  '[[ACCEPTANCE_REVIEW]]',
  '{"decisions":[{"taskId":"research","criterionId":"sources","status":"passed","note":"Quellen geprüft."}]}',
  '[[/ACCEPTANCE_REVIEW]]',
  '[[PROJECT_DONE]]',
].join('\n');
assert.deepEqual(orchestration.extractAcceptanceReview(acceptanceReviewReply), [{
  taskId: 'research', criterionId: 'sources', status: 'passed', note: 'Quellen geprüft.',
}]);
assert.doesNotMatch(orchestration.cleanAgentReply(`${evidenceReply}\n${acceptanceReviewReply}`), /TASK_EVIDENCE|ACCEPTANCE_REVIEW|criterionId/);
const distributedDeveloperTasks = orchestration.distributeTaskPlanAcrossAgentPools([
  { id: 'dev-1', title: 'Modul A', agent: 'Max', type: 'task', order: 0 },
  { id: 'dev-2', title: 'Modul B', agent: 'Max', type: 'task', order: 1 },
  { id: 'dev-3', title: 'Modul C', agent: 'Max', type: 'task', order: 2 },
  { id: 'review', title: 'PM-Abnahme', agent: 'PM', type: 'review', order: 3 },
], [pm, coder, coderTwo, tester]);
assert.deepEqual(distributedDeveloperTasks.slice(0, 3).map(task => task.agent), ['Max', 'Alex', 'Max']);
assert.equal(distributedDeveloperTasks[1].requestedAgentName, 'Max');
assert.equal(distributedDeveloperTasks[3].agent, 'PM');
const parallelRolePlan = orchestration.extractTaskPlan([
  '[[TASK_PLAN]]',
  '{"tasks":[',
  '{"id":"frontend","title":"Frontend-Modul erstellen","agent":"Max","type":"task","dependsOn":[]},',
  '{"id":"backend","title":"Backend-Modul erstellen","agent":"Max","type":"task","dependsOn":[]}',
  ']}',
  '[[/TASK_PLAN]]',
].join('\n'));
const parallelRoleTasks = orchestration.distributeTaskPlanAcrossAgentPools(parallelRolePlan.tasks, [pm, coder, coderTwo, tester])
  .map(task => {
    const assigned = [coder, coderTwo].find(agent => agent.name === task.agent);
    return { ...task, agentId: assigned.id, agentName: assigned.name };
  });
assert.deepEqual(parallelRoleTasks.map(task => task.agentName), ['Max', 'Alex']);
let rolePoolGraph = taskGraph.upsertTaskNode(taskGraph.createTaskGraph('role-pool'), {
  id: 'role-root', title: 'Planung', agentId: pm.id, agentName: pm.name, status: 'completed', source: 'user',
});
rolePoolGraph = taskGraph.materializeTaskPlan(rolePoolGraph, { rootNodeId: 'role-root', tasks: parallelRoleTasks });
const rolePoolTaskIds = rolePoolGraph.nodes.filter(node => node.planTaskId).map(node => node.id);
assert.equal(taskGraph.validateParallelSelection(rolePoolGraph, rolePoolTaskIds).ok, true);
assert.deepEqual(taskGraph.findSafeAutoParallelTaskIds(
  rolePoolGraph,
  rolePoolTaskIds.map(graphNodeId => ({ graphNodeId })),
), rolePoolTaskIds);
assert.equal(orchestration.shouldCompleteProject({ isOrchestrator: true, source: 'user', reply: artifactReply, handoffCount: 0, pendingTaskCount: 0, asksUser: false }), true);
assert.equal(orchestration.shouldCompleteProject({ isOrchestrator: true, source: 'team-synthesis', reply: 'Alles erledigt.', handoffCount: 0, pendingTaskCount: 0, asksUser: false }), true);
assert.equal(orchestration.shouldCompleteProject({ isOrchestrator: true, source: 'team-synthesis', reply: 'Noch offen', handoffCount: 1, pendingTaskCount: 1, asksUser: false }), false);
assert.equal(orchestration.shouldCompleteProject({ isOrchestrator: true, source: 'team-synthesis', reply: 'Alles erledigt. [[PROJECT_DONE]]', handoffCount: 0, pendingTaskCount: 0, asksUser: false, acceptanceReady: false }), false);
const projectPrompt = orchestration.buildIsolatedSystemPrompt({
  agent: pm, groupName: 'Dev Team', groupAgentNames: ['PM', 'Max'], memoryNamespace: 'dev-team',
  groupAgents: [pm, coder, coderTwo],
  projectPath: 'C:/projects/demo', isOrchestrator: true,
});
assert.match(projectPrompt, /````file:relativer\/pfad\.ext/);
assert.match(projectPrompt, /\[\[PROJECT_DONE\]\]/);
assert.match(projectPrompt, /unabhängigen Review[\s\S]*vollständig entschieden und belegt/);
assert.match(projectPrompt, /Ist noch etwas offen/);
assert.match(projectPrompt, /keine zusätzlichen README-/);
assert.match(projectPrompt, /AUFGABENPLAN/);
assert.match(projectPrompt, /\[\[TASK_PLAN\]\]/);
assert.match(projectPrompt, /acceptanceCriteria[\s\S]*reviewer-Kriterien noch unentschieden/);
assert.match(projectPrompt, /Max \(Developer\)/);
assert.match(projectPrompt, /Rollenpool mit mindestens zwei Agenten/);
assert.match(projectPrompt, /gemeinsamen Arbeitsbereich freigegeben/);
assert.match(projectPrompt, /Verändere niemals \.git, \.svn oder node_modules/);
const planningPrompt = orchestration.buildIsolatedSystemPrompt({
  agent: pm,
  groupName: 'Dev Team',
  groupAgents: [pm, coder, coderTwo],
  isOrchestrator: true,
  planningMode: true,
});
assert.match(planningPrompt, /PM im Planungsmodus/);
assert.match(planningPrompt, /Rückfrage[\s\S]*eigenen Zeile mit "@user" beginnen/);
assert.doesNotMatch(planningPrompt, /keine @Agent- oder @user-Zeilen/);
assert.match(planningPrompt, /ausschließlich über den UI-Button/);
assert.doesNotMatch(planningPrompt, /gemeinsamen Arbeitsbereich freigegeben/);
const userOwnedPlanningPrompt = orchestration.buildIsolatedSystemPrompt({
  agent: pm,
  groupName: 'Dev Team',
  groupAgents: [pm, coder, coderTwo],
  isOrchestrator: true,
  planningMode: true,
  userOwnedWorkflow: true,
});
assert.match(userOwnedPlanningPrompt, /PLANUNGSMODUS/);
assert.match(userOwnedPlanningPrompt, /nicht mehr benötigte oder fehlerhafte Aufgaben entfernen/);
assert.match(userOwnedPlanningPrompt, /Entwurf enthält Entscheidungen des Users/);
assert.match(userOwnedPlanningPrompt, /vollständigen Workflow als gültigen \[\[TASK_PLAN\]\]-Block/);
assert.match(userOwnedPlanningPrompt, /Rückfrage[\s\S]*"@user" beginnen/);
const userOwnedPmPrompt = orchestration.buildIsolatedSystemPrompt({
  agent: pm,
  groupName: 'Dev Team',
  groupAgents: [pm, coder, coderTwo],
  isOrchestrator: true,
  userOwnedWorkflow: true,
});
assert.match(userOwnedPmPrompt, /VERBINDLICHER USER-PLAN/);
assert.match(userOwnedPmPrompt, /Delegiere keine neue Arbeit/);
assert.match(userOwnedPmPrompt, /Nur der User kann/);
const userOwnedSpecialistPrompt = orchestration.buildIsolatedSystemPrompt({
  agent: coder,
  groupName: 'Dev Team',
  groupAgents: [pm, coder, coderTwo],
  userOwnedWorkflow: true,
});
assert.match(userOwnedSpecialistPrompt, /frage den PM oder User/);
assert.match(userOwnedSpecialistPrompt, /verändere den Plan nicht/);
const sharedProjectFileContext = orchestration.buildSharedProjectFileContext({
  agentName: 'Max',
  projectFiles: [
    { filename: 'src/sort.js', content: 'export const sort = values => values;\n' },
    { filename: 'src/unsaved.js', content: 'nicht freigegeben\n' },
  ],
  savedProjectFiles: ['src\\sort.js'],
});
assert.match(sharedProjectFileContext, /Max/);
assert.match(sharedProjectFileContext, /src\/sort\.js/);
assert.match(sharedProjectFileContext, /export const sort/);
assert.doesNotMatch(sharedProjectFileContext, /unsaved/);
assert.match(orchestration.buildSharedProjectFileContext({
  projectFiles: [{ filename: 'large.txt', content: 'x'.repeat(100) }],
  savedProjectFiles: ['large.txt'],
  maxCharactersPerFile: 20,
}), /nach 20 von 100 Zeichen gekürzt/);
const directChatPrompt = orchestration.buildIsolatedSystemPrompt({
  agent: coder,
  groupName: coder.name,
  groupAgents: [coder],
  isDirectChat: true,
});
assert.match(directChatPrompt, /direkten Einzelchat/);
assert.match(directChatPrompt, /kein PM vorgeschaltet/);
assert.match(directChatPrompt, /Antworte unmittelbar selbst/);
assert.doesNotMatch(directChatPrompt, /Du bist der Orchestrator/);
assert.doesNotMatch(directChatPrompt, /VERBINDLICHER USER-PLAN/);

const memoryStore = new Map();
const localMemoryRuntime = require(path.join(root, 'electron/memory-local.js'));
const queuedLocalMemoryOperation = localMemoryRuntime.createLocalMemoryOperationQueue({
  get: key => memoryStore.get(key),
  set: (key, value) => memoryStore.set(key, value),
});
globalThis.window = {
  electronAPI: {
    appStateGet: async key => memoryStore.get(key),
    appStateSet: async (key, value) => memoryStore.set(key, value),
    memoryLocalOperation: params => queuedLocalMemoryOperation(params),
  },
};
const memory = await importSource('src/memory-provider.js');
const sharedA = memory.getMemoryAPI({ provider: 'local', namespace: 'shared-project' });
const sharedB = memory.getMemoryAPI({ provider: 'local', namespace: 'shared-project' });
await sharedA.clear('shared-project');
await sharedA.clear('cross-group-memory-test');
const observedMemoryChanges = [];
const unsubscribeMemoryChanges = sharedB.subscribe(change => observedMemoryChanges.push(change));
const localMemoryEntry = memory.createEntry({
  type: 'decision', namespace: 'shared-project', content: 'PostgreSQL verwenden', tags: ['database'], author: 'PM',
});
await sharedA.write('shared-project', localMemoryEntry);
assert.equal(observedMemoryChanges.at(-1).type, 'write');
assert.equal(observedMemoryChanges.at(-1).namespace, 'shared-project');
assert.equal((await sharedB.list('shared-project')).length, 1);
assert.equal((await sharedB.search('shared-project', 'PostgreSQL', 5))[0].type, 'decision');
const crossGroupMemoryEntry = memory.createCrossGroupResultEntry({
  namespace: 'cross-group-memory-test',
  requestId: 'request-42',
  requestKind: 'task_delegation',
  question: 'Welche Architektur ist freigegeben?',
  answer: 'Die modulare Architektur ist geprüft.',
  sourceGroupId: 'dev',
  sourceGroupName: 'Dev',
  targetGroupId: 'tech',
  targetGroupName: 'Tech',
  sourceTaskId: 'task-1',
  sourceTaskTitle: 'Architektur klären',
  author: 'Tech PM',
});
assert.equal((await sharedA.writeOnce('cross-group-memory-test', crossGroupMemoryEntry)).created, true);
assert.equal((await sharedB.writeOnce('cross-group-memory-test', crossGroupMemoryEntry)).created, false);
assert.equal((await sharedA.list('cross-group-memory-test')).length, 1);
assert.equal(crossGroupMemoryEntry.provenance.requestId, 'request-42');
await Promise.all([
  sharedA.write('parallel-project', memory.createEntry({
    type: 'finding', namespace: 'parallel-project', content: 'Parallel A', tags: ['parallel'], author: 'Max',
  })),
  sharedB.write('parallel-project', memory.createEntry({
    type: 'finding', namespace: 'parallel-project', content: 'Parallel B', tags: ['parallel'], author: 'Lisa',
  })),
]);
assert.equal((await sharedA.list('parallel-project')).length, 2);
await sharedA.handoff('shared-project', {
  from: 'Max', to: 'Lisa', taskId: 'task-shared', summary: 'Bitte Ergebnis prüfen.', findings: ['A'],
});
assert.equal(observedMemoryChanges.at(-1).entry.type, 'handoff');
await sharedA.handoff('shared-project', {
  from: 'Tom', to: 'Max', taskId: 'task-max', summary: 'Prüfung nur für Max.', findings: ['C'],
});
await sharedA.handoff('other-project', {
  from: 'Tom', to: 'Lisa', taskId: 'task-other', summary: 'Andere Gruppe', findings: ['B'],
});
const lisaSharedContext = await sharedB.getContextForAgent('shared-project', 'Prüfung', 'Lisa', 5);
assert.match(lisaSharedContext, /Bitte Ergebnis prüfen/);
assert.doesNotMatch(lisaSharedContext, /Prüfung nur für Max/);
assert.doesNotMatch(lisaSharedContext, /Andere Gruppe/);
assert.equal(memoryStore.has('memspace:_handoff_Lisa'), false);
assert.deepEqual(await sharedB.delete('shared-project', localMemoryEntry.id), { ok: true, deleted: true });
assert.equal(observedMemoryChanges.at(-1).type, 'delete');
assert.deepEqual((await sharedA.list('shared-project')).map(entry => entry.type), ['handoff', 'handoff']);
assert.deepEqual(await sharedB.delete('shared-project', localMemoryEntry.id), { ok: false, deleted: false });
await sharedB.clear('shared-project');
assert.equal(observedMemoryChanges.at(-1).type, 'clear');
const observedBeforeUnsubscribe = observedMemoryChanges.length;
unsubscribeMemoryChanges();
await sharedB.clear('parallel-project');
await sharedB.clear('other-project');
await sharedB.clear('cross-group-memory-test');
assert.equal(observedMemoryChanges.length, observedBeforeUnsubscribe);
assert.equal((await sharedA.list('shared-project')).length, 0);

const chatAttachments = require(path.join(root, 'electron/chat-attachments.js'));
const tempAttachmentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-attachments-'));
try {
  const sourceDir = path.join(tempAttachmentDir, 'sources');
  const attachmentRoot = path.join(tempAttachmentDir, 'stored');
  await fs.mkdir(sourceDir, { recursive: true });
  const sourceFiles = {
    markdown: path.join(sourceDir, 'notes.md'),
    text: path.join(sourceDir, 'data.json'),
    image: path.join(sourceDir, 'pixel.png'),
    pdf: path.join(sourceDir, 'brief.pdf'),
    binary: path.join(sourceDir, 'archive.custombin'),
  };
  await fs.writeFile(sourceFiles.markdown, '# Anforderung\nDateiinhalt', 'utf8');
  await fs.writeFile(sourceFiles.text, '{"enabled":true}', 'utf8');
  await fs.writeFile(sourceFiles.image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', 'base64'));
  await fs.writeFile(sourceFiles.pdf, Buffer.from('%PDF-1.4\n%%EOF', 'utf8'));
  await fs.writeFile(sourceFiles.binary, Buffer.from([0, 1, 2, 3, 255]));

  const saved = chatAttachments.savePickedAttachments({
    sourcePaths: Object.values(sourceFiles), attachmentRoot,
    root: attachmentRoot,
    chatId: 'attachment-chat',
  });
  assert.deepEqual(saved.errors, []);
  assert.deepEqual(saved.attachments.map(item => item.kind), ['markdown', 'text', 'image', 'pdf', 'file']);
  assert.equal(saved.attachments.find(item => item.kind === 'markdown').content.includes('Dateiinhalt'), true);
  assert.equal(await fs.readFile(sourceFiles.markdown, 'utf8'), '# Anforderung\nDateiinhalt');

  const openAIPrepared = chatAttachments.prepareApiMessages({
    messages: [{ role: 'user', content: 'Bitte auswerten.' }],
    attachments: saved.attachments,
    root: attachmentRoot,
    provider: 'openai',
  });
  const openAIParts = openAIPrepared.messages[0].content;
  assert.equal(openAIParts.filter(part => part.type === 'image_url').length, 1);
  assert.deepEqual(openAIParts.filter(part => part.type === 'file').map(part => part.file.filename), ['brief.pdf', 'archive.custombin']);
  assert.match(openAIParts.find(part => part.type === 'text').text, /notes\.md/);

  const anthropicPrepared = chatAttachments.prepareApiMessages({
    messages: [{ role: 'user', content: 'Bitte auswerten.' }],
    attachments: saved.attachments,
    root: attachmentRoot,
    provider: 'anthropic',
  });
  assert.equal(anthropicPrepared.messages[0].content.filter(part => part.type === 'image').length, 1);
  assert.equal(anthropicPrepared.messages[0].content.filter(part => part.type === 'document').length, 1);
  assert.match(anthropicPrepared.messages[0].content.find(part => part.type === 'text').text, /archive\.custombin/);
  assert.match(chatAttachments.attachmentData(saved.attachments.find(item => item.kind === 'image'), attachmentRoot).dataUrl, /^data:image\/png;base64,/);
  assert.throws(() => chatAttachments.validateStoredAttachment({ path: sourceFiles.markdown, name: 'notes.md' }, attachmentRoot), /Ungültiger Anhangspfad/);
  chatAttachments.clearChatAttachments('attachment-chat', attachmentRoot);
  await assert.rejects(() => fs.access(saved.attachments[0].path));
} finally {
  await fs.rm(tempAttachmentDir, { recursive: true, force: true });
}

const memoryFiles = require(path.join(root, 'electron/memory-file.js'));
const tempMemoryDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-memory-'));
try {
  const memoryPath = path.join(tempMemoryDir, 'shared.memory.json');
  const secondMemoryPath = path.join(tempMemoryDir, 'other.memory.json');
  memoryFiles.ensureMemoryFile(memoryPath, 'shared-project');
  memoryFiles.ensureMemoryFile(secondMemoryPath, 'shared-project');
  globalThis.window.electronAPI.memoryFileOperation = async params => memoryFiles.operateMemoryFile(params);

  const fileMemory = memory.getMemoryAPI({ provider: 'file', filePath: memoryPath });
  const otherFileMemory = memory.getMemoryAPI({ provider: 'file', filePath: secondMemoryPath });
  const fileEntry = memory.createEntry({
    type: 'finding', namespace: 'shared-project', content: 'Datei-Memory funktioniert', tags: ['json'], author: 'Lisa',
  });
  await fileMemory.write('shared-project', fileEntry);
  const fileCrossGroupEntry = memory.createCrossGroupResultEntry({
    namespace: 'shared-project',
    requestId: 'file-request-42',
    question: 'Welche Datei gilt?',
    answer: 'Die freigegebene JSON-Datei gilt.',
    sourceGroupId: 'source',
    sourceGroupName: 'Source',
    targetGroupId: 'target',
    targetGroupName: 'Target',
  });
  assert.equal((await fileMemory.writeOnce('shared-project', fileCrossGroupEntry)).created, true);
  assert.equal((await fileMemory.writeOnce('shared-project', fileCrossGroupEntry)).created, false);
  await fileMemory.write('second-space', memory.createEntry({
    type: 'fact', namespace: 'second-space', content: 'Getrennter Namespace', tags: ['separate'], author: 'PM',
  }));
  assert.equal((await fileMemory.search('shared-project', 'funktioniert', 5))[0].id, fileEntry.id);
  assert.equal((await fileMemory.list('second-space')).length, 1);
  assert.equal((await otherFileMemory.list('shared-project')).length, 0);
  assert.equal((await fileMemory.update('shared-project', fileEntry.id, { confidence: 'high' })).confidence, 'high');
  await fileMemory.handoff('shared-project', {
    from: 'Max', to: 'Lisa', taskId: 'file-handoff', summary: 'Dateiübergabe prüfen.', findings: ['JSON'],
  });
  const fileLisaContext = await fileMemory.getContextForAgent('shared-project', 'ohne Treffer', 'Lisa', 5);
  assert.match(fileLisaContext, /Dateiübergabe prüfen/);
  assert.equal((await otherFileMemory.list('shared-project')).length, 0);

  const storedMemory = JSON.parse(await fs.readFile(memoryPath, 'utf8'));
  assert.equal(storedMemory.format, 'agent-teams-memory');
  assert.equal(storedMemory.version, 1);
  assert.deepEqual(Object.keys(storedMemory.namespaces).sort(), ['second-space', 'shared-project']);
  assert.deepEqual(await fileMemory.delete('shared-project', fileEntry.id), { ok: true, deleted: true });
  assert.equal((await fileMemory.list('shared-project')).length, 2);
  assert.deepEqual(await fileMemory.delete('shared-project', fileEntry.id), { ok: false, deleted: false });
  await fileMemory.clear('shared-project');
  assert.equal((await fileMemory.list('shared-project')).length, 0);

  const legacyPath = path.join(tempMemoryDir, 'legacy.json');
  await fs.writeFile(legacyPath, JSON.stringify([fileEntry]), 'utf8');
  memoryFiles.ensureMemoryFile(legacyPath, 'legacy-space');
  assert.equal(memoryFiles.operateMemoryFile({ filePath: legacyPath, action: 'list', namespace: 'legacy-space' }).length, 1);
  assert.throws(() => memoryFiles.ensureMemoryFile(path.join(tempMemoryDir, 'memory.txt'), 'shared'), /\.json/);
} finally {
  await fs.rm(tempMemoryDir, { recursive: true, force: true });
}

const claude = require(path.join(root, 'electron/claude-main.js'));
assert.equal(claude.resolveClaudeCommand({
  platform: 'win32',
  homeDir: 'C:\\Users\\Example',
  env: {},
  existsSync: candidate => candidate === path.win32.join('C:\\Users\\Example', '.local', 'bin', 'claude.exe'),
}), path.win32.join('C:\\Users\\Example', '.local', 'bin', 'claude.exe'));
assert.equal(claude.resolveClaudeCommand({
  platform: 'win32', homeDir: 'C:\\Users\\Example', env: {}, existsSync: () => false,
}), 'claude.exe');
assert.equal(claude.resolveClaudeCommand({ platform: 'linux' }), 'claude');
assert.equal(claude.fallbackModelFor('claude-opus-4-5'), 'sonnet');
assert.equal(claude.fallbackModelFor('claude-sonnet-4-5'), null);
assert.equal(claude.isClaudeRateLimitMessage('You have hit your usage limit'), true);
assert.equal(claude.isClaudeRateLimitMessage("You've hit your session limit · resets 2am (Europe/Berlin)"), true);
assert.equal(claude.parseClaudeResult('{"type":"result","result":"ok"}').result, 'ok');
assert.equal(claude.cancelClaudeRun('nicht-vorhanden').ok, false);
const claudeAttachmentPath = path.join(os.tmpdir(), 'attachment.bin');
const claudeAttachmentArgs = claude.buildClaudeArgs({ attachments: [{ kind: 'file', path: claudeAttachmentPath }] }).args;
assert.equal(claudeAttachmentArgs.includes('--add-dir'), true);
assert.equal(claudeAttachmentArgs.includes('Read'), true);
assert.equal(claudeAttachmentArgs.includes('Read,Write,Edit'), false);
const claudeProjectArgs = claude.buildClaudeArgs({ cwd: path.join(os.tmpdir(), 'shared-project') }).args;
assert.equal(claudeProjectArgs.includes('Read,Write,Edit'), true);
assert.equal(claudeProjectArgs.includes('Read,Edit(/**),Write(/**)'), true);
assert.equal(claudeProjectArgs.includes('dontAsk'), true);
const claudeProjectSettings = JSON.parse(claudeProjectArgs[claudeProjectArgs.indexOf('--settings') + 1]);
assert.equal(claudeProjectSettings.permissions.deny.includes('Write(/.git/**)'), true);
assert.equal(claudeProjectSettings.permissions.deny.includes('Edit(/node_modules/**)'), true);
assert.equal(claudeProjectArgs.includes('stream-json'), true);
assert.equal(claudeProjectArgs.includes('--include-partial-messages'), true);
const claudeSessionArgs = claude.buildClaudeArgs({ sessionId: '00000000-0000-4000-8000-000000000001' }).args;
assert.deepEqual(claudeSessionArgs.slice(-2), ['--session-id', '00000000-0000-4000-8000-000000000001']);
const claudeResumeArgs = claude.buildClaudeArgs({ sessionId: '00000000-0000-4000-8000-000000000001', resumeSession: true }).args;
assert.deepEqual(claudeResumeArgs.slice(-2), ['--resume', '00000000-0000-4000-8000-000000000001']);
assert.equal(claude.parseClaudeStreamEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hallo' } } }).delta, 'Hallo');
assert.match(claude.buildClaudePrompt({ systemContent: 'System', merged: [], attachments: [{ kind: 'file', path: claudeAttachmentPath }] }), /attachment\.bin/);
const claudeStatus = await claude.getClaudeStatus();
assert.equal(typeof claudeStatus.installed, 'boolean');
assert.equal(typeof claudeStatus.connected, 'boolean');

const llmMain = require(path.join(root, 'electron/llm-main.js'));
assert.equal(llmMain.normalizeConversationLanguage('en'), 'en');
assert.equal(llmMain.normalizeConversationLanguage('invalid'), 'de');
assert.match(llmMain.buildResponseLanguageInstruction('en'), /every user-visible sentence in English/);
assert.match(llmMain.buildResponseLanguageInstruction('de'), /sichtbaren Satz auf Deutsch/);
assert.equal(llmMain.parseRetryAfterMs({ 'retry-after': '2' }, 0), 2000);
assert.equal(llmMain.parseRetryAfterMs({ 'retry-after': 'Thu, 01 Jan 1970 00:00:03 GMT' }, 1000), 2000);
const providerRuntime = require(path.join(root, 'electron/provider-config.js'));
const providerRequests = [];
const providerServer = http.createServer((request, response) => {
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const parsed = JSON.parse(body || '{}');
    providerRequests.push({ url: request.url, headers: request.headers, body: parsed });
    response.setHeader('content-type', 'text/event-stream');
    if (request.url.endsWith('/chat/completions')) {
      response.end('data: {"choices":[{"delta":{"content":"OpenAI-kompatibel"}}]}\n\ndata: {"choices":[{"delta":{"content":"\\nOK"}}]}\n\ndata: [DONE]\n\n');
    } else if (request.url.endsWith('/messages')) {
      response.end('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Anthropic-kompatibel OK"}}\n\n');
    } else {
      response.end('data: {"candidates":[{"content":{"parts":[{"text":"Gemini OK"}]}}]}\n\n');
    }
  });
});
await new Promise(resolve => providerServer.listen(0, '127.0.0.1', resolve));
try {
  const providerPort = providerServer.address().port;
  const base = `http://127.0.0.1:${providerPort}`;
  const providerProgress = [];
  const openAIResult = await llmMain.callConfiguredProvider({
    connection: providerRuntime.normalizeProviderConnection({
      id: 'api-openai-fixture', name: 'Fixture OpenAI', protocol: 'openai', baseUrl: `${base}/v1`, models: ['fixture-model'],
    }),
    apiKey: 'fixture-openai-key', model: 'fixture-model', systemContent: 'System', messages: [{ role: 'user', content: 'Hallo' }],
    onProgress: progress => providerProgress.push(progress),
  });
  const anthropicResult = await llmMain.callConfiguredProvider({
    connection: providerRuntime.normalizeProviderConnection({
      id: 'api-anthropic-fixture', name: 'Fixture Anthropic', protocol: 'anthropic', baseUrl: `${base}/v1`, models: ['fixture-model'],
    }),
    apiKey: 'fixture-anthropic-key', model: 'fixture-model', systemContent: 'System', messages: [{ role: 'user', content: 'Hallo' }],
    onProgress: progress => providerProgress.push(progress),
  });
  const geminiResult = await llmMain.callConfiguredProvider({
    connection: providerRuntime.normalizeProviderConnection({
      id: 'api-gemini-fixture', name: 'Fixture Gemini', protocol: 'gemini', baseUrl: `${base}/v1beta`, models: ['gemini-test'],
    }),
    apiKey: 'fixture-gemini-key', model: 'gemini-test', systemContent: 'System', messages: [{ role: 'user', content: 'Hallo' }],
    onProgress: progress => providerProgress.push(progress),
  });
  assert.equal(openAIResult.text, 'OpenAI-kompatibel\nOK');
  assert.equal(anthropicResult.text, 'Anthropic-kompatibel OK');
  assert.equal(geminiResult.text, 'Gemini OK');
  assert.equal(providerRequests.every(request => request.body.stream !== false), true);
  assert.equal(providerProgress.filter(progress => progress.phase === 'streaming').length >= 3, true);
  assert.equal(providerProgress.some(progress => progress.partialText === 'OpenAI-kompatibel\nOK'), true);
  assert.equal(providerRequests[0].headers.authorization, 'Bearer fixture-openai-key');
  assert.equal(providerRequests[1].headers['x-api-key'], 'fixture-anthropic-key');
  assert.equal(providerRequests[2].headers['x-goog-api-key'], 'fixture-gemini-key');
  assert.match(providerRequests[2].url, /models\/gemini-test:streamGenerateContent\?alt=sse$/);
} finally {
  await new Promise(resolve => providerServer.close(resolve));
}
const projectFiles = require(path.join(root, 'electron/project-files.js'));
const tempProject = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-teams-smoke-'));
try {
  const sourceWrite = projectFiles.writeProjectFile({ projectPath: tempProject, filename: 'src/app.js', content: "console.log('ok');\n" });
  assert.equal(sourceWrite.success, true);
  assert.equal(await fs.readFile(path.join(tempProject, 'src/app.js'), 'utf8'), "console.log('ok');\n");
  assert.match(projectFiles.writeProjectFile({ projectPath: tempProject, filename: '../escape.txt', content: 'no' }).error, /innerhalb/);
  assert.match(projectFiles.writeProjectFile({ projectPath: tempProject, filename: '.git/config', content: 'no' }).error, /Geschützter/);
  assert.equal(projectFiles.writeProjectFile({ projectPath: tempProject, filename: '.agent-teams/progress/run.md', content: 'progress' }).success, true);
  const listed = projectFiles.listProjectFiles({ projectPath: tempProject }).files.map(file => file.name.replace(/\\/g, '/'));
  assert.deepEqual(listed, ['src/app.js']);
} finally {
  await fs.rm(tempProject, { recursive: true, force: true });
}

const codex = require(path.join(root, 'electron/codex-main.js'));
const codexAppServer = require(path.join(root, 'electron/codex-app-server.js'));
assert.equal(codex.resolveCodexCommand({ platform: 'linux' }), 'codex');
assert.equal(codex.resolveCodexCommand({
  platform: 'win32',
  env: { LOCALAPPDATA: 'C:\\Users\\Fixture\\AppData\\Local' },
  homeDir: 'C:\\Users\\Fixture',
  existsSync: candidate => candidate.endsWith('OpenAI\\Codex\\bin\\codex.exe'),
}), 'C:\\Users\\Fixture\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe');
assert.equal(codex.resolveCodexCommand({ platform: 'win32', env: {}, homeDir: '', existsSync: () => false }), 'codex.exe');
assert.deepEqual(codex.codexImageArgs([{ kind: 'image', path: 'C:/tmp/image.png' }, { kind: 'file', path: 'C:/tmp/data.bin' }]), ['--image', 'C:/tmp/image.png']);
assert.match(codex.buildCodexPrompt({ systemContent: 'System', merged: [], attachments: [{ kind: 'file', path: 'C:/tmp/data.bin' }] }), /data\.bin/);
assert.doesNotMatch(codex.buildCodexResumePrompt({ merged: [{ role: 'user', content: 'Nur das Delta' }] }), /System/);
assert.match(codex.buildCodexResumePrompt({ merged: [{ role: 'user', content: 'Nur das Delta' }] }), /Nur das Delta/);
assert.equal(codex.normalizeCodexReasoningEffort('HIGH'), 'high');
assert.equal(codex.normalizeCodexReasoningEffort('invalid'), 'medium');
assert.equal(codex.sessionIdFromCodexEvent({ type: 'thread.started', thread_id: 'thread-123' }), 'thread-123');
assert.equal(codex.isMissingCodexSessionError({ stderr: 'Thread not found: thread-123' }), true);
assert.equal(codex.isMissingCodexSessionError({ stderr: 'Task failed because npm test failed' }), false);
assert.deepEqual(codexAppServer.buildAppServerInput('Hallo', [
  { kind: 'image', path: 'C:/tmp/image.png' },
  { kind: 'file', path: 'C:/tmp/data.bin' },
]), [
  { type: 'text', text: 'Hallo' },
  { type: 'localImage', path: 'C:/tmp/image.png' },
]);
assert.deepEqual(codexAppServer.appServerItemProgress({ type: 'commandExecution', command: 'npm test' }, false), {
  phase: 'command', message: 'Befehl läuft: npm test',
});
assert.deepEqual(codexAppServer.appServerItemProgress({ type: 'commandExecution', exitCode: 0 }, true), {
  phase: 'command', message: 'Befehl erfolgreich abgeschlossen.',
});
const appServerProgress = [];
const appServerClient = new codexAppServer.CodexAppServerClient({
  command: process.execPath,
  args: [path.join(root, 'scripts/fixtures/codex-app-server.cjs')],
});
try {
  const appServerResult = await appServerClient.run({
    prompt: 'Hallo', requestId: 'fixture-run', onProgress: progress => appServerProgress.push(progress),
  });
  assert.equal(appServerResult.text, 'Hallo Codex');
  assert.equal(appServerResult.sessionId, 'thread-fixture');
  assert.equal(appServerResult.metrics.transport, 'app-server');
  assert.equal(appServerProgress.some(progress => progress.phase === 'streaming' && progress.partialText === 'Hallo Codex'), true);
} finally {
  appServerClient.stop();
}
const persistentCodexArgs = codex.buildCodexExecArgs({
  model: 'gpt-5.6-sol', cwd: 'C:/project', outputPath: 'C:/tmp/out.txt', reasoningEffort: 'low', persistSession: true,
});
assert.equal(persistentCodexArgs.resumed, false);
assert.equal(persistentCodexArgs.args.includes('--ephemeral'), false);
assert.ok(persistentCodexArgs.args.includes('model_reasoning_effort="low"'));
const resumedCodexArgs = codex.buildCodexExecArgs({
  model: 'gpt-5.6-sol', sessionId: 'thread-123', resumeSession: true, outputPath: 'C:/tmp/out.txt', reasoningEffort: 'high',
});
assert.equal(resumedCodexArgs.resumed, true);
assert.deepEqual(resumedCodexArgs.args.slice(0, 2), ['exec', 'resume']);
assert.ok(resumedCodexArgs.args.includes('thread-123'));
assert.ok(resumedCodexArgs.args.includes('model_reasoning_effort="high"'));
assert.deepEqual(codex.describeCodexEvent({ type: 'turn.started' }), {
  phase: 'analysis', message: 'Prüft Anforderungen und plant die nächsten Schritte.',
});
assert.deepEqual(codex.describeCodexEvent({
  type: 'item.started', item: { type: 'command_execution', command: 'npm test' },
}), {
  phase: 'command', message: 'Befehl läuft: npm test',
});
assert.deepEqual(codex.describeCodexEvent({
  type: 'item.completed', item: { type: 'error', message: 'Connection failed' },
}), {
  phase: 'error', message: 'Connection failed',
});
assert.equal(codex.cancelCodexRun('nicht-vorhanden').ok, false);
const codexStatus = await codex.getCodexStatus();
assert.equal(typeof codexStatus.installed, 'boolean');
assert.equal(typeof codexStatus.connected, 'boolean');
if (!codexStatus.connected) {
  const result = await codex.callCodexCLI({ systemContent: 'Test', merged: [], model: 'codex-default' });
  if (codexStatus.installed) {
    assert.equal(result.status, 401);
  } else {
    assert.match(result.error, /Codex CLI nicht gefunden/i);
  }
}

const { McpManager } = require(path.join(root, 'electron/mcp-manager.js'));
const mcpManager = new McpManager({ connectionTimeoutMs: 5000, requestTimeoutMs: 5000 });
const fixtureServer = {
  id: 'fixture-mcp', name: 'Fixture MCP', enabled: true, transport: 'stdio',
  command: process.execPath, args: [path.join(root, 'scripts/fixtures/mcp-test-server.cjs')],
};
try {
  const fixtureStatus = await mcpManager.testServer(fixtureServer);
  assert.equal(fixtureStatus.ok, true);
  assert.deepEqual(fixtureStatus.tools, ['echo']);
  const fixtureResult = await mcpManager.callTool(fixtureServer, 'echo', { value: 'integration' });
  assert.equal(fixtureResult.text, 'echo:integration');
} finally {
  await mcpManager.closeAll();
}

console.log(JSON.stringify({
  ok: true,
  checks: ['portable-workflow-import-export', 'cross-group-memory-writeback', 'no-artificial-agent-delay', 'safe-auto-parallel-batching', 'work-conserving-workflow-scheduler', 'lean-fast-mode', 'selective-project-tools', 'provider-neutral-streaming', 'resumable-cli-sessions', 'configurable-run-limits', 'pm-turn-limit-review', 'resumable-run-segments', 'agent-teams-window-branding', 'typing-agent-identity', 'always-focused-chat-composer', 'draft-while-agent-runs', 'persistent-user-request-queue', 'global-agent-role-catalog', 'legacy-agent-role-migration', 'routing', 'direct-chat-conversation-history', 'directed-group-context-window', 'direct-specialist-without-pm-review', 'explicit-memory-commands', 'manual-memory-entry', 'quality-cascade-policy', 'quality-deterministic-gates', 'quality-chat-controls', 'custom-provider-quality-cascade', 'direct-chat-without-pm', 'mixed-provider-routing', 'generic-provider-presets', 'encrypted-provider-credentials', 'provider-protocol-routing', 'claude-cli-oauth-routing', 'anthropic-api-key-routing', 'claude-rate-limit-metadata', 'retryable-provider-queue', 'retry-after-parsing', 'claude-opus-sonnet-fallback', 'claude-cli-status', 'claude-windows-native-path', 'group-output-folder-notice', 'browser-file-attachments', 'persistent-file-attachments', 'provider-native-file-payloads', 'cli-file-access', 'detached-singleton-task-window', 'memory-entry-delete-controls', 'multi-handoffs', 'strict-line-start-mentions', 'left-aligned-mention-layout', 'code-block-mention-isolation', 'direct-user-question-display', 'multi-turn-task-queue', 'direct-handoff-priority', 'deferred-pm-handoff', 'timeout-detection', 'immediate-pm-timeout-recovery', 'stepwise-timeout-review', 'persistent-conversation-checkpoint', 'interrupted-agent-checkpoint', 'resume-without-restarting-pm', 'short-agent-activity', 'pm-final-review-rules', 'pause-resume-user-handoff', 'persistent-task-graph', 'generic-acceptance-evidence-gate', 'initial-pm-plan-protocol', 'upfront-plan-materialization', 'planned-future-gating', 'dependency-readiness-guard', 'agent-role-pool-distribution', 'delegation-tree-hierarchy', 'dependency-cross-links', 'multi-result-review-placement', 'legacy-graph-tree-migration', 'agent-subtask-branching', 'graph-dependencies', 'parallel-selection-validation', 'parallel-batch-execution', 'parallel-file-conflict-guard', 'pm-task-approval', 'project-artifact-protocol', 'nested-markdown-artifact-fences', 'project-review-evidence', 'rephrased-file-task-loop-guard', 'persistent-loop-guard', 'safe-project-writes', 'project-completion-signal', 'task-capsules', 'isolated-sessions', 'shared-local-memory', 'shared-json-file-memory', 'versioned-memory-file', 'legacy-memory-file-migration', 'mcp-global-group-merge', 'mcp-official-excalidraw-preset', 'mcp-official-perplexity-preset', 'mcp-direct-chat-global-access', 'mcp-tool-permission-gate', 'mcp-global-tool-catalog', 'mcp-global-tool-policy', 'mcp-unknown-tool-asks', 'full-screen-settings', 'mcp-persistent-chat-grants', 'mcp-once-grant-consumed-on-invocation', 'mcp-timeout-keeps-pending-once-grant', 'mcp-permission-wording-recovery', 'mcp-neutral-json-planner', 'mcp-ui-result-short-circuit', 'mcp-denied-tool-path', 'mcp-app-tool-filtering', 'excalidraw-inline-preview', 'mcp-call-protocol', 'mcp-provider-neutral-tool-loop', 'mcp-stdio-integration', 'codex-progress-events', 'codex-cancel-routing', 'codex-status'],
  codex: codexStatus,
  claude: claudeStatus,
}, null, 2));
