# Privacy

Agent Teams does not require a central Agent Teams account and does not include application telemetry by default.

## Local processing and storage

App configuration, conversations, task graphs, permissions and app-local memory are stored on the device. Chat attachments are copied to an application-managed directory. User-selected JSON memory files and project files remain at their selected locations.

Provider API keys, including keys for user-defined connections, are encrypted with Electron `safeStorage`. Connection names, base URLs, protocols and model IDs are stored as ordinary app configuration. Environment variables and authenticated CLI sessions remain managed by the operating system or their respective CLI.

## Project experience register

Experience learning is enabled by default in the desktop app and local API.
The app-local register stores hashed project identifiers, complexity, fixed
quality-error and hint codes, final gate acceptance, token estimates and
timestamps. It does not store raw prompts, responses or project files. Hashes
are stable and unsalted; they allow correlation and are not an anonymity guarantee.

After each write the register contains at most 1,000 observations. Records aged
90 days or more are excluded from selection and statistics; physical pruning
occurs on the next experience write, not through a background deletion timer.

## External processing

When an agent is used, the selected built-in or user-configured provider receives the prompt, relevant conversation context, system instructions and supported attachments. When an MCP tool is used, that MCP server receives the tool name and arguments. Their privacy and retention terms apply independently. Verify custom provider URLs carefully because they define where that content is sent.

The optional REST API is local-only, disabled by default and does not send data to an Agent Teams service. Requests can still trigger configured AI providers or MCP services.

Selected predefined harness hints are included in subsequent model prompts and
therefore reach the selected provider. The experience register itself is not
uploaded, and learning does not make a separate model or telemetry request.

## Deletion

Deleting a group removes its local messages, task state, permissions, app-local group memory and managed attachments. Externally selected project files and external JSON memory files are not deleted automatically. Provider-side retention cannot be controlled by this application.

Global harness experiences survive group deletion. In Settings → API access →
Quality Cascading, save **Aus Projekterfahrungen lernen** as disabled to stop
collection and retrieval; **Erfahrungen löschen** clears existing experiences.
Disabling alone does not erase data. In-flight runs may still write their outcome;
stop those runs before clearing if the register must remain empty.
