# Changelog

All notable changes are documented here. The project follows semantic versioning while APIs remain subject to beta changes.

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
