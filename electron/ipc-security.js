const path = require('path');

const APP_STATE_KEYS = new Set([
  'agents', 'groups', 'messages', 'conversationStates', 'userRequestQueues', 'taskGraphs', 'groupMemory',
  'kbPath', 'projectPath', 'mcpServers', 'mcpPermissions', 'mcpPresetVersion',
  'agentRoles', 'conversationLimits', 'qualityRouting', 'qualityStats', 'language',
  'providerConnections',
  'dataSchemaVersion', 'migrationNotices',
]);

function isAllowedStateKey(key) {
  return APP_STATE_KEYS.has(key) || /^memspace:[a-zA-Z0-9äöüÄÖÜß_.:-]{1,120}$/.test(String(key || ''));
}

function assertAllowedStateKey(key) {
  if (!isAllowedStateKey(key)) throw new Error('Nicht erlaubter App-State-Schlüssel.');
  return String(key);
}

function createSenderValidator({ appRoot, isDev }) {
  const expectedFile = path.resolve(appRoot, 'dist', 'index.html').toLowerCase();
  return function assertTrustedSender(event) {
    const senderUrl = event?.senderFrame?.url || event?.sender?.getURL?.() || '';
    if (isDev && /^http:\/\/(localhost|127\.0\.0\.1):5173(?:\/|$)/i.test(senderUrl)) return;
    if (senderUrl.startsWith('file:')) {
      try {
        const filePath = decodeURIComponent(new URL(senderUrl).pathname)
          .replace(/^\/(?:([a-zA-Z]:))/, '$1')
          .replace(/\//g, path.sep);
        if (path.resolve(filePath).toLowerCase() === expectedFile) return;
      } catch {}
    }
    throw new Error('IPC-Aufruf von einer nicht vertrauenswürdigen Seite blockiert.');
  };
}

module.exports = { assertAllowedStateKey, createSenderValidator, isAllowedStateKey };
