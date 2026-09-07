const agentLeases = new Map();

/**
 * Serialize use of one configured agent across simultaneously mounted groups.
 * Every waiter receives a release callback, so normal workflow tasks and
 * background group consultations share the same single-flight guarantee.
 */
export async function acquireAgentLease(agentId) {
  const key = String(agentId || '').trim();
  if (!key) return () => {};
  const previous = agentLeases.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const currentTail = previous.then(() => current);
  agentLeases.set(key, currentTail);
  await previous;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    if (agentLeases.get(key) === currentTail) agentLeases.delete(key);
  };
}
