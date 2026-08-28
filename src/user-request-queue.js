function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeQueueItem(item) {
  if (!isRecord(item)) return null;
  const id = String(item.id || '').trim().slice(0, 200);
  const messageId = String(item.messageId ?? '').trim().slice(0, 200);
  if (!id || !messageId) return null;
  return {
    id,
    messageId,
    createdAt: Number(item.createdAt) || Date.now(),
  };
}

export function normalizeUserRequestQueues(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const [chatId, items] of Object.entries(value)) {
    if (!Array.isArray(items)) continue;
    const seen = new Set();
    const normalized = items
      .map(normalizeQueueItem)
      .filter(item => item && !seen.has(item.id) && seen.add(item.id));
    if (normalized.length > 0) result[String(chatId).slice(0, 200)] = normalized;
  }
  return result;
}

export function enqueueUserRequest(queues, chatId, request) {
  const normalized = normalizeQueueItem(request);
  if (!normalized) return normalizeUserRequestQueues(queues);
  const current = normalizeUserRequestQueues(queues);
  const chatQueue = current[chatId] || [];
  if (chatQueue.some(item => item.id === normalized.id)) return current;
  return { ...current, [chatId]: [...chatQueue, normalized] };
}

export function removeUserRequest(queues, chatId, requestId) {
  const current = normalizeUserRequestQueues(queues);
  if (!current[chatId]) return current;
  const remaining = current[chatId].filter(item => item.id !== requestId);
  const next = { ...current };
  if (remaining.length > 0) next[chatId] = remaining;
  else delete next[chatId];
  return next;
}

export function clearUserRequests(queues, chatId) {
  const current = normalizeUserRequestQueues(queues);
  if (!current[chatId]) return current;
  const next = { ...current };
  delete next[chatId];
  return next;
}

export function buildQueuedRequestHistory(messages, queuedRequests, activeRequestId) {
  const queue = Array.isArray(queuedRequests) ? queuedRequests : [];
  const activeIndex = queue.findIndex(item => item.id === activeRequestId);
  const laterMessageIds = new Set((activeIndex >= 0 ? queue.slice(activeIndex + 1) : [])
    .map(item => String(item.messageId)));
  return (Array.isArray(messages) ? messages : [])
    .filter(message => !laterMessageIds.has(String(message?.id)));
}
