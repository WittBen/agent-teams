// ── Key resolution ────────────────────────────────────────────────────────────
// Priority: manual (settings) > env var > CLI credentials (passed in)

function resolveAnthropicAuth(apiKeys) {
  // Browser-only development may keep a key in memory. Electron exposes only
  // a configured marker and resolves the reusable secret in the main process.
  if (apiKeys?.anthropic?.trim()) return { type: 'api-key', value: apiKeys.anthropic.trim() };
  if (apiKeys?.anthropicConfigured) return { type: 'api-key', value: '' };
  // 2. Env var (set externally)
  if (typeof process !== 'undefined' && process.env?.ANTHROPIC_API_KEY) {
    return { type: 'api-key', value: process.env.ANTHROPIC_API_KEY };
  }
  // 3. Claude Code CLI session.
  if (apiKeys?.claudeCli) return { type: 'claude-cli', value: '' };
  return null;
}

function resolveOpenAIKey(apiKeys) {
  // 1. Manual API key
  if (apiKeys?.openai?.trim()) return { type: 'api-key', value: apiKeys.openai.trim() };
  if (apiKeys?.openaiConfigured) return { type: 'api-key', value: '' };
  // 2. Env var
  if (typeof process !== 'undefined' && process.env?.OPENAI_API_KEY) {
    return { type: 'api-key', value: process.env.OPENAI_API_KEY };
  }
  return null;
}

// ── Error classification ──────────────────────────────────────────────────────

function classifyError(err, provider) {
  const msg = (err?.message || '').toLowerCase();
  const status = err?.status || err?.statusCode || 0;
  const providerLabel = provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : String(provider || 'Provider');

  if (status === 401 || msg.includes('401') || msg.includes('incorrect api key') || msg.includes('invalid_api_key') || msg.includes('authentication') || msg.includes('unauthenticated')) {
    return provider === 'codex'
      ? '🔑 Codex ist nicht angemeldet. Bitte in Einstellungen → API-Zugang die Codex-Anmeldung starten.'
      : `🔑 Ungültiger API-Key für ${providerLabel}. Bitte in Einstellungen prüfen.`;
  }
  if (status === 429 || msg.includes('429') || msg.includes('rate limit') || msg.includes('rate_limit') || msg.includes('too many requests')) {
    return `⏳ Rate-Limit erreicht. Bitte kurz warten und erneut versuchen.`;
  }
  if (status === 402 || msg.includes('quota') || msg.includes('billing') || msg.includes('insufficient_quota') || msg.includes('credit')) {
    return `💳 API-Guthaben aufgebraucht. Bitte das Konto aufladen.`;
  }
  if (status >= 500 || msg.includes('server error') || msg.includes('overloaded') || msg.includes('internal server')) {
    return `🔴 API-Server temporär nicht verfügbar. Bitte später erneut versuchen.`;
  }
  if (msg.includes('fetch') || msg.includes('network') || msg.includes('enotfound') || msg.includes('econnrefused') || msg.includes('failed to fetch')) {
    return `🌐 Netzwerkfehler. Bitte Internetverbindung prüfen.`;
  }
  if (err?.name === 'AbortError' || msg.includes('timeout') || msg.includes('timed out')) {
    return `⌛ Zeitüberschreitung (30s). Bitte erneut versuchen.`;
  }
  return `❌ ${err?.message?.slice(0, 150) || 'Unbekannter Fehler'}`;
}

// ── Timeout wrapper ───────────────────────────────────────────────────────────

function withTimeout(promise, ms = 30000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(Object.assign(new Error('Request timed out after 30s'), { name: 'AbortError' })), ms)
    ),
  ]);
}

export function collectChatAttachments(history = []) {
  const seen = new Set();
  const newestFirst = [];
  for (let messageIndex = history.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = history[messageIndex];
    if (message?.agentId !== 'user' || !Array.isArray(message.attachments)) continue;
    for (let attachmentIndex = message.attachments.length - 1; attachmentIndex >= 0; attachmentIndex -= 1) {
      const attachment = message.attachments[attachmentIndex];
      const id = attachment?.id || attachment?.path || attachment?.name;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      newestFirst.push(attachment);
      if (newestFirst.length >= 8) return newestFirst.reverse();
    }
  }
  return newestFirst.reverse();
}

export function prepareBrowserAttachmentMessages(messages, attachments, provider) {
  const textFiles = attachments
    .filter(attachment => ['markdown', 'text'].includes(attachment?.kind) && attachment.content)
    .map(attachment => `## ${attachment.kind === 'markdown' ? 'Markdown-Anhang' : 'Text-Anhang'}: ${attachment.name}\n\n${attachment.content}`)
    .join('\n\n---\n\n');
  const nativeAttachments = attachments.filter(attachment => attachment?.dataUrl && !['markdown', 'text'].includes(attachment.kind));
  const unsupportedForAnthropic = provider === 'anthropic'
    ? attachments.filter(attachment => !['image', 'pdf', 'markdown', 'text'].includes(attachment?.kind))
    : [];
  if (!textFiles && !nativeAttachments.length && !unsupportedForAnthropic.length) return messages;
  const next = messages.map(message => ({ ...message }));
  let index = -1;
  for (let current = next.length - 1; current >= 0; current -= 1) {
    if (next[current].role === 'user') { index = current; break; }
  }
  if (index < 0) {
    next.push({ role: 'user', content: 'Bitte analysiere die angehängten Dateien.' });
    index = next.length - 1;
  }
  const originalText = typeof next[index].content === 'string'
    ? next[index].content
    : (next[index].content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const text = [
    originalText,
    textFiles ? `[ANGEHÄNGTE TEXTDATEIEN]\n${textFiles}` : '',
    unsupportedForAnthropic.length
      ? `[WEITERE ANGEHÄNGTE DATEIEN]\n${unsupportedForAnthropic.map(file => `- ${file.name} (${file.mimeType || 'unbekannter Typ'}, ${file.size || 0} Bytes)`).join('\n')}`
      : '',
  ].filter(Boolean).join('\n\n');
  if (!nativeAttachments.length) {
    next[index].content = text;
    return next;
  }
  const parts = nativeAttachments.flatMap(attachment => {
    const base64 = attachment.dataUrl.split(',')[1] || '';
    if (provider === 'openai') {
      return attachment.kind === 'image'
        ? [{ type: 'image_url', image_url: { url: attachment.dataUrl, detail: 'auto' } }]
        : [{ type: 'file', file: { filename: attachment.name, file_data: base64 } }];
    }
    if (attachment.kind === 'image') {
      return [{ type: 'image', source: { type: 'base64', media_type: attachment.mimeType, data: base64 } }];
    }
    if (attachment.kind === 'pdf') {
      return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 }, title: attachment.name }];
    }
    return [];
  });
  next[index].content = provider === 'anthropic'
    ? [...parts, { type: 'text', text: text || 'Bitte analysiere die angehängten Dateien.' }]
    : [{ type: 'text', text: text || 'Bitte analysiere die angehängten Dateien.' }, ...parts];
  return next;
}

// ── Main LLM caller ───────────────────────────────────────────────────────────

export async function callLLM({ apiKeys, providerConnections = [], agent, history, userMessage, groupContext, kbContext, isolatedSession = null, projectPath = '', requestId = '' }) {
  const provider = agent.provider || 'openai';
  const model = agent.model || (provider === 'anthropic' ? 'claude-haiku-4-5' : provider === 'codex' ? 'codex-default' : 'gpt-4o-mini');

  // Phase 2: isolated session uses its own system prompt; otherwise build group-aware prompt
  const basePrompt = (isolatedSession && isolatedSession.systemPrompt)
    ? isolatedSession.systemPrompt
    : (agent.systemPrompt || 'You are a helpful assistant.');
  const groupRules = (groupContext && !isolatedSession)
    ? `\n\nDu bist in einem Gruppen-Chat mit: ${groupContext}.\n\nWICHTIGE REGELN:\n• Antworte NUR wenn du direkt @erwähnt wurdest.\n• Erwähne andere Agenten mit @Name um Aufgaben zu delegieren. Die Erwähnung muss ganz links am Anfang einer eigenen Zeile stehen.\n• Erwähnungen im Fließtext oder mit Einrückung lösen keine Aktion aus.\n• Schreibe "@user" ganz links am Anfang einer eigenen Zeile, wenn du eine Entscheidung des Users brauchst.\n• NIEMALS @${agent.name} (dich selbst) erwähnen.\n• Halte Antworten knapp (2-4 Sätze). Sprich Deutsch.`
    : '';
  const systemContent = basePrompt + groupRules + (kbContext || '');

  const recentHistory = history.slice(-20);
  const attachments = collectChatAttachments(recentHistory);

  if (provider === 'codex') {
    const merged = recentHistory.map(msg => ({
      role: msg.agentId === 'user' ? 'user' : 'assistant',
      content: (msg.agentId !== 'user' && msg.agentId !== agent.id)
        ? `[${msg.senderName}]: ${msg.text}`
        : msg.text,
    }));
    if (userMessage) merged.push({ role: 'user', content: userMessage });
    if (!window.electronAPI?.codexCall && !window.electronAPI?.llmCall) {
      throw new Error('❌ Codex-Agenten sind nur in der Electron-App verfügbar.');
    }
    try {
      const call = window.electronAPI.codexCall || window.electronAPI.llmCall;
      const result = await call({ provider: 'codex', model, systemContent, merged, attachments, cwd: projectPath || undefined, requestId });
      if (result?.error) throw Object.assign(new Error(result.error), {
        status: result.status,
        isAgentTimeout: !!result.timedOut,
        timeoutKind: result.timeoutKind,
        cancelled: !!result.cancelled,
      });
      if (!result?.text?.trim()) throw new Error('Leere Antwort von Codex.');
      return result.text;
    } catch (err) {
      if (err.isAgentTimeout || err.cancelled) throw err;
      if (err.message?.startsWith('❌') || err.message?.startsWith('Leere')) throw err;
      throw new Error(classifyError(err, 'codex'));
    }
  }

  const configuredProvider = (providerConnections || []).find(item => item?.id === provider);
  if (configuredProvider) {
    const configuredInDesktop = configuredProvider.requiresApiKey === false || Boolean(apiKeys?.providerConfigured?.[provider]);
    const browserKey = apiKeys?.providerSecrets?.[provider] || '';
    if (!configuredInDesktop && !browserKey) {
      throw new Error(`🔑 Für „${configuredProvider.name || provider}“ ist kein API-Key konfiguriert.`);
    }
    if (!window.electronAPI?.llmCall) {
      throw new Error('❌ Eigene API-Provider sind nur in der Electron-App verfügbar.');
    }
    const messages = recentHistory.map(msg => ({
      role: msg.agentId === 'user' ? 'user' : 'assistant',
      content: (msg.agentId !== 'user' && msg.agentId !== agent.id)
        ? `[${msg.senderName}]: ${msg.text}`
        : msg.text,
    }));
    if (userMessage) messages.push({ role: 'user', content: userMessage });
    if (!messages.length) messages.push({ role: 'user', content: '(start)' });
    try {
      const result = await window.electronAPI.llmCall({
        provider, model, systemContent, merged: messages, attachments,
      });
      if (result?.error) throw Object.assign(new Error(result.error), {
        status: result.status,
        rateLimited: !!result.rateLimited,
        retryable: !!result.retryable,
        retryAfterMs: result.retryAfterMs || 0,
      });
      if (!result?.text?.trim()) throw new Error(`Leere Antwort von „${configuredProvider.name || provider}“.`);
      return result.text;
    } catch (err) {
      if (err.rateLimited || err.message?.startsWith('🔑') || err.message?.startsWith('❌') || err.message?.startsWith('Leere')) throw err;
      throw new Error(classifyError(err, configuredProvider.name || provider));
    }
  }

  if (provider === 'anthropic') {
    const auth = resolveAnthropicAuth(apiKeys);
    if (!auth) {
      throw new Error(
        `🔑 Kein Anthropic-Zugang konfiguriert.\n\nOptionen:\n• API-Key in ⚙️ Einstellungen eingeben\n• Claude Code CLI verbinden (⚙️ → Anthropic)\n• Umgebungsvariable ANTHROPIC_API_KEY setzen`
      );
    }

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
    // Anthropic requires messages to end with user role — add synthetic prompt if needed
    if (merged[merged.length - 1].role === 'assistant') {
      merged.push({ role: 'user', content: '(Bitte antworte auf die vorige Nachricht)' });
    }

    try {
      let result;
      if (auth.type === 'claude-cli') {
        if (!window.electronAPI?.claudeCall) {
          throw new Error('❌ Claude-Code-Agenten sind nur in der Electron-App verfügbar.');
        }
        result = await window.electronAPI.claudeCall({
          model,
          systemContent,
          merged,
          attachments,
          cwd: projectPath || undefined,
          requestId,
        });
      } else if (window.electronAPI?.llmCall) {
        // API keys use the Messages API through Electron main to avoid CORS.
        result = await window.electronAPI.llmCall({ provider: 'anthropic', model, systemContent, merged, attachments });
      } else {
        // Browser fallback is available only for real Anthropic API keys.
        const preparedMessages = prepareBrowserAttachmentMessages(merged, attachments, 'anthropic');
        const headers = { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' };
        headers['x-api-key'] = auth.value;
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers,
          body: JSON.stringify({ model, system: systemContent, messages: preparedMessages, max_tokens: 400 }),
        });
        const data = await res.json();
        if (data.type === 'error' || data.error) result = { error: (data.error || data).message, status: res.status };
        else result = { text: data.content[0].text };
      }
      if (result.error) {
        const retrySeconds = result.retryAfterMs
          ? Math.max(1, Math.ceil(result.retryAfterMs / 1000))
          : 60;
        const message = result.rateLimited
          ? `⏳ Claude-Rate-Limit erreicht. Der Arbeitsstand wurde gespeichert; bitte nach etwa ${retrySeconds}s fortsetzen.`
          : result.error;
        throw Object.assign(new Error(message), {
          status: result.status,
          rateLimited: !!result.rateLimited,
          retryable: !!result.retryable,
          retryAfterMs: result.retryAfterMs || 0,
          isAgentTimeout: !!result.timedOut,
          timeoutKind: result.timeoutKind,
          cancelled: !!result.cancelled,
        });
      }
      if (!result.text?.trim()) throw new Error('Leere Antwort vom Anthropic-Modell.');
      return result.text;
    } catch (err) {
      if (err.rateLimited || err.isAgentTimeout || err.cancelled) throw err;
      if (err.message?.startsWith('🔑') || err.message?.startsWith('⏳') || err.message?.startsWith('🌐') || err.message?.startsWith('❌') || err.message?.startsWith('💳') || err.message?.startsWith('🔴') || err.message?.startsWith('⌛') || err.message?.startsWith('Leere')) throw err;
      throw new Error(classifyError(err, 'anthropic'));
    }

  } else {
    // OpenAI
    const auth = resolveOpenAIKey(apiKeys);
    if (!auth) {
      throw new Error(
        `🔑 Kein OpenAI-Zugang konfiguriert.\n\n` +
        `Optionen:\n` +
        `• API-Key in ⚙️ Einstellungen eingeben\n` +
        `• Für ein ChatGPT-/Codex-Abo den separaten Anbieter "Codex (lokal)" beim Agenten wählen\n` +
        `• Umgebungsvariable OPENAI_API_KEY setzen`
      );
    }

    const messages = recentHistory.map(msg => ({
      role: msg.agentId === 'user' ? 'user' : 'assistant',
      content: (msg.agentId !== 'user' && msg.agentId !== agent.id)
        ? `[${msg.senderName}]: ${msg.text}`
        : msg.text,
    }));
    if (userMessage) messages.push({ role: 'user', content: userMessage });

    try {
      let result;
      if (window.electronAPI?.llmCall) {
        result = await window.electronAPI.llmCall({ provider: 'openai', model, systemContent, merged: messages, attachments });
      } else {
        const preparedMessages = prepareBrowserAttachmentMessages(messages, attachments, 'openai');
        const res = await withTimeout(fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${auth.value}` },
          body: JSON.stringify({
            model, temperature: 0.85, max_tokens: 300,
            messages: [{ role: 'system', content: systemContent }, ...preparedMessages],
          }),
        }));
        const data = await res.json();
        result = data.error
          ? { error: data.error.message, status: res.status }
          : { text: data.choices?.[0]?.message?.content || '' };
      }
      if (result.error) throw Object.assign(new Error(result.error), { status: result.status });
      if (!result.text?.trim()) throw new Error('Leere Antwort vom OpenAI-Modell.');
      return result.text;
    } catch (err) {
      if (err.message?.startsWith('🔑') || err.message?.startsWith('⏳') || err.message?.startsWith('🌐') || err.message?.startsWith('❌') || err.message?.startsWith('💳') || err.message?.startsWith('🔴') || err.message?.startsWith('⌛')) throw err;
      throw new Error(classifyError(err, 'openai'));
    }
  }
}

export const PROVIDER_MODELS = {
  openai: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-mini'],
  codex: ['codex-default', 'gpt-5.6-sol', 'gpt-5.4'],
  anthropic: [
    'claude-haiku-4-5',
    'claude-3-5-haiku-20241022',
    'claude-3-5-sonnet-20241022',
    'claude-sonnet-4-5',
    'claude-opus-4-5',
  ],
};
