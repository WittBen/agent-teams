import { runTaskPool } from './workflow-execution.mjs';
import { hasTaskResourceConflict } from './workflow-scheduling.mjs';
import { selectTaskAttachments } from '../electron/agent-context.mjs';
import { useCallback } from 'react';
import { uuidv4 } from './store.jsx';
import { callLLM } from './llm.js';
import { callLLMWithMcp } from './mcp.js';
import { assessTaskComplexity, runQualityCascade, usesNativeCli, evaluateResponseQuality, resolveQualityPolicy, resolveGroupAgent } from './quality-cascade.js';
import { addTaskEdge, applyAcceptanceDecisions, appendTaskRecoveryNote, approveAgentDoneTasks, findDependencyPreparationCandidateIds, findSafeAutoParallelTaskIds, inferHandoffDependency, inferTaskNodeType, isTaskNodeReady, materializeRuntimeRecoveryPlan, materializeTaskPlan, orderTasksForParallelSelection, recordTaskExecutionEvent, removePlanningTask, runTaskBatch, submitTaskEvidence, summarizeAcceptance, invalidateTaskRecoveryBranch, updateTaskNodeStatus, validateApprovedTaskExecution, workflowDependencyAncestorIds } from './task-graph.js';
import { extractKnowledgeFromReply } from './memory.js';
import { createEntry } from './memory-provider.js';
import { acquireAgentLease, codexReasoningEffortForTask, shouldEnableProjectTools } from './agent-runtime.js';
import { buildTaskTicketContext, compareTicketPriority } from './task-ticket.js';
import { createCrossGroupRequest, extractGroupMentions } from './cross-group.js';
import { evaluateTaskDelegation } from './delegation.js';
import { AgentTaskQueue, buildAgentSession, buildIsolatedSystemPrompt, buildProjectReviewEvidence, buildRelevantConversationHistory, buildRelevantProjectInventoryContext, buildTaskCapsule, buildTurnLimitReviewTask, buildTimeoutRecoveryReviewTask, buildTimeoutRecoveryTask, buildUserAnswerTask, cleanAgentReply, createHandoff, distributeTaskPlanAcrossAgentPools, extractAcceptanceReview, extractHandoffsFromReply, extractProjectFiles, extractRecoveryPlan, extractTaskPlan, extractStreamingTaskPlan, extractTaskEvidence, extractUserQuestions, getGroupPMAgent, hasDirectedMention, hasUserDirectedMention, isAgentTimeoutError, MAX_PM_RECOVERY_ATTEMPTS, normalizeAgentMentionLayout, orchestrate, shouldCompleteProject, shouldDeferHandoffToPM, shouldMaterializeTaskPlan, shouldRequestPMFinalReview, shouldRunAsWorkflowSideConversation, summarizeTaskActivity } from './orchestrator.js';
import { conversationContinuations, FINISHED_PLAN_STATUSES, CLAIMABLE_PLAN_STATUSES, buildRecoveryUserQuestion, buildDelegatedTaskQuestion, planTaskMatchScore, rewritePlanHandoffAssignments, formatAcceptanceContext } from './chat-workflow-helpers.mjs';
import { createMcpPlannerAgent } from './chat-workflow-helpers.mjs';

export function useConversationRunner({
  chat,
  language,
  t,
  agents,
  groups,
  conversationStates,
  addMessage,
  apiKeys,
  providerConnections,
  kbPath,
  enqueueCrossGroupRequest,
  mcpServers,
  conversationLimits,
  qualityRouting,
  recordQualityEvent,
  projectPath,
  chatAgents,
  setRunning,
  setTypingAgents,
  setLastRunContext,
  setStoppedForUser,
  setAgentProgress,
  claudeConversationSessionsRef,
  codexConversationSessionsRef,
  autoRunRef,
  runIdRef,
  activeAgentRunRef,
  taskGraphRef,
  reportedMcpErrorsRef,
  requestMcpPermission,
  handleMcpPermissionConsumed,
  handleMcpToolResult,
  memoryConfig,
  memoryEnabled,
  memoryAPI,
  activeMcpServers,
  reachableCrossGroupIds,
  refreshMemoryCount,
  persistConversationCheckpoint,
  discardConversationCheckpoint,
  commitTaskGraph,
  registerGraphTask,
  setGraphTaskStatus
}) {
  return useCallback(async (history, triggerText, options = {}) => {
    // Validate keys
    const neededProviders = new Set(chatAgents.map(a => a.provider || 'openai'));
    const missingProviders = [...neededProviders].filter(p => {
      if (p === 'codex') return false;
      if (p === 'anthropic') return (
        !apiKeys?.anthropic?.trim() &&
        !apiKeys?.anthropicConfigured &&
        !apiKeys?.claudeCli &&
        !(typeof process !== 'undefined' && process.env?.ANTHROPIC_API_KEY)
      );
      if (p === 'openai') return (
        !apiKeys?.openai?.trim() &&
        !apiKeys?.openaiConfigured &&
        !(typeof process !== 'undefined' && process.env?.OPENAI_API_KEY)
      );
      const connection = providerConnections.find(item => item.id === p);
      if (!connection) return true;
      return connection.requiresApiKey !== false && !apiKeys?.providerConfigured?.[p];
    });

    if (missingProviders.length === neededProviders.size) {
      addMessage(chat.id, {
        id: Date.now(), agentId: 'system', senderName: 'System',
        text: `⚠️|${t('Kein API-Key konfiguriert. Bitte in ⚙️ Einstellungen eintragen.')}`,
        ts: Date.now(), isError: true,
      });
      return;
    }

    if (chatAgents.length === 0) return;

    const persistedContinuation = conversationContinuations.get(chat.id) || conversationStates?.[chat.id] || null;
    const explicitMentions = chatAgents.filter(agent =>
      hasUserDirectedMention(triggerText || '', agent.name)
    );
    const sideConversation = shouldRunAsWorkflowSideConversation({
      chatType: chat.type,
      triggerText,
      chatAgents,
      continuation: persistedContinuation,
    });
    const savedContinuation = sideConversation ? null : persistedContinuation;
    const planningOnly = options.planningOnly === true || savedContinuation?.mode === 'planning';
    const restartPlanningFromScratch = planningOnly && taskGraphRef.current?.workflowResetRequired === true;
    const latestUserMessage = [...(history || [])].reverse().find(message => message?.agentId === 'user');
    const latestUserAttachments = latestUserMessage?.attachments || [];
    const activeQualityMode = triggerText
      ? (latestUserMessage?.qualityMode || 'auto')
      : (savedContinuation?.qualityMode || latestUserMessage?.qualityMode || 'auto');
    const attachmentKeys = new Set();
    let retainedGroupWaits = Array.isArray(savedContinuation?.waitingGroupTasks)
      ? [...savedContinuation.waitingGroupTasks]
      : [];
    let retainedDelegationWaits = Array.isArray(savedContinuation?.waitingDelegationTasks)
      ? [...savedContinuation.waitingDelegationTasks]
      : [];
    const activeAttachments = [...latestUserAttachments, ...(savedContinuation?.attachments || [])]
      .filter(attachment => {
        const key = attachment?.id || attachment?.path || attachment?.name;
        if (!key || attachmentKeys.has(key)) return false;
        attachmentKeys.add(key);
        return true;
      })
      .slice(0, 8);
    const persistRunCheckpoint = state => {
      if (sideConversation) return;
      persistConversationCheckpoint({
        ...state,
        ...(retainedGroupWaits.length > 0 ? { waitingGroupTasks: retainedGroupWaits } : { waitingGroupTasks: undefined }),
        ...(retainedDelegationWaits.length > 0
          ? { waitingDelegationTasks: retainedDelegationWaits }
          : { waitingDelegationTasks: undefined }),
        ...(planningOnly ? { mode: 'planning' } : {}),
        attachments: activeAttachments,
        qualityMode: activeQualityMode,
      });
    };
    const finishRunCheckpoint = () => {
      if (!sideConversation) discardConversationCheckpoint();
    };
    if (savedContinuation?.status === 'provider-limited' && savedContinuation.retryNotBefore > Date.now()) {
      const retrySeconds = Math.max(1, Math.ceil((savedContinuation.retryNotBefore - Date.now()) / 1000));
      if (triggerText && savedContinuation.pendingTasks?.length) {
        const pendingTasks = savedContinuation.pendingTasks.map((pendingTask, index) => index === 0
          ? {
            ...pendingTask,
            objective: `${pendingTask.objective || 'Setze die offene Aufgabe fort.'}\n\nZusätzliche Nachricht des Users: ${triggerText}`,
          }
          : pendingTask);
        persistRunCheckpoint({ ...savedContinuation, pendingTasks });
      }
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `⏳|${t('Claude ist noch begrenzt. Deine Nachricht wurde gespeichert; Fortsetzen ist in etwa {seconds}s möglich.', { seconds: retrySeconds })}`,
        ts: Date.now(), isError: false,
      });
      return;
    }

    setLastRunContext({ history, triggerText });
    setStoppedForUser(false);
    setRunning(true);

    // Cancel token: if a new run starts, the old one aborts after its current LLM call
    runIdRef.current += 1;
    const myRunId = runIdRef.current;

    // PM orchestration is a group-only concern. In direct chats even the PM
    // agent behaves like a normal one-to-one conversation partner.
    const isDirectChat = chat.type !== 'group';
    const pm = getGroupPMAgent(chat.type, chatAgents);

    // Helper: all explicitly mentioned group agents. The queue de-duplicates
    // them, so the orchestrator can activate exactly the needed specialists.
    const getMentionedAgents = (text) => {
      if (!text) return [];
      return chatAgents.filter(agent => hasDirectedMention(text, agent.name));
    };

    // Keep only a lightweight inventory here. KB and project context are
    // selected separately for each task, including parallel agent runs.
    let projectInventory = [];
    if (projectPath && window.electronAPI?.projectList) {
      const projectResult = await window.electronAPI.projectList({ projectPath });
      projectInventory = Array.isArray(projectResult?.files) ? projectResult.files : [];
    }

    // Load shared memory for this group (lazy — only top-N relevant entries)
    const memoryNamespace = memoryEnabled ? memoryConfig.namespace : null;
    const memAPI = memoryEnabled ? memoryAPI : null;

    // ── Chain-conversation engine ──────────────────────────────────────────
    const isEveryoneCall = hasUserDirectedMention(triggerText || '', 'everyone');
    let pendingAgents = [];

    const route = chat.type === 'group'
      ? orchestrate({ request: triggerText || '', chatAgents, isEveryone: isEveryoneCall, explicitMentions })
      : { agents: chatAgents.slice(0, 1), mode: 'direct-chat' };
    pendingAgents = route.agents;

    if (chat.type === 'group' && !isEveryoneCall && explicitMentions.length === 0 && pm) {
      // No mention → PM responds (but only if PM hasn't responded since last user message)
      const lastUserMsgIdx = [...history].reverse().findIndex(m => m.agentId === 'user');
      const msgsSinceUser = lastUserMsgIdx >= 0 ? history.slice(history.length - lastUserMsgIdx) : [];
      const pmAlreadyResponded = msgsSinceUser.some(m => m.agentId === pm.id);
      if (!pmAlreadyResponded) {
        pendingAgents = [pm];
      }
      // If PM already responded, check if there's a pending agent from last PM message
      else {
        const lastPMMsg = [...msgsSinceUser].reverse().find(m => m.agentId === pm.id);
        if (lastPMMsg?.text) {
          const pendingFromPM = getMentionedAgents(lastPMMsg.text).filter(a => {
            // Only trigger agents that haven't responded since last user message
            return !msgsSinceUser.some(m => m.agentId === a.id);
          });
          if (pendingFromPM.length) pendingAgents = pendingFromPM;
        }
      }
    }

    if (planningOnly && pm) pendingAgents = [pm];

    const initialObjective = savedContinuation?.initialObjective || triggerText ||
      [...history].reverse().find(message => message.agentId === 'user')?.text ||
      'Bearbeite die aktuelle Aufgabe.';
    const initialRunComplexity = assessTaskComplexity({
      objective: initialObjective,
      attachmentCount: activeAttachments.length,
    });
    const useLeanFastPath = chat.type === 'group' &&
      activeQualityMode === 'fast' &&
      initialRunComplexity.level === 'low' &&
      activeAttachments.length === 0 &&
      activeMcpServers.length === 0 &&
      pendingAgents.length <= 1;
    const taskQueue = new AgentTaskQueue({
      maxTurns: conversationLimits.maxTurns,
      maxTurnsPerAgent: conversationLimits.maxTurnsPerAgent,
      guardState: savedContinuation?.queueGuard,
    });
    const requestedParallelTaskIds = new Set(savedContinuation?.parallelTaskIds || []);
    let needsSynthesis = savedContinuation?.needsSynthesis || false;
    let synthesisCount = savedContinuation?.synthesisCount || 0;
    const delegatedResults = [...(savedContinuation?.delegatedResults || [])];
    const loopGuardRejections = [];
    let activePlanRootNodeId = savedContinuation?.planRootGraphNodeId || null;
    let planningDraftTasks = [...(savedContinuation?.pendingTasks || [])];

    if (planningOnly && pm) {
      const planningTask = registerGraphTask({
        agent: pm,
        objective: triggerText || initialObjective || 'Besprich und aktualisiere den Workflow mit dem User.',
        source: 'user',
        ...(activePlanRootNodeId ? { graphNodeId: activePlanRootNodeId } : {}),
      }, { status: 'queued' });
      activePlanRootNodeId = planningTask.graphNodeId;
      taskQueue.enqueue(planningTask);
    } else if (savedContinuation) {
      const restoreTask = (pendingTask) => {
        const restoredAgent = chatAgents.find(candidate =>
          candidate.id === pendingTask?.agent?.id || candidate.name === pendingTask?.agent?.name
        );
        return restoredAgent ? {
          ...pendingTask,
          agent: pendingTask.modelOverride
            ? { ...restoredAgent, model: pendingTask.modelOverride }
            : restoredAgent,
        } : null;
      };
      const restoredPendingTasks = orderTasksForParallelSelection((savedContinuation.pendingTasks || [])
        .map(restoreTask)
        .filter(Boolean), requestedParallelTaskIds);
      const awaitsUserAnswer = savedContinuation.status === 'awaiting-user' ||
        (!savedContinuation.status && savedContinuation.askingAgent);
      const awaitsGroupAnswer = Boolean(options.crossGroupBatchId) &&
        (savedContinuation.waitingGroupTasks || []).some(wait => wait.batchId === options.crossGroupBatchId);

      if (awaitsGroupAnswer) {
        const waitingGroupTasks = Array.isArray(savedContinuation.waitingGroupTasks)
          ? savedContinuation.waitingGroupTasks
          : [];
        const answeredBatchId = String(options.crossGroupBatchId || '');
        const answeredWaits = waitingGroupTasks.filter(wait => wait.batchId === answeredBatchId);
        retainedGroupWaits = waitingGroupTasks.filter(wait => wait.batchId !== answeredBatchId);
        if (!triggerText || !answeredBatchId || answeredWaits.length === 0) {
          setRunning(false);
          return;
        }
        for (const wait of answeredWaits) {
          const waitingTask = restoreTask(wait.task);
          if (!waitingTask) continue;
          const delegatedTaskResult = wait.kind === 'task_delegation';
          const savedInterim = String(wait.interimResult || '').trim();
          const answerTask = {
            ...waitingTask,
            objective: [
              waitingTask.objective || 'Setze die wartende Aufgabe fort.',
              savedInterim ? `Zwischengespeicherter Arbeitsstand vor der Rückfrage:\n${savedInterim.slice(0, 12000)}` : '',
              `${delegatedTaskResult ? 'Ergebnis der delegierten Ausführung' : 'Antwort der angefragten Gruppe(n)'}:\n${triggerText}`,
              'Setze auf diesem Arbeitsstand auf und wiederhole bereits erledigte Schritte nicht.',
            ].filter(Boolean).join('\n\n'),
            source: waitingTask.runtimeRecovery ? waitingTask.source : 'group-answer',
            approvedContinuation: true,
            delegatedTaskResult,
            crossGroupBatchId: answeredBatchId,
            crossGroupRequestIds: wait.requestIds || [],
          };
          registerGraphTask(answerTask, { status: 'queued' });
          taskQueue.enqueue(answerTask);
          if (answerTask.graphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(graph, answerTask.graphNodeId, 'queued', {
              groupAnsweredAt: Date.now(),
              waitingGroupNames: [],
              ...(savedInterim ? { interimResult: savedInterim, interimResumedAt: Date.now() } : {}),
              ...(delegatedTaskResult ? { delegationCompletedAt: Date.now() } : {}),
            }));
          }
        }
      } else if (awaitsUserAnswer) {
        if (!triggerText) {
          setStoppedForUser(true);
          setRunning(false);
          return;
        }
        const restoredAskingAgent = chatAgents.find(candidate =>
          candidate.id === savedContinuation.askingAgent?.id || candidate.name === savedContinuation.askingAgent?.name
        );
        if (restoredAskingAgent) {
          const answerTask = buildUserAnswerTask({
            askingAgent: restoredAskingAgent,
            question: savedContinuation.question,
            answer: triggerText,
          });
          const askingNode = savedContinuation.askingGraphNodeId
            ? taskGraphRef.current?.nodes?.find(node => node.id === savedContinuation.askingGraphNodeId)
            : null;
          if (taskGraphRef.current?.approvedPlan && askingNode) {
            answerTask.graphNodeId = askingNode.id;
            answerTask.planRootId = askingNode.planRootId;
            answerTask.planTaskId = askingNode.planTaskId;
            answerTask.approvedContinuation = true;
            if (askingNode.modelOverride || askingNode.model) answerTask.modelOverride = askingNode.modelOverride || askingNode.model;
            if (askingNode.runtimeRecovery && askingNode.recovery) {
              answerTask.source = askingNode.source === 'timeout-recovery-step'
                ? 'timeout-recovery-step'
                : 'timeout-recovery';
              answerTask.runtimeRecovery = true;
              answerTask.recovery = askingNode.recovery;
              // Runtime recovery nodes are intentionally outside the approved
              // contract but remain authorized through their original task.
              answerTask.modelOverride = undefined;
            }
          }
          registerGraphTask(answerTask, {
            status: 'queued',
            parentNodeId: answerTask.graphNodeId === savedContinuation.askingGraphNodeId
              ? null
              : savedContinuation.askingGraphNodeId || null,
          });
          taskQueue.enqueue(answerTask);
          if (savedContinuation.askingGraphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(
              graph,
              savedContinuation.askingGraphNodeId,
              answerTask.graphNodeId === savedContinuation.askingGraphNodeId ? 'queued' : 'agent_done',
              { answeredAt: Date.now() },
            ));
          }
        }
      } else if (triggerText && restoredPendingTasks.length > 0) {
        restoredPendingTasks[0] = {
          ...restoredPendingTasks[0],
          objective: `${restoredPendingTasks[0].objective || 'Setze die offene Aufgabe fort.'}\n\nZusätzliche Nachricht des Users beim Fortsetzen: ${triggerText}`,
        };
      }
      for (const pendingTask of restoredPendingTasks) {
        registerGraphTask(pendingTask, { status: pendingTask.graphNodeId ? undefined : 'queued' });
        taskQueue.enqueue(pendingTask);
      }
    } else {
      for (const agent of pendingAgents) {
        const taskDraft = {
          agent,
          objective: initialObjective,
          source: 'user',
          routeMode: route.mode,
          explicitMentionCount: explicitMentions.length,
          explicitlyAddressedAgentId: explicitMentions.length === 1 ? explicitMentions[0].id : null,
          outOfBand: sideConversation,
        };
        const initialTask = sideConversation
          ? taskDraft
          : registerGraphTask(taskDraft, { status: 'queued' });
        if (chat.type === 'group' && agent.id === pm?.id && !activePlanRootNodeId) {
          activePlanRootNodeId = initialTask.graphNodeId;
        }
        taskQueue.enqueue(initialTask);
      }
    }

    if (chat.type === 'group' && autoRunRef.current && requestedParallelTaskIds.size === 0) {
      const safeParallelIds = findSafeAutoParallelTaskIds(taskGraphRef.current, taskQueue.pendingTasks());
      safeParallelIds.forEach(nodeId => requestedParallelTaskIds.add(nodeId));
      taskQueue.prioritize(safeParallelIds);
    }

    let task;
    let successfulTasks = savedContinuation?.successfulTasks || 0;
    let projectCompleted = false;
    let resumableFailure = false;

    const executeAgentTask = async (task) => {
      if (['paused', 'pausing'].includes(taskGraphRef.current?.nodes?.find(node => node.id === task.graphNodeId)?.status)) {
        resumableFailure = true;
        return { task, agent: task.agent, taskPaused: true };
      }
      if (runIdRef.current !== myRunId) {
        return null;
      }

      const { agent } = task;
      const liveTaskNode = task.graphNodeId
        ? taskGraphRef.current?.nodes?.find(node => node.id === task.graphNodeId)
        : null;
      const mayRouteDelegation = Boolean(
        chat.type === 'group' &&
        taskGraphRef.current?.approvedPlan &&
        liveTaskNode &&
        inferTaskNodeType(liveTaskNode) === 'task' &&
        !task.outOfBand &&
        !task.runtimeRecovery &&
        !task.preparationOnly &&
        task.source !== 'group-answer'
      );
      if (mayRouteDelegation) {
        const delegationDecision = evaluateTaskDelegation({
          taskNode: liveTaskNode,
          sourceGroup: chat,
          groups,
          agents,
        });
        if (delegationDecision.action === 'delegate') {
          const candidate = delegationDecision.candidate;
          const targetGroup = groups.find(group => group.id === candidate.groupId);
          const targetAgent = agents.find(candidateAgent => candidateAgent.id === candidate.agentId);
          const targetAgents = (candidate.agentIds || [candidate.agentId])
            .map(agentId => agents.find(candidateAgent => candidateAgent.id === agentId))
            .filter(Boolean);
          const batchId = `task-delegation-batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const request = createCrossGroupRequest({
            sourceGroup: chat,
            sourceTask: task,
            sourceAgent: agent,
            targetGroup,
            targetAgent,
            targetAgents,
            question: buildDelegatedTaskQuestion(liveTaskNode, delegationDecision.policy),
            attachments: activeAttachments,
            batchId,
            origin: 'agent',
            kind: 'task_delegation',
            requiredCapabilities: delegationDecision.policy.requiredCapabilities,
            delegationReason: delegationDecision.reason,
            qualityMode: activeQualityMode,
          });
          if (request) {
            enqueueCrossGroupRequest(request);
            setGraphTaskStatus(task, 'waiting_group', {
              delegationKind: 'task',
              delegatedToGroupId: request.targetGroupId,
              delegatedToGroupName: request.targetGroupName,
              delegatedToAgentId: request.targetAgentId,
              delegatedToAgentName: request.targetAgentName,
              waitingGroupRequestIds: [request.id],
              groupWaitStartedAt: Date.now(),
            });
            commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'delegated', {
              requestId: request.id,
              targetGroupId: request.targetGroupId,
              targetAgentId: request.targetAgentId,
            }));
            addMessage(chat.id, {
              id: `task-delegation-${request.id}`,
              agentId: 'system',
              senderName: 'System',
              text: `⇄|${t('„{task}“ wird von {agent} in {group} ausgeführt. Unabhängige Aufgaben laufen parallel weiter.', {
                task: liveTaskNode.title,
                agent: request.targetAgentName,
                group: request.targetGroupName,
              })}`,
              ts: Date.now(),
              isError: false,
            });
            return {
              task,
              agent,
              groupPauseRequested: true,
              groupPauseRequests: [request],
              delegatedTask: true,
            };
          }
        }
        if (delegationDecision.action === 'ask') {
          const proposal = {
            id: `delegation-proposal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            taskId: liveTaskNode.id,
            taskTitle: liveTaskNode.title,
            requiredCapabilities: delegationDecision.policy.requiredCapabilities,
            candidate: delegationDecision.candidate,
            candidates: delegationDecision.candidates,
            createdAt: Date.now(),
          };
          setGraphTaskStatus(task, 'delegation_pending', { delegationProposal: proposal });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'delegation-proposed', {
            targetGroupId: proposal.candidate.groupId,
            targetAgentId: proposal.candidate.agentId,
          }));
          addMessage(chat.id, {
            id: proposal.id,
            agentId: 'system',
            senderName: 'System',
            text: `⇄|${t('Für „{task}“ gibt es lokal keinen passenden Experten. Delegation an {agent} in {group} hier oder im Workflow freigeben oder lokal ausführen.', {
              task: liveTaskNode.title,
              agent: proposal.candidate.agentName,
              group: proposal.candidate.groupName,
            })}`,
            ts: Date.now(),
            isError: false,
            delegationTaskId: liveTaskNode.id,
          });
          return { task, agent, delegationApprovalRequested: true, delegationProposal: proposal };
        }
        if (delegationDecision.action === 'unavailable') {
          setGraphTaskStatus(task, 'blocked', {
            blockedReason: 'delegation-no-target-expert',
            error: 'Keine freigeschaltete Zielgruppe deckt die benötigten Fähigkeiten semantisch ab.',
          });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'delegation-unavailable'));
          addMessage(chat.id, {
            id: `delegation-unavailable-${liveTaskNode.id}-${Date.now()}`,
            agentId: 'system',
            senderName: 'System',
            text: `⇄|${t('Für „{task}“ wurde in den erreichbaren Zielgruppen keine ausreichende Kompetenzabdeckung gefunden. Der Plan blieb unverändert.', { task: liveTaskNode.title })}`,
            ts: Date.now(),
            isError: true,
          });
          return { task, agent, delegationUnavailable: true };
        }
      }
      const configuredAgent = task.modelOverride
        ? { ...agent, model: task.modelOverride }
        : resolveGroupAgent(agent, chat.type === 'group' ? chat : null);
      const usesClaudeCli = configuredAgent.provider === 'anthropic' &&
        !apiKeys?.anthropic?.trim() && !apiKeys?.anthropicConfigured && apiKeys?.claudeCli;
      const conversationSessionKey = isDirectChat ? `${chat.id}:${agent.id}` : '';
      const rememberedSession = conversationSessionKey
        ? claudeConversationSessionsRef.current.get(conversationSessionKey)
        : null;
      const rememberedSessionMatchesModel = rememberedSession?.model === configuredAgent.model;
      if (usesClaudeCli && !task.cliSessionId) task.cliSessionId = rememberedSessionMatchesModel ? rememberedSession.sessionId : uuidv4();
      if (usesClaudeCli && rememberedSessionMatchesModel && rememberedSession?.started) {
        task.cliSessionStarted = true;
        task.cliSessionModel = configuredAgent.model;
      }
      const rememberedCodexSession = conversationSessionKey
        ? codexConversationSessionsRef.current.get(conversationSessionKey)
        : null;
      const persistedCodexSessionId = liveTaskNode?.codexSessionId || '';
      const persistedCodexSessionModel = liveTaskNode?.codexSessionModel || '';
      if (configuredAgent.provider === 'codex' && !task.codexSessionId) {
        if (rememberedCodexSession?.model === configuredAgent.model) {
          task.codexSessionId = rememberedCodexSession.sessionId;
          task.codexSessionStarted = Boolean(rememberedCodexSession.sessionId);
          task.codexSessionModel = configuredAgent.model;
        } else if (persistedCodexSessionId && (!persistedCodexSessionModel || persistedCodexSessionModel === configuredAgent.model)) {
          task.codexSessionId = persistedCodexSessionId;
          task.codexSessionStarted = true;
          task.codexSessionModel = configuredAgent.model;
        }
      }
      if (!task.outOfBand) {
        const executionStatus = task.preparationOnly ? 'preparing' : 'running';
        commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, task.preparationOnly ? 'preparation-started' : 'started'));
        registerGraphTask(task, { status: executionStatus });
        setGraphTaskStatus(task, executionStatus, {
          startedAt: Date.now(),
          ...(task.preparationOnly ? { preparationAttemptedAt: Date.now(), preparationError: undefined } : {}),
        });
        if (task.runtimeRecovery && task.recovery?.originalGraphNodeId) {
          commitTaskGraph(graph => updateTaskNodeStatus(graph, task.recovery.originalGraphNodeId, task.recovery.originalStatus || 'timed_out', {
            recoveryStatus: task.source === 'timeout-recovery-step' ? 'step' : 'pm',
            recoveryTaskId: task.graphNodeId,
          }));
        }
      }
      const activeHandoff = task.handoff || null;
      const objective = activeHandoff?.summary || task.objective || initialObjective;
      let pauseRequested = false;
      let pauseQuestion = '';
      let scheduleDecisionRequested = false;
      let providerPauseRequested = false;
      let providerRetryAfterMs = 0;
      let groupPauseRequested = false;
      let groupPauseRequests = [];
      let savedInterimResult = '';
      let releaseAgentLease = () => {};
      const isOrchestrator = chat.type === 'group' && agent.id === pm?.id;
      // Independent retrieval overlaps KB search and lease acquisition. Capture
      // errors immediately so an interrupted run cannot leave a rejected promise.
      const memoryContextPromise = memAPI && (isOrchestrator || isDirectChat)
        ? memAPI.getContextForAgent(memoryNamespace, objective || agent.name, agent.name, 5,
          { taskId: task.graphNodeId || task.id || '' }).then(value => ({ value }), error => ({ error }))
        : Promise.resolve({ value: '' });
      let taskKbContext = '';
      if ((isOrchestrator || isDirectChat) && kbPath && objective && window.electronAPI?.kbSearch) {
        try {
          const kbResult = await window.electronAPI.kbSearch({ query: objective, kbPath, maxResults: 3 });
          if (kbResult?.results?.length > 0) {
            taskKbContext = '\n\n[Für diese Aufgabe relevante Wissensbasis-Auszüge]:\n' +
              kbResult.results.map(result => `**${result.title}**:\n${result.snippet}`).join('\n\n---\n');
          }
        } catch {
          taskKbContext = '';
        }
      }
      const projectToolsEnabled = shouldEnableProjectTools({
        projectPath,
        objective,
        source: task.source,
        planningOnly,
        outOfBand: task.outOfBand,
        preparationOnly: task.preparationOnly,
        runtimeRecovery: task.runtimeRecovery,
      });
      const modelProjectPath = projectToolsEnabled ? projectPath : '';
      const taskProjectContext = projectToolsEnabled
        ? buildRelevantProjectInventoryContext({
          files: projectInventory,
          objective,
          maxFiles: isOrchestrator || isDirectChat ? 20 : 12,
          includeFallback: isOrchestrator || isDirectChat,
        })
        : '';
      const taskComplexity = assessTaskComplexity({
        requirements: liveTaskNode?.acceptanceCriteria || [],
        dependencyCount: liveTaskNode ? workflowDependencyAncestorIds(taskGraphRef.current, liveTaskNode.id).size : 0,
        objective,
        source: task.source,
        attachmentCount: activeAttachments.length,
        recovery: task.source === 'timeout-recovery' || task.source === 'timeout-recovery-step',
      });
      const qualityPolicy = resolveQualityPolicy({
        globalConfig: qualityRouting,
        groupConfig: chat.qualityRouting,
        agentConfig: configuredAgent.qualityRouting,
        messageMode: activeQualityMode,
        complexity: taskComplexity,
        agent: configuredAgent,
        providerModelsById: Object.fromEntries(providerConnections.map(connection => [connection.id, connection.models || []])),
      });
      let selectedModelAgent = task.modelOverride
        ? configuredAgent
        : qualityPolicy.directStrong ? qualityPolicy.escalationAgent : configuredAgent;
      const agentRequestId = `${chat.id}-${agent.id}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const taskSummary = summarizeTaskActivity({ objective, source: task.source, handoff: activeHandoff });
      const activeAgentRun = {
        requestId: agentRequestId,
        agentId: agent.id,
        agentName: agent.name,
        provider: selectedModelAgent.provider || 'openai',
        runtime: selectedModelAgent.provider === 'anthropic' && !apiKeys?.anthropic?.trim() && !apiKeys?.anthropicConfigured && apiKeys?.claudeCli
          ? 'claude'
          : (selectedModelAgent.provider || 'openai'),
        graphNodeId: task.graphNodeId,
        taskSummary,
        task,
        model: selectedModelAgent.model,
        startedAt: Date.now(),
      };
      if (isOrchestrator && !task.outOfBand && !task.preparationOnly) {
        activeAgentRun.onPlanProgress = text => {
          if (runIdRef.current !== myRunId || taskGraphRef.current?.approvedPlan) return;
          const plan = extractStreamingTaskPlan(text);
          if (!plan?.tasks?.length) return;
          const signature = JSON.stringify(plan.tasks);
          if (signature === activeAgentRun.savedPlanSignature) return;
          const tasks = distributeTaskPlanAcrossAgentPools(plan.tasks, chatAgents).flatMap(planTask => {
            const owner = chatAgents.find(candidate => candidate.name.toLowerCase() === planTask.agent.toLowerCase());
            return owner ? [{ ...planTask, agentId: owner.id, agentName: owner.name }] : [];
          });
          if (!tasks.length) return;
          const current = taskGraphRef.current;
          const rootNodeId = activePlanRootNodeId || current.nodes.find(node => node.id === task.graphNodeId)?.planRootId || task.graphNodeId;
          // Merge completed tickets; remove superseded tickets only when the final plan arrives.
          if (current.planOwner === 'user' || current.previousApprovedPlan) return;
          commitTaskGraph(graph => materializeTaskPlan(graph, { rootNodeId, tasks }));
          activeAgentRun.savedPlanSignature = signature;
        };
      }
      activeAgentRunRef.current.set(agentRequestId, activeAgentRun);
      setAgentProgress(previous => ({ ...previous, [agent.id]: {
        agentId: agent.id,
        taskSummary,
        detail: selectedModelAgent.provider === 'codex'
          ? 'Bereitet die Arbeitsumgebung für diesen Task vor.'
          : qualityPolicy.directStrong
            ? 'Bearbeitet die Aufgabe direkt mit der stärkeren Modellstufe.'
            : 'Bearbeitet die Aufgabe und formuliert das konkrete Ergebnis.',
        phase: 'working',
        startedAt: activeAgentRun.startedAt,
        updatedAt: Date.now(),
      }}));
      setTypingAgents(prev => [...prev, agent.id]);
      if (runIdRef.current !== myRunId) return;

      try {
        releaseAgentLease = await acquireAgentLease(agent.id);
        if (activeAgentRun.taskPaused) throw Object.assign(new Error('Aufgabe pausiert.'), { cancelled: true });
        if (runIdRef.current !== myRunId) return null;
        let taskReviewContext = '';
        const shouldRunConfiguredReview = !task.outOfBand
          && chat.type === 'group'
          && Boolean(projectPath)
          && Boolean(chat.reviewEnvironment?.test?.command)
          && /(?:test|prüf|validier|kontrollier|abnahme|quality|qa|lektori)/i.test(objective)
          && /(?:test|qa|quality|prüf|review|lektor|analyst)/i.test(`${agent.role || ''} ${agent.name || ''}`)
          && Boolean(window.electronAPI?.reviewRun);
        if (shouldRunConfiguredReview) {
          setAgentProgress(previous => ({ ...previous, [agent.id]: {
            ...(previous[agent.id] || {}),
            detail: t('Führt den konfigurierten Prüfbefehl aus.'),
            phase: 'review', updatedAt: Date.now(),
          }}));
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🧪|${t('{agent} startet den konfigurierten Prüfbefehl.', { agent: agent.name })}`,
            ts: Date.now(), isError: false,
          });
          try {
            const reviewResult = await window.electronAPI.reviewRun(chat.id, 'test');
            if (runIdRef.current !== myRunId) return;
            taskReviewContext = `\n\n[AUTOMATISCHER PRÜFLAUF]\nBefehl: ${reviewResult.command || ''}\nStatus: ${reviewResult.ok ? 'ERFOLGREICH' : 'FEHLGESCHLAGEN'}\nExit-Code: ${reviewResult.code ?? 'unbekannt'}\nAusgabe:\n${String(reviewResult.output || '(keine Ausgabe)').slice(-30000)}\n`;
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `🧪|${reviewResult.ok
                ? t('{agent}: Prüfbefehl erfolgreich abgeschlossen.', { agent: agent.name })
                : t('{agent}: Prüfbefehl fehlgeschlagen. Die Ausgabe wurde an den Agenten übergeben.', { agent: agent.name })}`,
              ts: Date.now(), isError: !reviewResult.ok,
            });
          } catch (reviewError) {
            if (runIdRef.current !== myRunId) return;
            taskReviewContext = `\n\n[AUTOMATISCHER PRÜFLAUF NICHT AUSGEFÜHRT]\n${reviewError.message}\n`;
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `🧪|${t('{agent}: Prüfbefehl konnte nicht gestartet werden — {error}', { agent: agent.name, error: reviewError.message })}`,
              ts: Date.now(), isError: true,
            });
          }
        }
        const memoryResult = await memoryContextPromise;
        if (memoryResult.error) throw memoryResult.error;
        const memoryContext = memoryResult.value;
        let isolatedSystemPrompt = buildIsolatedSystemPrompt({
          agent,
          groupName: chat.name,
          groupAgentNames: (isOrchestrator ? chatAgents : [agent, pm].filter(Boolean)).map(a => a.name),
          groupAgents: isOrchestrator ? chatAgents : [agent, pm].filter(Boolean),
          availableGroups: chat.crossGroupCollaborationEnabled
            ? groups
              .filter(group => reachableCrossGroupIds.includes(group.id))
              .map(group => ({
                ...group,
                capabilities: [...new Set([
                  ...(group.capabilityIndex?.explicitCapabilities || []),
                  ...(group.capabilityIndex?.derivedCapabilities || []),
                ])].slice(0, 24),
              }))
            : [],
          memoryNamespace,
          projectPath: task.outOfBand ? '' : projectPath,
          reviewEnvironment: chat.reviewEnvironment,
          isOrchestrator,
          isDirectChat,
          planningMode: planningOnly,
          recoveryMode: task.source === 'timeout-recovery',
          userOwnedWorkflow: Boolean(
            taskGraphRef.current?.planOwner === 'user' ||
            taskGraphRef.current?.approvedPlan ||
            taskGraphRef.current?.previousApprovedPlan
          ),
        });
        if (qualityPolicy.acceptanceCriteria) {
          isolatedSystemPrompt += `\n\nZusätzliche Akzeptanzkriterien für diesen Agenten:\n${qualityPolicy.acceptanceCriteria}`;
        }
        const recoveryOriginalGraphNodeId = task.runtimeRecovery ? task.recovery?.originalGraphNodeId : '';
        const evidenceGraphNodeId = task.source === 'timeout-recovery-step' && recoveryOriginalGraphNodeId
          ? recoveryOriginalGraphNodeId
          : task.graphNodeId;
        const taskCapsuleGraphNodeId = recoveryOriginalGraphNodeId || task.graphNodeId;
        const allCurrentPlanNodes = activePlanRootNodeId
          ? (taskGraphRef.current?.nodes || [])
            .filter(node => node.planRootId === activePlanRootNodeId)
            .sort(compareTicketPriority)
          : [];
        const needsCompletePlanContext = planningOnly || (
          isOrchestrator && ['user', 'team-synthesis', 'turn-limit-review'].includes(task.source)
        );
        const relevantPlanNodeIds = needsCompletePlanContext
          ? null
          : new Set([
            taskCapsuleGraphNodeId,
            ...(taskGraphRef.current?.edges || [])
              .filter(edge => edge.to === taskCapsuleGraphNodeId && ['dependency', 'review'].includes(edge.kind))
              .map(edge => edge.from),
          ].filter(Boolean));
        const currentPlanNodes = relevantPlanNodeIds
          ? allCurrentPlanNodes.filter(node => relevantPlanNodeIds.has(node.id))
          : allCurrentPlanNodes;
        const currentPlanContext = currentPlanNodes.length
          ? `${needsCompletePlanContext ? 'Aktueller Workflow-Plan' : 'Für diese Aufgabe relevanter Workflow-Ausschnitt'}:\n${currentPlanNodes.map(node =>
            `- ${node.planTaskId || node.id}: ${node.title} | Typ: ${node.nodeType === 'review' ? 'review' : 'task'} | Ziel: ${node.objective || node.title} | Agent: ${node.agentName} | Übergeordnet: ${taskGraphRef.current?.nodes?.find(candidate => candidate.id === node.parentNodeId)?.planTaskId || 'keine'} | Abhängig von: ${(taskGraphRef.current?.edges || []).filter(edge => edge.to === node.id && ['dependency', 'review'].includes(edge.kind)).map(edge => taskGraphRef.current?.nodes?.find(candidate => candidate.id === edge.from)?.planTaskId || edge.from).join(', ') || 'keiner'} | Delegation: ${JSON.stringify(node.delegation || { mode: 'never', requiredCapabilities: [], allowedTargetGroupIds: [] })} | Status: ${node.status}`
          ).join('\n')}${formatAcceptanceContext(currentPlanNodes)}`
          : '';
        const currentGraphTaskNode = taskGraphRef.current?.nodes?.find(node => node.id === taskCapsuleGraphNodeId);
        if (!isOrchestrator && inferTaskNodeType(currentGraphTaskNode || {}) === 'review') {
          isolatedSystemPrompt += `\n\nUNABHÄNGIGE TICKET-PRÜFUNG:
• Prüfe die Nachweise der abhängigen Tickets gegen deren Akzeptanzkriterien; implementiere die Fachaufgabe nicht selbst.
• Liefere jede Entscheidung maschinenlesbar als [[ACCEPTANCE_REVIEW]] {"decisions":[{"taskId":"ticket-id","criterionId":"kriterium-id","status":"passed","note":"konkreter Nachweis oder Defekt"}]} [[/ACCEPTANCE_REVIEW]].
• Zulässig sind passed, failed und waived. Ein failed benötigt einen konkreten Befund; die Laufzeit gibt das bestehende Ticket anschließend zur Nachbesserung zurück.`;
        }
        const taskCapsule = buildTaskCapsule({
          agentName: agent.name,
          agentRole: agent.role || 'Agent',
          objective,
          constraints: [
            ...(isDirectChat ? [
              'Dies ist ein Einzelchat: Antworte direkt selbst auf die User-Anfrage.',
              'Keine PM-Planung, keine Agenten-Handoffs und keine Abschlussprüfung durch einen anderen Agenten.',
            ] : [
              'Keinen vollständigen Gruppenverlauf anfordern.',
              'Nur die zugewiesene Aufgabe bearbeiten.',
              taskGraphRef.current?.planOwner === 'user'
                ? (task.runtimeRecovery
                  ? 'Dies ist eine systemseitige Recovery-Unteraufgabe. Der freigegebene Plan bleibt unverändert; nur die technische Ausführung der festgefahrenen Originalaufgabe wird kleinteilig fortgesetzt.'
                  : 'Bei einem unlösbaren Problem den PM oder User um Entscheidung bitten; keine neue Aufgabe anlegen und den Plan nicht verändern.')
                : 'Weitere Arbeit mit einer klaren @Name-Aufgabe übergeben.',
            ]),
            ...(isOrchestrator && task.source === 'user' && !useLeanFastPath && !planningOnly ? [
              'Erstelle vor den Handoffs jetzt den vollständigen initialen [[TASK_PLAN]] mit allen absehbaren Aufgaben und echten Abhängigkeiten. Eine Prüfaufgabe ist optional.',
            ] : []),
            ...(isOrchestrator && task.source === 'user' && useLeanFastPath && !planningOnly ? [
              'Schnellmodus für eine einfache Aufgabe: Halte die Koordination minimal und delegiere höchstens an einen Spezialisten.',
              'Ein TASK_PLAN ist für diesen Lauf nicht erforderlich.',
            ] : []),
            ...(isOrchestrator && task.source === 'team-synthesis' && currentPlanContext ? [
              'Nutze den aktuellen PM-Plan: Delegiere nur startbereite offene Aufgaben. Schließe nicht ab, solange geplante Fachaufgaben offen sind.',
            ] : []),
            ...(planningOnly ? [
              ...(restartPlanningFromScratch ? [
                'Achtung: Der vorherige Workflow wurde ausdrücklich gelöscht. Beginne die Planung vollständig neu.',
                'Übernimm keine Aufgaben, IDs, Abhängigkeiten, Status oder Annahmen aus früheren TASK_PLAN-Blöcken. Maßgeblich ist ausschließlich die neue User-Anforderung.',
              ] : []),
              'Bleibe im Planungsmodus: keine Agenten aktivieren, keine Werkzeuge zur Umsetzung verwenden und keine Dateien erzeugen.',
              'Wenn du für die Planung eine Antwort des Users benötigst, beginne jede Rückfrage ganz links auf einer eigenen Zeile mit @user.',
              'Gib bei jeder Antwort den vollständigen aktuellen TASK_PLAN-Entwurf aus; er ersetzt den Entwurf im Workflowfenster.',
              'In der Planungsphase darfst du nicht mehr benötigte oder fehlerhafte Aufgaben entfernen, indem du ihre IDs im vollständigen neuen TASK_PLAN weglässt.',
              'Bewahre alle nicht von der gewünschten Änderung betroffenen IDs, Ziele, Agenten, Kriterien und Abhängigkeiten.',
              'Bereits im aktuellen Plan enthaltene Tickets sind gespeichert. Setze nach einer Unterbrechung dort fort: Bewahre diese Tickets samt IDs, ergänze fehlende Tickets und gib abschließend den vollständigen Plan aus. Lege gespeicherte Tickets nicht unter neuen IDs doppelt an.',
            ] : []),
            ...(task.outOfBand ? [
              'Dies ist eine direkte Fachfrage außerhalb des pausierten Workflows. Antworte selbst und verändere den gespeicherten Plan nicht.',
              'Keine Agenten-Handoffs, keine TASK_PLAN-Ausgabe, keine Werkzeuge und keine Dateiänderungen.',
            ] : []),
            ...(task.source === 'timeout-recovery' ? [
              `Dies ist eine ${task.recovery?.trigger === 'quality' ? 'Qualitäts-Recovery' : task.recovery?.trigger === 'error' ? 'Problem-Recovery' : 'Timeout-Recovery'} für ${task.recovery?.originalAgentName || 'den ursprünglichen Agenten'}.`,
              `Untersuche die zu große oder festgefahrene Aufgabe und delegiere höchstens EINEN deutlich kleineren, konkret prüfbaren Schritt an @${task.recovery?.originalAgentName || 'den ursprünglichen Agenten'}.`,
              'Delegiere während der Recovery nicht mehrere Schritte gleichzeitig und verwende noch kein [[PROJECT_DONE]].',
              'Wenn die festgefahrene Aufgabe vollständig gelöst ist, bestätige das ausdrücklich mit [[RECOVERY_RESOLVED]].',
              'Wenn du keine sichere Lösung innerhalb des freigegebenen Plans findest oder eine Entscheidung benötigst, beginne eine konkrete Rückfrage auf einer eigenen Zeile mit @user.',
              'Eine @user-Rückfrage soll die Diagnose und möglichst zwei verständliche Handlungsoptionen enthalten.',
            ] : []),
            ...(task.source === 'timeout-recovery-step' ? [
              'Dies ist ein verkleinerter Recovery-Teilschritt. Bearbeite ausschließlich diesen Schritt und erweitere seinen Umfang nicht.',
              'Dein Ergebnis wird danach sofort vom PM geprüft.',
            ] : []),
            ...(task.preparationOnly ? [
              'Dies ist ausschließlich ein sicherer Vorbereitungslauf, während freigegebene Abhängigkeiten noch laufen.',
              'Bearbeite nur reversible, von den fehlenden Vorgängerergebnissen unabhängige Vorarbeit. Triff keine Annahmen über diese Ergebnisse.',
              'Schließe die Gesamtaufgabe nicht ab. Stelle keine Rückfragen, delegiere nichts und gib keine @Erwähnungen, TASK_PLAN- oder PROJECT_DONE-Blöcke aus.',
              'Dokumentiere präzise, was vorbereitet wurde und was bis zum Eintreffen der Abhängigkeiten offenbleibt.',
            ] : []),
            ...(isOrchestrator && task.source === 'turn-limit-review' ? [
              'Dies ist die einmalige PM-Prüfung am Ende eines begrenzten Laufsegments.',
              'Wenn die User-Anforderung vollständig erfüllt ist, gib den finalen Abschluss mit [[PROJECT_DONE]].',
              'Wenn Arbeit offen ist, übergib höchstens EINEN priorisierten, kleinen und konkret prüfbaren nächsten Schritt.',
              'Erstelle keinen neuen Gesamtplan und wiederhole keine bereits erledigte Aufgabe.',
            ] : []),
          ],
          context: [
            taskKbContext ? 'Aufgabenbezogene Wissensbasis-Auszüge stehen im Systemkontext.' : '',
            memoryContext ? `Relevantes Shared Memory: memory://${memoryNamespace}` : '',
            !task.outOfBand && projectPath ? `Projektdateien müssen in ${projectPath} als vollständige file:-Artefakte geliefert werden.` : '',
            !isDirectChat ? currentPlanContext : '',
            !isDirectChat && currentGraphTaskNode ? buildTaskTicketContext(currentGraphTaskNode, taskGraphRef.current) : '',
          ].filter(Boolean),
          handoff: activeHandoff,
          acceptanceCriteria: currentGraphTaskNode?.acceptanceCriteria || [],
          requestedOutput: isDirectChat || task.outOfBand
            ? ['Direkte Antwort an den User', 'Offene Rückfrage, falls wirklich nötig']
            : ['Konkretes Ergebnis', 'Offene Fragen oder nächster Handoff, falls nötig'],
        });
        const agentSession = buildAgentSession({
          agent, taskCapsule, memoryContext, handoff: activeHandoff,
          lastUserMessage: (isOrchestrator || isDirectChat) && task.source === 'user' ? objective : '',
        });
        const isolatedSession = { ...agentSession, systemPrompt: isolatedSystemPrompt };
        const capsuleHistory = agentSession.messages.map((message, index) => ({
          id: `${agentSession.sessionId}-${index}`,
          agentId: message.role === 'assistant' ? agent.id : 'user',
          senderName: message.role === 'assistant' ? agent.name : 'Task Capsule',
          text: message.content,
          ts: Date.now(),
        }));
        const relevantConversationHistory = buildRelevantConversationHistory({
          history,
          agent,
          chatType: chat.type,
          includeGroupContext: isOrchestrator && task.source === 'user',
        });
        // The task capsule already contains the current objective. Remove only
        // its matching source message from group context, while retaining the
        // preceding conversation needed to understand follow-up requests.
        const normalizedObjective = String(objective || '').trim().toLocaleLowerCase();
        const duplicateObjectiveIndex = !isDirectChat && task.source === 'user' && normalizedObjective
          ? relevantConversationHistory.findLastIndex(message => (
            message.agentId === 'user' &&
            String(message.text || '').trim().toLocaleLowerCase().includes(normalizedObjective)
          ))
          : -1;
        const compactConversationHistory = duplicateObjectiveIndex >= 0
          ? relevantConversationHistory.filter((_, index) => index !== duplicateObjectiveIndex)
          : relevantConversationHistory;
        const agentHistory = isDirectChat && compactConversationHistory.length > 0
          ? [...compactConversationHistory]
          : compactConversationHistory.length > 0
            ? [...compactConversationHistory, ...capsuleHistory.slice(-1)]
            : capsuleHistory;
        const taskAttachments = selectTaskAttachments(activeAttachments, {
          coordinator: isOrchestrator || isDirectChat, objective, handoff: activeHandoff,
        });
        if (taskAttachments.length > 0) {
          let attachmentMessageIndex = -1;
          for (let index = agentHistory.length - 1; index >= 0; index -= 1) {
            if (agentHistory[index].agentId === 'user') { attachmentMessageIndex = index; break; }
          }
          if (attachmentMessageIndex >= 0) {
            agentHistory[attachmentMessageIndex] = {
              ...agentHistory[attachmentMessageIndex],
              attachments: taskAttachments,
            };
          }
        }

        let usedMcp = false;
        const invokeTaskModel = async ({ modelAgent, modelHistory, extraContext = '', requestId = agentRequestId, allowProjectTools = true }) => {
          if (activeAgentRun.taskPaused) throw Object.assign(new Error('Aufgabe pausiert.'), { cancelled: true });
          const modelUsesClaudeCli = modelAgent.provider === 'anthropic' &&
            !apiKeys?.anthropic?.trim() && !apiKeys?.anthropicConfigured && apiKeys?.claudeCli;
          const modelUsesCodex = modelAgent.provider === 'codex';
          const sameCliModel = task.cliSessionStarted === true && task.cliSessionModel === modelAgent.model;
          const reusableSessionId = task.cliSessionId && (!task.cliSessionModel || task.cliSessionModel === modelAgent.model)
            ? task.cliSessionId
            : '';
          const callSessionId = modelUsesClaudeCli ? (reusableSessionId || uuidv4()) : '';
          const sameCodexModel = task.codexSessionStarted === true && task.codexSessionModel === modelAgent.model;
          const reusableCodexSessionId = task.codexSessionId && (!task.codexSessionModel || task.codexSessionModel === modelAgent.model)
            ? task.codexSessionId
            : '';
          const isEscalatedModel = modelAgent.model !== configuredAgent.model || modelAgent.provider !== configuredAgent.provider;
          const reasoningEffort = codexReasoningEffortForTask({
            planningOnly,
            outOfBand: task.outOfBand,
            preparationOnly: task.preparationOnly,
            runtimeRecovery: task.runtimeRecovery,
            complexity: taskComplexity.level,
            qualityMode: activeQualityMode,
            escalated: isEscalatedModel,
          });
          const result = await callLLM({
            apiKeys,
            providerConnections,
            agent: modelAgent,
            history: modelHistory,
            userMessage: null,
            groupContext: isOrchestrator ? chatAgents.map(a => a.name).join(', ') : null,
            kbContext: taskKbContext + memoryContext + taskProjectContext + taskReviewContext + extraContext,
            isolatedSession,
            projectPath: allowProjectTools ? modelProjectPath : '',
            requestId,
            language,
            cliSessionId: callSessionId,
            resumeCliSession: modelUsesClaudeCli && sameCliModel,
            codexSessionId: modelUsesCodex ? reusableCodexSessionId : '',
            resumeCodexSession: modelUsesCodex && sameCodexModel,
            persistCodexSession: modelUsesCodex,
            reasoningEffort,
            onRunMetadata: metadata => {
              if (metadata?.provider !== 'codex') return;
              if (metadata.sessionId) {
                task.codexSessionId = metadata.sessionId;
                task.codexSessionStarted = true;
                task.codexSessionModel = modelAgent.model;
              }
              if (metadata.metrics) task.lastRunMetrics = metadata.metrics;
              if (conversationSessionKey && metadata.sessionId) {
                codexConversationSessionsRef.current.set(conversationSessionKey, {
                  sessionId: metadata.sessionId,
                  model: modelAgent.model,
                });
              }
            },
          });
          if (activeAgentRun.taskPaused) throw Object.assign(new Error('Aufgabe pausiert.'), { cancelled: true });
          if (modelUsesClaudeCli) {
            task.cliSessionId = callSessionId;
            task.cliSessionStarted = true;
            task.cliSessionModel = modelAgent.model;
            if (conversationSessionKey) {
              claudeConversationSessionsRef.current.set(conversationSessionKey, {
                sessionId: task.cliSessionId,
                started: true,
                model: modelAgent.model,
              });
            }
          }
          return result;
        };
        const callWithModel = (modelAgent, modelHistory) => callLLMWithMcp({
          servers: planningOnly || task.outOfBand ? [] : activeMcpServers,
          history: modelHistory,
          agent: modelAgent,
          requestPermission: request => activeAgentRun.taskPaused ? Promise.resolve({ allowed: false, scope: 'cancelled' }) : requestMcpPermission(request),
          onPermissionConsumed: handleMcpPermissionConsumed,
          onToolResult: handleMcpToolResult,
          onConnectionError: error => {
            const key = `${error?.serverId || error?.serverName}:${error?.message}`;
            if (reportedMcpErrorsRef.current.has(key)) return;
            reportedMcpErrorsRef.current.add(key);
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `MCP|${t('Verbindung zu „{server}“ fehlgeschlagen: {error}', {
                server: error?.serverName || 'MCP',
                error: error?.message || t('Unbekannter Fehler'),
              })}`,
              ts: Date.now(), isError: true,
            });
          },
          call: ({ history: nextHistory, extraContext }) => invokeTaskModel({
            modelAgent,
            modelHistory: nextHistory,
            extraContext,
          }),
          callRecovery: ({ history: nextHistory }) => {
            if (activeAgentRun.taskPaused) throw Object.assign(new Error('Aufgabe pausiert.'), { cancelled: true });
            return callLLM({
            apiKeys, providerConnections,
            agent: createMcpPlannerAgent(modelAgent),
            history: nextHistory,
            userMessage: null,
            groupContext: null,
            kbContext: '',
            isolatedSession: {
              systemPrompt: 'Du bist ein reiner JSON-Datengenerator. Verwende keine Werkzeuge. Antworte ausschließlich mit genau einem gültigen JSON-Objekt, ohne Markdown, Erklärung oder Rückfrage.',
            },
            projectPath: '',
            requestId: agentRequestId,
            language,
            });
          },
          onActivity: ({ serverName, toolName }) => {
            if (activeAgentRun.taskPaused) throw Object.assign(new Error('Aufgabe pausiert.'), { cancelled: true });
            usedMcp = true;
            setAgentProgress(previous => ({ ...previous, [agent.id]: {
              ...(previous[agent.id] || {}),
              agentId: agent.id,
              taskSummary,
              detail: `MCP: ${serverName} · ${toolName}`,
              phase: 'tool',
              startedAt: previous[agent.id]?.startedAt || activeAgentRun.startedAt,
              updatedAt: Date.now(),
            }}));
          },
        });
        const callWithoutTools = (modelAgent, modelHistory) => invokeTaskModel({
          modelAgent,
          modelHistory,
          requestId: agentRequestId,
          allowProjectTools: false,
        });

        const taskModelContext = taskKbContext + memoryContext + taskProjectContext + taskReviewContext;
        const assessCandidate = candidateReply => {
          const normalized = normalizeAgentMentionLayout(candidateReply, agent, chatAgents);
          const candidatePlan = isOrchestrator && !(useLeanFastPath && task.source === 'user')
            ? extractTaskPlan(normalized)
            : null;
          const candidateFiles = extractProjectFiles(normalized);
          return {
            normalized,
            evaluation: evaluateResponseQuality({
              reply: normalized,
              objective,
              complexity: taskComplexity,
              isOrchestrator,
              requiresInitialPlan: isOrchestrator && task.source === 'user' && (planningOnly || !useLeanFastPath),
              parsedTaskPlan: candidatePlan,
              projectFiles: candidateFiles,
              projectPath: modelProjectPath,
              usedMcp,
            }),
          };
        };

        const cascadeResult = await runQualityCascade({
          project: modelProjectPath || chat.id,
          // MCP side effects must never be repeated by the quality retry.
          agent: configuredAgent,
          policy: task.modelOverride ? { ...qualityPolicy, directStrong: false, maxEscalations: 0 } : qualityPolicy,
          history: agentHistory,
          objective,
          complexity: taskComplexity,
          systemContext: isolatedSystemPrompt + taskModelContext,
          evaluate: candidate => assessCandidate(candidate).evaluation,
          canEscalate: () => !(projectToolsEnabled && usesNativeCli(selectedModelAgent, apiKeys)),
          call: async ({ agent: modelAgent, history: modelHistory, phase }) => {
            if (runIdRef.current !== myRunId) throw Object.assign(new Error('Lauf abgebrochen.'), { cancelled: true });
            if (phase === 'escalated') {
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `🧠|${t('{agent}: Die Qualitätsprüfung fordert eine stärkere Modellstufe ({from} → {to}).', {
                  agent: agent.name, from: configuredAgent.model, to: modelAgent.model,
                })}`,
                ts: Date.now(), isError: false,
              });
            }
            activeAgentRun.provider = modelAgent.provider || 'openai';
            activeAgentRun.model = modelAgent.model;
            activeAgentRun.runtime = modelAgent.provider === 'anthropic' && !apiKeys?.anthropic?.trim() && !apiKeys?.anthropicConfigured && apiKeys?.claudeCli
              ? 'claude' : activeAgentRun.provider;
            if (activeAgentRun.taskPaused) throw Object.assign(new Error('Aufgabe pausiert.'), { cancelled: true });
            const response = await (phase === 'escalated' && usedMcp
              ? callWithoutTools(modelAgent, modelHistory)
              : callWithModel(modelAgent, modelHistory));
            if (activeAgentRun.taskPaused) throw Object.assign(new Error('Aufgabe pausiert.'), { cancelled: true });
            return response;
          },
        });
        if (runIdRef.current !== myRunId) return;
        let reply = cascadeResult.reply;
        if (!String(reply || '').trim()) throw new Error('Der Agent hat keine verwertbare Antwort geliefert.');
        selectedModelAgent = cascadeResult.selectedAgent;
        const qualityResult = assessCandidate(reply);
        const { outcome: qualityOutcome, escalationFailed, didEscalate, unresolved: qualityUnresolved,
          estimatedInputTokens, estimatedOutputTokens } = cascadeResult;
        recordQualityEvent({
          outcome: qualityOutcome,
          unresolved: qualityUnresolved,
          estimatedInputTokens,
          estimatedOutputTokens,
        });
        if (qualityUnresolved) {
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `⚠️|${agent.name}: Die Antwort erfüllt nicht alle automatisch prüfbaren Kriterien. ${escalationFailed ? 'Die stärkere Modellstufe war nicht verfügbar.' : ''}`,
            ts: Date.now(), isError: false,
          });
        }
        const shouldStartQualityRecovery = Boolean(
          qualityUnresolved &&
          !planningOnly &&
          !task.outOfBand &&
          !task.preparationOnly &&
          !task.runtimeRecovery &&
          taskGraphRef.current?.approvedPlan &&
          pm &&
          agent.id !== pm.id
        );
        if (shouldStartQualityRecovery) {
          const qualityRecoveryError = new Error(
            `Die Aufgabe blieb nach der Qualitätskaskade unzureichend: ${qualityResult.evaluation.reasons.join('; ') || 'automatische Kriterien nicht erfüllt'}`,
          );
          qualityRecoveryError.isTaskComplexityFailure = true;
          throw qualityRecoveryError;
        }

        let rawReply = normalizeAgentMentionLayout(reply, agent, chatAgents);
        const addressedGroups = task.outOfBand || task.preparationOnly
          ? []
          : extractGroupMentions(rawReply, groups, { sourceGroupId: chat.id, userAuthored: false });
        const submittedTaskEvidence = extractTaskEvidence(rawReply);
        const replyNode = taskGraphRef.current?.nodes?.find(node => node.id === task.graphNodeId);
        const mayReviewAcceptance = isOrchestrator || inferTaskNodeType(replyNode || {}) === 'review';
        const acceptanceDecisions = mayReviewAcceptance
          ? extractAcceptanceReview(rawReply).filter(decision => {
            const reviewedNode = taskGraphRef.current?.nodes?.find(node =>
              node.id === decision.taskId || node.planTaskId === decision.taskId || node.ticketId === decision.taskId
            );
            return !reviewedNode || reviewedNode.agentId !== agent.id;
          })
          : [];
        const acceptanceReworkRequested = acceptanceDecisions.some(decision => decision.status === 'failed');
        const canMaterializePlan = shouldMaterializeTaskPlan({
          isOrchestrator,
          planningOnly,
          taskSource: task.source,
          hasApprovedPlan: Boolean(taskGraphRef.current?.approvedPlan),
          userOwnedPlan: taskGraphRef.current?.planOwner === 'user',
        });
        const parsedTaskPlan = canMaterializePlan
          ? extractTaskPlan(rawReply)
          : null;
        let normalizedPlanTasks = [];
        if (parsedTaskPlan?.tasks?.length) {
          const currentGraphNode = taskGraphRef.current?.nodes?.find(node => node.id === task.graphNodeId);
          const planRootNodeId = activePlanRootNodeId || currentGraphNode?.planRootId || task.graphNodeId;
          const distributedPlanTasks = distributeTaskPlanAcrossAgentPools(parsedTaskPlan.tasks, chatAgents);
          normalizedPlanTasks = distributedPlanTasks.map(planTask => {
            const plannedAgent = chatAgents.find(candidate =>
              candidate.name.toLowerCase() === planTask.agent.toLowerCase()
            );
            return plannedAgent ? {
              ...planTask,
              agentId: plannedAgent.id,
              agentName: plannedAgent.name,
            } : null;
          }).filter(Boolean);
          if (normalizedPlanTasks.length) {
            activePlanRootNodeId = planRootNodeId;
            commitTaskGraph(graph => {
              const materialized = materializeTaskPlan(graph, {
                rootNodeId: planRootNodeId,
                tasks: normalizedPlanTasks,
                replace: planningOnly,
                allowPlanningRevision: planningOnly,
              });
              return restartPlanningFromScratch ? {
                ...materialized,
                workflowResetRequired: false,
                workflowResetConsumedAt: Date.now(),
              } : materialized;
            });
          }
        }
        const mayCreateRecoveryPlan = task.runtimeRecovery === true &&
          task.source === 'timeout-recovery' &&
          agent.id === pm?.id;
        const parsedRecoveryPlan = mayCreateRecoveryPlan ? extractRecoveryPlan(rawReply) : null;
        let normalizedRecoveryTasks = [];
        let activeRecovery = task.recovery || null;
        if (parsedRecoveryPlan?.tasks?.length && activeRecovery) {
          const requestedAttempt = activeRecovery.mode === 'review'
            ? (activeRecovery.attempt || 0) + 1
            : (activeRecovery.attempt || 1);
          if (requestedAttempt <= MAX_PM_RECOVERY_ATTEMPTS) {
            const batchId = `recovery-batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
            activeRecovery = {
              ...activeRecovery,
              attempt: requestedAttempt,
              mode: 'plan',
              batchId,
              controllerGraphNodeId: task.graphNodeId,
            };
            normalizedRecoveryTasks = parsedRecoveryPlan.tasks.map(recoveryTask => {
              const recoveryAgent = chatAgents.find(candidate =>
                candidate.name.toLowerCase() === recoveryTask.agent.toLowerCase()
              );
              return recoveryAgent ? {
                ...recoveryTask,
                agentId: recoveryAgent.id,
                agentName: recoveryAgent.name,
              } : null;
            }).filter(Boolean);
            if (normalizedRecoveryTasks.length !== parsedRecoveryPlan.tasks.length) {
              normalizedRecoveryTasks = [];
            }
            const availableRecoveryTaskIds = new Set(normalizedRecoveryTasks.map(recoveryTask => recoveryTask.id));
            normalizedRecoveryTasks = normalizedRecoveryTasks.map(recoveryTask => ({
              ...recoveryTask,
              dependsOn: recoveryTask.dependsOn.filter(dependencyId => availableRecoveryTaskIds.has(dependencyId)),
            }));
            if (normalizedRecoveryTasks.length && addressedGroups.length === 0) {
              commitTaskGraph(graph => materializeRuntimeRecoveryPlan(graph, {
                rootNodeId: activePlanRootNodeId || activeRecovery.planRootId,
                controllerNodeId: task.graphNodeId,
                recovery: activeRecovery,
                tasks: normalizedRecoveryTasks,
              }));
            }
          }
        }
        rawReply = rewritePlanHandoffAssignments(rawReply, normalizedPlanTasks);
        const projectFiles = extractProjectFiles(rawReply);
        const savedProjectFiles = [];
        if (!planningOnly && !task.outOfBand && !task.preparationOnly && projectPath && window.electronAPI?.projectWrite) {
          for (const file of projectFiles) {
            const writeResult = await window.electronAPI.projectWrite({
              projectPath,
              filename: file.filename,
              content: file.content,
            });
            if (writeResult?.success) {
              savedProjectFiles.push(writeResult.relativePath || file.filename);
            } else {
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `📁|${t('{agent}: {file} konnte nicht gespeichert werden — {error}', {
                  agent: agent.name,
                  file: file.filename,
                  error: writeResult?.error || t('unbekannter Fehler'),
                })}`,
                ts: Date.now(), isError: true,
              });
            }
          }
        }

        const displayReply = cleanAgentReply(rawReply) ||
          (savedProjectFiles.length
            ? t('Dateien gespeichert: {files}', { files: savedProjectFiles.join(', ') })
            : t('Aufgabe abgeschlossen.'));
        const reviewEvidence = buildProjectReviewEvidence({
          displayReply,
          projectFiles,
          savedProjectFiles,
        });
        const evidenceNode = taskGraphRef.current?.nodes?.find(node => node.id === evidenceGraphNodeId);
        if (!planningOnly && !task.preparationOnly && evidenceNode?.acceptanceCriteria?.length) {
          const evidenceKind = savedProjectFiles.length
            ? 'artifact'
            : taskReviewContext.includes('Status: ERFOLGREICH')
              ? 'automatic-test'
              : 'result';
          commitTaskGraph(graph => submitTaskEvidence(graph, evidenceGraphNodeId, submittedTaskEvidence, {
            author: agent.name,
            fallbackSummary: reviewEvidence,
            kind: evidenceKind,
          }));
        }
        if (!planningOnly && !task.preparationOnly && acceptanceDecisions.length) {
          commitTaskGraph(graph => applyAcceptanceDecisions(graph, acceptanceDecisions, { reviewer: agent.name }));
        }
        if (!planningOnly && !task.outOfBand && projectPath && window.electronAPI?.projectWrite) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const safeAgentName = agent.name.replace(/[^a-zA-Z0-9_-]/g, '-');
          const progressPath = `.agent-teams/progress/${timestamp}-${safeAgentName}-${agentSession.sessionId}.md`;
          const progressContent = [
            `# ${t('Zwischenstand: {agent}', { agent: agent.name })}`,
            '',
            `- ${t('Session: {session}', { session: agentSession.sessionId })}`,
            `- ${t('Aufgabe: {task}', { task: objective })}`,
            `- ${t('Zeitpunkt: {time}', { time: new Date().toISOString() })}`,
            savedProjectFiles.length
              ? `- ${t('Geschriebene Dateien: {files}', { files: savedProjectFiles.join(', ') })}`
              : `- ${t('Geschriebene Dateien: keine expliziten Datei-Artefakte')}`,
            '',
            `## ${t('Ergebnis')}`,
            '',
            (task.preparationOnly ? reviewEvidence : displayReply).slice(0, 100000),
            '',
          ].join('\n');
          const progressResult = await window.electronAPI.projectWrite({
            projectPath, filename: progressPath, content: progressContent,
          });
          if (!progressResult?.success) {
            addMessage(chat.id, {
              id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
              text: `📁|${t('Zwischenstand konnte nicht gespeichert werden — {error}', { error: progressResult?.error || t('unbekannter Fehler') })}`,
              ts: Date.now(), isError: true,
            });
          }
        }
        if (savedProjectFiles.length) {
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `📁|${t(
              savedProjectFiles.length === 1
                ? '{agent} hat {count} Datei gespeichert: {files}'
                : '{agent} hat {count} Dateien gespeichert: {files}',
              { agent: agent.name, count: savedProjectFiles.length, files: savedProjectFiles.join(', ') },
            )}`,
            ts: Date.now(), isError: false,
          });
        }

        const agentMsg = {
          id: Date.now() + Math.random(),
          agentId: agent.id, senderName: agent.name,
          text: displayReply, ts: Date.now(),
          provider: selectedModelAgent.provider,
          model: selectedModelAgent.model,
        };
        addMessage(chat.id, agentMsg);
        history = [...history, agentMsg];
        savedInterimResult = String(reviewEvidence || displayReply || '').slice(0, 12000);
        if (addressedGroups.length > 0) {
          const batchId = `group-request-batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          groupPauseRequests = addressedGroups.map(mention => createCrossGroupRequest({
            sourceGroup: chat,
            sourceTask: task,
            sourceAgent: agent,
            targetGroup: mention.group,
            question: mention.question,
            attachments: activeAttachments,
            batchId,
            origin: 'agent',
            qualityMode: activeQualityMode,
          })).filter(Boolean);
          groupPauseRequests.forEach(enqueueCrossGroupRequest);
          groupPauseRequested = groupPauseRequests.length > 0;
          if (groupPauseRequested) {
            setGraphTaskStatus(task, 'waiting_group', {
              waitingGroupRequestIds: groupPauseRequests.map(request => request.id),
              waitingGroupNames: groupPauseRequests.map(request => request.targetGroupName),
              groupWaitStartedAt: Date.now(),
              interimResult: savedInterimResult,
              interimSavedAt: Date.now(),
            });
            commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'waiting-group', {
              requestIds: groupPauseRequests.map(request => request.id),
            }));
            addMessage(chat.id, {
              id: `cross-group-wait-${batchId}`,
              agentId: 'system',
              senderName: 'System',
              text: `↗|${t('{agent} wartet auf eine Antwort von {groups}. Unabhängige Aufgaben laufen weiter; der freigegebene Plan bleibt unverändert.', {
                agent: agent.name,
                groups: groupPauseRequests.map(request => request.targetGroupName).join(', '),
              })}`,
              ts: Date.now(),
              isError: false,
            });
          }
        }
        if (!groupPauseRequested && !task.preparationOnly) {
          successfulTasks += 1;
          taskQueue.markSuccessful(task);
        }
        if (!task.outOfBand && task.preparationOnly) {
          setGraphTaskStatus(task, 'prepared', {
            preparationCompletedAt: Date.now(),
            interimResult: savedInterimResult,
            interimSavedAt: Date.now(),
            preparedFiles: projectFiles.map(file => file.filename),
            runtimeModel: selectedModelAgent.model,
            qualityEscalated: didEscalate,
          });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'prepared', {
            model: selectedModelAgent.model,
            savedFileCount: savedProjectFiles.length,
          }));
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `⏸|${t('{agent} hat sichere Vorarbeit für „{task}“ zwischengespeichert. Die Aufgabe wartet weiterhin auf ihre Abhängigkeiten.', {
              agent: agent.name,
              task: liveTaskNode?.title || objective,
            })}`,
            ts: Date.now(), isError: false,
          });
        } else if (!task.outOfBand && !groupPauseRequested) {
          setGraphTaskStatus(task, 'agent_done', {
            completedAt: Date.now(),
            runtimeModel: selectedModelAgent.model,
            qualityEscalated: didEscalate,
            ...(liveTaskNode?.interimResult ? { interimConsumedAt: Date.now() } : {}),
          });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, 'completed', { model: selectedModelAgent.model }));
          if (acceptanceReworkRequested && inferTaskNodeType(replyNode || {}) === 'review') {
            // Reuse the same review ticket after the rejected implementation
            // ticket was corrected. No new plan node is created.
            commitTaskGraph(graph => updateTaskNodeStatus(graph, task.graphNodeId, 'planned', {
              reworkCycleRequestedAt: Date.now(),
              completedAt: undefined,
            }));
          }
        } else if (task.consultingGraphNodeId) {
          commitTaskGraph(graph => updateTaskNodeStatus(graph, task.consultingGraphNodeId, 'retryable', {
            pmConsultedAt: Date.now(),
          }));
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `💬|${t('Die PM-Einschätzung liegt vor. Der freigegebene Plan blieb unverändert; der User kann die Aufgabe erneut starten oder eine neue Planversion bearbeiten.')}`,
            ts: Date.now(), isError: false,
          });
        }

        const knowledgeEntries = extractKnowledgeFromReply(displayReply, agent.id, agent.name);
        if (!planningOnly && !task.preparationOnly && memAPI && knowledgeEntries.length > 0) {
          for (const entry of knowledgeEntries) {
            const requestedType = entry.tags.find(tag => ['fact', 'decision', 'constraint', 'finding', 'task_state'].includes(tag));
            await memAPI.write(memoryNamespace, createEntry({
              type: requestedType || 'finding', namespace: memoryNamespace, content: entry.text,
              tags: entry.tags, author: agent.name, confidence: 'medium',
            }));
          }
          await refreshMemoryCount();
        }

        const addressedGroupNames = new Set(addressedGroups.map(item => item.group.name.toLowerCase()));
        const handoffs = task.outOfBand || task.preparationOnly ? [] : extractHandoffsFromReply(rawReply, agent, chatAgents)
          .filter(handoff => !addressedGroupNames.has(String(handoff.to || '').toLowerCase()));
        const userQuestions = task.outOfBand || task.preparationOnly ? [] : extractUserQuestions(rawReply);
        let asksUser = userQuestions.length > 0;
        const immediateHandoffTasks = [];
        const claimedPlanNodeIds = new Set();
        const canDrivePlan = isOrchestrator &&
          activePlanRootNodeId &&
          ['user', 'team-synthesis', 'turn-limit-review'].includes(task.source);
        const findPlannedNode = (target, summary) => {
          if (!canDrivePlan) return null;
          const newPlanIds = new Set(normalizedPlanTasks.map(planTask => planTask.id));
          const candidates = (taskGraphRef.current?.nodes || [])
            .filter(node =>
              node.planRootId === activePlanRootNodeId &&
              node.agentId === target.id &&
              node.nodeType !== 'review' &&
              CLAIMABLE_PLAN_STATUSES.has(node.status) &&
              !claimedPlanNodeIds.has(node.id)
            )
            .map(node => ({
              node,
              score: planTaskMatchScore(node, summary),
              ready: isTaskNodeReady(taskGraphRef.current, node.id),
              isNew: newPlanIds.has(node.planTaskId),
            }))
            .sort((left, right) =>
              right.score - left.score ||
              Number(right.isNew) - Number(left.isNew) ||
              Number(right.ready) - Number(left.ready) ||
              (left.node.planOrder || 0) - (right.node.planOrder || 0)
            );
          const best = candidates[0];
          return best && (best.score > 0 || best.isNew) ? best.node : null;
        };

        for (const handoff of handoffs) {
          const target = chatAgents.find(candidate => candidate.name.toLowerCase() === handoff.to.toLowerCase());
          if (!target || target.id === agent.id) continue;
          const plannedNode = findPlannedNode(target, handoff.summary);
          const isRecoveryDelegation = task.source === 'timeout-recovery' &&
            task.runtimeRecovery === true &&
            task.recovery &&
            agent.id === pm?.id &&
            target.id === task.recovery.originalAgentId;
          if (taskGraphRef.current?.approvedPlan && !plannedNode && !isRecoveryDelegation) {
            if (target.id === pm?.id && agent.id !== pm.id) {
              setGraphTaskStatus(task, 'waiting_pm', {
                blockedReason: 'pm-consultation',
                issueSummary: handoff.summary,
              });
              immediateHandoffTasks.push({
                agent: target,
                objective: `Berate zur bestehenden Aufgabe „${objective}“: ${handoff.summary}. Ändere den Workflow nicht und schlage dem User höchstens konkrete Optionen innerhalb der bestehenden Aufgabe vor.`,
                source: 'workflow-consultation',
                outOfBand: true,
                consultingGraphNodeId: task.graphNodeId,
              });
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `💬|${t('{agent} hat den PM um Hilfe gebeten. Die Aufgabe und der freigegebene Plan werden dabei nicht verändert.', { agent: agent.name })}`,
                ts: Date.now(), isError: false,
              });
            } else {
              setGraphTaskStatus(task, 'waiting_user', {
                blockedReason: 'unplanned-handoff',
                issueSummary: handoff.summary,
              });
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `🛡️|${t('{agent} schlägt zusätzliche Arbeit vor: {proposal} Der Plan wurde nicht verändert. Entscheide im Workflowfenster, ob du eine neue Planversion anlegen möchtest.', { agent: agent.name, proposal: handoff.summary })}`,
                ts: Date.now(), isError: false,
              });
            }
            continue;
          }
          if (!planningOnly && memAPI) await memAPI.handoff(memoryNamespace, handoff);
          if (shouldDeferHandoffToPM({ fromAgent: agent, targetAgent: target, pm })) {
            needsSynthesis = true;
            continue;
          }
          const recovery = isRecoveryDelegation
            ? {
              ...task.recovery,
              attempt: task.recovery.mode === 'review'
                ? (task.recovery.attempt || 0) + 1
                : task.recovery.attempt,
              mode: 'step',
              currentStep: handoff.summary,
            }
            : null;
          if (plannedNode) {
            claimedPlanNodeIds.add(plannedNode.id);
            // Future plan steps are visible in the tree but must not enter the
            // executable queue before all of their dependencies are complete.
            if (!isTaskNodeReady(taskGraphRef.current, plannedNode.id)) continue;
          }
          const dependencyNodeId = plannedNode
            ? null
            : inferHandoffDependency(handoff.summary, immediateHandoffTasks);
          const approvedObjective = plannedNode && taskGraphRef.current?.approvedPlan
            ? (plannedNode.objective || plannedNode.title)
            : handoff.summary;
          const predecessorFindings = agent.id !== pm?.id && reviewEvidence
            ? [`Relevantes Ergebnis des direkten Vorgängers ${agent.name}: ${String(reviewEvidence).slice(0, 8000)}`]
            : [];
          const contextualHandoff = predecessorFindings.length > 0
            ? { ...handoff, findings: [...(handoff.findings || []), ...predecessorFindings] }
            : handoff;
          const executableHandoff = approvedObjective === handoff.summary
            ? contextualHandoff
            : { ...contextualHandoff, summary: approvedObjective };
          const approvedTaskNode = plannedNode && taskGraphRef.current?.approvedPlan
            ? taskGraphRef.current.approvedPlan.nodes.find(node => node.id === plannedNode.id)
            : null;
          const approvedTaskModel = approvedTaskNode
            ? (approvedTaskNode.modelOverride || approvedTaskNode.model)
            : plannedNode?.modelOverride;
          const nextTask = registerGraphTask({
            agent: target,
            objective: approvedObjective,
            handoff: executableHandoff,
            source: recovery ? 'timeout-recovery-step' : agent.name,
            ...(recovery ? { runtimeRecovery: true } : {}),
            ...(plannedNode ? {
              graphNodeId: plannedNode.id,
              planRootId: activePlanRootNodeId,
              planTaskId: plannedNode.planTaskId,
              ...(approvedTaskModel ? { modelOverride: approvedTaskModel } : {}),
            } : {}),
            ...(recovery ? { recovery } : {}),
          }, { status: 'planned', parentNodeId: plannedNode ? null : task.graphNodeId });
          if (recovery?.originalGraphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(graph, recovery.originalGraphNodeId, recovery.originalStatus || 'timed_out', {
              recoveryStatus: 'step',
              recoveryTaskId: nextTask.graphNodeId,
            }));
          }
          if (dependencyNodeId) {
            commitTaskGraph(graph => addTaskEdge(graph, {
              from: dependencyNodeId,
              to: nextTask.graphNodeId,
              kind: 'dependency',
            }));
          }
          immediateHandoffTasks.push(nextTask);
        }

        // A recovery plan is a temporary DAG tied to one approved ticket. It
        // may use several suitable group agents and starts every dependency-
        // ready branch immediately, including safe parallel branches.
        if (normalizedRecoveryTasks.length && activeRecovery?.batchId && !asksUser && !groupPauseRequested) {
          const recoveryNodes = (taskGraphRef.current?.nodes || [])
            .filter(node =>
              node.runtimeRecovery &&
              node.recovery?.batchId === activeRecovery.batchId &&
              node.source === 'timeout-recovery-step' &&
              CLAIMABLE_PLAN_STATUSES.has(node.status) &&
              isTaskNodeReady(taskGraphRef.current, node.id)
            )
            .sort(compareTicketPriority);
          for (const recoveryNode of recoveryNodes) {
            const target = chatAgents.find(candidate => candidate.id === recoveryNode.agentId);
            if (!target) continue;
            const recoveryHandoff = createHandoff({
              from: pm?.name || agent.name,
              to: target.name,
              taskId: `recovery-${recoveryNode.planTaskId || recoveryNode.id}`,
              summary: recoveryNode.objective || recoveryNode.title,
              findings: [
                `Originalaufgabe: ${activeRecovery.originalObjective}`,
                ...(activeRecovery.additionalInformation
                  ? [`Zusatzinformation des Users: ${activeRecovery.additionalInformation}`]
                  : []),
              ],
            });
            immediateHandoffTasks.push(registerGraphTask({
              agent: target,
              objective: recoveryNode.objective || recoveryNode.title,
              handoff: recoveryHandoff,
              source: 'timeout-recovery-step',
              runtimeRecovery: true,
              recovery: recoveryNode.recovery,
              graphNodeId: recoveryNode.id,
              planRootId: recoveryNode.planRootId,
              planTaskId: recoveryNode.planTaskId,
            }, { status: recoveryNode.status }));
          }
        }

        // The structured PM plan is authoritative. Queue every currently
        // reachable planned task even if the PM forgot its matching @line;
        // future nodes remain disabled until a later review unlocks them.
        if (canDrivePlan && !asksUser) {
          const readyPlanNodes = (taskGraphRef.current?.nodes || [])
            .filter(node =>
              node.planRootId === activePlanRootNodeId &&
              node.nodeType !== 'review' &&
              CLAIMABLE_PLAN_STATUSES.has(node.status) &&
              !claimedPlanNodeIds.has(node.id) &&
              isTaskNodeReady(taskGraphRef.current, node.id)
            )
            .sort(compareTicketPriority);
          for (const plannedNode of readyPlanNodes) {
            const target = chatAgents.find(candidate => candidate.id === plannedNode.agentId);
            if (!target) continue;
            const plannedHandoff = createHandoff({
              from: agent.name,
              to: target.name,
              taskId: `plan-${plannedNode.planTaskId}`,
              summary: plannedNode.objective || plannedNode.title,
            });
            const nextTask = registerGraphTask({
              agent: target,
              objective: plannedHandoff.summary,
              handoff: plannedHandoff,
              source: agent.name,
              graphNodeId: plannedNode.id,
              planRootId: activePlanRootNodeId,
              planTaskId: plannedNode.planTaskId,
              ...(plannedNode.modelOverride ? { modelOverride: plannedNode.modelOverride } : {}),
            }, { status: 'planned' });
            immediateHandoffTasks.push(nextTask);
            claimedPlanNodeIds.add(plannedNode.id);
          }
        }
        let queuedHandoffs = immediateHandoffTasks.length;
        let prependResult = { accepted: immediateHandoffTasks, rejected: [] };
        if (planningOnly && isOrchestrator) {
          planningDraftTasks = immediateHandoffTasks;
        } else {
          queuedHandoffs = taskQueue.prepend(immediateHandoffTasks);
          prependResult = taskQueue.getLastPrependResult();
        }
        if (!planningOnly && prependResult.rejected.length > 0) {
          loopGuardRejections.push(...prependResult.rejected);
          for (const rejection of prependResult.rejected) {
            setGraphTaskStatus(rejection.task, 'blocked', {
              blockedReason: rejection.reason === 'repeat-limit'
                ? 'repeat-limit'
                : 'duplicate-handoff',
            });
          }
        }
        const parallelHandoffTasks = prependResult.accepted;
        if (!planningOnly && agent.id === pm?.id && parallelHandoffTasks.length >= 2) {
          if (taskGraphRef.current?.approvedPlan || autoRunRef.current) {
            const safeParallelIds = findSafeAutoParallelTaskIds(taskGraphRef.current, parallelHandoffTasks);
            safeParallelIds.forEach(nodeId => requestedParallelTaskIds.add(nodeId));
            taskQueue.prioritize(safeParallelIds);
            if (safeParallelIds.length >= 2) {
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `⚡|${t('{count} unabhängige Aufgaben werden automatisch parallel ausgeführt.', { count: safeParallelIds.length })}`,
                ts: Date.now(), isError: false,
              });
            }
          } else {
            scheduleDecisionRequested = true;
          }
        }

        if (!groupPauseRequested && agent.id === pm?.id && queuedHandoffs > 0) {
          const skipFastFinalReview = useLeanFastPath &&
            task.source === 'user' &&
            queuedHandoffs === 1 &&
            !activePlanRootNodeId;
          needsSynthesis = !skipFastFinalReview;
          if (task.source === 'timeout-recovery') {
            delegatedResults.push({
              agent: agent.name,
              objective: `${task.recovery?.trigger === 'quality' ? 'Qualitäts-Recovery' : task.recovery?.trigger === 'error' ? 'Problem-Recovery' : 'Timeout-Recovery'} für ${task.recovery?.originalAgentName || 'Agent'}`,
              result: reviewEvidence,
              graphNodeId: task.graphNodeId,
            });
          }
        } else if (!groupPauseRequested && !task.preparationOnly && agent.id !== pm?.id) {
          delegatedResults.push({ agent: agent.name, objective, result: reviewEvidence, graphNodeId: task.graphNodeId });
          // A single specialist explicitly addressed by the user remains a
          // direct conversation. Multi-agent/delegated work still returns to
          // the PM for the final synthesis.
          if (shouldRequestPMFinalReview({
            pm,
            agent,
            taskSource: task.source,
            routeMode: task.routeMode || route.mode,
            explicitMentionCount: task.explicitMentionCount ?? explicitMentions.length,
            explicitlyAddressedAgentId: task.explicitlyAddressedAgentId || explicitMentions[0]?.id,
            handoffCount: handoffs.length,
            hasActivePlan: !!activePlanRootNodeId,
            useLeanFastPath,
            asksUser,
            requiresAcceptanceReview: Boolean(evidenceNode?.acceptanceCriteria?.some(criterion => criterion.required !== false)),
          })) needsSynthesis = true;
        }

        if (task.source === 'timeout-recovery-step' && task.recovery && pm) {
          const recoveryBatchId = task.recovery.batchId;
          const recoverySiblings = recoveryBatchId
            ? (taskGraphRef.current?.nodes || []).filter(node =>
              node.source === 'timeout-recovery-step' && node.recovery?.batchId === recoveryBatchId
            )
            : [];
          const allRecoveryStepsFinished = !recoveryBatchId || (
            recoverySiblings.length > 0 &&
            recoverySiblings.every(node => FINISHED_PLAN_STATUSES.has(node.status))
          );
          const reviewAlreadyQueued = recoveryBatchId && (taskGraphRef.current?.nodes || []).some(node =>
            node.source === 'timeout-recovery' &&
            node.recovery?.mode === 'review' &&
            node.recovery?.parentBatchId === recoveryBatchId
          );
          if (allRecoveryStepsFinished && !reviewAlreadyQueued) {
            const batchResults = recoverySiblings.length
              ? delegatedResults.filter(result => recoverySiblings.some(node => node.id === result.graphNodeId))
                .map(result => `${result.agent}: ${result.result}`).join('\n\n')
              : reviewEvidence;
            const recoveryReviewTask = buildTimeoutRecoveryReviewTask({
              pm,
              recovery: task.recovery,
              stepObjective: recoverySiblings.length
                ? recoverySiblings.map(node => node.title).join(', ')
                : objective,
              result: batchResults || reviewEvidence,
            });
            if (recoveryReviewTask) {
              registerGraphTask(recoveryReviewTask, { status: 'planned', parentNodeId: task.graphNodeId });
              taskQueue.prepend([recoveryReviewTask]);
            }
          }
        }

        const recoveryResolved = /\[\[RECOVERY_RESOLVED\]\]/i.test(rawReply);
        const recoveryNeedsUser = !groupPauseRequested && task.source === 'timeout-recovery' &&
          task.runtimeRecovery === true && handoffs.length === 0 && normalizedRecoveryTasks.length === 0 && !asksUser && !recoveryResolved;
        if (recoveryNeedsUser) {
          const originalAgent = chatAgents.find(candidate => candidate.id === task.recovery?.originalAgentId);
          const repeatedRecoveryTask = buildTimeoutRecoveryTask({
            pm,
            originalAgent,
            objective: task.recovery?.originalObjective || objective,
            errorMessage: displayReply,
            additionalInformation: task.recovery?.additionalInformation || '',
            previousRecovery: task.recovery,
            originalGraphNodeId: task.recovery?.originalGraphNodeId,
            planRootId: task.recovery?.planRootId || activePlanRootNodeId,
            trigger: task.recovery?.trigger || 'error',
          });
          if (repeatedRecoveryTask) {
            const registeredRecoveryTask = registerGraphTask(repeatedRecoveryTask, {
              status: 'planned',
              parentNodeId: task.graphNodeId,
            });
            taskQueue.prepend([registeredRecoveryTask]);
            commitTaskGraph(graph => updateTaskNodeStatus(
              graph,
              task.recovery.originalGraphNodeId,
              task.recovery.originalStatus || 'blocked',
              {
                recoveryStatus: 'pm',
                recoveryTaskId: registeredRecoveryTask.graphNodeId,
                recoveryError: displayReply,
              },
            ));
          } else {
            asksUser = true;
            pauseRequested = true;
            pauseQuestion = buildRecoveryUserQuestion({ recovery: task.recovery, pmReply: displayReply });
          }
        }
        const recoveredOriginalNodeId = !groupPauseRequested && task.source === 'timeout-recovery' &&
          task.runtimeRecovery === true && recoveryResolved &&
          handoffs.length === 0 && !asksUser
          ? task.recovery.originalGraphNodeId
          : '';
        if (recoveredOriginalNodeId) {
          commitTaskGraph(graph => approveAgentDoneTasks(
            recordTaskExecutionEvent(
              updateTaskNodeStatus(graph, recoveredOriginalNodeId, 'agent_done', {
                recoveredAt: Date.now(),
                recoveryStatus: null,
                recoveryTaskId: null,
                recoveryTrigger: null,
                recoveryError: undefined,
                error: undefined,
                blockedReason: undefined,
              }),
              {
                graphNodeId: recoveredOriginalNodeId,
                agent: chatAgents.find(candidate => candidate.id === task.recovery.originalAgentId),
              },
              'recovered',
              { recoveryAttempt: task.recovery.attempt },
            ),
          ));
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🧭|${t('PM hat die Recovery abgeschlossen. Die ursprüngliche Aufgabe wird im freigegebenen Workflow fortgeführt.')}`,
            ts: Date.now(), isError: false,
          });
        }

        if (asksUser && !groupPauseRequested) {
          pauseRequested = true;
          pauseQuestion = pauseQuestion || userQuestions.join('\n');
          if (task.runtimeRecovery && task.recovery?.originalGraphNodeId) {
            commitTaskGraph(graph => updateTaskNodeStatus(graph, task.recovery.originalGraphNodeId, 'waiting_user', {
              recoveryStatus: 'user',
              recoveryTaskId: task.graphNodeId,
              recoveryTrigger: task.recovery.trigger || 'timeout',
              blockedReason: 'pm-recovery-needs-user',
              issueSummary: pauseQuestion,
            }));
          }
        }

        const openPlanTaskCount = activePlanRootNodeId
          ? (taskGraphRef.current?.nodes || []).filter(node =>
            node.planRootId === activePlanRootNodeId &&
            node.id !== task.graphNodeId &&
            !FINISHED_PLAN_STATUSES.has(node.status)
          ).length
          : 0;
        const acceptanceSummary = activePlanRootNodeId
          ? summarizeAcceptance(taskGraphRef.current, activePlanRootNodeId)
          : { ready: true, unmet: [], required: 0, passed: 0 };
        const requestedProjectCompletion = /\[\[PROJECT_DONE\]\]/i.test(rawReply);
        if (requestedProjectCompletion && !acceptanceSummary.ready) {
          resumableFailure = true;
          setGraphTaskStatus(task, 'blocked', { blockedReason: 'acceptance-pending' });
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🛡️|${t('Abschluss blockiert: {count} erforderliche Abnahmekriterien sind noch nicht bestanden. Der PM muss Nachweise prüfen, Korrekturen beauftragen oder eine erforderliche User-Freigabe einholen.', { count: acceptanceSummary.unmet.length })}`,
            ts: Date.now(), isError: false,
          });
        }
        if (!groupPauseRequested && !task.preparationOnly && !planningOnly && shouldCompleteProject({
          isOrchestrator,
          source: task.source,
          reply: rawReply,
          handoffCount: handoffs.length,
          pendingTaskCount: taskQueue.length + openPlanTaskCount,
          asksUser,
          acceptanceReady: acceptanceSummary.ready,
        })) {
          projectCompleted = true;
          needsSynthesis = false;
          taskQueue.clear();
          finishRunCheckpoint();
          commitTaskGraph(graph => approveAgentDoneTasks(
            updateTaskNodeStatus(graph, task.graphNodeId, 'completed', { pmApprovedAt: Date.now() })
          ));
          if (projectPath && window.electronAPI?.projectWrite) {
            const completionContent = [
              `# ${t('Projekt abgeschlossen')}`,
              '',
              `- ${t('Gruppe: {group}', { group: chat.name })}`,
              `- ${t('Abschluss durch: {agent}', { agent: agent.name })}`,
              `- ${t('Zeitpunkt: {time}', { time: new Date().toISOString() })}`,
              `- ${t('Bearbeitete Agenten-Tasks: {count}', { count: successfulTasks })}`,
              ...(acceptanceSummary.required > 0
                ? [`- ${t('Bestandene Abnahmekriterien: {passed}/{required}', { passed: acceptanceSummary.passed, required: acceptanceSummary.required })}`]
                : []),
              '',
              `## ${t('Abschlussbericht')}`,
              '',
              displayReply,
              '',
            ].join('\n');
            const completionResult = await window.electronAPI.projectWrite({
              projectPath, filename: '.agent-teams/PROJECT_DONE.md', content: completionContent,
            });
            if (!completionResult?.success) {
              addMessage(chat.id, {
                id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
                text: `📁|${t('Abschlussbericht konnte nicht gespeichert werden — {error}', { error: completionResult?.error || t('unbekannter Fehler') })}`,
                ts: Date.now(), isError: true,
              });
            }
          }
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: projectPath
              ? `✅|${t('Projekt abgeschlossen. Dateien und Abschlussbericht liegen in {path}.', { path: projectPath })}`
              : `✅|${t('Projekt abgeschlossen. Es war kein Projektordner konfiguriert.')}`,
            ts: Date.now(), isError: false,
          });
        }
      } catch (e) {
        if (runIdRef.current !== myRunId) return;
        if (activeAgentRun.taskPaused) {
          resumableFailure = true;
          setGraphTaskStatus(task, 'paused', {
            interimResult: String(activeAgentRun.streamText || savedInterimResult || '').slice(-12000),
            interimSavedAt: Date.now(), userPausedAt: Date.now(),
          });
          return { task, agent, taskPaused: true };
        }
        const rateLimited = e.rateLimited || e.status === 429;
        const authenticationRequired = e.status === 401 && configuredAgent.provider === 'codex';
        const timedOut = isAgentTimeoutError(e);
        const qualityBlocked = e.isTaskComplexityFailure === true;
        if (!task.outOfBand) {
          setGraphTaskStatus(task, task.preparationOnly ? 'planned' : (rateLimited || authenticationRequired) ? 'provider_paused' : timedOut ? 'timed_out' : qualityBlocked ? 'blocked' : 'failed', {
            error: task.preparationOnly ? undefined : e.message,
            ...(qualityBlocked ? { blockedReason: 'quality-recovery' } : {}),
            ...(task.preparationOnly ? { preparationFailedAt: Date.now(), preparationError: e.message } : {}),
          });
          commitTaskGraph(graph => recordTaskExecutionEvent(graph, task, task.preparationOnly ? 'preparation-failed' : 'failed', { error: String(e.message || '').slice(0, 600) }));
        }
        addMessage(chat.id, {
          id: Date.now() + Math.random(),
          agentId: 'system', senderName: 'System',
          text: `${agent.name}|${e.message}`,
          ts: Date.now(), isError: true,
        });
        if (task.outOfBand || task.preparationOnly) {
          // A failed side conversation must not enqueue PM synthesis, recovery,
          // or provider checkpoints into the paused workflow. Preparation is
          // best-effort and failure never blocks the later full task.
        } else if (rateLimited || authenticationRequired) {
          taskQueue.retry(task);
          providerPauseRequested = true;
          providerRetryAfterMs = authenticationRequired ? 0 : (e.retryAfterMs || 60000);
          resumableFailure = true;
        } else if (task.runtimeRecovery && pm && agent.id === pm.id) {
          const originalAgent = chatAgents.find(candidate => candidate.id === task.recovery?.originalAgentId);
          const nextRecoveryTask = buildTimeoutRecoveryTask({
            pm,
            originalAgent,
            objective: task.recovery?.originalObjective || objective,
            errorMessage: e.message,
            additionalInformation: task.recovery?.additionalInformation || '',
            previousRecovery: task.recovery,
            originalGraphNodeId: task.recovery?.originalGraphNodeId,
            planRootId: task.recovery?.planRootId || activePlanRootNodeId,
            trigger: task.recovery?.trigger || 'error',
          });
          if (nextRecoveryTask) {
            const registeredRecoveryTask = registerGraphTask(nextRecoveryTask, {
              status: 'planned',
              parentNodeId: task.graphNodeId,
            });
            taskQueue.prepend([registeredRecoveryTask]);
            commitTaskGraph(graph => updateTaskNodeStatus(
              graph,
              task.recovery.originalGraphNodeId,
              task.recovery.originalStatus || 'blocked',
              {
                recoveryStatus: 'pm',
                recoveryTaskId: registeredRecoveryTask.graphNodeId,
                recoveryError: e.message,
              },
            ));
          } else {
            pauseRequested = true;
            pauseQuestion = buildRecoveryUserQuestion({
              recovery: task.recovery,
              errorMessage: e.message,
            });
            if (task.recovery?.originalGraphNodeId) {
              commitTaskGraph(graph => updateTaskNodeStatus(graph, task.recovery.originalGraphNodeId, 'waiting_user', {
                recoveryStatus: 'user',
                recoveryTaskId: task.graphNodeId,
                recoveryTrigger: task.recovery.trigger || 'error',
                recoveryError: e.message,
                blockedReason: 'pm-recovery-needs-user',
                issueSummary: pauseQuestion,
              }));
            }
          }
        } else if (pm && agent.id !== pm.id) {
          const problemTrigger = qualityBlocked ? 'quality' : timedOut ? 'timeout' : task.recovery?.trigger || 'error';
          delegatedResults.push({
            agent: agent.name,
            objective,
            result: `${problemTrigger === 'quality' ? 'QUALITÄTSPROBLEM' : problemTrigger === 'timeout' ? 'TIMEOUT' : 'AUSFÜHRUNGSPROBLEM'}: ${e.message}`,
            graphNodeId: task.graphNodeId,
          });
          needsSynthesis = true;
          const originalAgent = task.recovery
            ? chatAgents.find(candidate => candidate.id === task.recovery.originalAgentId) || agent
            : agent;
          const originalGraphNodeId = task.recovery?.originalGraphNodeId || task.graphNodeId;
          const nextRecoveryAttempt = Math.min(
            MAX_PM_RECOVERY_ATTEMPTS,
            (task.recovery?.attempt || 0) + 1,
          );
          commitTaskGraph(graph => invalidateTaskRecoveryBranch(
            appendTaskRecoveryNote(graph, originalGraphNodeId, {
              author: 'System',
              mode: 'runtime-recovery',
              problem: e.message,
              text: `Automatische ${problemTrigger}-Recovery nach fehlgeschlagener Agentenausführung.`,
            }),
            originalGraphNodeId,
            { recoveryAttempt: nextRecoveryAttempt, reason: e.message },
          ));
          const recoveryTask = buildTimeoutRecoveryTask({
            pm,
            originalAgent,
            objective,
            errorMessage: e.message,
            previousRecovery: task.recovery,
            originalGraphNodeId,
            planRootId: task.planRootId || task.recovery?.planRootId || activePlanRootNodeId,
            trigger: problemTrigger,
          });
          if (recoveryTask) {
            const registeredRecoveryTask = registerGraphTask(recoveryTask, { status: 'planned', parentNodeId: task.graphNodeId });
            taskQueue.prepend([registeredRecoveryTask]);
            if (originalGraphNodeId) {
              commitTaskGraph(graph => updateTaskNodeStatus(graph, originalGraphNodeId, recoveryTask.recovery?.originalStatus || (timedOut ? 'timed_out' : 'blocked'), {
                recoveryStatus: 'pm',
                recoveryTaskId: registeredRecoveryTask.graphNodeId,
                recoveryTrigger: recoveryTask.recovery?.trigger || problemTrigger,
              }));
            }
          } else {
            pauseRequested = true;
            pauseQuestion = buildRecoveryUserQuestion({
              recovery: task.recovery || {
                originalAgentName: originalAgent.name,
                originalObjective: objective,
                attempt: MAX_PM_RECOVERY_ATTEMPTS,
                trigger: problemTrigger,
              },
              errorMessage: e.message,
            });
            commitTaskGraph(graph => updateTaskNodeStatus(graph, originalGraphNodeId, 'waiting_user', {
              recoveryStatus: 'user',
              recoveryTrigger: problemTrigger,
              recoveryError: e.message,
              blockedReason: 'pm-recovery-needs-user',
              issueSummary: pauseQuestion,
            }));
          }
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🧭|${problemTrigger === 'quality'
              ? t('PM übernimmt die Qualitäts-Recovery für {agent}: Aufgabe verkleinern und schrittweise mit erneuter Qualitätsprüfung ausführen.', { agent: originalAgent.name })
              : problemTrigger === 'timeout'
                ? t('PM übernimmt sofort die Timeout-Recovery für {agent}: Aufgabe untersuchen, verkleinern und schrittweise neu vergeben.', { agent: originalAgent.name })
                : t('PM übernimmt die Problem-Recovery für {agent}: Ursache prüfen und einen sicheren kleineren Lösungsschritt planen.', { agent: originalAgent.name })}`,
            ts: Date.now(), isError: false,
          });
        } else if (taskGraphRef.current?.approvedPlan) {
          // Without an available PM, or when the PM's own approved task fails,
          // the user becomes the final decision authority.
          pauseRequested = true;
          pauseQuestion = buildRecoveryUserQuestion({
            recovery: task.recovery || {
              trigger: timedOut ? 'timeout' : qualityBlocked ? 'quality' : 'error',
              originalObjective: objective,
            },
            errorMessage: e.message,
          });
          setGraphTaskStatus(task, 'waiting_user', {
            blockedReason: 'pm-recovery-needs-user',
            issueSummary: pauseQuestion,
          });
          needsSynthesis = false;
        } else if (agent.id === pm?.id) {
          resumableFailure = true;
        } else if (pm) {
          delegatedResults.push({
            agent: agent.name,
            objective,
            result: `FEHLER: ${e.message}`,
            graphNodeId: task.graphNodeId,
          });
          needsSynthesis = true;
        }
      } finally {
        if (activeAgentRun.taskPaused) setGraphTaskStatus(task, 'paused', { userPausedAt: Date.now() });
        releaseAgentLease();
        setTypingAgents(prev => prev.filter(id => id !== agent.id));
        if (activeAgentRunRef.current.has(agentRequestId)) {
          activeAgentRunRef.current.delete(agentRequestId);
          setAgentProgress(previous => {
            const next = { ...previous };
            delete next[agent.id];
            return next;
          });
        }
      }

      return {
        task,
        agent,
        pauseRequested,
        pauseQuestion,
        scheduleDecisionRequested,
        providerPauseRequested,
        providerRetryAfterMs,
        groupPauseRequested,
        groupPauseRequests,
        interimResult: savedInterimResult,
      };
    };

    const enqueueReadyApprovedWorkflowTasks = (excludedNodeIds = new Set()) => {
      const currentGraph = taskGraphRef.current;
      if (planningOnly || !currentGraph?.approvedPlan || !activePlanRootNodeId) return [];
      const queuedNodeIds = new Set(taskQueue.pendingTasks().map(pendingTask => pendingTask.graphNodeId).filter(Boolean));
      const readyNodes = (currentGraph.nodes || [])
        .filter(node =>
          node.planRootId === activePlanRootNodeId &&
          inferTaskNodeType(node) !== 'request' &&
          CLAIMABLE_PLAN_STATUSES.has(node.status) &&
          !queuedNodeIds.has(node.id) &&
          !excludedNodeIds.has(node.id) &&
          isTaskNodeReady(currentGraph, node.id)
        )
        .sort(compareTicketPriority);
      const acceptedTasks = [];
      for (const plannedNode of readyNodes) {
        const target = chatAgents.find(candidate => candidate.id === plannedNode.agentId);
        if (!target) continue;
        const runtimeRecovery = plannedNode.runtimeRecovery === true && String(plannedNode.source || '').startsWith('timeout-recovery');
        const approvedNode = currentGraph.approvedPlan.nodes.find(node => node.id === plannedNode.id);
        const approvedModel = approvedNode?.modelOverride || approvedNode?.model;
        const relevantResultNodeIds = workflowDependencyAncestorIds(currentGraph, plannedNode.id);
        const relevantResults = delegatedResults
          .filter(result => relevantResultNodeIds.has(result.graphNodeId))
          .slice(-12);
        const preparedFinding = plannedNode.interimResult
          ? [`Zwischengespeicherte Vorarbeit dieser Aufgabe: ${String(plannedNode.interimResult).slice(0, 12000)}`]
          : [];
        const handoff = createHandoff({
          from: runtimeRecovery ? 'Timeout-Wächter' : 'Workflow-Scheduler',
          to: target.name,
          taskId: `approved-${plannedNode.planTaskId || plannedNode.id}`,
          summary: plannedNode.objective || plannedNode.title,
          findings: [
            ...preparedFinding,
            ...relevantResults.map(item => `${item.agent}: ${String(item.result || '').slice(0, 6000)}`),
          ],
        });
        const readyTask = registerGraphTask({
          agent: target,
          objective: plannedNode.objective || plannedNode.title,
          handoff,
          source: runtimeRecovery ? plannedNode.source : 'approved-workflow',
          ...(runtimeRecovery ? { runtimeRecovery: true, recovery: plannedNode.recovery } : {}),
          graphNodeId: plannedNode.id,
          planRootId: activePlanRootNodeId,
          planTaskId: plannedNode.planTaskId,
          ...(approvedModel ? { modelOverride: approvedModel } : {}),
        }, { status: plannedNode.status });
        if (taskQueue.enqueue(readyTask)) acceptedTasks.push(readyTask);
      }
      return acceptedTasks;
    };

    const enqueueDependencyPreparationTasks = ({
      activeNodeIds = new Set(),
      activeAgentIds = new Set(),
      limit = 2,
    } = {}) => {
      const currentGraph = taskGraphRef.current;
      if (planningOnly || !currentGraph?.approvedPlan || !activePlanRootNodeId) return [];
      const pendingTasks = taskQueue.pendingTasks();
      const queuedNodeIds = new Set(pendingTasks.map(pendingTask => pendingTask.graphNodeId).filter(Boolean));
      const queuedAgentIds = new Set(pendingTasks.map(pendingTask => pendingTask.agent?.id).filter(Boolean));
      const candidateIds = findDependencyPreparationCandidateIds(currentGraph, {
        activeNodeIds: [...activeNodeIds],
        activeAgentIds: [...activeAgentIds, ...queuedAgentIds],
        queuedNodeIds: [...queuedNodeIds],
        limit,
      });
      const preparationTasks = [];
      for (const nodeId of candidateIds) {
        const plannedNode = currentGraph.nodes.find(node => node.id === nodeId);
        const target = chatAgents.find(candidate => candidate.id === plannedNode?.agentId);
        if (!plannedNode || !target || plannedNode.planRootId !== activePlanRootNodeId) continue;
        const approvedNode = currentGraph.approvedPlan.nodes.find(node => node.id === nodeId);
        const approvedModel = approvedNode?.modelOverride || approvedNode?.model;
        const taskObjective = plannedNode.objective || plannedNode.title;
        const handoff = createHandoff({
          from: 'Workflow-Scheduler',
          to: target.name,
          taskId: `prepare-${plannedNode.planTaskId || plannedNode.id}`,
          summary: `Sichere Vorarbeit für die freigegebene Aufgabe „${taskObjective}“ erstellen. Bearbeite ausschließlich Teile, die ohne die noch laufenden Vorgängerergebnisse korrekt und reversibel vorbereitet werden können.`,
          findings: ['Die eigentliche Aufgabe bleibt blockiert, bis alle freigegebenen Abhängigkeiten abgeschlossen sind.'],
        });
        const preparationTask = registerGraphTask({
          agent: target,
          objective: handoff.summary,
          handoff,
          source: 'dependency-preparation',
          preparationOnly: true,
          approvedContinuation: true,
          graphNodeId: plannedNode.id,
          planRootId: activePlanRootNodeId,
          planTaskId: plannedNode.planTaskId,
          ...(approvedModel ? { modelOverride: approvedModel } : {}),
        }, { status: plannedNode.status });
        if (taskQueue.enqueue(preparationTask)) preparationTasks.push(preparationTask);
      }
      return preparationTasks;
    };

    const runWorkConservingApprovedBatch = initialTasks => runTaskPool({
      initialTasks,
      execute: nextTask => {
        requestedParallelTaskIds.delete(nextTask.graphNodeId);
        return executeAgentTask(nextTask);
      },
      shouldStop: () => projectCompleted || runIdRef.current !== myRunId,
      stopAfter: execution => !execution || execution.pauseRequested || execution.scheduleDecisionRequested || execution.providerPauseRequested,
      claim: ({ activeNodeIds, activeAgentIds }) => {
        enqueueReadyApprovedWorkflowTasks(activeNodeIds);
        enqueueDependencyPreparationTasks({ activeNodeIds, activeAgentIds });
        return taskQueue.nextMatching(candidate => !activeAgentIds.has(candidate.agent.id)
          && !hasTaskResourceConflict(taskGraphRef.current, candidate.graphNodeId, activeNodeIds)
          && (candidate.outOfBand || validateApprovedTaskExecution(taskGraphRef.current, candidate).ok));
      },
      onSnapshot: activeTasks => {
        if (runIdRef.current !== myRunId) return;
        persistRunCheckpoint({
          status: 'running', pendingTasks: [...activeTasks, ...taskQueue.pendingTasks()],
          parallelTaskIds: activeTasks.length >= 2 ? activeTasks.map(task => task.graphNodeId).filter(Boolean) : [],
          initialObjective, needsSynthesis, synthesisCount, delegatedResults: [...delegatedResults], successfulTasks,
          queueGuard: taskQueue.guardState(), planRootGraphNodeId: activePlanRootNodeId,
        });
      },
    });

    while ((task = taskQueue.next())) {
      if (['paused', 'pausing'].includes(taskGraphRef.current?.nodes?.find(node => node.id === task.graphNodeId)?.status)) {
        resumableFailure = true;
        continue;
      }
      const taskBatch = [task];
      const startsSelectedParallelBatch = requestedParallelTaskIds.has(task.graphNodeId);
      if (startsSelectedParallelBatch) {
        requestedParallelTaskIds.delete(task.graphNodeId);
        // Selected tasks were stably sorted to the front while restoring the
        // checkpoint. Peek before next() so unrelated sequential work is never
        // accidentally pulled into this batch.
        while (requestedParallelTaskIds.size > 0 && taskQueue.length > 0) {
          const nextPendingTask = taskQueue.pendingTasks()[0];
          if (!requestedParallelTaskIds.has(nextPendingTask?.graphNodeId)) break;
          const parallelTask = taskQueue.next();
          if (!parallelTask) break;
          requestedParallelTaskIds.delete(parallelTask.graphNodeId);
          if (['paused', 'pausing'].includes(taskGraphRef.current?.nodes?.find(node => node.id === parallelTask.graphNodeId)?.status)) continue;
          taskBatch.push(parallelTask);
        }
      }

      const authorizationFailure = taskBatch
        .map(candidate => ({
          task: candidate,
          validation: candidate.outOfBand
            ? { ok: true, mode: 'side-conversation' }
            : validateApprovedTaskExecution(taskGraphRef.current, candidate),
        }))
        .find(item => !item.validation.ok);
      if (authorizationFailure) {
        const rejectedTask = authorizationFailure.task;
        if (rejectedTask?.graphNodeId && taskGraphRef.current?.nodes?.some(node => node.id === rejectedTask.graphNodeId)) {
          const belongsToContract = taskGraphRef.current?.approvedPlan?.nodes?.some(node => node.id === rejectedTask.graphNodeId);
          commitTaskGraph(graph => belongsToContract
            ? updateTaskNodeStatus(graph, rejectedTask.graphNodeId, 'waiting_user', {
              blockedReason: 'contract-violation',
              issueSummary: authorizationFailure.validation.reason,
            })
            : removePlanningTask(graph, rejectedTask.graphNodeId));
        }
        const attentionCheckpoint = {
          mode: 'execution',
          status: 'needs-attention',
          pendingTasks: [],
          parallelTaskIds: [],
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        };
        persistRunCheckpoint(attentionCheckpoint);
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🛡️|${t('Eine nicht freigegebene Workflowaktion wurde blockiert: {reason} Der Plan blieb unverändert. Nur der User kann eine neue Planversion anlegen.', { reason: authorizationFailure.validation.reason })}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      const remainingBatchTasks = new Map(taskBatch.map(batchTask => [batchTask.graphNodeId, batchTask]));
      persistRunCheckpoint({
        status: 'running',
        pendingTasks: [...taskBatch, ...taskQueue.pendingTasks()],
        parallelTaskIds: startsSelectedParallelBatch ? taskBatch.map(batchTask => batchTask.graphNodeId) : [],
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
      });

      const executions = !planningOnly && taskGraphRef.current?.approvedPlan
        ? await runWorkConservingApprovedBatch(taskBatch)
        : await runTaskBatch(taskBatch, async batchTask => {
          const execution = await executeAgentTask(batchTask);
          if (execution && runIdRef.current === myRunId) {
            remainingBatchTasks.delete(batchTask.graphNodeId);
            // Persist after every settled task. If another parallel agent is
            // interrupted, already completed siblings are not repeated later.
            const unfinishedBatch = [...remainingBatchTasks.values()];
            persistRunCheckpoint({
              status: 'running',
              pendingTasks: [...unfinishedBatch, ...taskQueue.pendingTasks()],
              parallelTaskIds: startsSelectedParallelBatch
                ? unfinishedBatch.map(pendingTask => pendingTask.graphNodeId)
                : [],
              initialObjective,
              needsSynthesis,
              synthesisCount,
              delegatedResults: [...delegatedResults],
              successfulTasks,
              queueGuard: taskQueue.guardState(),
              planRootGraphNodeId: activePlanRootNodeId,
            });
          }
          return execution;
        });
      if (executions.some(execution => !execution)) {
        setRunning(false);
        return;
      }
      const groupPauseExecutions = executions.filter(execution => execution.groupPauseRequested);
      const delegationApprovalExecutions = executions.filter(execution => execution.delegationApprovalRequested);
      const delegationUnavailableExecutions = executions.filter(execution => execution.delegationUnavailable);
      for (const execution of groupPauseExecutions) {
        const requests = execution.groupPauseRequests || [];
        const batchId = requests[0]?.batchId;
        if (!batchId || retainedGroupWaits.some(wait => wait.batchId === batchId)) continue;
        retainedGroupWaits.push({
          batchId,
          requestIds: requests.map(request => request.id),
          targetGroupIds: requests.map(request => request.targetGroupId),
          targetGroupNames: requests.map(request => request.targetGroupName),
          kind: requests.some(request => request.kind === 'task_delegation') ? 'task_delegation' : 'consultation',
          task: execution.task,
          interimResult: execution.interimResult || '',
          createdAt: Date.now(),
        });
      }
      for (const execution of delegationApprovalExecutions) {
        if (retainedDelegationWaits.some(wait => wait.taskId === execution.task.graphNodeId)) continue;
        retainedDelegationWaits.push({
          taskId: execution.task.graphNodeId,
          task: execution.task,
          proposal: execution.delegationProposal,
          createdAt: Date.now(),
        });
      }
      if (planningOnly) {
        const planningProviderPause = executions.find(execution => execution.providerPauseRequested);
        if (planningProviderPause) {
          const requiresLogin = planningProviderPause.providerRetryAfterMs <= 0;
          persistRunCheckpoint({
            status: requiresLogin ? 'provider-auth-required' : 'provider-limited',
            pendingTasks: taskQueue.pendingTasks(),
            initialObjective,
            needsSynthesis: false,
            synthesisCount,
            delegatedResults: [],
            successfulTasks: 0,
            queueGuard: taskQueue.guardState(),
            planRootGraphNodeId: activePlanRootNodeId,
            limitedProvider: planningProviderPause.agent.provider,
            limitedAgentId: planningProviderPause.agent.id,
            ...(requiresLogin ? {} : {
              retryAfterMs: planningProviderPause.providerRetryAfterMs,
              retryNotBefore: Date.now() + planningProviderPause.providerRetryAfterMs,
            }),
          });
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: requiresLogin
              ? `🔑|${t('Der Workflow wartet auf die Codex-Anmeldung. Öffne Einstellungen → API-Zugang, verbinde Codex und klicke danach auf „Workflow fortsetzen“.')}`
              : `⏳|${t('Der Planungstask bleibt wegen des Provider-Limits in der Warteschlange.')}`,
            ts: Date.now(), isError: false,
          });
          setRunning(false);
          return;
        }
        const planningPause = executions.find(execution => execution.pauseRequested);
        const pauseQuestion = planningPause?.pauseQuestion || '';
        if (planningPause) setGraphTaskStatus(planningPause.task, 'waiting_user');
        persistRunCheckpoint({
          status: planningPause ? 'awaiting-user' : groupPauseExecutions.length > 0 ? 'awaiting-group' : 'planning',
          ...(planningPause ? {
            askingAgent: planningPause.agent,
            askingGraphNodeId: planningPause.task.graphNodeId,
            question: pauseQuestion,
          } : {}),
          pendingTasks: planningDraftTasks,
          initialObjective,
          needsSynthesis: planningDraftTasks.length > 0,
          synthesisCount,
          delegatedResults: [],
          successfulTasks: 0,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        if (planningPause) {
          const questionList = pauseQuestion
            .split('\n')
            .map(question => question.trim())
            .filter(Boolean)
            .map(question => `• ${question}`)
            .join('\n');
          setStoppedForUser(true);
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `💬|${t('{agent} wartet auf deine Antwort:', { agent: planningPause.agent.name })}\n\n${questionList || `• ${t('Bitte beantworte die Rückfrage des Agenten.')}`}\n\n${t('Antworte einfach im Eingabefeld – danach läuft die Agenten-Konversation weiter.')}`,
            ts: Date.now(), isError: false,
          });
        }
        setRunning(false);
        return;
      }
      const pauseExecution = executions.find(execution => execution.pauseRequested);
      const scheduleExecution = executions.find(execution => execution.scheduleDecisionRequested);
      const providerPauseExecution = executions.find(execution => execution.providerPauseRequested);
      const lastExecution = executions.at(-1);
      const { agent } = providerPauseExecution || pauseExecution || scheduleExecution || lastExecution;
      task = (providerPauseExecution || pauseExecution || scheduleExecution || lastExecution).task;

      if (projectCompleted) {
        setRunning(false);
        return;
      }

      if (providerPauseExecution) {
        if (providerPauseExecution.providerRetryAfterMs <= 0) {
          persistRunCheckpoint({
            status: 'provider-auth-required',
            pendingTasks: taskQueue.pendingTasks(),
            initialObjective,
            needsSynthesis,
            synthesisCount,
            delegatedResults: [...delegatedResults],
            successfulTasks,
            queueGuard: taskQueue.guardState(),
            planRootGraphNodeId: activePlanRootNodeId,
            limitedProvider: agent.provider,
            limitedAgentId: agent.id,
          });
          addMessage(chat.id, {
            id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
            text: `🔑|${t('Der Task bleibt gespeichert. Verbinde Codex unter Einstellungen → API-Zugang und klicke danach auf „Workflow fortsetzen“.')}`,
            ts: Date.now(), isError: false,
          });
          setRunning(false);
          return;
        }
        const retrySeconds = Math.max(1, Math.ceil(providerPauseExecution.providerRetryAfterMs / 1000));
        persistRunCheckpoint({
          status: 'provider-limited',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
          limitedProvider: agent.provider,
          limitedAgentId: agent.id,
          retryAfterMs: providerPauseExecution.providerRetryAfterMs,
          retryNotBefore: Date.now() + providerPauseExecution.providerRetryAfterMs,
        });
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `⏳|${t('{agent}s Task bleibt in der Warteschlange. Frühestens in etwa {seconds}s fortsetzen; bereits fertige Parallel-Tasks werden nicht wiederholt.', { agent: agent.name, seconds: retrySeconds })}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (pauseExecution) {
        const { pauseQuestion } = pauseExecution;
        setGraphTaskStatus(task, 'waiting_user');
        const questionList = pauseQuestion
          .split('\n')
          .map(question => question.trim())
          .filter(Boolean)
          .map(question => `• ${question}`)
          .join('\n');
        persistRunCheckpoint({
          status: 'awaiting-user',
          askingAgent: agent,
          askingGraphNodeId: task.graphNodeId,
          question: pauseQuestion,
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setStoppedForUser(true);
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `💬|${t('{agent} wartet auf deine Antwort:', { agent: agent.name })}\n\n${questionList || `• ${t('Bitte beantworte die Rückfrage des Agenten.')}`}\n\n${t('Antworte einfach im Eingabefeld – danach läuft die Agenten-Konversation weiter.')}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (scheduleExecution) {
        persistRunCheckpoint({
          status: 'awaiting-schedule',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🗺️|${t('Der Aufgabenplan ist bereit. Prüfe ihn im Workflowfenster und starte die laut Abhängigkeiten bereiten Aufgaben.')}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (delegationUnavailableExecutions.length > 0) {
        persistRunCheckpoint({
          status: 'needs-attention',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setRunning(false);
        return;
      }

      if (delegationApprovalExecutions.length > 0) {
        persistRunCheckpoint({
          status: 'awaiting-delegation',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setRunning(false);
        return;
      }

      if (groupPauseExecutions.length > 0) {
        persistRunCheckpoint({
          status: 'awaiting-group',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setRunning(false);
        return;
      }

      // A locked workflow advances from the approved graph itself. The PM may
      // describe work, but cannot silently redefine which task runs next.
      if (taskQueue.length === 0 && needsSynthesis && taskGraphRef.current?.approvedPlan && activePlanRootNodeId) {
        const approvedTasks = enqueueReadyApprovedWorkflowTasks();
        if (approvedTasks.length > 0) {
          const safeParallelIds = findSafeAutoParallelTaskIds(taskGraphRef.current, approvedTasks);
          safeParallelIds.forEach(nodeId => requestedParallelTaskIds.add(nodeId));
          taskQueue.prioritize(safeParallelIds);
        }
      }

      if (taskQueue.length === 0 && needsSynthesis && taskGraphRef.current?.approvedPlan) {
        const openContractNodes = (taskGraphRef.current.nodes || []).filter(node =>
          node.planRootId === activePlanRootNodeId &&
          inferTaskNodeType(node) !== 'request' &&
          !FINISHED_PLAN_STATUSES.has(node.status)
        );
        resumableFailure = openContractNodes.length > 0;
        needsSynthesis = false;
        if (resumableFailure) {
          persistRunCheckpoint({
            status: retainedDelegationWaits.length > 0
              ? 'awaiting-delegation'
              : retainedGroupWaits.length > 0
                ? 'awaiting-group'
                : 'needs-attention',
            pendingTasks: [],
            initialObjective,
            needsSynthesis: false,
            synthesisCount,
            delegatedResults: [...delegatedResults],
            successfulTasks,
            queueGuard: taskQueue.guardState(),
            planRootGraphNodeId: activePlanRootNodeId,
          });
        } else {
          delegatedResults.length = 0;
        }
      }

      // Free mode retains dynamic PM synthesis. Approved workflows execute only
      // user-authored nodes; even the PM cannot create a hidden review task.
      if (taskQueue.length === 0 && needsSynthesis && pm && delegatedResults.length > 0 && !taskGraphRef.current?.approvedPlan) {
        synthesisCount += 1;
        const reviewDependencyIds = [...new Set(delegatedResults.map(item => item.graphNodeId).filter(Boolean))];
        const synthesisHandoff = createHandoff({
          from: `Team-Runde-${synthesisCount}`,
          to: pm.name,
          taskId: `synthesis-${Date.now().toString(36)}`,
          summary: `Final-Review: Prüfe alle Ergebnisse gegen die ursprüngliche User-Anforderung "${initialObjective}". Falls etwas offen ist, delegiere es konkret an den zuständigen Agenten. Falls alles erfüllt ist, gib den Abschluss an den User und beende mit [[PROJECT_DONE]].`,
          findings: delegatedResults.slice(-12).map(item => `${item.agent} | Aufgabe: ${item.objective} | Ergebnis: ${String(item.result || '').slice(0, 6000)}`),
        });
        const synthesisTask = registerGraphTask({
          agent: pm,
          objective: synthesisHandoff.summary,
          handoff: synthesisHandoff,
          source: 'team-synthesis',
          planRootId: activePlanRootNodeId,
        }, {
          status: 'planned',
          parentNodeId: reviewDependencyIds.length ? null : task.graphNodeId,
        });
        if (reviewDependencyIds.length > 0) {
          commitTaskGraph(graph => reviewDependencyIds.reduce((nextGraph, dependencyNodeId) =>
            addTaskEdge(nextGraph, { from: dependencyNodeId, to: synthesisTask.graphNodeId, kind: 'review' }),
          graph));
        }
        taskQueue.enqueue(synthesisTask);
        delegatedResults.length = 0;
        needsSynthesis = false;
      }

      if (taskQueue.length > 0) {
        persistRunCheckpoint({
          status: 'running',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
      } else if (!resumableFailure) {
        // Mark the just-finished task as consumed before the final cleanup, so
        // an app shutdown in this small window cannot execute it a second time.
        persistRunCheckpoint({
          status: 'running',
          pendingTasks: [],
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
      }
    }

    // A bounded run segment never ends without PM supervision. The PM gets
    // one extra review task outside the normal queue budget and may either
    // approve completion or define one smaller next step. Remaining work is
    // checkpointed for an explicit resume, which keeps the loop guard intact.
    if (taskQueue.reachedLimit && chat.type === 'group' && pm && conversationLimits.pmReviewOnLimit) {
      const pendingAtLimit = taskQueue.pendingTasks();
      if (taskGraphRef.current?.approvedPlan) {
        persistRunCheckpoint({
          status: 'limit-reached',
          pendingTasks: pendingAtLimit,
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
          completedSegmentTurns: conversationLimits.maxTurns,
        });
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `💾|${t('Der freigegebene Workflow wurde an der Laufgrenze sicher pausiert. Mit „Fortsetzen“ läuft derselbe Plan weiter.', { count: conversationLimits.maxTurns })}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🧭|${t('Laufgrenze nach {count} Agenten-Tasks erreicht. Der PM prüft jetzt Abschluss und offene Arbeit.', { count: conversationLimits.maxTurns })}`,
        ts: Date.now(), isError: false,
      });
      const limitReviewDraft = buildTurnLimitReviewTask({
        pm,
        initialObjective,
        maxTurns: conversationLimits.maxTurns,
        pendingTasks: pendingAtLimit,
        delegatedResults,
      });
      const limitReviewTask = registerGraphTask(limitReviewDraft, { status: 'planned' });
      const reviewExecution = await executeAgentTask(limitReviewTask);
      if (!reviewExecution || runIdRef.current !== myRunId) {
        setRunning(false);
        return;
      }
      if (projectCompleted) {
        setRunning(false);
        return;
      }

      if (reviewExecution.providerPauseRequested) {
        const retrySeconds = Math.max(1, Math.ceil(reviewExecution.providerRetryAfterMs / 1000));
        persistRunCheckpoint({
          status: 'provider-limited',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
          limitedProvider: pm.provider,
          limitedAgentId: pm.id,
          retryAfterMs: reviewExecution.providerRetryAfterMs,
          retryNotBefore: Date.now() + reviewExecution.providerRetryAfterMs,
        });
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `⏳|${t('Die PM-Grenzprüfung wurde gespeichert und kann in etwa {seconds}s fortgesetzt werden.', { seconds: retrySeconds })}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (reviewExecution.pauseRequested) {
        const pauseQuestion = reviewExecution.pauseQuestion || '';
        const questionList = pauseQuestion
          .split('\n')
          .map(question => question.trim())
          .filter(Boolean)
          .map(question => `• ${question}`)
          .join('\n');
        setGraphTaskStatus(limitReviewTask, 'waiting_user');
        persistRunCheckpoint({
          status: 'awaiting-user',
          askingAgent: pm,
          askingGraphNodeId: limitReviewTask.graphNodeId,
          question: pauseQuestion,
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        setStoppedForUser(true);
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `💬|${t('{agent} wartet auf deine Antwort:', { agent: pm.name })}\n\n${questionList || `• ${t('Bitte beantworte die Rückfrage des Agenten.')}`}\n\n${t('Antworte einfach im Eingabefeld – danach läuft die Agenten-Konversation weiter.')}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      if (reviewExecution.scheduleDecisionRequested) {
        persistRunCheckpoint({
          status: 'awaiting-schedule',
          pendingTasks: taskQueue.pendingTasks(),
          initialObjective,
          needsSynthesis,
          synthesisCount,
          delegatedResults: [...delegatedResults],
          successfulTasks,
          queueGuard: taskQueue.guardState(),
          planRootGraphNodeId: activePlanRootNodeId,
        });
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `🗺️|${t('Der Aufgabenplan ist bereit. Prüfe ihn im Workflowfenster und starte die laut Abhängigkeiten bereiten Aufgaben.')}`,
          ts: Date.now(), isError: false,
        });
        setRunning(false);
        return;
      }

      const pendingAfterReview = taskQueue.pendingTasks();
      persistRunCheckpoint({
        status: 'limit-reached',
        pendingTasks: pendingAfterReview,
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
        completedSegmentTurns: conversationLimits.maxTurns,
      });
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `💾|${t('Laufgrenze nach {count} Agenten-Tasks erreicht. Der Arbeitsstand und {pending} offene Aufgabe(n) wurden gespeichert. Mit „Fortsetzen“ beginnt das nächste Laufsegment.', {
          count: conversationLimits.maxTurns,
          pending: pendingAfterReview.length,
        })}`,
        ts: Date.now(), isError: false,
      });
      setRunning(false);
      return;
    }

    if (loopGuardRejections.length > 0) {
      finishRunCheckpoint();
      const affectedAgents = [...new Set(loopGuardRejections
        .map(rejection => rejection.task?.agent?.name)
        .filter(Boolean))];
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `🛑|${t('Wiederholungsschleife gestoppt: {agents} sollte eine bereits erledigte Dateiaufgabe erneut erhalten. Die doppelte Übergabe wurde blockiert; vorhandene Dateien und Zwischenstände bleiben erhalten.', { agents: affectedAgents.join(', ') || t('Ein Agent') })}`,
        ts: Date.now(), isError: false,
      });
    } else if (taskQueue.reachedLimit) {
      const pendingTasks = taskQueue.pendingTasks();
      persistRunCheckpoint({
        status: 'limit-reached',
        pendingTasks,
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
        completedSegmentTurns: conversationLimits.maxTurns,
      });
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `💾|${t('Laufgrenze nach {count} Agenten-Tasks erreicht. Der Arbeitsstand wurde gespeichert. Mit „Fortsetzen“ kann der PM die offene Arbeit prüfen.', { count: conversationLimits.maxTurns })}`,
        ts: Date.now(), isError: false,
      });
    } else if (retainedDelegationWaits.length > 0) {
      persistRunCheckpoint({
        status: 'awaiting-delegation',
        pendingTasks: taskQueue.pendingTasks(),
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
      });
    } else if (retainedGroupWaits.length > 0) {
      persistRunCheckpoint({
        status: 'awaiting-group',
        pendingTasks: taskQueue.pendingTasks(),
        initialObjective,
        needsSynthesis,
        synthesisCount,
        delegatedResults: [...delegatedResults],
        successfulTasks,
        queueGuard: taskQueue.guardState(),
        planRootGraphNodeId: activePlanRootNodeId,
      });
    } else if (resumableFailure) {
      addMessage(chat.id, {
        id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
        text: `⏸|${t('Der Arbeitsstand wurde gespeichert. Du kannst den Lauf mit „Fortsetzen“ an derselben Stelle erneut starten.')}`,
        ts: Date.now(), isError: false,
      });
    } else if (successfulTasks > 0) {
      finishRunCheckpoint();
      if (chat.type === 'group' && !sideConversation) {
        addMessage(chat.id, {
          id: Date.now() + Math.random(), agentId: 'system', senderName: 'System',
          text: `✅|${t(
            projectPath
              ? (successfulTasks === 1
                ? 'Agentenlauf beendet. {count} Task abgeschlossen; Zwischenstände wurden in {path} gespeichert.'
                : 'Agentenlauf beendet. {count} Tasks abgeschlossen; Zwischenstände wurden in {path} gespeichert.')
              : (successfulTasks === 1
                ? 'Agentenlauf beendet. {count} Task abgeschlossen.'
                : 'Agentenlauf beendet. {count} Tasks abgeschlossen.'),
            { count: successfulTasks, path: projectPath },
          )}`,
          ts: Date.now(), isError: false,
        });
      }
    } else {
      finishRunCheckpoint();
    }
    setRunning(false);
  }, [apiKeys, providerConnections, chatAgents, groups, conversationStates, kbPath, projectPath, memoryEnabled, memoryConfig?.namespace, memoryAPI, mcpServers, chat, qualityRouting, conversationLimits, recordQualityEvent, refreshMemoryCount, addMessage, enqueueCrossGroupRequest, requestMcpPermission, handleMcpPermissionConsumed, handleMcpToolResult, persistConversationCheckpoint, discardConversationCheckpoint, commitTaskGraph, registerGraphTask, setGraphTaskStatus, language, t]);
}
