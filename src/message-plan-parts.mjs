import { extractClosedPlanTasks } from './streaming-plan.mjs';

/** Presentation only: keep the original protocol text intact for orchestration. */
export function messagePlanParts(value) {
  const text = String(value || '');
  const parts = [];
  const marker = /\[\[(TASK_PLAN|ACCEPTANCE_REVIEW|TASK_EVIDENCE|RECOVERY_RESOLVED|TASK_DONE|PROJECT_DONE)\]\]/gi;
  let cursor = 0;
  let match;
  while ((match = marker.exec(text))) {
    if (match.index > cursor) parts.push({ type: 'text', text: text.slice(cursor, match.index) });
    const kind = match[1].toUpperCase();
    if (['RECOVERY_RESOLVED', 'TASK_DONE', 'PROJECT_DONE'].includes(kind)) {
      parts.push({ type: 'status', kind });
      cursor = marker.lastIndex;
      continue;
    }
    const bodyStart = marker.lastIndex;
    const end = new RegExp(`\\[\\[/${kind}\\]\\]`, 'gi');
    end.lastIndex = bodyStart;
    const closing = end.exec(text);
    const bodyEnd = closing ? closing.index : text.length;
    const keys = kind === 'TASK_PLAN' ? ['tasks'] : kind === 'TASK_EVIDENCE' ? ['evidence'] : ['decisions', 'reviews'];
    const tasks = extractClosedPlanTasks(`[[TASK_PLAN]]${text.slice(bodyStart, bodyEnd)}`, keys) || [];
    parts.push(kind === 'TASK_PLAN'
      ? { type: 'plan', tasks, complete: Boolean(closing) }
      : { type: 'review', kind, items: tasks, complete: Boolean(closing) });
    cursor = closing ? end.lastIndex : text.length;
    marker.lastIndex = cursor;
  }
  if (cursor < text.length) {
    // A protocol marker can arrive across multiple stream chunks.
    const tail = text.slice(cursor).replace(/\[\[[A-Z_/]*$/i, '');
    if (tail) parts.push({ type: 'text', text: tail });
  }
  return parts;
}
