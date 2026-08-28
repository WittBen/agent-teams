# Changelog

All notable changes are documented here. The project follows semantic versioning while APIs remain subject to beta changes.

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
