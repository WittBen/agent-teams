/** Keep agent lanes busy while respecting the caller's DAG/authorization checks. */
export async function runTaskPool({ initialTasks = [], execute, claim, shouldStop = () => false, stopAfter = () => false, onSnapshot = () => {} }) {
  const pending = [...initialTasks];
  const active = new Map();
  const occupied = new Set();
  const executions = [];
  let sequence = 0;
  let stopped = false;
  let failure;
  const launch = task => {
    const key = sequence++;
    occupied.add(task.agent.id);
    // Settle errors as values until every active agent has released its lease.
    const promise = Promise.resolve().then(() => execute(task)).then(
      result => ({ key, task, result }), error => ({ key, task, error }),
    );
    active.set(key, { task, promise });
  };
  const fill = () => {
    if (stopped || shouldStop()) return;
    let task;
    while (!stopped && !shouldStop()) {
      const index = pending.findIndex(item => !occupied.has(item.agent.id));
      task = index >= 0 ? pending.splice(index, 1)[0] : claim?.({
        activeAgentIds: new Set(occupied),
        activeNodeIds: new Set([...active.values()].map(item => item.task.graphNodeId).filter(Boolean)),
      });
      if (!task) break;
      if (occupied.has(task.agent.id)) throw new Error('Scheduler hat einen bereits belegten Agenten zugewiesen.');
      launch(task);
    }
    onSnapshot([...active.values()].map(item => item.task));
  };
  const safelyFill = () => {
    try { fill(); } catch (error) { failure ||= error; stopped = true; }
  };
  safelyFill();
  while (active.size) {
    const settled = await Promise.race([...active.values()].map(item => item.promise));
    active.delete(settled.key);
    occupied.delete(settled.task.agent.id);
    if (settled.error) { failure ||= settled.error; stopped = true; }
    else {
      executions.push(settled.result);
      if (stopAfter(settled.result)) stopped = true;
    }
    safelyFill();
    if (stopped || shouldStop()) onSnapshot([...active.values()].map(item => item.task));
  }
  if (failure) throw failure;
  return executions;
}
