/**
 * Group Memory Module
 * Shared group knowledge with explicit #memory/#fact-style commands.
 * Ordinary Markdown headings and topical hashtags are never persisted.
 */

export const MEMORY_TAG_REGEX = /#([A-Za-zÄÖÜäöü][A-Za-zÄÖÜäöü0-9_-]*)/g;
export const USER_TAG = '#user';
export const PM_TAG = '#pm';
export const MEMORY_COMMAND_TAGS = Object.freeze([
  'memory',
  'fact',
  'decision',
  'constraint',
  'finding',
  'task_state',
]);

const MEMORY_COMMAND_LINE_REGEX = new RegExp(
  `^#(${MEMORY_COMMAND_TAGS.join('|')})\\b(?:\\s*:\\s*|\\s+)?(.*)$`,
  'i',
);

/**
 * Extract all #tags from text.
 * @returns string[] of tag names (lowercase, without #)
 */
export function extractTags(text) {
  const tags = [];
  const matches = text.matchAll(MEMORY_TAG_REGEX);
  for (const m of matches) tags.push(m[1].toLowerCase());
  return [...new Set(tags)];
}

function parseMemoryCommands(text) {
  const lines = String(text || '').split(/\r?\n/);
  const consumedLines = new Set();
  const commands = [];

  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(MEMORY_COMMAND_LINE_REGEX);
    if (!match) continue;

    const commandTag = match[1].toLowerCase();
    const inlineContent = match[2].trim();
    const commandLines = [lines[index].trimEnd()];
    consumedLines.add(index);

    // A tag on its own may introduce one following paragraph. Inline commands
    // remain one line so an ordinary numbered list cannot be swallowed.
    if (!inlineContent) {
      let continuationIndex = index + 1;
      while (continuationIndex < lines.length && lines[continuationIndex].trim()) {
        if (MEMORY_COMMAND_LINE_REGEX.test(lines[continuationIndex]) || /^@\S/.test(lines[continuationIndex])) break;
        commandLines.push(lines[continuationIndex].trimEnd());
        consumedLines.add(continuationIndex);
        continuationIndex += 1;
      }
      index = continuationIndex - 1;
    }

    const content = commandLines.slice(1).join('\n').trim() || inlineContent;
    if (!content) continue;
    const commandText = commandLines.join('\n').trim();
    commands.push({
      commandTag,
      text: commandText,
      tags: extractTags(commandText),
    });
  }

  return { commands, consumedLines, lines };
}

/** Explicit memory commands must start at column zero of their own line. */
export function extractMemoryCommands(text) {
  return parseMemoryCommands(text).commands;
}

export function hasExplicitMemoryCommand(text) {
  return extractMemoryCommands(text).length > 0;
}

/** True when the message only stores memory and should not activate agents. */
export function isMemoryCommandOnly(text) {
  const { commands, consumedLines, lines } = parseMemoryCommands(text);
  if (commands.length === 0) return false;
  return lines.every((line, index) => !line.trim() || consumedLines.has(index));
}

/**
 * Create a memory entry.
 */
export function createMemoryEntry({ text, authorId, authorName, tags = [] }) {
  return {
    id: Date.now() + Math.random(),
    ts: Date.now(),
    authorId,
    authorName,
    text,
    tags: tags.map(t => t.toLowerCase()),
    // explicit: if tags were manually added vs auto-extracted
  };
}

/**
 * Filter memory entries relevant to an agent.
 * PM (isSystemAgent) sees everything.
 * Others see entries tagged with their name OR untagged entries.
 */
export function filterMemoryForAgent(entries, agent) {
  if (!entries || entries.length === 0) return [];
  if (agent.isSystemAgent) return entries; // PM sees all

  const agentName = agent.name.toLowerCase();
  return entries.filter(e => {
    if (!e.tags || e.tags.length === 0) return true; // untagged = visible to all
    return e.tags.includes(agentName);
  });
}

/**
 * Format memory entries for injection into LLM context.
 * Returns a string block to append to system prompt.
 */
export function formatMemoryContext(entries, agentName) {
  if (!entries || entries.length === 0) return '';
  const lines = entries.slice(-20).map(e => { // last 20 relevant entries
    const tagStr = e.tags?.length > 0 ? ` [für: ${e.tags.map(t => '#' + t).join(' ')}]` : '';
    return `[${e.authorName}${tagStr}]: ${e.text}`;
  });
  return `\n\n[Gruppen-Wissen für ${agentName}]:\n${lines.join('\n')}`;
}

/**
 * Extract explicitly marked knowledge entries from an agent reply.
 * Returns array of {text, tags} to add to group memory.
 */
export function extractKnowledgeFromReply(reply, authorId, authorName) {
  if (!reply) return [];
  return extractMemoryCommands(reply).map(command => createMemoryEntry({
    text: command.text,
    authorId,
    authorName,
    tags: command.tags,
  }));
}
