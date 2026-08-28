# Security Policy

## Supported versions

Only the most recent tagged beta or stable release receives security fixes. Development snapshots are unsupported.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Contact the repository maintainers privately through the security-reporting mechanism configured by the hosting repository. Include affected versions, reproduction steps, impact and any proposed mitigation.

The maintainers should acknowledge a report within seven days and avoid publishing details before a fix or coordinated disclosure date is available.

## Security boundaries

- MCP servers and their tools are third-party code and are not sandboxed by Agent Teams.
- AI providers receive prompts, selected chat context and supported attachments.
- User-defined provider endpoints must be treated as external services. Verify
  their URL, operator and privacy terms before assigning them to an agent.
- Project folders explicitly selected by the user are writable by authorized agent workflows.
- The optional localhost API grants broad app access to anyone holding its bearer token.

See [THREAT_MODEL.md](THREAT_MODEL.md) for the detailed trust model.
