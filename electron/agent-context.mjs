/** Attachments are opt-in for specialists: the PM must name the file in its task. */
export function selectTaskAttachments(attachments = [], { coordinator = false, objective = '', handoff = null } = {}) {
  if (coordinator) return attachments;
  const assignment = [objective, handoff?.summary, ...(handoff?.findings || [])].join('\n').toLowerCase();
  return attachments.filter(attachment => {
    const name = String(attachment?.name || attachment?.filename || attachment?.path?.split(/[\\/]/).at(-1) || '').toLowerCase();
    return name.length > 3 && assignment.includes(name);
  });
}

/** Keep historical messages at the coordinator; direct chats stay two-party. */
export function selectAgentHistory(history = [], { agentId, coordinator = false, direct = false, maxCharacters = 12000 } = {}) {
  if (!coordinator && !direct) return [];
  const candidates = history.filter(message => message && message.agentId !== 'system' && !message.memoryOnly
    && (coordinator || message.agentId === 'user' || message.agentId === agentId)).slice(-20);
  let remaining = maxCharacters;
  const selected = [];
  for (const message of candidates.reverse()) {
    if (remaining <= 0) break;
    const text = String(message.text || '').slice(0, remaining);
    remaining -= text.length;
    // History never silently reattaches old files to a new assignment.
    selected.push({ agentId: message.agentId, senderName: message.senderName, text });
  }
  return selected.reverse();
}

export function handoffContext(handoff) {
  if (!handoff) return '';
  return [
    ...(handoff.findings || []).slice(0, 8),
    ...(handoff.openQuestions || []).slice(0, 5),
    ...(Array.isArray(handoff.relevantMemory) ? handoff.relevantMemory.slice(0, 5) : []),
  ].map(value => String(value).slice(0, 1500)).join('\n').slice(0, 8000);
}
