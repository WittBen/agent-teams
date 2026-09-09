const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createCliStatusCache, createOutputBudget } = require('../electron/cli-performance');

test('Claude activity extends idle deadline, while silence and hard limit still stop it', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const { EventEmitter } = require('node:events');
  const { createRequire } = require('node:module');
  const filename = require.resolve('../electron/claude-main');
  const localRequire = createRequire(filename);
  const setup = () => {
    let now = 0;
    let nextId = 0;
    const timers = new Map();
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { write() {}, end() {} };
    child.kill = () => { child.killed = true; };
    const context = {
      module: { exports: {} }, process, Buffer, Date,
      setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; },
      clearTimeout: id => timers.delete(id),
      require: id => id === 'child_process' ? { spawn: () => child }
        : id === './llm-stream' ? { createTextProgress: () => ({ start() {}, push() {}, finish() {} }) }
          : localRequire(id),
    };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    return { child, run: context.module.exports.runClaude, advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= now && timers.has(id)) { timers.delete(id); timer.fn(); }
    }, timers };
  };
  const active = setup();
  const success = active.run([], { timeoutMs: 100, idleTimeoutMs: 30 });
  for (let i = 0; i < 4; i++) { active.advance(20); active.child.stdout.emit('data', Buffer.from('{}\n')); }
  assert.equal(active.child.killed, undefined);
  active.child.emit('close', 0);
  await success;
  assert.equal(active.timers.size, 0);
  const idle = setup();
  const idleResult = assert.rejects(idle.run([], { timeoutMs: 100, idleTimeoutMs: 30 }), { code: 'CLAUDE_IDLE_TIMEOUT' });
  idle.advance(31);
  await idleResult;
  const hard = setup();
  const hardResult = assert.rejects(hard.run([], { timeoutMs: 100, idleTimeoutMs: 30 }), { code: 'CLAUDE_TIMEOUT' });
  for (let i = 0; i < 5; i++) { hard.advance(20); hard.child.stdout.emit('data', Buffer.from('{}\n')); }
  await hardResult;
  assert.equal(hard.timers.size, 0);
});

test('API streams can be cancelled while the provider is still generating', async () => {
  const http = require('node:http');
  const { postEventStream } = require('../electron/llm-stream');
  const controller = new AbortController();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"started":true}\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(postEventStream(`http://127.0.0.1:${server.address().port}`, {}, {}, {
      signal: controller.signal, onEvent: () => controller.abort(), timeoutMs: 2000,
    }), /abort|unterbrochen/i);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('SSE emits before completion and preserves UTF-8 split across network packets', async () => {
  const http = require('node:http');
  const { postEventStream, openAIStreamDelta } = require('../electron/llm-stream');
  let release;
  const observed = new Promise(resolve => { release = resolve; });
  const server = http.createServer(async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const payload = Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Grüße 🌍' } }] })}\n\n`);
    const split = payload.indexOf(Buffer.from('🌍')) + 2;
    response.write(payload.subarray(0, split));
    setImmediate(() => response.write(payload.subarray(split)));
    await observed;
    response.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    let streamed = '';
    const result = await postEventStream(`http://127.0.0.1:${server.address().port}`, {}, {}, {
      timeoutMs: 2000, onEvent: event => { streamed += openAIStreamDelta(event); release(); },
    });
    assert.equal(streamed, 'Grüße 🌍');
    assert.equal(result.eventCount, 1);
  } finally { release(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('an interrupted SSE response rejects promptly instead of waiting indefinitely', async () => {
  const http = require('node:http');
  const { postEventStream } = require('../electron/llm-stream');
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"partial":true}\n\n');
    setImmediate(() => response.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(postEventStream(`http://127.0.0.1:${server.address().port}`, {}, {}, { timeoutMs: 2000 }), /unterbrochen|aborted|reset/i);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('parallel status requests share one probe and expiry starts at completion', async () => {
  let clock = 0;
  let calls = 0;
  const cache = createCliStatusCache(async () => {
    calls += 1;
    clock += 100;
    return { connected: true };
  }, { now: () => clock, successMs: 50 });
  await Promise.all(Array.from({ length: 100 }, () => cache.get()));
  assert.equal(calls, 1);
  assert.equal((await cache.get()).cached, true);
  clock += 51;
  await cache.get();
  assert.equal(calls, 2);
  await cache.get({ force: true });
  assert.equal(calls, 3);
});

test('invalidation prevents an older in-flight auth result from overwriting new status', async () => {
  const resolvers = [];
  const cache = createCliStatusCache(() => new Promise(resolve => resolvers.push(resolve)));
  const old = cache.get();
  await Promise.resolve();
  cache.invalidate();
  const fresh = cache.get();
  await Promise.resolve();
  resolvers[1]({ connected: true });
  await fresh;
  resolvers[0]({ connected: false });
  await old;
  assert.equal((await cache.get()).connected, true);
});

test('failure cache expires quickly and rejected probes can be retried', async () => {
  let clock = 0;
  let calls = 0;
  const cache = createCliStatusCache(async () => {
    calls += 1;
    if (calls === 1) throw new Error('probe failed');
    return { connected: false };
  }, { now: () => clock, failureMs: 10 });
  await assert.rejects(cache.get(), /probe failed/);
  await cache.get();
  await cache.get();
  assert.equal(calls, 2);
  clock = 11;
  await cache.get();
  assert.equal(calls, 3);
});

test('output budget counts actual UTF-8 bytes and rejects overflow', () => {
  const accept = createOutputBudget(6);
  assert.equal(accept(Buffer.from('ä')), true);
  assert.equal(accept('😀'), true);
  assert.equal(accept(Buffer.from('x')), false);
});
