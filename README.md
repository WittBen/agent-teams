# Agent Teams

Agent Teams is a local-first Electron and React desktop application for configurable AI agents, direct chats and coordinated multi-agent groups. Groups can share structured memory, use project folders, connect to MCP servers and maintain a task graph.

> **Status:** `1.1.0-beta.11`. This project is in public beta. Keep backups of important project data and review every MCP server before granting access.

## Download

Windows users can download the installer and `SHA256SUMS.txt` from the
[GitHub Releases](https://github.com/WittBen/agent-teams/releases) page. Verify
the SHA-256 checksum before running the installer. Beta installers without an
Authenticode signature are marked as unsigned and may trigger a Windows
SmartScreen warning.

The source archive from **Code → Download ZIP** is intended for development. It
does not contain dependencies or a prebuilt application.

## Security model

- Provider API keys are encrypted by Electron `safeStorage` and remain in the Electron main process.
- Codex and Claude CLI sessions are used through their local command-line clients; OAuth tokens are not copied into the app store.
- The optional REST API is disabled by default and requires a random bearer token when enabled.
- MCP servers require native trust confirmation. Tool permissions are separate and are invalidated when a tool definition changes.
- Project and memory paths must be selected through a native file dialog before agents may write to them.

Read [SECURITY.md](SECURITY.md), [THREAT_MODEL.md](THREAT_MODEL.md) and [PRIVACY.md](PRIVACY.md) before using the application with sensitive data.

## Requirements

- Windows 10/11 for the currently tested desktop release
- Node.js 22 or newer and npm 10 or newer when running from source
- An API key for OpenAI, Anthropic or another configured provider, or an
  authenticated Codex CLI or Claude Code CLI session, to run AI requests

macOS and Linux are Electron build targets, but are not yet part of the supported release matrix.

| Platform | Verification and support |
| --- | --- |
| Windows 10/11 | Tested desktop target. Individual OS-permission-dependent checks may be skipped and are reported by the test suite. |
| macOS | Untested build target; no supported desktop release yet. |
| Linux | Untested build target; no supported desktop release yet. |

## Development

```bash
npm ci
npm run dev
```

The Vite development server listens only for local development. Production builds load bundled files.

## Verification

```bash
npm test
npm run build
npm run audit
```

Create a Windows installer:

```bash
npm run dist:win
```

Artifacts are written to `release/` and are intentionally excluded from Git.
The release checklist, including Windows code signing, is documented in
[RELEASING.md](RELEASING.md). The process and trust boundaries are described in
[ARCHITECTURE.md](ARCHITECTURE.md) and [THREAT_MODEL.md](THREAT_MODEL.md).

Pushing a version tag that exactly matches `package.json`, for example
`v1.1.0-beta.11`, runs the release workflow. GitHub Actions verifies the project,
builds the Windows installer, generates `SHA256SUMS.txt` and publishes a beta
tag as the latest public release while retaining the beta label in its version
and release notes.

## Provider configuration

Open **Settings → API access**. Manually entered keys are encrypted using the operating-system credential facility. The built-in OpenAI and Anthropic connections also support environment variables:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

Codex CLI and Claude Code CLI sign-in remain independent options. The app invokes the authenticated local CLI session and does not require an additional API key for those routes.

Additional connections can be created from presets for OpenRouter, Groq, Mistral AI, Google Gemini, xAI, DeepSeek, Together AI, Ollama and LM Studio. A custom connection can use an OpenAI-compatible Chat Completions API, an Anthropic-compatible Messages API or the Google Gemini content API. Enter the provider's base URL and one or more exact model IDs, then select that connection on any agent. Local Ollama and LM Studio presets do not require a key by default.

Custom does not mean every arbitrary HTTP API: its request and response format must match one of the three supported protocols. HTTPS is required for remote endpoints; cleartext HTTP is accepted only for `localhost`, `127.0.0.1` or IPv6 loopback. Base URLs containing credentials, query parameters or fragments are rejected.

Provider configuration is available globally to direct and group-chat agents. Quality Cascading can also escalate to a model on a configured connection. Keys are sent only to the selected provider as part of authenticated API requests. Prompt content, attachments and relevant conversation context are also sent to that provider.

The desktop app streams visible answer progress for every supported route:
OpenAI, Anthropic, Gemini, compatible custom providers, Codex and Claude Code
CLI. Codex uses a long-lived local App Server for incremental answer deltas and
falls back to `codex exec --json` if that transport cannot start. Streaming makes
the first result visible sooner; it does not make the model
finish its work sooner. The live preview is bounded and temporary, and the final
chat message remains the saved result. Claude Code can reuse the isolated session
of a continuing task. Codex does the same for a matching agent, ticket and model;
planning, preparation and simple work use low reasoning effort, normal-complexity
execution uses medium, and difficult or escalated recovery uses high. A model change intentionally
starts a new isolated session. Codex workflow details retain total runtime,
first-activity/first-text latency, reasoning effort and prompt size for diagnosis.
Project tools are started only for tasks that actually need the configured
workspace, reducing avoidable prompt and CLI overhead for ordinary questions.

Protocol references: [OpenRouter](https://openrouter.ai/docs/quickstart), [Groq](https://console.groq.com/docs/openai), [Mistral AI](https://docs.mistral.ai/api/endpoint/chat), [Google Gemini](https://ai.google.dev/api), [xAI](https://docs.x.ai/developers/model-capabilities/text/comparison), [DeepSeek](https://api-docs.deepseek.com/guides/function_calling), [Together AI](https://docs.together.ai/docs/api-keys-authentication), [Ollama](https://docs.ollama.com/api/openai-compatibility) and [LM Studio](https://lmstudio.ai/docs/developer).

## MCP configuration

MCP servers can execute code or access external data. Add only servers you trust. Sensitive literal HTTP headers and environment values are moved to protected storage. For portable configurations, use an environment-variable reference:

```text
Authorization=$env:MCP_AUTHORIZATION
API_TOKEN=$env:MCP_API_TOKEN
```

The application asks separately whether to trust a server and whether a particular tool may run.

The global MCP settings include disabled official presets for Excalidraw and Perplexity. To use Perplexity, edit its preset and enter `Authorization=Bearer YOUR_API_KEY` under HTTP headers, save the settings, enable the server, and load its tools. The literal key is moved to the operating-system credential store when saved. The preset connects to Perplexity's hosted MCP endpoint; search and research requests are therefore sent to Perplexity.

## Generic acceptance workflow

Every planned group task can carry required or optional acceptance criteria.
Criteria are domain-neutral and may be checked by a reviewer, by an available
deterministic check, or through explicit user approval. Agents attach concise
evidence to the criteria they worked on; a user-configured review ticket assigned
to a different agent records passed, failed or waived decisions. A failed required
criterion returns the same implementation ticket for another attempt and schedules
the same review ticket again. The PM checks only that decisions and evidence are
complete. The workflow window contains a separate **Prüfungen** tab derived from
the tickets. Criteria marked `automatic` run through the group's already configured
and trusted test command; the run is persisted with result and bounded output and
may be repeated after changes. These checks run independently of the main agent
workflow. User criteria remain under user control and always require a written
verification note. If a ticket has no criteria, the PM asks `@user` and the app
creates a manual overall approval instead of completing it silently. A reviewer or
automatic criterion can be waived by the user only as an explicitly reasoned
exception. A group run cannot report project completion while required criteria
are still open, merely submitted or rejected.

## Persistent task tickets

Workflow tasks are persisted as project-local JSON tickets below
`.agent-teams/tickets/<group-id>/`. Each ticket contains a stable ID, title,
description, priority, assignment, dependencies, status, acceptance criteria,
evidence, test runs, manual approval requests, checkpoints, recovery notes/plans
and a bounded transition history. `workflow.json` retains
the complete graph contract, while `history.jsonl` records persistence revisions.
Existing stored graphs are migrated automatically and reconciled with the project
copy when the app starts. The files are written through the Electron main process
using bounded, atomic replacements; the renderer cannot choose an arbitrary path.

The workflow window is a projection of these tickets. Ticket ID and priority are
visible in task details, priority can be changed during planning, and ready work is
scheduled `critical` → `high` → `medium` → `low` without bypassing dependencies.
Agents receive only the relevant ticket, dependency results and acceptance state
inside their isolated task capsule. Cross-group questions are persisted separately
under `.agent-teams/requests/`. Deleting a workflow archives its tickets, history
and related request files under `.agent-teams/archive/` before starting fresh.

## Cross-group collaboration and task delegation

Cross-group work uses directed routes. Enable outgoing collaboration in the
source group and select any number of reachable target groups. This group-owned
list is the only set exposed to the source PM, `@` mention picker and delegation
router, so the PM never scans every configured group. A selected target may
receive and answer even when it has no outbound collaboration of its own; a
reverse route is needed only when that group wants to initiate a new request.

The same setting governs both information requests and complete task
delegations. Agents declare domain-neutral capabilities as free labels. A task
may prohibit delegation, require user approval, or allow automatic delegation;
it also names its required capabilities and may further restrict the target.
Saving a group builds a local semantic capability index from the explicit labels,
roles and profile descriptions of its members. Explicit matches have priority;
profile-derived matches remain visible as inferred. One expert is preferred, but
several members of the same group may jointly cover the requirements. The search
still evaluates only groups on the source group's reachable-target list and any
additional target restriction stored on the task. It does not call an external
embedding service.

Delegation is runtime state, not a plan edit. The original workflow node waits
while the target group's PM first creates a bounded internal subplan. Its selected
experts may then work in parallel in their own group context; independent source
branches continue as well, and the exact source task resumes with the returned
result. Delegations that require user approval expose the currently validated,
recommended target through a compact approval action on the related chat message;
the full target selection and local-execution alternative remain available in the
workflow window. Different target groups may work concurrently, while requests to the same
target group and use of the same configured agent are serialized.
Information requests follow the same directed-route rules. Neither operation can
add tasks or dependencies to an approved workflow.

Quality Cascading applies independently to every normal task, parallel task,
receiving group PM, parallel group specialist and final group synthesis. The
request's **Fast**, **Automatic** or **Thorough** mode follows it through nested
group requests. An explicit model selected in an approved workflow remains fixed,
because silently replacing it would change the user-approved execution contract.

“Quality” means structural completeness and configured evidence checks, not proof of factual correctness. Explicit requirements, output contracts and JSON validation work independently of response language; DE/EN text heuristics remain a fallback for unstructured requests. Model compatibility defaults live in `electron/quality-model-catalog.mjs`; a provider's model list is never treated as a strength ranking. Set an explicit escalation model for unsupported/custom aliases.

Model context is selected per task. Specialists receive their task capsule,
direct/transitive dependency results and PM-selected memory excerpts,
and only matching project filenames. They do not receive unrelated parallel
results or the full workflow. PM planning/review may receive the complete plan
when that overview is required. Cross-group PMs receive at most a bounded set of
conversation messages that match the incoming question; group specialists receive
only their subtask and explicitly selected attachments. The PM retains general memory and knowledge-base retrieval access.

## Learning from project experience

The desktop app and local API use an adaptive experience harness by default.
Completed quality-cascade runs retain recognized quality-gate failures and select
up to three short, application-owned checklist hints for later tasks of the same
complexity. Repeated local failures can activate a hint; transfer to another
project area requires observations from at least two areas. Hints that repeatedly
fail to prevent their associated error are excluded from selection.

Under **Settings → API access → Quality Cascading**, use **Aus Projekterfahrungen
lernen** and save the settings to enable or disable collection and retrieval.
The experience panel shows observed runs, project areas, final gate acceptances
and estimated additional harness tokens. **Aktualisieren** refreshes the counters;
**Erfahrungen löschen** clears the global experience register immediately.
Disabling learning preserves existing records. Clearing experiences while work is
running does not prevent that work from recording another observation later.

The register stores fixed error/rule codes, complexity, final gate acceptance,
token estimates, timestamps and hashed project identifiers locally. It does not
store prompt text, responses or project files. A project area uses the execution
project path when supplied, otherwise the chat/group ID. It is separate from
Shared Memory and is not removed when a group is deleted. At most 1,000 records
are retained after a write; observations older than 90 days are excluded from
retrieval and counters and removed from storage on the next write.

Learning requires no extra model call. It adapts a predefined set of hints; it
does not train model weights, generate new rules or rewrite the app. It currently
observes quality-cascade gates, not later reviewer decisions, automatic test runs
or user approvals. Existing task-context limits and acceptance requirements still
apply. Token counts are estimates of additional prompt text, not demonstrated
savings or provider billing. Quality improvements must be evaluated in actual use.
See [ARCHITECTURE.md](ARCHITECTURE.md#adaptive-experience-harness) and
[PRIVACY.md](PRIVACY.md) for selection and storage details.

## Planning mode and workflows

The PM streams complete ticket objects into the draft as it writes the plan. Completed objects are persisted and displayed immediately; incomplete objects are ignored. Plan approval is still required before execution. Existing user-edited plans retain their edit protections.

An approved workflow's task cards provide **Pause task** and **Resume task**. A pause cancels the current model request and prevents subsequent tool calls. A tool already running must settle before the agent becomes free. Independent ready tasks can then use that agent; tasks depending on the paused result remain blocked. The pause survives restarts. Splitting a task preserves incoming dependencies and connects part 1 → part 2 → existing successors, including manually drawn routes.

**Group settings → General → Shared group AI** selects a common provider/model template for all members, including the PM. Individual roles and skills remain intact. Other groups and direct chats retain their own settings; explicit task models and quality routing retain their documented precedence. Group import/export includes this template without credentials.

In a group chat, start planning mode from the header before describing the
work. A temporary infobar above the composer shows that specialists have not
started. The PM may create the initial draft; once the user edits it, the user
keeps approval control, while the PM may continue maintaining the draft during
planning. A complete PM draft replaces the previous draft and may omit obsolete
or invalid tasks to remove them; unaffected user decisions should be retained.
The detached workflow window shows freely editable ticket titles, descriptions,
priorities, dependencies, acceptance criteria and assigned agents. Dependencies
determine readiness: ready independent tasks may run
in parallel, while connected successors wait. Per-task models can be overridden
from the assigned agent's provider. Only **Approve plan version & start workflow**
releases a versioned plan. Ordinary chat messages never approve it.

The workflow is drawn as a horizontal Git-style execution graph from left to
right. Blocking edges derive the phases; independent tasks form visual branches
and may join before a shared successor. Cards can be moved freely between visible
lines without changing execution semantics. A review is an optional task type,
not an implicit PM step. A collapsible legend explains main-line, fork/join,
dependency, review and change markers.

While planning is active, users can add, rename, describe, split, delete and
reorder tasks directly in the workflow window. They can also change task types,
the assigned agent, a compatible model, acceptance criteria and arbitrary
dependencies. The graph and its connection lines are recalculated immediately.
Cycles, unconnected review tasks and unavailable agent/model configurations are
rejected by preflight validation; a plan without a review task is valid.

The **Check** button runs deterministic preflight validation without changing the
plan. Its report names affected tasks and suggests manual corrections. Approval
remains disabled until blocking structural or provider errors have been fixed.
Tasks carrying the amber **Problem** badge show their concrete diagnostics and
task-specific repair suggestions at the top of the detail panel when selected.
An additional exclamation button opens a focused problem prompt. The same
problem is posted once in the chat with a **Resolve** action. The shared dialog
always accepts optional user context and separates two decisions: **Repair
execution** creates runtime-only recovery tickets, while **Revise main plan**
opens a PM-prepared draft that cannot run until the user explicitly approves the
new version. Structural/provider preflight problems offer only the revision path.

Planning mode is active by default for every unused group. Closing its infobar
with the X explicitly suspends it for that group; **Free mode** is therefore a
deliberate user choice rather than an accidental initial state. After approval, the workflow
is immutable for every agent including the PM: only its tasks can run,
dependencies gate every successor, and agent/model assignments are enforced.
Problems become explicit waiting or retryable states. Agents may ask the PM for
advice or the user for a decision, but no runtime path may add a hidden task. Only
the user can open and approve a new plan version; while that version is in
planning, the user and PM may revise its draft. Provider availability and
structural conflicts are checked before approval; user acceptance becomes
available only after the relevant task is finished.

While a direct predecessor is actively running, an idle agent may perform one
bounded preparation pass for its still-blocked approved task. This pass may only
create dependency-independent drafts: it cannot complete the task, submit
acceptance evidence, delegate work or modify the approved plan. The result is
persisted as an intermediate checkpoint and supplied to the normal task once all
dependencies are complete. Prepared tasks and their checkpoint are visible on
the workflow card and in the task details. A failed preparation is best-effort
and never prevents the later full task.

Recovery remains runtime-only but is fully visible in the workflow. A real
timeout keeps the original task marked as timed out; a result that still fails
automatic quality gates after model escalation is marked as a quality problem.
Other execution errors also go to the PM first. The PM creates a bounded recovery
DAG of small tickets, selects suitable local agents by their roles/capabilities,
sets only necessary dependencies and lets independent branches run in parallel.
The approved main contract is not rewritten. Downstream tickets whose results
depend on the failed ticket become stale and are rerun/reviewed after recovery;
successful unrelated branches remain untouched. The PM must explicitly confirm
the recovered result and its acceptance evidence. After at most two PM recovery
rounds the task waits for the user; new user information may start a fresh bounded
cycle. If the plan itself is structurally wrong, the alternative revision path
preserves the approved snapshot and presents a diff for user approval. Provider
rate limits remain automatically retryable. Every user note, attempt, recovery
plan, status and actual model is persisted in the corresponding ticket.

Workflow nodes remain freely movable before and after approval. Their coordinates
live in separate view state and therefore never change the approved execution
contract, its revision, task content or compliance checks. The automatic-layout
action resets only this visual state.

The workflow header includes a confirmed delete action. It stops an active run
before removing the graph, plan revisions, undo history and resumable checkpoint.
The same single action also cancels and removes every group-work request tree
visible to the current group, including nested branches. It remains available
when only group work is left and the main graph is already empty.
The group immediately enters a fresh, empty planning session. A visible reset
notice and an internal one-shot instruction require a new user request and keep
the PM from reconstructing the deleted plan from older chat history. Chat
messages, group configuration, memory and project settings remain intact.

The same header can export a reusable `.agent-workflow.json` plan or import one
from another installation. Exported files use a versioned, bounded schema with
tasks, review steps, fork/join points, blocking connections, acceptance criteria,
layout positions and symbolic agent roles. They deliberately exclude chat IDs,
local agent IDs, approvals, execution logs, results, errors and resume state.

Import never starts work. The file is size-limited and structurally validated,
then every symbolic role must be mapped to an agent in the current group. Name,
role and capability matches are suggested but remain visible and editable. The
result replaces an existing workflow only after confirmation and is persisted as
a user-owned planning draft; normal preflight checks and explicit user approval
are still required before any agent can execute it.

After approval, task content, types, assignments, models, criteria and
dependencies are read-only. Visual card positions remain movable, and runtime
status transitions update badges without changing the graph layout.

Execution progress is runtime state as well: queued, active, completed, waiting,
retryable, provider-paused, failed or timed-out statuses and acceptance evidence
do not count as plan edits. When the user opens a versioned draft, the workflow compares only contract fields with
the last approved snapshot. Changed tasks and connections are highlighted in red;
the details panel shows the previous and proposed values, while removed tasks are
listed in the draft banner.

### Cross-group requests

Users can address another group from a group chat with
`@Group name: question`. Agents use the same syntax at the beginning of a line.
The target group's PM answers from its recent conversation and shared-memory
context and may consult specialists in that group. If several groups are
addressed in one batch, the source waits until every answer is available.

An agent-created request puts only its source task into **Waiting for group**.
Independent ready tasks continue according to the approved dependency graph;
the plan itself, assignments and connections remain unchanged. Agent capacity is
global, so one configured agent is never used by two groups at the same time.
Target groups continue in the background even when their chats are not visible.

The workflow window separates the immutable **Main workflow** and the complete
**Group work** request chain into full-size tabs. The group-work view renders a
non-editable tree in the target groups' colors. Each branch exposes the receiving
PM's live planning, specialist, waiting and synthesis steps. All group tasks are
rendered at normal contrast regardless of the currently viewed group. Returned
answers are also attached to the originating task and
remain readable from its detail panel. The selected tab is remembered per chat,
so an opened group-work view survives status updates and reopening the workflow
window. Deletion is intentionally centralized in the single header action, which
clears this view together with the main workflow. Answers resume the exact
waiting task.
Invalid PM targets are corrected once and
then fail visibly rather than being ignored. Failed or timed-out requests stay
visible and can be retried there. Requests survive an app
restart; a request interrupted while running returns to its queue. A group that
needs information while processing a request may create a child consultation
along one of its own directed routes. The parent waits, the child answer resumes
the exact parent task, and the final result then returns through the stored
request chain. Persisted group paths, a bounded depth and per-agent leases prevent
cycles, unbounded forwarding and concurrent reuse of the same agent.

After a group request is answered successfully, its bounded synthesized result
is written to the enabled Shared Memory of both the source and target group. The
entry carries request, group and source-task provenance. Intermediate PM plans,
specialist chatter, questions, failures and cancellations are never stored.
Stable request keys make retries idempotent; when both groups intentionally use
the same provider, namespace and memory file, only one entry is written.

Child results remain persisted for audit, but every parent request records which
request IDs its PM has already consumed. A continuation receives only newly
completed child results plus a bounded rolling summary; messages from the same
request chain are excluded from its model history to avoid duplicate context.
In approved workflows, a task receives results only from its direct or transitive
dependencies. Independent branches receive no unrelated group results. The PM is
involved again only through an explicit review/synthesis task, a real problem, or
the final synthesis used by the unplanned free-running mode.

## Project review and preview

Groups with an output folder can open a separate review window from the group
chat. It lists reviewable project files, previews text, images and Word content,
opens PDFs and other formats through their installed desktop application, and
keeps a local snapshot before every supported text or DOCX change. DOCX editing
uses conservative exact-text replacement; replacements spanning differently
formatted Word runs are refused to protect the document structure.

Each group may configure one test command and one long-running preview command.
Reviewer agents can automatically run the test command when their assigned task
is a review or validation task. The first run requires a native confirmation;
changing the folder, command or arguments revokes that approval. Commands use
the group folder as their working directory and receive a scrubbed environment,
but they still run with the signed-in operating-system user's permissions. This
is a controlled runner, not an operating-system security sandbox.

## Local data

Electron stores app state below the operating system's application-data directory. Attachments are copied into an application-managed `chat-attachments` directory. A group can alternatively use a JSON memory file selected by the user.

Existing installations using the historical `whatsapp-agents` data directory continue using that directory to avoid losing chats during the rename.

All agents in one group use the group's configured shared-memory namespace.
Different groups remain isolated by default; choose the same namespace to share
app-local memory, or the same JSON file and namespace for file-backed memory.
Parallel writes are serialized so independently running agents cannot overwrite
one another's entries.

## Optional REST API

The REST API is disabled by default. Enable it in **Settings → Security**, copy the generated token once and send it with every request:

```text
Authorization: Bearer <token>
```

The server binds only to `127.0.0.1`. Browser origins must be explicitly allow-listed. Treat the token as a password.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security vulnerabilities must be reported according to [SECURITY.md](SECURITY.md), not through a public issue.

## License

Agent Teams is available under the [MIT License](LICENSE). Dependencies and bundled runtimes retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
