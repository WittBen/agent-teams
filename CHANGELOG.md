# Changelog

All notable changes are documented here. The project follows semantic versioning while APIs remain subject to beta changes.

## 1.1.0-beta.11 - 2026-09-09

### Changed

- Refactored Workflow

## Unreleased

### Added

- Local experience harness for desktop tasks, cross-group calls and local API
  calls. Repeated quality-gate failures select up to three predefined hints,
  with evidence thresholds for transfer between project areas and exclusion of
  hints that repeatedly fail to prevent the same error.
- Learning controls, experience counters, estimated additional harness tokens
  and a global delete action in the Quality Cascading settings. Records contain
  bounded metadata and hashed project identifiers rather than conversation text.
- Regression coverage for promotion thresholds, complexity isolation, discarded
  untrusted text, ineffective hints, concurrent persistence, deletion, disabled
  learning and storage-failure tolerance in `scripts/learning-harness-test.mjs`.

## 1.1.0-beta.10 - 2026-09-07

### Changed

- new workflow window
- Model output is now streamed through one provider-neutral progress channel for
  Codex, Claude Code CLI, OpenAI, Anthropic, Gemini and compatible custom
  providers. The chat shows bounded live answer text and first-text latency while
  retaining the final message as the authoritative result.
- Codex now uses a long-lived local App Server for incremental
  `item/agentMessage/delta` text and lower per-turn startup overhead. It falls
  back to `codex exec --json` only when the server cannot initialize before a
  turn starts.
- Claude Code task continuations reuse an isolated CLI session when the model is
  unchanged. Model escalation starts a fresh session, and missing or expired
  sessions safely fall back to a complete one-shot prompt.
- Codex now reuses isolated sessions for the same agent, ticket and model, falls
  back safely when a stored session is unavailable, and applies low/medium/high
  reasoning effort according to planning, normal execution and quality/recovery
  work. Bounded authentication caching, compact group context, activity
  heartbeats and persisted runtime metrics reduce overhead and make delays
  diagnosable without changing provider-neutral Quality Cascading.
- Codex connection checks now distinguish CLI installation and completed
  authentication without blocking each run on an unrelated API endpoint probe. The settings dialog polls the
  browser login to completion without stale status caching, repeated network
  reconnects fail with a bounded diagnostic, and affected workflow tickets pause
  for login instead of entering unrelated PM recovery.
- Low-complexity fast-mode requests can remain on the lean execution path even
  when a project folder is configured. Expensive workspace tools and project
  inventory are now attached only to tasks whose objective can use them.
- The group-chat composer now remains inside the visible chat area at narrow,
  zoomed and short viewports. Responsive sidebar/header reflow, complete flex
  shrink boundaries, dynamic viewport height and bounded textarea growth prevent
  the input and actions from being clipped behind application chrome.
- Workflow nodes now have persistent project-local task tickets with stable IDs,
  descriptions, four priorities, assignments, dependencies, acceptance evidence,
  checkpoints and bounded transition history. Existing graphs migrate into
  `.agent-teams/tickets`, requests are mirrored under `.agent-teams/requests`, and
  workflow deletion archives both before clearing the UI.
- Ticket priority now controls the order of ready and safe-preparation work without
  bypassing graph dependencies. The workflow details expose ticket ID and editable
  priority during planning, and import/export preserves priority.
- Reviewer acceptance is now independent of implementation: a different agent can
  decide submitted criteria from a planned review ticket. Failed criteria return
  the same implementation ticket for rework and repeat the same review ticket;
  the PM only checks that acceptance decisions and evidence are complete.
- The workflow window now includes a parallel ticket-derived test lane. Automatic
  criteria use only the trusted group test command and retain bounded run output;
  user decisions and exceptional overrides require an auditable note. Tickets
  without criteria request manual `@user` approval instead of completing silently.
- Execution failures now offer two explicit paths in the shared problem dialog:
  a bounded PM-authored recovery DAG inside the approved contract, or a new
  PM-prepared plan revision that still requires user approval. Recovery tickets
  may run safely in parallel across suitable group agents, persist user notes and
  dependencies, invalidate only affected downstream results, and escalate to the
  user after two unsuccessful PM rounds.

## 1.1.0-beta.9 - 2026-08-31

### Changed

- The beta release tool now explains security-audit failures, offers a safe
  dependency repair without `--force`, repeats the audit, and verifies the
  repaired tree before publishing.
- Preflight problems now expose a focused prompt directly on the affected task
  and a matching **Resolve** action in the chat. A response from either surface
  is sent to the PM in planning mode, while duplicate chat notices for the same
  workflow problem are suppressed.
- Execution problems now escalate to the responsible PM before involving the
  user. The PM may recover only inside the approved plan and must explicitly
  confirm resolution; an unresolved or failed PM recovery pauses the task with
  a visible user question, diagnosis and concrete choices. Provider rate limits
  keep their automatic retry path.
- Approved workflows now use idle capacity for bounded, dependency-independent
  preparation while a predecessor is running. Draft output is checkpointed on
  the task and reused after dependencies finish, without completing the task,
  writing speculative project files or changing the approved plan.
- Prepared tasks now have a distinct workflow state and expose their saved work
  in task details. Timeout recovery also shows its ordered PM/agent substeps and
  actual runtime model directly in the workflow.
- Specialist results that still miss deterministic quality gates after model
  escalation now enter the same visible, stepwise PM recovery path as timeouts,
  with a distinct quality-problem state instead of being silently accepted.
- Cross-group waits now retain the asking task's bounded intermediate result and
  restore it with the group answer, preventing already completed work from being
  lost or needlessly repeated.
- Successful cross-group consultations and delegations now write one bounded,
  provenance-tagged final result to the enabled Shared Memory of their source and
  target groups. Intermediate chatter and unsuccessful requests are excluded;
  stable request keys and destination collapsing prevent duplicate entries.
- Planning mode is now the default for unused groups and still respects an
  explicit suspension through the infobar X. Deleting a workflow immediately
  opens a clean planning session, shows a reset notice and requires a new user
  request so the PM cannot reconstruct the deleted plan from older chat history.
- The single workflow-header delete action now clears both the main workflow and
  all group-work trees visible to the current group. It remains enabled when only
  group work exists, and late provider responses cannot recreate deleted child
  requests. The redundant delete control inside the group-work tab was removed.
- Added versioned workflow import and export through `.agent-workflow.json`
  files. Exports contain only the portable plan contract; runtime state, local
  identifiers and results are omitted. Imports are size/schema validated, map
  symbolic roles to local agents and always enter user-owned planning mode for
  preflight review and explicit approval instead of starting automatically.
- The workflow window now has a confirmed delete action. It safely stops an
  active run and clears the graph, plan/undo history and resumable checkpoint
  while cancelling task-bound group requests and retaining chat messages,
  groups, memory and project settings.
- Every incoming group request or delegation now starts the receiving group's PM.
  The PM owns a persistent runtime subplan whose planning, specialist, child wait,
  synthesis and failure states are shown as a nested request tree in every
  participating workflow window without changing the approved source plan.
- The workflow window now separates the main plan and group work into full-size,
  keyboard-accessible tabs. Completed group answers are additionally shown on the
  originating task card and in its detail panel. The selected tab is remembered
  per chat across status updates and workflow-window reopening.
- Group-work branches now use the same full-contrast presentation in every chat;
  remote group tasks are no longer rendered as disabled or desaturated cards.
- PM-directed agent and group names are validated before execution. Unknown
  `@Name:` targets receive one constrained correction pass and then fail visibly,
  eliminating silently accepted work that no configured expert performed.
- Group settings are now organized into accessible tabs for general membership,
  cross-group collaboration, workspace/review configuration, and AI tools/memory.
  Keyboard arrow, Home and End navigation is supported, and hidden-tab validation
  problems are marked on the affected tab.
- Cross-group requests now support bounded directed chains such as
  Dev → Tech → Design. Parent requests wait for child consultations, resume the
  exact target task with the returned information and then answer their own
  source. Stored group paths prevent cycles, while replies require no reverse
  group assignment.
- Cross-group continuations now consume child answers as deltas. Processed
  request IDs and a bounded rolling summary prevent the same answer from being
  sent repeatedly to the PM. Approved workflow tasks receive prior results only
  from their direct or transitive dependencies; independent branches no longer
  inherit the complete result history.
- Quality Cascading now covers receiving group PMs, parallel group specialists,
  nested consultations and final group synthesis. The selected message quality
  mode follows the request chain; explicit models in approved workflows remain
  fixed to preserve the user's execution contract.
- Agent context is now assembled per task: knowledge search uses the concrete
  objective, specialists receive only the relevant plan ancestry and matching
  project inventory, dependency results are bounded, and cross-group history is
  relevance- and size-filtered instead of forwarding broad transcripts.
- Group target lists are now outbound permissions. A selected target can receive
  and reply without enabling an outbound route of its own; its toggle is needed
  only when it should initiate requests to further groups.
- The PM can now continue revising a user-edited workflow during planning,
  including removing obsolete or invalid tasks through a complete replacement
  draft. Approved plans remain immutable and still require explicit user approval.
- Workflow tasks marked with the **Problem** badge now expose their concrete
  validation/runtime errors and task-specific repair suggestions in the detail panel.
- Added generic, capability-based task delegation between arbitrary groups. Each
  task can disable delegation, request user approval or delegate automatically;
  delegated work preserves the approved plan and independent branches continue
  in parallel. Pending user approvals can now be granted directly from the
  related chat message through a compact, single-use action.
- Added one group-level collaboration option for both information requests and
  task delegation. Each source group persists its own list of reachable groups,
  so its PM and `@` picker see only those routes instead of searching every group.
  The option governs outgoing work; selected targets can receive and reply.
- Added free-form agent capability labels, delegation approval/local-execution
  controls in the workflow window, route-aware preflight validation and schema-6
  migration for the new group and agent settings. Schema 7 migrates the earlier
  single-target setting into the new target list.
- Groups now persist a local semantic capability index assembled from member
  skills, roles and profile descriptions. The index is refreshed on group,
  agent and role changes, keeps inferred matches distinguishable from explicit
  skills and never broadens the configured outbound target routes.
- Capability routing now prefers a single complete expert but can combine
  several members of one group when their skills jointly cover a task. The
  receiving PM coordinates such a team without changing the approved workflow.
- Added persistent cross-group requests through `@Group name: question` in group
  chats and line-start mentions in agent responses. The target PM may consult its
  own specialists while the source task waits and independent workflow branches
  continue in the background.
- Added non-editable, group-colored request indicators to the workflow window,
  exact-task resumption after answers, and visible retry controls for failed or
  timed-out group requests. Requests recover safely after an app restart.
- Added global per-agent execution leases so background group consultations and
  normal workflows cannot run the same configured agent concurrently. Approved
  task plans remain immutable throughout the exchange.
- Replaced the obsolete PM solution-tip description with the deterministic
  workflow preflight report used by the current interface.
- fix: conversation language
- Fixed the chat composer inheriting the app-wide selection lock; text fields
  remain selectable and automatic focus restoration preserves the current range.
- Workflow plans are now user-owned, versioned execution contracts. After user
  approval, neither agents nor the PM can add, remove or rewrite tasks; problems
  become visible waiting/retry states and only the user can open a new version.
- Removed the separate sequential/parallel task mode. Blocking dependencies alone
  determine order and safe parallel execution; card movement changes only the
  visible line. Review tasks are optional and freely configurable.
- Claude CLI session-limit responses such as `resets 2am` are classified as
  retryable provider pauses instead of generic workflow failures.
- Replaced the detached task-tree UI with a workflow window that supports
  dependency-safe parallel planning and per-task model overrides.
- Added an explicit per-group planning mode with a conditional composer infobar;
  only the PM participates until the user finishes planning from the UI.
- Approved workflows now act as execution contracts for task objectives,
  dependencies, agents and models. Unplanned agent changes are rejected without
  mutating the plan, while groups without a user-owned plan retain free mode.
- Added workflow preflight validation, execution-compliance logging and guards
  against acceptance before a task has finished.
- Kept workflow nodes movable after plan approval by separating canvas positions
  from the immutable execution contract; automatic layout now resets view state only.
- Runtime task-status and evidence updates no longer appear as plan changes.
  Versioned user plan drafts highlight affected tasks and connections in red and
  show before/after values from the last approved snapshot.
- Shared-memory mutations now notify the active group view immediately, so the
  brain badge count and an open memory viewer update without an extra click.
- Reworked the workflow canvas into a horizontal Git-style execution graph with
  a left-to-right main line, vertically stacked parallel branches, automatic
  fork/join markers and a collapsible legend.
- Planning users can now add, edit, split, remove and reorder tasks, as well as
  change task types, objectives, agents, compatible models, acceptance criteria
  and dependencies. Lines and phases update immediately.
- Removed PM delegation links from scheduling semantics. Only dependencies and
  review edges gate execution; status updates remain layout-neutral, while
  approved task semantics stay locked and cards remain visually movable.
- The task detail sidebar can now be collapsed to reclaim canvas space and
  pinned so clicks on the free workflow canvas do not close it accidentally.
- Invalid planning drafts now offer a PM-powered solution tip in the upper-left
  corner. Suggested nodes and edges are previewed in yellow, validated against
  the workflow rules, and applied only after explicit user approval.
- Preflight errors now identify their exact task nodes. Affected cards receive
  an amber warning outline and issue badge, including both cards for conflicts.

## 1.1.0-beta.8 - 2026-08-30

### Changed

- perplexity mcp added

## 1.1.0-beta.7 - 2026-08-30

### Changed

- Prepared the current application state for automated beta distribution.

## 1.1.0-beta.6 - 2026-08-30

### Changed

- Prepared the current application state for automated beta distribution.

## 1.1.0-beta.5 - 2026-08-30

### Release summary

- Prepared the current application state for automated beta distribution.

### Added

- Added a detached, singleton project review window for groups with safe text,
  image and Word inspection, external opening of additional file formats, and
  integrity-checked snapshots before supported edits.
- Added per-group test and preview commands with native first-run approval,
  bounded output, scrubbed child environments and automatic reviewer-agent test
  handoff.
- Added domain-neutral task acceptance criteria, structured agent evidence,
  PM review decisions, user-only approvals and a persisted completion gate in
  the detached task tree.

### Security

- Review file access rejects traversal, symlink escapes, sensitive filenames and
  protected project directories. Stored command approvals are excluded from data
  exports and invalidated when the folder or command changes.
- The UI now states explicitly that approved child processes use the group folder
  as their working directory but are not an operating-system sandbox.

### Fixed

- A task limit of `0` now means unlimited for both group-run tasks and per-agent tasks.
- Local shared-memory writes are now serialized atomically in the Electron main
  process, preventing parallel agents from overwriting each other's entries.
- Agent handoffs are stored in the group's configured memory namespace and are
  injected only for the addressed agent instead of using global agent-name keys.

## 1.1.0-beta.4 - 2026-08-28

### Added

- Group chats without a configured output folder now show a persistent bilingual notice with a direct link to the group settings.
- The group editor now explains that file-based tasks require an output folder for reliable shared file access.

### Fixed

- Packaged Windows builds now find the native Claude Code installation in the standard user directory even when Explorer starts the app with a stale or reduced `PATH`.

## 1.1.0-beta.3 - 2026-08-28

### Changed

- The detached task window now opens only when the user selects the task-plan button.
- A selected group project folder is shared automatically across team agents for bounded file reading and writing; saved text artifacts are also passed to later API-backed agents as limited context.
- The bundled Excalidraw MCP preset is disabled by default and can be enabled manually when needed.
- Automated beta builds are published as the repository's visible latest release while remaining clearly labelled as beta software.

### Security

- CLI project access is accepted only for project folders explicitly configured and trusted through the app.
- Claude project tools are limited to read, write and edit operations, with protected project paths denied.

## 1.1.0-beta.2 - 2026-08-28

### Fixed

- Disabled Electron Builder's implicit tag publishing so the verified release
  workflow can generate checksums and publish all release assets explicitly.

## 1.1.0-beta.1 - 2026-08-27

### Security

- Disabled the external REST API by default and added bearer-token authentication, strict origin handling, rate limiting and request-size limits.
- Moved provider secrets into operating-system protected storage and out of the renderer process.
- Added IPC sender checks, an application-state allowlist, CSP, renderer sandboxing and navigation restrictions.
- Added native trust confirmation for MCP servers and invalidation of permissions when tool definitions change.
- Restricted project and memory operations to paths selected by the user.
- Updated Electron and removed known npm audit findings.

### Changed

- Renamed historical package identifiers to Agent Teams while preserving existing user data paths.
- Added complete group-data and attachment deletion.
- User messages sent during an active agent run now enter a persistent per-chat FIFO queue and remain immediately visible.
- PM plans now explicitly inspect same-role agent pools, distribute independent work fairly, and start only conflict-free tasks in parallel.
- Added release documentation, security tests and CI configuration.
- Added a tag-driven GitHub Actions release workflow that verifies the project,
  builds the Windows installer and publishes a generated SHA-256 checksum.
- Grouped each provider's authentication options together in Settings:
  Anthropic API key with Claude Code CLI, and OpenAI API key with Codex CLI.
- Added an explicit Claude Code CLI status refresh action alongside its connect
  and disconnect controls.
- Added concise in-app sign-in instructions for both Codex CLI and Claude Code
  CLI directly above their authentication controls.

### Added

- Added global API-provider connections with presets for OpenRouter, Groq,
  Mistral AI, Google Gemini, xAI, DeepSeek, Together AI, Ollama and LM Studio.
- Added custom OpenAI-compatible, Anthropic Messages-compatible and Gemini
  provider connections with per-provider encrypted credentials and model lists.
- Made configured providers available to direct chats, group agents and Quality
  Cascading while retaining the existing Codex CLI and Claude Code CLI routes.
