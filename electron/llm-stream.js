const http = require('http');
const https = require('https');
const { StringDecoder } = require('string_decoder');

const MAX_STREAM_BYTES = 20 * 1024 * 1024;
const MAX_PREVIEW_CHARACTERS = 12000;
const PROGRESS_FLUSH_MS = 40;

function createTextProgress(onProgress, provider = '') {
  const startedAt = Date.now();
  let firstTextAt = 0;
  let text = '';
  let pendingDelta = '';
  let flushTimer = null;
  const emit = (phase, extra = {}) => {
    if (typeof onProgress !== 'function') return;
    onProgress({
      provider,
      phase,
      ts: Date.now(),
      elapsedMs: Date.now() - startedAt,
      firstTokenMs: firstTextAt ? firstTextAt - startedAt : 0,
      ...extra,
    });
  };
  // Token events may arrive much faster than the renderer can paint them. Batch
  // only the UI notifications; the complete answer is still retained verbatim.
  const flush = () => {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    if (!pendingDelta) return;
    const delta = pendingDelta;
    pendingDelta = '';
    emit('streaming', {
      message: 'Antwort wird live erstellt.',
      delta,
      partialText: text.slice(-MAX_PREVIEW_CHARACTERS),
    });
  };
  return {
    start(message = 'Modellaufruf wird gestartet.') {
      emit('starting', { message, partialText: '', firstTokenMs: 0 });
    },
    push(delta) {
      const value = String(delta || '');
      if (!value) return;
      if (!firstTextAt) firstTextAt = Date.now();
      text += value;
      pendingDelta += value;
      if (text === value) { flush(); return; }
      if (!flushTimer) flushTimer = setTimeout(flush, PROGRESS_FLUSH_MS);
    },
    finish(message = 'Antwort ist vollständig.') {
      flush();
      emit('completed', {
        message,
        partialText: text.slice(-MAX_PREVIEW_CHARACTERS),
      });
    },
    get text() { return text; },
  };
}

function parseSseFrame(frame) {
  const data = String(frame || '')
    .split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
    .trim();
  if (!data || data === '[DONE]') return null;
  try { return JSON.parse(data); } catch { return null; }
}

function postEventStream(target, headers, body, { onEvent, timeoutMs = 30000, signal } = {}) {
  const url = target instanceof URL ? target : new URL(String(target));
  const transport = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    const request = transport.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      signal,
      headers: { ...headers, accept: 'text/event-stream', 'content-length': Buffer.byteLength(bodyText) },
    }, response => {
      let raw = '';
      let pending = '';
      let size = 0;
      let eventCount = 0;
      const decoder = new StringDecoder('utf8');
      const consumeFrame = frame => {
        const event = parseSseFrame(frame);
        if (!event) return;
        eventCount += 1;
        onEvent?.(event);
      };
      response.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_STREAM_BYTES) {
          request.destroy(new Error('Provider-Antwort überschreitet das Sicherheitslimit.'));
          return;
        }
        const value = decoder.write(chunk);
        raw += value;
        pending += value;
        const frames = pending.split(/\r?\n\r?\n/);
        pending = frames.pop() || '';
        frames.forEach(consumeFrame);
      });
      response.on('end', () => {
        const tail = decoder.end();
        raw += tail;
        pending += tail;
        if (pending.trim()) consumeFrame(pending);
        let parsedBody = null;
        try { parsedBody = JSON.parse(raw); } catch {}
        resolve({
          status: response.statusCode,
          headers: response.headers || {},
          body: parsedBody,
          raw,
          eventCount,
        });
      });
      response.on('error', reject);
      response.on('aborted', () => reject(new Error('Provider-Stream wurde vorzeitig unterbrochen.')));
    });
    request.on('error', reject);
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`)));
    request.write(bodyText);
    request.end();
  });
}

function openAIStreamDelta(event) {
  const content = event?.choices?.[0]?.delta?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => typeof part === 'string' ? part : (part?.text || '')).join('');
}

function anthropicStreamDelta(event) {
  return event?.type === 'content_block_delta' && event?.delta?.type === 'text_delta'
    ? String(event.delta.text || '')
    : '';
}

function geminiStreamDelta(event) {
  return (event?.candidates?.[0]?.content?.parts || [])
    .map(part => String(part?.text || ''))
    .join('');
}

module.exports = {
  anthropicStreamDelta,
  createTextProgress,
  geminiStreamDelta,
  openAIStreamDelta,
  parseSseFrame,
  postEventStream,
};
