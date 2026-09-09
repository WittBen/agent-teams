/** Read complete task objects, never an incomplete ticket, from a partial JSON plan. */
export function extractClosedPlanTasks(reply, arrayKeys = ['tasks']) {
  const marker = String(reply || '').indexOf('[[TASK_PLAN]]');
  if (marker < 0) return null;
  const json = String(reply).slice(marker + 13).trim().replace(/^```(?:json)?\s*/i, '');
  let arrayStart = json.startsWith('[') ? 1 : -1;
  let depth = 0;
  // Locate only the top-level tasks property; metadata order does not matter.
  for (let i = 0; arrayStart < 0 && i < json.length; i++) {
    const ch = json[i];
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === '"') {
      const start = i;
      while (++i < json.length) {
        if (json[i] === '\\') { i++; continue; }
        if (json[i] === '"') break;
      }
      if (depth !== 1) continue;
      try {
        if (arrayKeys.includes(JSON.parse(json.slice(start, i + 1)))) {
          const suffix = json.slice(i + 1).match(/^\s*:\s*\[/);
          if (suffix) arrayStart = i + 1 + suffix[0].length;
        }
      } catch { return null; }
    }
  }
  if (arrayStart < 0) return null;
  const tasks = [];
  let start = -1;
  let quoted = false;
  let escaped = false;
  depth = 0;
  for (let i = arrayStart; i < json.length; i++) {
    const ch = json[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === '{') { if (depth++ === 0) start = i; }
    else if (ch === '}' && depth > 0 && --depth === 0) {
      try { tasks.push(JSON.parse(json.slice(start, i + 1))); } catch { return null; }
      if (tasks.length >= 50) break;
    } else if (ch === ']' && depth === 0) break;
  }
  return tasks.length ? tasks : null;
}
