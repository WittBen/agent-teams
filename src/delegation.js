export const DELEGATION_MODES = new Set(['never', 'ask', 'automatic']);

export const GROUP_CAPABILITY_INDEX_VERSION = 1;

const SEMANTIC_MATCH_THRESHOLD = 0.4;
const PROFILE_TERM_LIMIT = 80;

/** Normalize a group's persisted outbound collaboration routes, including the legacy single-route field. */
export function normalizeCrossGroupTargetIds(value, legacyValue = '') {
  const source = Array.isArray(value) ? value : (value ? [value] : (legacyValue ? [legacyValue] : []));
  return [...new Set(source
    .map(id => String(id || '').trim().slice(0, 200))
    .filter(Boolean))].slice(0, 30);
}

function capabilityKey(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

/** Normalize user-defined expertise labels without assuming a particular domain. */
export function normalizeCapabilities(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[\n,;]+/);
  const seen = new Set();
  const result = [];
  for (const candidate of source.slice(0, 40)) {
    const label = String(candidate || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    const key = capabilityKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(label);
  }
  return result;
}

export function normalizeDelegationPolicy(value = {}) {
  const mode = DELEGATION_MODES.has(value?.mode) ? value.mode : 'never';
  return {
    mode,
    requiredCapabilities: normalizeCapabilities(value?.requiredCapabilities),
    allowedTargetGroupIds: [...new Set((Array.isArray(value?.allowedTargetGroupIds)
      ? value.allowedTargetGroupIds
      : [])
      .map(id => String(id || '').trim().slice(0, 200))
      .filter(Boolean))].slice(0, 30),
  };
}

function semanticStem(token) {
  let result = token;
  const suffixes = [
    'ierungen', 'ierung', 'ments', 'ment', 'ations', 'ation', 'ities', 'ity',
    'ungen', 'ung', 'ischen', 'ische', 'isch', 'ern', 'ers', 'er',
    'enden', 'ende', 'end', 'ing', 'ists', 'ist', 'innen', 'in', 'en', 'ed', 'es', 's',
  ];
  for (const suffix of suffixes) {
    if (result.length - suffix.length >= 5 && result.endsWith(suffix)) {
      result = result.slice(0, -suffix.length);
      break;
    }
  }
  return result;
}

function semanticTokens(value) {
  return capabilityKey(value)
    .split('-')
    .filter(token => token.length >= 2)
    .map(semanticStem);
}

function trigrams(value) {
  const normalized = capabilityKey(value).replaceAll('-', '');
  if (normalized.length < 3) return new Set(normalized ? [normalized] : []);
  const result = new Set();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    result.add(normalized.slice(index, index + 3));
  }
  return result;
}

function trigramSimilarity(left, right) {
  const leftGrams = trigrams(left);
  const rightGrams = trigrams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let intersection = 0;
  for (const gram of leftGrams) if (rightGrams.has(gram)) intersection += 1;
  return intersection / (leftGrams.size + rightGrams.size - intersection);
}

/**
 * Deterministic, local semantic similarity for freely named expertise. It uses
 * normalized word roots and fuzzy phrase similarity, so no profile data leaves
 * the app merely to build or query the index.
 */
export function semanticCapabilityScore(requiredCapability, availableText) {
  const requiredKey = capabilityKey(requiredCapability);
  const availableKey = capabilityKey(availableText);
  if (!requiredKey || !availableKey) return 0;
  if (requiredKey === availableKey) return 1;

  const requiredTokens = [...new Set(semanticTokens(requiredCapability))];
  const availableTokens = [...new Set(semanticTokens(availableText))];
  if (!requiredTokens.length || !availableTokens.length) return 0;
  const matchedRequired = requiredTokens.filter(required => availableTokens.some(available => (
    required === available ||
    (required.length >= 5 && available.length >= 5 && (required.startsWith(available) || available.startsWith(required)))
  ))).length;
  const coverage = matchedRequired / requiredTokens.length;
  const precision = matchedRequired / availableTokens.length;
  const fuzzy = trigramSimilarity(requiredCapability, availableText);
  const contained = requiredKey.includes(availableKey) || availableKey.includes(requiredKey);
  return Math.min(1, Math.max(
    fuzzy * 0.72,
    coverage * 0.78 + precision * 0.16 + (contained ? 0.06 : 0),
  ));
}

function profileTerms(agent) {
  const terms = [];
  if (agent?.role) terms.push(String(agent.role));
  const prompt = String(agent?.systemPrompt || '').replace(/\r/g, '');
  for (const rawLine of prompt.split('\n')) {
    const line = rawLine.replace(/^\s*[•*-]\s*/, '').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator > 0) {
      terms.push(line.slice(0, separator));
      terms.push(...line.slice(separator + 1).split(/[,;|/]+/));
    } else if (terms.length < 8) {
      // The opening profile sentence usually describes the broad profession.
      terms.push(line);
    }
    if (terms.length >= PROFILE_TERM_LIMIT) break;
  }
  return normalizeCapabilities(terms).slice(0, PROFILE_TERM_LIMIT);
}

function buildMemberCapabilityDocument(agent) {
  const explicitCapabilities = normalizeCapabilities(agent?.capabilities);
  const derivedTerms = profileTerms(agent)
    .filter(term => !explicitCapabilities.some(capability => capabilityKey(capability) === capabilityKey(term)));
  return {
    agentId: String(agent?.id || '').slice(0, 200),
    agentName: String(agent?.name || 'Agent').slice(0, 200),
    agentRole: String(agent?.role || 'Agent').slice(0, 200),
    explicitCapabilities,
    derivedTerms,
  };
}

/** Build the persisted, inspectable search index for one group's current members. */
export function buildGroupCapabilityIndex(group, agents = []) {
  const agentById = new Map(agents.map(agent => [agent?.id, agent]));
  const members = [...new Set(Array.isArray(group?.agentIds) ? group.agentIds : [])]
    .map(agentId => agentById.get(agentId))
    .filter(Boolean)
    .map(buildMemberCapabilityDocument);
  const explicitCapabilities = normalizeCapabilities(members.flatMap(member => member.explicitCapabilities));
  const derivedCapabilities = normalizeCapabilities(members.flatMap(member => [
    member.agentRole,
    ...member.derivedTerms,
  ])).slice(0, 40);
  return {
    version: GROUP_CAPABILITY_INDEX_VERSION,
    members,
    explicitCapabilities,
    derivedCapabilities,
  };
}

function memberCapabilityMatch(member, requiredCapabilities = []) {
  const required = normalizeCapabilities(requiredCapabilities);
  const matches = required.map(capability => {
    let best = { capability, score: 0, source: '', matchedTerm: '' };
    for (const term of member?.explicitCapabilities || []) {
      const score = semanticCapabilityScore(capability, term);
      if (score > best.score) best = { capability, score, source: 'explicit', matchedTerm: term };
    }
    for (const term of [member?.agentRole, ...(member?.derivedTerms || [])].filter(Boolean)) {
      const score = semanticCapabilityScore(capability, term) * 0.92;
      if (score > best.score) best = { capability, score, source: 'derived', matchedTerm: term };
    }
    return best;
  });
  return {
    member,
    matches,
    covers: required.length > 0 && matches.every(match => match.score >= SEMANTIC_MATCH_THRESHOLD),
    score: matches.length ? matches.reduce((sum, match) => sum + match.score, 0) / matches.length : 0,
    inferred: matches.some(match => match.source === 'derived'),
  };
}

export function agentCapabilityMatch(agent, requiredCapabilities = []) {
  return memberCapabilityMatch(buildMemberCapabilityDocument(agent), requiredCapabilities);
}

/** Compatibility helper used by request validation; matching is now semantic rather than exact-only. */
export function agentCoversCapabilities(agent, requiredCapabilities = []) {
  return agentCapabilityMatch(agent, requiredCapabilities).covers;
}

/**
 * Resolve a group's best capability coverage. Prefer one complete expert; when
 * necessary, combine members so a cross-functional group can cover the task.
 */
export function matchGroupCapabilities(group, agents = [], requiredCapabilities = []) {
  const required = normalizeCapabilities(requiredCapabilities);
  if (!required.length) return { covers: false, score: 0, members: [], matches: [] };
  const index = group?.capabilityIndex?.version === GROUP_CAPABILITY_INDEX_VERSION
    ? group.capabilityIndex
    : buildGroupCapabilityIndex(group, agents);
  const availableAgentIds = new Set((group?.agentIds || []).map(String));
  const liveAgentIds = new Set(agents.map(agent => String(agent?.id || '')));
  const memberResults = (index.members || [])
    .filter(member => availableAgentIds.has(String(member.agentId)) && liveAgentIds.has(String(member.agentId)))
    .map(member => memberCapabilityMatch(member, required));
  const completeMembers = memberResults.filter(result => result.covers)
    .sort((left, right) => right.score - left.score || left.member.agentName.localeCompare(right.member.agentName));
  if (completeMembers.length > 0) {
    const best = completeMembers[0];
    return {
      covers: true,
      score: best.score,
      members: [best.member],
      matches: best.matches.map(match => ({ ...match, agentId: best.member.agentId, agentName: best.member.agentName })),
      inferred: best.inferred,
    };
  }

  const assignments = required.map((capability, capabilityIndex) => {
    const options = memberResults
      .map(result => ({ member: result.member, match: result.matches[capabilityIndex] }))
      .filter(option => option.match?.score >= SEMANTIC_MATCH_THRESHOLD)
      .sort((left, right) => right.match.score - left.match.score || left.member.agentName.localeCompare(right.member.agentName));
    return options[0] || null;
  });
  if (assignments.some(assignment => !assignment)) {
    return {
      covers: false,
      score: 0,
      members: [],
      matches: assignments.filter(Boolean).map(({ member, match }) => ({
        ...match,
        agentId: member.agentId,
        agentName: member.agentName,
      })),
      missingCapabilities: required.filter((_, indexPosition) => !assignments[indexPosition]),
    };
  }
  const memberIds = [...new Set(assignments.map(assignment => assignment.member.agentId))];
  const members = memberIds.map(agentId => assignments.find(assignment => assignment.member.agentId === agentId).member);
  const matches = assignments.map(({ member, match }) => ({
    ...match,
    agentId: member.agentId,
    agentName: member.agentName,
  }));
  return {
    covers: true,
    score: matches.reduce((sum, match) => sum + match.score, 0) / matches.length,
    members,
    matches,
    inferred: matches.some(match => match.source === 'derived'),
  };
}

function candidateFromGroupMatch(group, match) {
  const primary = match.members[0];
  const agentIds = match.members.map(member => member.agentId);
  const agentNames = match.members.map(member => member.agentName);
  return {
    candidateId: `${group.id}:${agentIds.join(',')}`,
    groupId: group.id,
    groupName: group.name,
    groupEmoji: group.emoji || '💬',
    agentId: primary.agentId,
    agentName: agentNames.join(' + '),
    agentRole: match.members.length > 1 ? 'Expertenteam' : primary.agentRole,
    agentIds,
    agentNames,
    capabilities: normalizeCapabilities(match.members.flatMap(member => member.explicitCapabilities)),
    capabilityMatches: match.matches,
    matchScore: match.score,
    inferred: match.inferred === true,
    team: match.members.length > 1,
  };
}

/** Return semantically ranked candidates inside the source group's configured outbound routes. */
export function findDelegationCandidates({ sourceGroupId, groups = [], agents = [], policy = {} } = {}) {
  const normalizedPolicy = normalizeDelegationPolicy(policy);
  const required = normalizedPolicy.requiredCapabilities;
  if (!required.length) return [];
  const sourceGroup = groups.find(group => group?.id === sourceGroupId);
  const configuredTargetGroupIds = new Set(normalizeCrossGroupTargetIds(
    sourceGroup?.crossGroupTargetGroupIds,
    sourceGroup?.crossGroupTargetGroupId,
  ));
  if (!sourceGroup?.crossGroupCollaborationEnabled || configuredTargetGroupIds.size === 0) return [];
  const allowed = new Set(normalizedPolicy.allowedTargetGroupIds);
  const candidates = [];
  for (const group of groups) {
    if (!group?.id || group.id === sourceGroupId) continue;
    if (!configuredTargetGroupIds.has(group.id)) continue;
    if (allowed.size > 0 && !allowed.has(group.id)) continue;
    const match = matchGroupCapabilities(group, agents, required);
    if (match.covers) candidates.push(candidateFromGroupMatch(group, match));
  }
  return candidates.sort((left, right) => (
    right.matchScore - left.matchScore ||
    Number(left.inferred) - Number(right.inferred) ||
    left.groupName.localeCompare(right.groupName) ||
    left.agentName.localeCompare(right.agentName)
  ));
}

/** Decide whether the immutable task contract permits a runtime delegation. */
export function evaluateTaskDelegation({ taskNode, sourceGroup, groups = [], agents = [] } = {}) {
  const policy = normalizeDelegationPolicy(taskNode?.delegation);
  if (!sourceGroup?.crossGroupCollaborationEnabled || policy.mode === 'never') {
    return { action: 'local', reason: sourceGroup?.crossGroupCollaborationEnabled ? 'policy-never' : 'group-disabled', policy };
  }
  if (taskNode?.delegationLocalApprovedAt) {
    return { action: 'local', reason: 'user-local-override', policy };
  }
  if (!policy.requiredCapabilities.length) {
    return { action: 'local', reason: 'no-requirements', policy };
  }
  const localMatch = matchGroupCapabilities(sourceGroup, agents, policy.requiredCapabilities);
  if (localMatch.covers) {
    return {
      action: 'local',
      reason: localMatch.members.length > 1 ? 'local-team' : 'local-expert',
      policy,
      localExperts: localMatch.members,
      localMatch,
    };
  }
  const candidates = findDelegationCandidates({
    sourceGroupId: sourceGroup.id,
    groups,
    agents,
    policy,
  });
  if (!candidates.length) return { action: 'unavailable', reason: 'no-target-expert', policy, candidates };
  return {
    action: policy.mode === 'automatic' ? 'delegate' : 'ask',
    reason: 'no-local-expert',
    policy,
    candidate: candidates[0],
    candidates,
  };
}
