const readline = require('readline');

const input = readline.createInterface({ input: process.stdin });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

input.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ id: message.id, result: { userAgent: 'fixture' } });
    return;
  }
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId || 'thread-fixture' } } });
    return;
  }
  if (message.method === 'turn/start') {
    const threadId = message.params.threadId;
    const turn = { id: 'turn-fixture', items: [], status: 'inProgress' };
    if (process.argv.includes('--silent-start')) return;
    send({ id: message.id, result: { turn } });
    send({ method: 'turn/started', params: { threadId, turn } });
    if (process.argv.includes('--hang')) return;
    send({ method: 'item/started', params: {
      threadId, turnId: turn.id, startedAtMs: Date.now(),
      item: { id: 'message-fixture', type: 'agentMessage', text: '', phase: 'final_answer' },
    } });
    send({ method: 'item/agentMessage/delta', params: {
      threadId, turnId: turn.id, itemId: 'message-fixture', delta: 'Hallo ',
    } });
    send({ method: 'item/agentMessage/delta', params: {
      threadId, turnId: turn.id, itemId: 'message-fixture', delta: 'Codex',
    } });
    send({ method: 'item/completed', params: {
      threadId, turnId: turn.id, completedAtMs: Date.now(),
      item: { id: 'message-fixture', type: 'agentMessage', text: 'Hallo Codex', phase: 'final_answer' },
    } });
    send({ method: 'turn/completed', params: {
      threadId, turn: { id: turn.id, items: [], status: 'completed' },
    } });
    return;
  }
  if (message.method === 'turn/interrupt') {
    send({ id: message.id, result: {} });
  }
});
