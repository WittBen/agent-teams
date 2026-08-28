const readline = require('readline');

const lines = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

lines.on('line', line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;

  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-teams-smoke', version: '1.0.0' },
      },
    });
  } else if (message.method === 'tools/list') {
    send({
      jsonrpc: '2.0', id: message.id,
      result: {
        tools: [{
          name: 'echo',
          description: 'Echoes a value for integration tests.',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        }],
      },
    });
  } else if (message.method === 'tools/call') {
    send({
      jsonrpc: '2.0', id: message.id,
      result: { content: [{ type: 'text', text: `echo:${message.params?.arguments?.value || ''}` }] },
    });
  } else {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  }
});
