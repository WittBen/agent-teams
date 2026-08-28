# Threat Model

## Assets

- Provider API keys and authenticated CLI sessions
- Conversation messages, shared memory and attachments
- Project files writable by agent workflows
- MCP credentials and tool permissions
- Optional REST API bearer token

## Trust boundaries

The React renderer is treated as less trusted than the Electron main process. Reusable provider secrets remain in the main process. IPC calls accept only the packaged application page or the local Vite development origin and validate allowed state keys.

AI providers and MCP servers are external trust domains. Model output is untrusted input. A model cannot grant itself MCP permission; server trust and tool permission are separate user decisions.

## Principal threats and controls

| Threat | Control |
|---|---|
| Malicious webpage calls localhost API | API disabled by default, bearer token, strict origin allowlist |
| Renderer reads provider keys | OS-protected storage in main process; status-only renderer API |
| Renderer swaps a custom provider endpoint at call time | main-process lookup of saved configuration by provider ID; no renderer-supplied URL is used for the call |
| Cleartext or credential-bearing provider URL | HTTPS required remotely; HTTP limited to loopback; credentials, query and fragment rejected |
| Renderer invokes arbitrary IPC | sender validation, narrow preload bridge, state-key allowlist |
| MCP configuration changes after approval | configuration fingerprint and renewed native trust prompt |
| MCP tool changes after approval | tool signature invalidates stored permission |
| Path traversal or arbitrary writes | selected-path trust registry, containment checks, protected directories |
| Oversized requests or tool data | request, attachment, argument and result limits |
| Accidental data retention | cascading group deletion and documented storage locations |

## Residual risks

- MCP stdio servers execute with the current user's operating-system permissions.
- A provider or MCP service can retain data according to its own policy.
- A trusted custom HTTPS hostname can still resolve to private infrastructure;
  only add endpoints whose operator and network destination you understand.
- A user-approved project directory is writable and should be version-controlled or backed up.
- Local malware running as the same operating-system user remains outside the app's security boundary.
- AI-generated content can be incorrect or unsafe and requires review.
