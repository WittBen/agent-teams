// Shared by CLI adapters; only status probes are coalesced, never model calls.
function createCliStatusCache(probe, { successMs = 300000, failureMs = 10000, now = Date.now } = {}) {
  let cached = null;
  let pending = null;
  let generation = 0;
  return {
    get({ force = false } = {}) {
      if (pending) return pending;
      if (!force && cached && cached.expiresAt > now()) {
        return Promise.resolve({ ...cached.value, cached: true });
      }
      const current = generation;
      const request = Promise.resolve().then(probe).then(value => {
        if (current === generation) cached = {
          value,
          expiresAt: now() + (value.connected ? successMs : failureMs),
        };
        return value;
      }).finally(() => {
        if (pending === request) pending = null;
      });
      pending = request;
      return request;
    },
    invalidate() {
      generation += 1;
      cached = null;
      pending = null;
    },
  };
}

// Count incoming bytes once instead of re-encoding the entire accumulated log.
function createOutputBudget(limit) {
  let bytes = 0;
  return chunk => {
    bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, 'utf8');
    return bytes <= limit;
  };
}

module.exports = { createCliStatusCache, createOutputBudget };
