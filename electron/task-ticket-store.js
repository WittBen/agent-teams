const fs = require('fs');
const path = require('path');

const TICKET_SCHEMA_VERSION = 1;
const TICKET_PRIORITIES = new Set(['critical', 'high', 'medium', 'low']);

function safeSegment(value, fallback = 'workflow') {
  const normalized = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return normalized || fallback;
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function ticketIdForNode(node = {}) {
  return safeSegment(node.ticketId || node.planTaskId || node.id, 'ticket');
}

function normalizeCriterion(criterion = {}) {
  return {
    id: safeSegment(criterion.id, 'criterion'),
    text: String(criterion.text || '').trim().slice(0, 1000),
    required: criterion.required !== false,
    verification: ['reviewer', 'automatic', 'user'].includes(criterion.verification)
      ? criterion.verification
      : 'reviewer',
    status: ['open', 'submitted', 'passed', 'failed', 'waived'].includes(criterion.status)
      ? criterion.status
      : 'open',
    evidence: Array.isArray(criterion.evidence) ? clone(criterion.evidence.slice(-20)) : [],
    ...(criterion.reviewedBy ? { reviewedBy: String(criterion.reviewedBy).slice(0, 120) } : {}),
    ...(criterion.reviewedAt ? { reviewedAt: criterion.reviewedAt } : {}),
  };
}

function ticketFromNode(node = {}, graph = {}) {
  const ticketId = ticketIdForNode(node);
  const dependencyIds = (graph.edges || [])
    .filter(edge => edge.to === node.id && ['dependency', 'review'].includes(edge.kind))
    .map(edge => ticketIdForNode((graph.nodes || []).find(candidate => candidate.id === edge.from) || { id: edge.from }));
  const attempts = Array.isArray(node.ticketAttempts) ? clone(node.ticketAttempts.slice(-30)) : [];
  return {
    schemaVersion: TICKET_SCHEMA_VERSION,
    id: ticketId,
    workflowId: safeSegment(graph.chatId, 'workflow'),
    graphNodeId: String(node.id || '').slice(0, 300),
    type: node.nodeType || 'task',
    title: String(node.title || 'Aufgabe').trim().slice(0, 300),
    description: String(node.objective || node.title || '').trim().slice(0, 5000),
    priority: TICKET_PRIORITIES.has(node.priority) ? node.priority : 'medium',
    status: String(node.status || 'planned').slice(0, 80),
    assignment: {
      agentId: node.agentId || null,
      agentName: node.agentName || null,
      groupId: node.groupId || graph.chatId || null,
    },
    dependencies: [...new Set(dependencyIds)],
    acceptanceCriteria: (node.acceptanceCriteria || []).map(normalizeCriterion),
    acceptanceTestRuns: Array.isArray(node.acceptanceTestRuns)
      ? clone(node.acceptanceTestRuns.slice(-12))
      : [],
    manualAcceptance: node.manualAcceptanceRequestedAt ? {
      requestedAt: node.manualAcceptanceRequestedAt,
      requestedBy: node.manualAcceptanceRequestedBy || 'PM',
    } : null,
    checkpoint: node.interimResult ? {
      summary: String(node.interimResult).slice(0, 5000),
      savedAt: node.interimSavedAt || node.updatedAt || Date.now(),
      consumedAt: node.interimConsumedAt || null,
    } : null,
    waitingFor: node.waitingFor || node.blockedReason || null,
    attempts,
    recovery: node.recovery ? clone(node.recovery) : null,
    recoveryPlan: node.recoveryPlan ? clone(node.recoveryPlan) : null,
    recoveryNotes: Array.isArray(node.recoveryNotes) ? clone(node.recoveryNotes.slice(-30)) : [],
    staleDependency: node.staleBecauseTaskId ? {
      taskId: node.staleBecauseTaskId,
      previousStatus: node.stalePreviousStatus || null,
      invalidatedAt: node.staleAt || null,
    } : null,
    createdAt: node.createdAt || graph.createdAt || Date.now(),
    updatedAt: node.updatedAt || graph.updatedAt || Date.now(),
  };
}

function graphWithTicketMetadata(graph = {}) {
  return {
    ...clone(graph),
    version: Math.max(3, Number(graph.version) || 1),
    ticketSchemaVersion: TICKET_SCHEMA_VERSION,
    nodes: (graph.nodes || []).map(node => ({
      ...clone(node),
      ticketId: ticketIdForNode(node),
      priority: TICKET_PRIORITIES.has(node.priority) ? node.priority : 'medium',
    })),
  };
}

function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  try {
    fs.renameSync(temporary, filename);
  } catch (error) {
    // Windows does not replace an existing destination atomically. Remove only
    // the exact validated file and immediately finish the prepared rename.
    if (error.code !== 'EEXIST' && error.code !== 'EPERM') throw error;
    fs.unlinkSync(filename);
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function internalProjectPath(root, ...segments) {
  const projectRoot = path.resolve(root);
  const target = path.resolve(projectRoot, ...segments);
  const relative = path.relative(projectRoot, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Ticketpfad liegt außerhalb des Projektordners.');
  }
  let current = projectRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Symbolische Links sind im Ticketpfad nicht erlaubt.');
    }
  }
  return target;
}

function createTaskTicketStore({ projectPathForChat, now = () => Date.now() }) {
  function projectRoot(chatId) {
    const root = projectPathForChat(String(chatId || ''));
    if (!root) throw new Error('Für diese Gruppe ist kein Projektordner konfiguriert.');
    return path.resolve(root);
  }

  function workflowRoot(chatId) {
    const root = projectRoot(chatId);
    return internalProjectPath(root, '.agent-teams', 'tickets', safeSegment(chatId));
  }

  function readWorkflow(chatId) {
    const filename = path.join(workflowRoot(chatId), 'workflow.json');
    if (!fs.existsSync(filename)) return null;
    if (fs.statSync(filename).size > 20 * 1024 * 1024) throw new Error('Gespeicherter Workflow ist größer als 20 MB.');
    const document = JSON.parse(fs.readFileSync(filename, 'utf8'));
    return document?.graph && typeof document.graph === 'object' ? graphWithTicketMetadata(document.graph) : null;
  }

  function saveWorkflow(chatId, incomingGraph, { reason = 'sync' } = {}) {
    if (!incomingGraph || typeof incomingGraph !== 'object' || Array.isArray(incomingGraph)) {
      throw new Error('Ungültiger Workflow für die Ticket-Persistenz.');
    }
    const serialized = JSON.stringify(incomingGraph);
    if (Buffer.byteLength(serialized) > 20 * 1024 * 1024) throw new Error('Workflow ist größer als 20 MB.');
    const graph = graphWithTicketMetadata({ ...incomingGraph, chatId });
    const root = workflowRoot(chatId);
    const tickets = graph.nodes
      .filter(node => node.nodeType !== 'request')
      .map(node => ticketFromNode(node, graph));
    const persistedAt = now();
    const previous = readWorkflow(chatId);
    const revision = Math.max(Number(previous?.ticketRevision) || 0, Number(graph.ticketRevision) || 0) + 1;
    graph.ticketRevision = revision;
    atomicWriteJson(path.join(root, 'workflow.json'), {
      schemaVersion: TICKET_SCHEMA_VERSION,
      workflowId: safeSegment(chatId),
      revision,
      persistedAt,
      graph,
      ticketIds: tickets.map(ticket => ticket.id),
    });
    for (const ticket of tickets) atomicWriteJson(path.join(root, `${ticket.id}.json`), ticket);
    const expected = new Set(['workflow.json', ...tickets.map(ticket => `${ticket.id}.json`)]);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json') && !expected.has(entry.name)) {
        fs.unlinkSync(path.join(root, entry.name));
      }
    }
    fs.appendFileSync(path.join(root, 'history.jsonl'), `${JSON.stringify({
      revision, persistedAt, reason: String(reason).slice(0, 100), updatedAt: graph.updatedAt || persistedAt,
    })}\n`, 'utf8');
    return graph;
  }

  function reconcileWorkflow(chatId, fallbackGraph) {
    const persisted = readWorkflow(chatId);
    if (!persisted) return fallbackGraph ? saveWorkflow(chatId, fallbackGraph, { reason: 'migration' }) : null;
    if (!fallbackGraph || Number(persisted.updatedAt) >= Number(fallbackGraph.updatedAt)) return persisted;
    return saveWorkflow(chatId, fallbackGraph, { reason: 'reconcile-newer-app-state' });
  }

  function archiveWorkflow(chatId) {
    const source = workflowRoot(chatId);
    const root = projectRoot(chatId);
    const archiveRoot = internalProjectPath(root, '.agent-teams', 'archive');
    const destination = path.join(archiveRoot, `${safeSegment(chatId)}-${now()}`);
    let archived = false;
    if (fs.existsSync(source)) {
      fs.mkdirSync(archiveRoot, { recursive: true });
      fs.renameSync(source, destination);
      archived = true;
    }
    const requestsRoot = internalProjectPath(root, '.agent-teams', 'requests');
    if (fs.existsSync(requestsRoot)) {
      for (const entry of fs.readdirSync(requestsRoot, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const requestFile = path.join(requestsRoot, entry.name);
        try {
          const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
          if (request.sourceGroupId !== chatId && request.targetGroupId !== chatId) continue;
          const requestArchive = path.join(destination, 'requests');
          fs.mkdirSync(requestArchive, { recursive: true });
          fs.renameSync(requestFile, path.join(requestArchive, entry.name));
          archived = true;
        } catch {
          // Leave malformed/unrelated files untouched; workflow deletion must
          // never broaden into deleting unknown project data.
        }
      }
    }
    return { ok: true, archived, archiveName: archived ? path.basename(destination) : null };
  }

  function syncRequests(requests = {}) {
    const written = [];
    for (const request of Object.values(requests || {})) {
      const chatId = request?.sourceGroupId || request?.targetGroupId;
      if (!chatId) continue;
      let root;
      try {
        const project = projectRoot(chatId);
        root = internalProjectPath(project, '.agent-teams', 'requests');
      } catch {
        continue;
      }
      const id = safeSegment(request.id, 'request');
      atomicWriteJson(path.join(root, `${id}.json`), {
        schemaVersion: TICKET_SCHEMA_VERSION,
        ...clone(request),
        id,
      });
      written.push(id);
    }
    return { ok: true, written: [...new Set(written)].length };
  }

  return { archiveWorkflow, readWorkflow, reconcileWorkflow, saveWorkflow, syncRequests, ticketFromNode };
}

module.exports = {
  TICKET_SCHEMA_VERSION,
  createTaskTicketStore,
  graphWithTicketMetadata,
  safeSegment,
  ticketFromNode,
};
