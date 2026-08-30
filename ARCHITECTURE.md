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
chats use the orchestrator: the PM plans work, agents execute addressed tasks,
and the PM performs the final completion review. Group memory and resumable run
state preserve context across interruptions. The task graph mirrors planned,
blocked, active, and completed work.

All agents in a group resolve the same configured memory provider and namespace.
Local-memory mutations are single atomic main-process operations and are queued
per namespace; JSON-file mutations are queued per file. Groups share memory only
when they intentionally select the same namespace and, for file-backed memory,
the same JSON file. Structured handoffs live in that group namespace and are
prioritized only for their addressed agent.

User messages submitted during an active agent run are persisted in a separate
per-chat FIFO queue. They remain visible immediately and are processed in order
after the current run step finishes. PM plans are distributed across agents in
the same role pool; independent tasks may run in parallel only after dependency,
agent-capacity, and file-conflict checks succeed.

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
