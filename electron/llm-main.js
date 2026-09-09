/**
 * LLM caller for Electron main process and API server.
 * Uses Node.js HTTP(S) modules — no browser CORS restrictions.
 */
const { callCodexCLI } = require('./codex-main');
const { callClaudeCLI } = require('./claude-main');
const { findProviderConnection, providerEndpoint } = require('./provider-config');
const {
  anthropicStreamDelta,
  createTextProgress,
  geminiStreamDelta,
  openAIStreamDelta,
  postEventStream,
} = require('./llm-stream');

const { setTimeout: abortableDelay } = require('node:timers/promises');

const MAX_INLINE_RATE_LIMIT_WAIT_MS = 15000;

function parseRetryAfterMs(headers = {}, now = Date.now()) {
  const retryAfter = headers['retry-after'];
  if (retryAfter != null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds * 1000));
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) return Math.max(0, retryDate - now);
  }
  const reset = headers['anthropic-ratelimit-unified-reset'] || headers['anthropic-ratelimit-requests-reset'];
  const resetDate = Date.parse(reset || '');
  return Number.isFinite(resetDate) ? Math.max(0, resetDate - now) : 60000;
}

function anthropicFallbackModel(model) {
  return /opus/i.test(String(model || '')) ? 'claude-sonnet-4-5' : null;
}

function anthropicError(res) {
  const error = res?.body?.error || res?.body;
  return error?.message || error?.type || JSON.stringify(error || {});
}

async function callAnthropicMessages({ auth, model, systemContent, messages, maxTokens = 8192, onProgress = null, signal }) {
  if (auth?.type !== 'api-key' || !auth.value) {
    return { error: 'Für die direkte Anthropic API ist ein eigener API-Key erforderlich.', status: 401 };
  }
  const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
  headers['x-api-key'] = auth.value;

  const fallbackModel = anthropicFallbackModel(model);
  const modelCandidates = fallbackModel ? [model, fallbackModel] : [model];
  let lastRateLimit = null;
  const progress = createTextProgress(onProgress, 'anthropic');
  progress.start('Anthropic startet die Antwort.');

  for (const candidateModel of modelCandidates) {
    let streamError = null;
    const run = () => postEventStream(new URL('https://api.anthropic.com/v1/messages'), headers, {
      model: candidateModel, system: systemContent, messages, max_tokens: maxTokens, stream: true,
    }, { signal, onEvent: event => {
      const delta = anthropicStreamDelta(event);
      if (delta) progress.push(delta);
      if (event?.type === 'error') streamError = event.error || event;
    } });
    let res = await run();
    if (streamError && !res.body) res.body = { error: streamError };

    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(res.headers);
      if (retryAfterMs > 0 && retryAfterMs <= MAX_INLINE_RATE_LIMIT_WAIT_MS) {
        await abortableDelay(retryAfterMs, undefined, { signal });
        streamError = null;
        res = await run();
        if (streamError && !res.body) res.body = { error: streamError };
      }
      if (res.status === 429) {
        lastRateLimit = {
          error: anthropicError(res),
          status: 429,
          rateLimited: true,
          retryable: true,
          retryAfterMs: parseRetryAfterMs(res.headers),
          requestedModel: model,
          actualModel: candidateModel,
          fallbackUsed: candidateModel !== model,
        };
        continue;
      }
    }

    if (res.status >= 400 || res.body?.type === 'error' || res.body?.error) {
      const overloaded = res.status === 529 || res.status === 503 || /overloaded|unavailable/i.test(anthropicError(res));
      if (overloaded && candidateModel !== modelCandidates.at(-1)) continue;
      return { error: anthropicError(res), status: res.status, requestedModel: model, actualModel: candidateModel };
    }

    const textBlock = Array.isArray(res.body?.content) && res.body.content.find(block => block.type === 'text');
    const text = progress.text || textBlock?.text || '';
    if (!text.trim()) {
      return { error: `Leere Antwort vom Modell (${candidateModel})`, status: res.status, requestedModel: model, actualModel: candidateModel };
    }
    progress.finish();
    return {
      text,
      requestedModel: model,
      actualModel: candidateModel,
      fallbackUsed: candidateModel !== model,
    };
  }

  return lastRateLimit || { error: 'Anthropic-Aufruf fehlgeschlagen.', status: 500 };
}

function providerErrorMessage(response) {
  const error = response?.body?.error || response?.body;
  if (typeof error === 'string') return error;
  return error?.message || error?.status || error?.type || JSON.stringify(error || {});
}

function openAIResponseText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    return part?.text || '';
  }).filter(Boolean).join('\n');
}

function openAIContentToGeminiParts(content) {
  if (typeof content === 'string') return [{ text: content }];
  if (!Array.isArray(content)) return [{ text: String(content || '') }];
  return content.flatMap(part => {
    if (part?.type === 'text') return [{ text: String(part.text || '') }];
    if (part?.type === 'image_url') {
      const value = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
      const match = String(value || '').match(/^data:([^;,]+);base64,([a-zA-Z0-9+/=]+)$/);
      return match ? [{ inlineData: { mimeType: match[1], data: match[2] } }] : [];
    }
    if (part?.type === 'file' && part.file?.filename) {
      return [{ text: `[Angehängte Datei: ${String(part.file.filename).slice(0, 240)}]` }];
    }
    return [];
  }).filter(part => part.text === undefined || part.text);
}

function openAIMessagesToGemini(messages) {
  return (messages || []).filter(message => message?.role !== 'system').map(message => ({
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: openAIContentToGeminiParts(message.content),
  })).filter(message => message.parts.length);
}

function mergeMessageContent(left, right) {
  if (typeof left === 'string' && typeof right === 'string') return `${left}\n${right}`;
  const toParts = value => Array.isArray(value) ? value : [{ type: 'text', text: String(value || '') }];
  return [...toParts(left), ...toParts(right)];
}

function normalizeAnthropicMessages(messages) {
  const result = [];
  for (const message of messages || []) {
    const role = message?.role === 'assistant' ? 'assistant' : 'user';
    if (result.at(-1)?.role === role) {
      result[result.length - 1].content = mergeMessageContent(result.at(-1).content, message.content);
    } else {
      result.push({ role, content: message.content });
    }
  }
  if (!result.length || result[0].role !== 'user') result.unshift({ role: 'user', content: '(start)' });
  if (result.at(-1)?.role === 'assistant') result.push({ role: 'user', content: '(Bitte antworte auf die vorige Nachricht)' });
  return result;
}

async function callConfiguredProvider({ connection, apiKey = '', model, systemContent, messages, maxTokens = 8192, onProgress = null, signal }) {
  if (!connection) return { error: 'Der konfigurierte API-Provider wurde nicht gefunden.', status: 404 };
  if (connection.requiresApiKey && !String(apiKey || '').trim()) {
    return { error: `Für „${connection.name}“ ist kein API-Key konfiguriert.`, status: 401 };
  }

  const key = String(apiKey || '').trim();
  let response;
  const progress = createTextProgress(onProgress, connection.protocol || 'openai');
  progress.start(`${connection.name || 'Provider'} startet die Antwort.`);
  if (connection.protocol === 'anthropic') {
    const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
    if (key) headers['x-api-key'] = key;
    let streamError = null;
    response = await postEventStream(providerEndpoint(connection, 'messages'), headers, {
      model, system: systemContent, messages: normalizeAnthropicMessages(messages), max_tokens: maxTokens, stream: true,
    }, { signal, onEvent: event => {
      const delta = anthropicStreamDelta(event);
      if (delta) progress.push(delta);
      if (event?.type === 'error') streamError = event.error || event;
    } });
    if (streamError && !response.body) response.body = { error: streamError };
  } else if (connection.protocol === 'gemini') {
    const headers = { 'content-type': 'application/json', 'x-goog-api-client': 'agent-teams/1.1.0' };
    if (key) headers['x-goog-api-key'] = key;
    const safeModel = String(model || '').replace(/^models\//, '');
    const endpoint = providerEndpoint(connection, `models/${encodeURIComponent(safeModel)}:streamGenerateContent`);
    endpoint.searchParams.set('alt', 'sse');
    response = await postEventStream(endpoint, headers, {
      systemInstruction: { parts: [{ text: systemContent }] },
      contents: openAIMessagesToGemini(messages),
      generationConfig: { maxOutputTokens: maxTokens },
    }, { signal, onEvent: event => progress.push(geminiStreamDelta(event)) });
  } else {
    const headers = { 'content-type': 'application/json' };
    if (key) headers.Authorization = `Bearer ${key}`;
    response = await postEventStream(providerEndpoint(connection, 'chat/completions'), headers, {
      model,
      messages: [{ role: 'system', content: systemContent }, ...messages],
      max_tokens: maxTokens,
      stream: true,
    }, { signal, onEvent: event => progress.push(openAIStreamDelta(event)) });
  }

  if (response.status >= 400 || response.body?.error) {
    return {
      error: providerErrorMessage(response),
      status: response.status,
      rateLimited: response.status === 429,
      retryable: response.status === 429 || response.status >= 500,
      retryAfterMs: response.status === 429 ? parseRetryAfterMs(response.headers) : 0,
    };
  }

  const fallbackText = connection.protocol === 'anthropic'
    ? (response.body?.content || []).filter(block => block?.type === 'text').map(block => block.text).join('\n')
    : connection.protocol === 'gemini'
      ? (response.body?.candidates?.[0]?.content?.parts || []).map(part => part?.text || '').filter(Boolean).join('\n')
      : openAIResponseText(response.body?.choices?.[0]?.message?.content);
  const text = progress.text || fallbackText;
  if (!String(text || '').trim()) return { error: `Leere Antwort von „${connection.name}“.`, status: response.status };
  progress.finish();
  return { text: String(text), actualModel: model };
}

async function callOpenAIChat({ apiKey, model, systemContent, messages, maxTokens = 8192, onProgress = null, signal }) {
  if (!String(apiKey || '').trim()) return { error: 'OpenAI ist nicht konfiguriert.', status: 401 };
  const progress = createTextProgress(onProgress, 'openai');
  progress.start('OpenAI startet die Antwort.');
  const response = await postEventStream(new URL('https://api.openai.com/v1/chat/completions'), {
    'content-type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }, {
    model,
    messages: [{ role: 'system', content: systemContent }, ...messages],
    temperature: 0.85,
    max_tokens: maxTokens,
    stream: true,
  }, { signal, onEvent: event => progress.push(openAIStreamDelta(event)) });
  if (response.status >= 400 || response.body?.error) {
    return { error: providerErrorMessage(response), status: response.status };
  }
  const text = progress.text || openAIResponseText(response.body?.choices?.[0]?.message?.content);
  if (!String(text || '').trim()) return { error: 'Leere Antwort von OpenAI.', status: response.status };
  progress.finish();
  return { text: String(text), actualModel: model };
}

function resolveAnthropicAuth(apiKeys) {
  if (apiKeys?.anthropic?.trim()) return { type: 'api-key', value: apiKeys.anthropic.trim() };
  if (process.env.ANTHROPIC_API_KEY) return { type: 'api-key', value: process.env.ANTHROPIC_API_KEY };
  if (apiKeys?.claudeCli || apiKeys?.claudeOAuthToken?.trim()) return { type: 'claude-cli', value: '' };
  return null;
}

function resolveOpenAIAuth(apiKeys) {
  if (apiKeys?.openai?.trim()) return { type: 'api-key', value: apiKeys.openai.trim() };
  if (process.env.OPENAI_API_KEY) return { type: 'api-key', value: process.env.OPENAI_API_KEY };
  // Codex JWT does NOT work with OpenAI API — skip codexOAuthToken
  return null;
}

function classifyError(err, provider) {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.status || 0;
  if (status === 401 || msg.includes('authentication') || msg.includes('invalid_api_key') || msg.includes('unauthenticated')) {
    return `🔑 Ungültiger ${provider === 'anthropic' ? 'Anthropic' : 'OpenAI'} API-Key oder abgelaufenes OAuth-Token.`;
  }
  if (status === 429 || msg.includes('rate limit') || msg.includes('rate_limit')) return `⏳ Rate-Limit erreicht. Bitte kurz warten.`;
  if (status === 402 || msg.includes('quota') || msg.includes('billing')) return `💳 API-Guthaben aufgebraucht.`;
  if (status >= 500 || msg.includes('overloaded')) return `🔴 API-Server temporär nicht verfügbar.`;
  if (msg.includes('timeout') || msg.includes('timed out')) return `⌛ Zeitüberschreitung (30s).`;
  if (msg.includes('enotfound') || msg.includes('econnrefused')) return `🌐 Netzwerkfehler.`;
  return `❌ ${err?.message?.slice(0, 150) || 'Unbekannter Fehler'}`;
}

function normalizeConversationLanguage(language) {
  return language === 'en' ? 'en' : 'de';
}

function buildResponseLanguageInstruction(language) {
  return normalizeConversationLanguage(language) === 'en'
    ? '\n\nRESPONSE LANGUAGE (MANDATORY): Write every user-visible sentence in English, including plans, delegations, questions, handoffs, reviews, summaries, and final answers. This takes priority over role descriptions and conversation history. Preserve protocol markers and @mentions exactly.'
    : '\n\nANTWORTSPRACHE (VERBINDLICH): Schreibe jeden für den User sichtbaren Satz auf Deutsch, einschließlich Plänen, Delegationen, Rückfragen, Übergaben, Reviews, Zusammenfassungen und Abschlussantworten. Dies hat Vorrang vor Rollenbeschreibungen und Gesprächsverlauf. Protokollmarker und @Erwähnungen bleiben exakt erhalten.';
}

async function callLLMDirect({ apiKeys, providerConnections = [], providerSecrets = {}, agent, history, userMessage, groupContext, projectPath = '', language = 'de', onProgress = null }) {
  const provider = agent.provider || 'openai';
  const model = agent.model || (provider === 'anthropic' ? 'claude-haiku-4-5' : provider === 'codex' ? 'codex-default' : 'gpt-4o-mini');

  const systemContent = (agent.systemPrompt || 'You are a helpful assistant.')
    + (groupContext
      ? `\n\nDu bist in einem Gruppen-Chat mit: ${groupContext}.\n\nWICHTIGE REGELN:\n• Antworte NUR wenn du direkt @erwähnt wurdest.\n• Erwähne andere Agenten mit @Name um sie anzusprechen.\n• Schreibe "@user" wenn du den User brauchst.\n• Halte Antworten knapp (2-4 Sätze).`
      : '\n\nHalte Antworten knapp (2-4 Sätze).')
    + buildResponseLanguageInstruction(language);

  const recentHistory = history.slice(-20);

  if (provider === 'codex') {
    if (apiKeys?.codexCli === false) throw new Error('Codex CLI wurde in den Einstellungen getrennt.');
    const merged = recentHistory.map(m => ({
      role: m.agentId === 'user' ? 'user' : 'assistant',
      content: (m.agentId !== 'user' && m.agentId !== agent.id) ? `[${m.senderName}]: ${m.text}` : m.text,
    }));
    if (userMessage) merged.push({ role: 'user', content: userMessage });
    const result = await callCodexCLI({ systemContent, merged, model, cwd: projectPath || undefined, onProgress });
    if (result.error) throw new Error(result.error);
    return result.text;
  }

  const configuredProvider = findProviderConnection(providerConnections, provider);
  if (configuredProvider) {
    const messages = recentHistory.map(message => ({
      role: message.agentId === 'user' ? 'user' : 'assistant',
      content: (message.agentId !== 'user' && message.agentId !== agent.id)
        ? `[${message.senderName}]: ${message.text}`
        : message.text,
    }));
    if (userMessage) messages.push({ role: 'user', content: userMessage });
    if (!messages.length) messages.push({ role: 'user', content: '(start)' });
    const result = await callConfiguredProvider({
      connection: configuredProvider,
      apiKey: providerSecrets[provider] || '',
      model,
      systemContent,
      messages,
      onProgress,
    });
    if (result.error) throw Object.assign(new Error(result.error), result);
    return result.text;
  }

  if (provider === 'anthropic') {
    const auth = resolveAnthropicAuth(apiKeys);
    if (!auth) throw new Error('🔑 Kein Anthropic-Zugang konfiguriert.');

    const merged = [];
    for (const m of recentHistory) {
      const role = m.agentId === 'user' ? 'user' : 'assistant';
      const content = (m.agentId !== 'user' && m.agentId !== agent.id) ? `[${m.senderName}]: ${m.text}` : m.text;
      if (merged.length && merged[merged.length - 1].role === role) {
        merged[merged.length - 1].content += '\n' + content;
      } else {
        merged.push({ role, content });
      }
    }
    if (userMessage) {
      if (merged.length && merged[merged.length - 1].role === 'user') {
        merged[merged.length - 1].content += '\n' + userMessage;
      } else {
        merged.push({ role: 'user', content: userMessage });
      }
    }
    if (!merged.length || merged[0].role !== 'user') {
      merged.unshift({ role: 'user', content: '(start)' });
    }

    try {
      const result = auth.type === 'claude-cli'
        ? await callClaudeCLI({ systemContent, merged, model, cwd: projectPath || undefined, onProgress })
        : await callAnthropicMessages({ auth, model, systemContent, messages: merged, onProgress });
      if (result.error) throw Object.assign(new Error(result.error), {
        status: result.status,
        rateLimited: !!result.rateLimited,
        retryable: !!result.retryable,
        retryAfterMs: result.retryAfterMs || 0,
      });
      return result.text;
    } catch (err) {
      if (err.rateLimited) throw err;
      throw new Error(classifyError(err, 'anthropic'));
    }

  } else {
    const auth = resolveOpenAIAuth(apiKeys);
    if (!auth) throw new Error('🔑 Kein OpenAI API-Key konfiguriert. Bitte in ⚙️ Einstellungen eintragen (Codex JWT funktioniert nicht mit der OpenAI API).');

    const messages = recentHistory.map(m => ({
      role: m.agentId === 'user' ? 'user' : 'assistant',
      content: (m.agentId !== 'user' && m.agentId !== agent.id) ? `[${m.senderName}]: ${m.text}` : m.text,
    }));
    if (userMessage) messages.push({ role: 'user', content: userMessage });

    try {
      const result = await callOpenAIChat({
        apiKey: auth.value,
        model,
        systemContent,
        messages,
        onProgress,
      });
      if (result.error) throw Object.assign(new Error(result.error), { status: result.status });
      return result.text;
    } catch (err) {
      throw new Error(classifyError(err, 'openai'));
    }
  }
}

module.exports = {
  buildResponseLanguageInstruction,
  callAnthropicMessages,
  callConfiguredProvider,
  callOpenAIChat,
  callLLMDirect,
  normalizeConversationLanguage,
  parseRetryAfterMs,
};
