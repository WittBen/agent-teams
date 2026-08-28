# Privacy

Agent Teams does not require a central Agent Teams account and does not include application telemetry by default.

## Local processing and storage

App configuration, conversations, task graphs, permissions and app-local memory are stored on the device. Chat attachments are copied to an application-managed directory. User-selected JSON memory files and project files remain at their selected locations.

Provider API keys, including keys for user-defined connections, are encrypted with Electron `safeStorage`. Connection names, base URLs, protocols and model IDs are stored as ordinary app configuration. Environment variables and authenticated CLI sessions remain managed by the operating system or their respective CLI.

## External processing

When an agent is used, the selected built-in or user-configured provider receives the prompt, relevant conversation context, system instructions and supported attachments. When an MCP tool is used, that MCP server receives the tool name and arguments. Their privacy and retention terms apply independently. Verify custom provider URLs carefully because they define where that content is sent.

The optional REST API is local-only, disabled by default and does not send data to an Agent Teams service. Requests can still trigger configured AI providers or MCP services.

## Deletion

Deleting a group removes its local messages, task state, permissions, app-local group memory and managed attachments. Externally selected project files and external JSON memory files are not deleted automatically. Provider-side retention cannot be controlled by this application.
