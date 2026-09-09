import {
  createTaskGraph,
  inferTaskNodeType,
  normalizeAcceptanceCriteria,
  taskPlanGraphNodeId,
  validateWorkflowPlan,
} from './task-graph';
import {
  agentCapabilityMatch,
  normalizeCapabilities,
  normalizeDelegationPolicy,
} from './delegation';

export const WORKFLOW_FILE_FORMAT = 'agent-teams-workflow';
export const WORKFLOW_FILE_SCHEMA_VERSION = 1;

const MAX_WORKFLOW_NODES = 200;
const MAX_WORKFLOW_POINTS = 100;
const MAX_WORKFLOW_CONNECTIONS = 600;
const MAX_WORKFLOW_SLOTS = 100;
const PORTABLE_NODE_TYPES = new Set(['request', 'task', 'review']);
const PORTABLE_CONNECTION_KINDS = new Set(['dependency', 'review', 'delegation', 'flow']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedText(value, maxLength, { singleLine = false } = {}) {
  const normalized = String(value || '')
    .split(String.fromCharCode(0)).join('')
    .replace(singleLine ? /\s+/g : /\r\n?/g, singleLine ? ' ' : '\n')
    .trim();
  return normalized.slice(0, maxLength);
}

function requirePortableId(value, label) {
  const id = boundedText(value, 120, { singleLine: true });
  if (!id || !/^[a-zA-Z0-9_.:-]+$/.test(id)) {
    throw new Error(`${label} enthält eine ungültige ID.`);
  }
  return id;
}

function normalizedPosition(value) {
  const x = Number(value?.x);
  const y = Number(value?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.max(8, Math.min(10000, Math.round(x))),
    y: Math.max(8, Math.min(10000, Math.round(y))),
  };
}

function uniquePortableId(base, used) {
  const normalizedBase = boundedText(base, 90, { singleLine: true })
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'element';
  let candidate = normalizedBase;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${normalizedBase}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function portableAcceptanceCriteria(value, taskId) {
  return normalizeAcceptanceCriteria(value, { taskId }).map(criterion => ({
    id: criterion.id,
    text: criterion.text,
    required: criterion.required !== false,
    verification: criterion.verification,
  }));
}

function portableDelegation(value) {
  const delegation = normalizeDelegationPolicy(value);
  return {
    mode: delegation.mode,
    requiredCapabilities: delegation.requiredCapabilities,
  };
}

/**
 * Strip runtime state and local identifiers from a graph. The resulting file is
 * a portable execution contract, never a resumable or already-approved run.
 */
export function createWorkflowExportDocument(graph, { agents = [] } = {}) {
  const sourceNodes = (graph?.nodes || [])
    .filter(node => PORTABLE_NODE_TYPES.has(inferTaskNodeType(node)));
  const sourcePoints = (graph?.flowPoints || []).filter(point => ['fork', 'join'].includes(point?.type));
  if (!sourceNodes.some(node => inferTaskNodeType(node) !== 'request')) {
    throw new Error('Der Workflow enthält keine exportierbare Aufgabe.');
  }

  const usedIds = new Set();
  const endpointIds = new Map();
  const requestNode = sourceNodes.find(node => inferTaskNodeType(node) === 'request');
  if (requestNode) endpointIds.set(requestNode.id, uniquePortableId('root', usedIds));
  for (const [index, node] of sourceNodes.filter(candidate => candidate !== requestNode).entries()) {
    endpointIds.set(node.id, uniquePortableId(node.planTaskId || node.title || `task-${index + 1}`, usedIds));
  }
  for (const [index, point] of sourcePoints.entries()) {
    endpointIds.set(point.id, uniquePortableId(`${point.type}-${index + 1}`, usedIds));
  }

  const agentsById = new Map(agents.map(agent => [agent.id, agent]));
  const slotsByAgentKey = new Map();
  for (const node of sourceNodes) {
    if (inferTaskNodeType(node) === 'request') continue;
    const key = String(node.agentId || node.agentName || `unassigned-${node.id}`);
    if (slotsByAgentKey.has(key)) continue;
    const agent = agentsById.get(node.agentId) || {};
    const relatedCapabilities = sourceNodes
      .filter(candidate => String(candidate.agentId || candidate.agentName || `unassigned-${candidate.id}`) === key)
      .flatMap(candidate => normalizeDelegationPolicy(candidate.delegation).requiredCapabilities);
    const slotId = `slot-${slotsByAgentKey.size + 1}`;
    slotsByAgentKey.set(key, {
      id: slotId,
      name: boundedText(agent.name || node.agentName || `Rolle ${slotsByAgentKey.size + 1}`, 160, { singleLine: true }),
      role: boundedText(agent.role || '', 240, { singleLine: true }),
      capabilities: normalizeCapabilities([...(agent.capabilities || []), ...relatedCapabilities]),
      preferredProvider: boundedText(agent.provider || node.provider || '', 80, { singleLine: true }),
      preferredModel: boundedText(node.modelOverride || agent.model || node.model || '', 160, { singleLine: true }),
    });
  }

  const positions = graph?.viewState?.positions || {};
  const nodes = sourceNodes.map(node => {
    const type = inferTaskNodeType(node);
    const portableId = endpointIds.get(node.id);
    const key = String(node.agentId || node.agentName || `unassigned-${node.id}`);
    return {
      id: portableId,
      type,
      title: boundedText(node.title || (type === 'request' ? graph?.title : 'Aufgabe'), 180, { singleLine: true }),
      objective: boundedText(node.objective || node.title || '', 1200),
      ...(type === 'request' ? {} : { slotId: slotsByAgentKey.get(key).id }),
      ...(type === 'request' ? {} : { order: Math.max(0, Math.min(MAX_WORKFLOW_NODES, Number(node.planOrder) || 0)) }),
      ...(type === 'request' ? {} : { priority: ['critical', 'high', 'medium', 'low'].includes(node.priority) ? node.priority : 'medium' }),
      acceptanceCriteria: type === 'request' ? [] : portableAcceptanceCriteria(node.acceptanceCriteria, portableId),
      delegation: type === 'task' ? portableDelegation(node.delegation) : portableDelegation(),
      ...(normalizedPosition(positions[node.id]) ? { position: normalizedPosition(positions[node.id]) } : {}),
    };
  });

  if (!requestNode) {
    const rootId = uniquePortableId('root', usedIds);
    nodes.unshift({
      id: rootId,
      type: 'request',
      title: boundedText(graph?.title || 'Importierter Workflow', 180, { singleLine: true }),
      objective: boundedText(graph?.title || 'Importierter Workflow', 1200),
      acceptanceCriteria: [],
      delegation: portableDelegation(),
    });
  }

  const points = sourcePoints.map(point => ({
    id: endpointIds.get(point.id),
    type: point.type,
    title: point.type === 'fork' ? 'Fork' : 'Join',
    ...(normalizedPosition(positions[point.id]) ? { position: normalizedPosition(positions[point.id]) } : {}),
  }));
  const connections = [
    ...(graph?.edges || []).filter(edge => PORTABLE_CONNECTION_KINDS.has(edge.kind) && edge.kind !== 'flow'),
    ...(graph?.flowEdges || []).map(edge => ({ ...edge, kind: 'flow' })),
  ].flatMap(edge => {
    const from = endpointIds.get(edge.from);
    const to = endpointIds.get(edge.to);
    return from && to ? [{ from, to, kind: edge.kind }] : [];
  });

  return normalizeWorkflowDocument({
    format: WORKFLOW_FILE_FORMAT,
    schemaVersion: WORKFLOW_FILE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    title: boundedText(graph?.title || requestNode?.title || 'Workflow', 180, { singleLine: true }),
    description: boundedText(requestNode?.objective || '', 1200),
    slots: [...slotsByAgentKey.values()],
    nodes,
    points,
    connections,
  });
}

/** Parse and strictly bound an untrusted workflow file. Unknown fields vanish. */
export function normalizeWorkflowDocument(value) {
  if (!isRecord(value) || value.format !== WORKFLOW_FILE_FORMAT) {
    throw new Error('Die Datei ist kein Agent-Teams-Workflow.');
  }
  if (Number(value.schemaVersion) !== WORKFLOW_FILE_SCHEMA_VERSION) {
    throw new Error(`Workflow-Schemaversion ${value.schemaVersion || 'unbekannt'} wird nicht unterstützt.`);
  }
  if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > MAX_WORKFLOW_NODES + 1) {
    throw new Error(`Der Workflow muss zwischen 1 und ${MAX_WORKFLOW_NODES + 1} Knoten enthalten.`);
  }
  if (!Array.isArray(value.slots) || value.slots.length > MAX_WORKFLOW_SLOTS) {
    throw new Error(`Der Workflow enthält zu viele Agentenrollen (maximal ${MAX_WORKFLOW_SLOTS}).`);
  }
  if (!Array.isArray(value.points || []) || value.points.length > MAX_WORKFLOW_POINTS) {
    throw new Error(`Der Workflow enthält zu viele Fork-/Join-Punkte (maximal ${MAX_WORKFLOW_POINTS}).`);
  }
  if (!Array.isArray(value.connections || []) || value.connections.length > MAX_WORKFLOW_CONNECTIONS) {
    throw new Error(`Der Workflow enthält zu viele Verbindungen (maximal ${MAX_WORKFLOW_CONNECTIONS}).`);
  }

  const seenSlotIds = new Set();
  const slots = value.slots.map((slot, index) => {
    if (!isRecord(slot)) throw new Error(`Agentenrolle ${index + 1} ist ungültig.`);
    const id = requirePortableId(slot.id, `Agentenrolle ${index + 1}`);
    if (seenSlotIds.has(id)) throw new Error(`Agentenrollen-ID „${id}“ ist doppelt vorhanden.`);
    seenSlotIds.add(id);
    const name = boundedText(slot.name, 160, { singleLine: true });
    if (!name) throw new Error(`Agentenrolle ${index + 1} benötigt einen Namen.`);
    return {
      id,
      name,
      role: boundedText(slot.role, 240, { singleLine: true }),
      capabilities: normalizeCapabilities(slot.capabilities),
      preferredProvider: boundedText(slot.preferredProvider, 80, { singleLine: true }),
      preferredModel: boundedText(slot.preferredModel, 160, { singleLine: true }),
    };
  });

  const seenEndpointIds = new Set();
  const nodes = value.nodes.map((node, index) => {
    if (!isRecord(node)) throw new Error(`Workflow-Knoten ${index + 1} ist ungültig.`);
    const id = requirePortableId(node.id, `Workflow-Knoten ${index + 1}`);
    if (seenEndpointIds.has(id)) throw new Error(`Workflow-ID „${id}“ ist doppelt vorhanden.`);
    seenEndpointIds.add(id);
    if (!PORTABLE_NODE_TYPES.has(node.type)) {
      throw new Error(`Workflow-Knoten ${index + 1} hat einen unbekannten Typ.`);
    }
    const type = node.type;
    const title = boundedText(node.title, 180, { singleLine: true });
    if (!title) throw new Error(`Workflow-Knoten „${id}“ benötigt einen Titel.`);
    const slotId = type === 'request' ? '' : requirePortableId(node.slotId, `Workflow-Knoten „${id}“`);
    if (slotId && !seenSlotIds.has(slotId)) throw new Error(`Workflow-Knoten „${id}“ verweist auf eine unbekannte Agentenrolle.`);
    return {
      id,
      type,
      title,
      objective: boundedText(node.objective || title, 1200),
      ...(slotId ? { slotId } : {}),
      order: Math.max(0, Math.min(MAX_WORKFLOW_NODES, Number(node.order) || 0)),
      ...(type === 'request' ? {} : { priority: ['critical', 'high', 'medium', 'low'].includes(node.priority) ? node.priority : 'medium' }),
      acceptanceCriteria: type === 'request' ? [] : portableAcceptanceCriteria(node.acceptanceCriteria, id),
      delegation: type === 'task' ? portableDelegation(node.delegation) : portableDelegation(),
      ...(normalizedPosition(node.position) ? { position: normalizedPosition(node.position) } : {}),
    };
  });
  if (nodes.filter(node => node.type === 'request').length !== 1) {
    throw new Error('Ein portabler Workflow benötigt genau einen Anforderungsknoten.');
  }

  const points = (value.points || []).map((point, index) => {
    if (!isRecord(point) || !['fork', 'join'].includes(point.type)) {
      throw new Error(`Fork-/Join-Punkt ${index + 1} ist ungültig.`);
    }
    const id = requirePortableId(point.id, `Fork-/Join-Punkt ${index + 1}`);
    if (seenEndpointIds.has(id)) throw new Error(`Workflow-ID „${id}“ ist doppelt vorhanden.`);
    seenEndpointIds.add(id);
    return {
      id,
      type: point.type,
      title: point.type === 'fork' ? 'Fork' : 'Join',
      ...(normalizedPosition(point.position) ? { position: normalizedPosition(point.position) } : {}),
    };
  });

  const pointIds = new Set(points.map(point => point.id));
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  const connectionKeys = new Set();
  const connections = (value.connections || []).map((connection, index) => {
    if (!isRecord(connection)) throw new Error(`Verbindung ${index + 1} ist ungültig.`);
    const from = requirePortableId(connection.from, `Verbindung ${index + 1}`);
    const to = requirePortableId(connection.to, `Verbindung ${index + 1}`);
    if (!PORTABLE_CONNECTION_KINDS.has(connection.kind)) {
      throw new Error(`Verbindung ${index + 1} hat einen unbekannten Typ.`);
    }
    const kind = connection.kind;
    if (from === to || !seenEndpointIds.has(from) || !seenEndpointIds.has(to)) {
      throw new Error(`Verbindung ${index + 1} hat ungültige Endpunkte.`);
    }
    const usesPoint = pointIds.has(from) || pointIds.has(to);
    if (usesPoint !== (kind === 'flow')) {
      throw new Error(`Verbindung ${index + 1} verwendet einen unpassenden Verbindungstyp.`);
    }
    if (kind === 'review' && nodesById.get(to)?.type !== 'review') {
      throw new Error(`Abnahme-Verbindung ${index + 1} benötigt eine Prüfaufgabe als Ziel.`);
    }
    const key = `${kind}:${from}->${to}`;
    if (connectionKeys.has(key)) throw new Error(`Verbindung „${from} → ${to}“ ist doppelt vorhanden.`);
    connectionKeys.add(key);
    return { from, to, kind };
  });

  const usedSlotIds = new Set(nodes.map(node => node.slotId).filter(Boolean));
  return {
    format: WORKFLOW_FILE_FORMAT,
    schemaVersion: WORKFLOW_FILE_SCHEMA_VERSION,
    exportedAt: boundedText(value.exportedAt, 80, { singleLine: true }),
    title: boundedText(value.title || 'Importierter Workflow', 180, { singleLine: true }),
    description: boundedText(value.description, 1200),
    slots: slots.filter(slot => usedSlotIds.has(slot.id)),
    nodes,
    points,
    connections,
  };
}

/** Suggest local agents without silently inventing a match for unrelated roles. */
export function suggestWorkflowAgentMappings(document, agents = []) {
  const normalized = normalizeWorkflowDocument(document);
  const mappings = {};
  const slots = normalized.slots.map(slot => {
    const ranked = agents.map(agent => {
      const exactName = String(agent.name || '').trim().toLocaleLowerCase() === slot.name.toLocaleLowerCase();
      const exactRole = Boolean(slot.role) && String(agent.role || '').trim().toLocaleLowerCase() === slot.role.toLocaleLowerCase();
      const capability = slot.capabilities.length ? agentCapabilityMatch(agent, slot.capabilities) : { covers: false, score: 0 };
      const providerMatch = Boolean(slot.preferredProvider) && agent.provider === slot.preferredProvider;
      const score = (exactName ? 100 : 0) + (exactRole ? 35 : 0) +
        (capability.covers ? 45 + capability.score * 20 : capability.score * 10) +
        (providerMatch ? 5 : 0);
      return { agent, score, exactName, exactRole, capability };
    }).sort((left, right) => right.score - left.score || String(left.agent.name).localeCompare(String(right.agent.name)));
    const best = ranked[0];
    const suggested = best && (best.exactName || best.exactRole || best.capability.covers || agents.length === 1)
      ? best.agent.id
      : '';
    mappings[slot.id] = suggested;
    return {
      ...slot,
      suggestedAgentId: suggested,
      suggestionReason: !best || !suggested
        ? 'manual'
        : best.exactName
          ? 'name'
          : best.capability.covers
            ? 'capabilities'
            : best.exactRole
              ? 'role'
              : 'single-agent',
    };
  });
  return { document: normalized, slots, mappings };
}

/** Convert a validated portable contract into a local, editable planning graph. */
export function createImportedTaskGraph(document, { chatId, chatName, agents = [], mappings = {} } = {}) {
  const normalized = normalizeWorkflowDocument(document);
  const agentsById = new Map(agents.map(agent => [agent.id, agent]));
  for (const slot of normalized.slots) {
    if (!agentsById.has(mappings[slot.id])) {
      throw new Error(`Die Agentenrolle „${slot.name}“ ist noch nicht zugeordnet.`);
    }
  }

  const importedAt = Date.now();
  const suffix = `${importedAt.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const requestTemplate = normalized.nodes.find(node => node.type === 'request');
  const rootNodeId = `workflow-import-${suffix}:request`;
  const endpointIds = new Map();
  if (requestTemplate) endpointIds.set(requestTemplate.id, rootNodeId);
  const taskNodes = normalized.nodes.filter(node => node.type !== 'request');
  taskNodes.forEach((node, index) => {
    endpointIds.set(node.id, taskPlanGraphNodeId(rootNodeId, `import-${index + 1}-${node.id}`));
  });
  normalized.points.forEach((point, index) => {
    endpointIds.set(point.id, `__import-${point.type}-${index + 1}-${suffix}`);
  });

  const rootNode = {
    id: rootNodeId,
    title: requestTemplate?.title || normalized.title,
    objective: requestTemplate?.objective || normalized.description || normalized.title,
    status: 'completed',
    source: 'user',
    nodeType: 'request',
    acceptanceCriteria: [],
    createdAt: importedAt,
    updatedAt: importedAt,
  };
  const nodes = [rootNode, ...taskNodes.map((node, index) => {
    const agent = agentsById.get(mappings[node.slotId]);
    const slot = normalized.slots.find(candidate => candidate.id === node.slotId);
    const graphNodeId = endpointIds.get(node.id);
    const incomingParent = normalized.connections.find(connection =>
      connection.to === node.id && connection.kind === 'delegation' && normalized.nodes.some(candidate => candidate.id === connection.from && candidate.type !== 'request')
    );
    return {
      id: graphNodeId,
      title: node.title,
      objective: node.objective,
      priority: node.priority || 'medium',
      agentId: agent.id,
      agentName: agent.name,
      provider: agent.provider,
      model: agent.model,
      status: 'planned',
      source: 'Imported-Plan',
      nodeType: node.type,
      planRootId: rootNodeId,
      planTaskId: `import-${index + 1}-${node.id}`,
      planOrder: node.order,
      requestedAgentName: slot?.name || agent.name,
      acceptanceCriteria: normalizeAcceptanceCriteria(node.acceptanceCriteria, { taskId: graphNodeId }).map(criterion => ({
        ...criterion,
        status: 'open',
        evidence: [],
        reviewedBy: undefined,
        reviewedAt: undefined,
      })),
      delegation: normalizeDelegationPolicy({ ...node.delegation, allowedTargetGroupIds: [] }),
      ...(incomingParent ? { parentNodeId: endpointIds.get(incomingParent.from) } : {}),
      createdAt: importedAt + index + 1,
      updatedAt: importedAt,
    };
  })];

  const flowPoints = normalized.points.map(point => ({
    id: endpointIds.get(point.id),
    type: point.type,
    title: point.title,
    planRootId: rootNodeId,
    createdAt: importedAt,
  }));
  const edges = [];
  const flowEdges = [];
  for (const connection of normalized.connections) {
    const edge = {
      id: `${connection.kind}:${endpointIds.get(connection.from)}->${endpointIds.get(connection.to)}`,
      kind: connection.kind,
      from: endpointIds.get(connection.from),
      to: endpointIds.get(connection.to),
      planRootId: rootNodeId,
    };
    if (connection.kind === 'flow') flowEdges.push(edge);
    else edges.push(edge);
  }
  const importedPositions = {};
  for (const item of [...normalized.nodes, ...normalized.points]) {
    if (item.position && endpointIds.has(item.id)) importedPositions[endpointIds.get(item.id)] = item.position;
  }

  const graph = {
    ...createTaskGraph(chatId, normalized.title || chatName || 'Importierter Workflow'),
    workflowState: 'planning',
    planRevision: 1,
    planOwner: 'user',
    userEditedAt: importedAt,
    importedWorkflow: {
      format: normalized.format,
      schemaVersion: normalized.schemaVersion,
      title: normalized.title,
      importedAt,
    },
    nodes,
    edges,
    flowPoints,
    flowEdges,
    viewState: { positions: importedPositions },
    updatedAt: importedAt,
  };
  const validation = validateWorkflowPlan(graph);
  if (!validation.ok) {
    const error = new Error(validation.reason || 'Der importierte Workflow ist nicht ausführbar.');
    error.validation = validation;
    throw error;
  }
  return { graph, rootNodeId };
}
