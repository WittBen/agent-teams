# Agent Teams

Agent Teams is a local-first Electron and React desktop application for configurable AI agents, direct chats and coordinated multi-agent groups. Groups can share structured memory, use project folders, connect to MCP servers and maintain a task graph.

> **Status:** `1.1.0-beta.1`. This project is in public beta. Keep backups of important project data and review every MCP server before granting access.

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
`v1.1.0-beta.1`, runs the release workflow. GitHub Actions verifies the project,
builds the Windows installer, generates `SHA256SUMS.txt` and publishes a beta
tag as a prerelease.

## Provider configuration

Open **Settings → API access**. Manually entered keys are encrypted using the operating-system credential facility. The built-in OpenAI and Anthropic connections also support environment variables:

```text
OPENAI_API_KEY
ANTHROPIC_API_KEY
```

Codex CLI and Claude Code CLI sign-in remain independent options. The app invokes the authenticated local CLI session and does not require an additional API key for those routes.

Additional connections can be created from presets for OpenRouter, Groq, Mistral AI, Google Gemini, xAI, DeepSeek, Together AI, Ollama and LM Studio. A custom connection can use an OpenAI-compatible Chat Completions API, an Anthropic-compatible Messages API or the Google Gemini `generateContent` API. Enter the provider's base URL and one or more exact model IDs, then select that connection on any agent. Local Ollama and LM Studio presets do not require a key by default.

Custom does not mean every arbitrary HTTP API: its request and response format must match one of the three supported protocols. HTTPS is required for remote endpoints; cleartext HTTP is accepted only for `localhost`, `127.0.0.1` or IPv6 loopback. Base URLs containing credentials, query parameters or fragments are rejected.

Provider configuration is available globally to direct and group-chat agents. Quality Cascading can also escalate to a model on a configured connection. Keys are sent only to the selected provider as part of authenticated API requests. Prompt content, attachments and relevant conversation context are also sent to that provider.

Protocol references: [OpenRouter](https://openrouter.ai/docs/quickstart), [Groq](https://console.groq.com/docs/openai), [Mistral AI](https://docs.mistral.ai/api/endpoint/chat), [Google Gemini](https://ai.google.dev/api), [xAI](https://docs.x.ai/developers/model-capabilities/text/comparison), [DeepSeek](https://api-docs.deepseek.com/guides/function_calling), [Together AI](https://docs.together.ai/docs/api-keys-authentication), [Ollama](https://docs.ollama.com/api/openai-compatibility) and [LM Studio](https://lmstudio.ai/docs/developer).

## MCP configuration

MCP servers can execute code or access external data. Add only servers you trust. Sensitive literal HTTP headers and environment values are moved to protected storage. For portable configurations, use an environment-variable reference:

```text
Authorization=$env:MCP_AUTHORIZATION
API_TOKEN=$env:MCP_API_TOKEN
```

The application asks separately whether to trust a server and whether a particular tool may run.

## Local data

Electron stores app state below the operating system's application-data directory. Attachments are copied into an application-managed `chat-attachments` directory. A group can alternatively use a JSON memory file selected by the user.

Existing installations using the historical `whatsapp-agents` data directory continue using that directory to avoid losing chats during the rename.

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
