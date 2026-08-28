# Contributing

Thank you for helping improve Agent Teams.

1. Discuss large behavior or architecture changes before implementation.
2. Create a focused branch and avoid unrelated formatting changes.
3. Run `npm ci`, `npm test`, `npm run build` and `npm run audit`.
4. Add tests for fixes and new behavior.
5. Explain data migrations, security implications and user-visible changes in the pull request.

Never commit API keys, OAuth tokens, conversation exports, real memory files or user attachments. Security issues follow [SECURITY.md](SECURITY.md).

Code should keep Electron capabilities in the main process, expose narrow preload methods, validate IPC senders and inputs, and preserve existing user data through versioned migrations.
