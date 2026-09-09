const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { CodexAppServerClient } = require('../electron/codex-app-server');

function client(mode) {
  return new CodexAppServerClient({
    command: process.execPath,
    args: [path.join(__dirname, 'fixtures/codex-app-server.cjs'), ...(mode ? [mode] : [])],
  });
}

test('Codex result can cross the Electron structured-clone boundary', async () => {
  const c = client();
  try {
    const result = await c.run({ prompt: 'test' });
    assert.equal(structuredClone(result).text, 'Hallo Codex');
  } finally { c.stop(); }
});

for (const mode of ['--hang', '--silent-start']) {
  test(`cancellation settles without server completion (${mode})`, { timeout: 3000 }, async () => {
    const c = client(mode);
    try {
      await assert.rejects(c.run({
        prompt: 'test',
        onReady: ({ cancel }) => setTimeout(cancel, 30),
      }), { code: 'CODEX_CANCELLED', turnStarted: true });
      assert.equal(c.runsByThread.size, 0);
      assert.equal(c.runsByTurn.size, 0);
    } finally { c.stop(); }
  });

  test(`stopping rejects active work and clears requests (${mode})`, { timeout: 3000 }, async () => {
    const c = client(mode);
    try {
      await assert.rejects(c.run({
        prompt: 'test',
        onReady: () => setTimeout(() => c.stop(), 30),
      }), { code: 'CODEX_APP_SERVER_EXIT' });
      assert.equal(c.pending.size, 0);
      assert.equal(c.runsByThread.size, 0);
    } finally { c.stop(); }
  });
}
