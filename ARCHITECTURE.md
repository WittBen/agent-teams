# Architecture

Agent Teams is a local-first Electron application with a React renderer and a
Node.js main process.

## Process boundary

- The React renderer owns presentation and ordinary conversation state.
- The preload bridge exposes a small, named IPC surface. It does not expose
  Node.js primitives or a generic key/value store.
- The Electron main process owns provider credentials, MCP execution, file
  access, native dialogs, attachments, and the optional local REST API.
- Provider secrets are encrypted with Electron `safeStorage` and are never
  returned to the renderer after storage.
- Additional provider metadata and model IDs are ordinary renderer state, but
  their secrets are stored separately under provider-specific encrypted keys.

Renderer isolation is enforced with context isolation, sandboxing, disabled Node
integration, a Content Security Policy, blocked navigation/popups, and sender
validation on IPC handlers.

## Conversation flow

Direct chats call the selected agent without inserting a project manager. Group
chats use the orchestrator: the PM may draft work, and agents execute the final
user-approved graph. Reviews are explicit optional plan nodes, not an implicit PM
mutation step. Group memory and resumable run state preserve context across
interruptions. The task graph mirrors planned, waiting, retryable, active, and
completed work.

Unused groups enter per-chat planning mode by default. An explicit close action
sets `planningSuspended`, which prevents automatic reactivation for that group.
While the
mode is active, only the PM receives user messages, MCP tools and project writes
are withheld, and specialist handoffs are materialized as a draft workflow
rather than queued. A composer infobar is rendered only for that state. The
detached workflow window gives the user task, type, dependency, assignment and
same-provider model controls. Execution begins only after the user approves the
plan version; the checkpoint then changes atomically from `planning` to
`execution` and restores the approved tasks.

The editor exposes user-owned task CRUD, splitting, task types, display order,
assignment, model, criteria and dependency controls only while the planning
checkpoint is active. Contract changes rebuild pending tasks from the graph.
While that checkpoint remains active, PM responses carry a complete replacement
draft. This permits the PM to update or omit obsolete and invalid tasks even
after manual user edits, while retaining the user's explicit approval authority.
Blocking `dependency` and `review` edges are the only ordering semantics; PM
delegation metadata is not an execution prerequisite. The horizontal renderer
derives phases from those edges and creates visual fork/join rails. Manual card
coordinates are view data and never become part of the execution contract.

Invalid drafts are checked by a deterministic preflight validator. Its report
maps errors and suggestions to the affected nodes but never mutates the draft.
Task-specific problems are projected to both the workflow window and a
deduplicated system message in the related chat. Both surfaces use the same
problem prompt and route the user's answer back to the PM as a planning-only
instruction. The PM may replace the draft but cannot silently change external
group, agent or provider configuration. Only explicit user approval persists a
changed execution contract.

Workflow deletion is handled by the owning `ChatView`, not by the detached
renderer. After confirmation, an active run is invalidated and its provider
requests are cancelled without writing a new checkpoint. The task graph,
continuation and renderer-only undo stack are then cleared together. The same
single action marks every cross-group request tree visible to the current group
as cancelled, removes it from persistent state and discards queued answer
continuations, including when the main graph is already empty. Requests unrelated
to the current group remain untouched.

Deletion immediately creates a clean planning graph carrying the one-shot
`workflowResetRequired` marker and reset timestamp. The next PM planning capsule
is explicitly forbidden from reusing former task IDs, dependencies or plan
assumptions. Manual execution remains unavailable until a newer user request
exists; a successfully materialized replacement plan consumes the marker.
Messages, group settings, memory and project configuration remain outside that
lifecycle.

Portable workflow files are handled through the narrow `workflow-file-import`
and `workflow-file-export` IPC boundary. The main process owns file dialogs,
enforces a 1 MiB limit and parses JSON, while `workflow-portability.js` performs
domain validation and strips unknown fields. Schema version 1 contains only the
portable plan contract: symbolic role slots, tasks/reviews, fork/join points,
connections, acceptance criteria and optional view positions. It cannot contain
a resumable run, approvals, outputs, errors, local chat/agent identifiers or
cross-group request state.

On import, symbolic slots are suggested against the current group's agents by
name, role and capability coverage. Every used slot must resolve locally before
conversion. Conversion creates fresh graph IDs, resets all task and acceptance
state, sets `planOwner: user` and persists a planning checkpoint. Replacing an
existing graph requires a separate renderer confirmation. The existing
`validateWorkflowPlan` preflight and ordinary plan-approval transition remain
the only path from the imported draft to execution.

Without an approved plan the orchestrator remains in free mode and may create
dynamic handoffs. Once a plan is approved, its node assignments, objectives,
models and dependency graph become an execution contract. The scheduler unlocks
successors directly from that contract; an unapproved task or changed assignment
is rejected and leaves the plan unchanged. Problems become waiting, provider-paused
or retryable runtime states. Only the user can open and approve a new version. A
bounded execution log records planned and actual assignments. User acceptance is unavailable until
the corresponding task has produced a completed agent result.

The workflow canvas stores node coordinates under `graph.viewState.positions`.
This view-only state is deliberately excluded from `approvedPlan`: dragging a
node or resetting the layout is allowed during execution and cannot alter task
objectives, assignments, models, dependencies or the approved plan revision.

`buildWorkflowChangeSet` compares a change draft with `previousApprovedPlan` and
produces node/edge deltas for the workflow UI. It intentionally excludes mutable
execution fields such as task status, timestamps, evidence, the execution log and
view state. This prevents ordinary progress updates from destabilizing the plan
or appearing as plan changes.

All agents in a group resolve the same configured memory provider and namespace.
Local-memory mutations are single atomic main-process operations and are queued
per namespace; JSON-file mutations are queued per file. Groups share memory only
when they intentionally select the same namespace and, for file-backed memory,
the same JSON file. Successful provider mutations publish a renderer-local change
event so every mounted view for that provider and namespace refreshes its badge
and open memory viewer immediately. Structured handoffs live in that group
namespace and are prioritized only for their addressed agent.

User messages submitted during an active agent run are persisted in a separate
per-chat FIFO queue. They remain visible immediately and are processed in order
after the current run step finishes. PM plans are distributed across agents in
the same role pool; independent tasks may run in parallel only after dependency,
agent-capacity, and file-conflict checks succeed.

## Cross-group coordination

`crossGroupRequests` is a persistent renderer-state map separate from chat
messages and task graphs. Each request records its kind (`consultation` or
`task_delegation`), source and target group, optional source task and agent,
selected target agents, batch, attempt, status, answer, delivery timestamp and a
bounded `runtimePlan` owned by the target PM. Runtime steps record PM planning,
specialist execution, child-group waits and final synthesis without becoming
nodes of the approved source graph.
Running entries recover as queued after restart. Deleting either participating
group cancels non-terminal requests instead of leaving orphaned work.

`crossGroupCollaborationEnabled` is the single group-level opt-in for both
information requests and complete task delegation. The source also stores one
array `crossGroupTargetGroupIds`; only groups in this persisted route list are
visible to its PM and accepted by request creation. The flag and target list are
outbound permissions: a selected target may receive and reply without enabling
an outbound route of its own. Changing the list cancels obsolete
outbound requests. Schema 7 migrates the former single target without losing it.
Agent `capabilities` and task `delegation` contracts are domain-neutral user
data. Every group persists a local capability index built from the explicit
labels, roles and profile descriptions of its current members. The index is
rebuilt when a group, one of its agents or the global role catalog changes.
Matching uses deterministic word-root and phrase similarity; inferred matches
remain marked separately from explicit labels and no profile data is sent to an
external embedding service. Search is always scoped to the source group's
persisted route list and any additional target restriction in the task contract.

Every group chat view stays mounted while the application is open, so its local
workflow scheduler and request queue can progress when another chat is selected.
The global `CrossGroupCoordinator` owns target-side execution. It limits total
parallel requests. Every incoming consultation or delegation starts with that
group's PM. The PM creates a bounded runtime subplan, may start same-group
specialists in parallel and delivers one synthesized answer. Capability routing
prefers one complete target expert. If different members cover different
requirements, the PM coordinates the bounded expert set. Requests to the same
target group are serialized while different groups may progress concurrently.
A shared per-agent lease prevents normal tasks,
consultations and delegations in different groups from using the same configured
agent concurrently.

Quality policy resolution occurs inside every executable agent task, so normal
and work-conserving parallel scheduling use the same deterministic gate. The
cross-group coordinator applies the same policy separately to the receiving PM,
each parallel specialist and the final synthesis, and persists the originating
message quality mode through nested requests. Explicit model overrides in an
approved plan bypass automatic escalation to preserve the approved contract.

The work-conserving scheduler may also enqueue a single-use
`dependency-preparation` pass for a blocked task when one of its workflow
predecessors is active, the assigned agent is idle and no explicit file conflict
is detected. `validateApprovedTaskExecution` authorizes this narrow runtime mode
without declaring the node ready. Its output is stored on the live node as a
bounded `interimResult`; the node becomes `prepared`, which is still unfinished
until normal dependency readiness succeeds. Preparation output is checkpointed,
but file artifacts are not materialized into the project until the regular task
consumes the checkpoint. Contract edits invalidate stale preparation metadata.

Timeout, post-escalation quality and ordinary execution-problem recovery nodes
retain `runtimeRecovery` and `recovery.originalGraphNodeId`. Delegation edges
place PM analysis and each small recovery/review step beneath the affected node
in the graph. The PM must emit an explicit resolved signal; otherwise the
original task enters `waiting_user` and exposes the PM diagnosis plus decision
options. A user answer resumes the same recovery chain. Runtime status, actual
model and ordered recovery history are presentation metadata, not additions to
`approvedPlan`.

Context is assembled per task rather than per run. Knowledge-base retrieval uses
the task objective, project inventories are reduced to matching filenames for
specialists, and non-PM plan context contains only the current node plus its
blocking ancestors. Results passed to approved successors are dependency-scoped
and bounded. Dynamic handoffs carry only the direct predecessor's bounded result.
Cross-group conversation history is both relevance-filtered and character-bounded;
parallel group specialists receive isolated one-task inputs instead of the PM and
group transcript.

PM `@Name:` targets are validated before execution. An unknown or unavailable
agent/group receives one constrained correction pass; a still-invalid plan fails
explicitly instead of silently accepting work that no agent performed.

Agent mentions of another group are actionable only at the beginning of a line;
user mentions may be inline. Fenced code is excluded from routing. For an
agent-originated request the source node becomes `waiting_group`, while the
work-conserving scheduler continues unrelated ready nodes. Batched answers are
delivered through the existing persistent per-chat request queue and resume the
exact saved task with answer context. The approved graph is never rewritten.

An approved task can use delegation mode `never`, `ask` or `automatic`. `ask`
creates a `delegation_pending` runtime state with explicit **Delegate** and
**Run locally** controls. `automatic` creates the request immediately. In both
cases the source node remains the sole workflow contract node, enters
`waiting_group`, and later resumes with the delegated result. Unrelated ready
nodes continue through the work-conserving scheduler.

Incoming and outgoing requests are read-only projections of the persistent
request map in the workflow window, not editable graph nodes. The window uses
separate main-workflow and group-work tabs, so the nested request tree can use the
full canvas without obscuring the approved plan. It includes the target PM's live
runtime steps. Every branch uses normal contrast regardless of the current chat;
planning, running, waiting, completed and failed states remain visible throughout
the request chain. Final answers are projected back into the originating node's detail panel through its
`sourceTaskId`; the node's approved contract data is not mutated. Failed and timed-out
requests are retryable; cancellations move an affected source task to explicit attention.
Every nested consultation records `parentRequestId`, `rootRequestId`, `depth` and
the complete `groupPath`. A target may create child consultations only along its
own configured outbound routes. The parent changes to `waiting_child`; terminal
child answers or errors queue that exact parent again with continuation context.
Already visited groups and requests beyond the depth limit are rejected, while
the stored parent chain provides the implicit reply route.

Only a successfully synthesized cross-group result is written back to Shared
Memory. The source and target destinations are resolved independently from their
configured provider, namespace and optional JSON file. Identical destinations
are collapsed. Each bounded `finding` stores request/group/task provenance and a
stable dedupe key; `MemoryAPI.writeOnce` prevents retries or restarts from
duplicating it. Intermediate runtime steps and non-successful requests never
write memory, and persistence errors do not turn an otherwise valid answer into
a failed workflow task.

Terminal child results are append-only audit data, while
`processedChildResponseIds` marks which result delta has already been consumed by
the owning PM. A continuation is isolated from UI messages belonging to its own
request lineage and receives only the unprocessed delta plus a bounded
`processedContextSummary`. Approved workflow handoffs use the graph's transitive
blocking ancestors to include only relevant `delegatedResults`; independent tasks
therefore do not inherit unrelated output. Re-entering the PM is reserved for an
explicit graph review/synthesis node, a surfaced execution problem, or the final
synthesis in free-running mode.

Planned specialist tasks use a domain-neutral acceptance contract. Each
criterion records whether it is required, how it must be verified, submitted
evidence, and its review state. Specialist evidence is data, not approval. The
PM may pass, reject or explicitly waive reviewer/automatic criteria; criteria
that require user approval can only be decided through the user-facing task
window. The completion gate evaluates persisted graph state and refuses
`PROJECT_DONE` until every required criterion in the active plan is passed or
waived. Graphs created by older versions without criteria remain compatible.

## Project review flow

A group may configure a fixed test command, preview command and optional preview
URL. The renderer can request an action only by group ID and action name. The
main process resolves the trusted project path and stored command, validates the
configuration again, and requires a native fingerprint-based approval before
the first execution. Process output is bounded and streamed to the singleton
detached review window. Provider secrets are removed from the child environment.

File inspection has a separate containment boundary: paths are resolved below
the selected group folder, traversal, symlinks, sensitive filenames and build or
dependency folders are blocked, and file sizes are limited. Text and conservative
DOCX replacements create integrity-checked snapshots in application data before
writing. Word previews inspect text and structure only; visual layout remains the
responsibility of Word or another compatible Office application.

## External boundaries

- LLM prompts and selected context leave the device only for the provider chosen
  by the user.
- User-defined provider URLs are normalized again in the main process. Remote
  connections require HTTPS; HTTP is restricted to loopback. The renderer sends
  only a provider ID when invoking a saved connection, so it cannot substitute a
  different endpoint for the associated secret.
- MCP servers are separate trusted processes or HTTPS services. Server trust and
  tool permission are distinct decisions and reset when relevant configuration
  changes.
- Project folders, knowledge folders, memory files, and attachments are accessed
  only after native selection or validation against an explicitly trusted path.
- The optional REST API binds to loopback, starts disabled, requires a bearer
  token, applies request limits, and accepts browser requests only from configured
  origins.

See `THREAT_MODEL.md`, `PRIVACY.md`, and `SECURITY.md` for security and disclosure
details.
