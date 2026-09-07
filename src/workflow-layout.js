const DEFAULTS = {
  nodeWidth: 230,
  nodeHeight: 124,
  horizontalGap: 118,
  verticalGap: 28,
  padding: 56,
};

function layoutNodeType(node = {}) {
  if (node.nodeType) return node.nodeType;
  if (node.source === 'team-synthesis') return 'review';
  if (String(node.source || '').startsWith('timeout-recovery')) return 'recovery';
  if (node.source === 'user-answer') return 'continuation';
  if (node.source === 'user' && !node.parentNodeId) return 'request';
  return 'task';
}

function blockingEdge(edge = {}) {
  return edge.kind === 'dependency' || edge.kind === 'review' || edge.kind === 'flow';
}

function finitePosition(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: value.x, y: value.y }
    : null;
}

function orderedNodes(nodes) {
  return [...nodes].sort((left, right) =>
    (left.planOrder || 0) - (right.planOrder || 0) ||
    (left.createdAt || 0) - (right.createdAt || 0) ||
    String(left.title || '').localeCompare(String(right.title || ''), 'de')
  );
}

function assignHorizontalPhases(nodes, edges, flowPoints = []) {
  const requests = nodes.filter(node => layoutNodeType(node) === 'request');
  const phase = new Map(requests.map(node => [node.id, 0]));
  for (const node of nodes) if (!phase.has(node.id)) phase.set(node.id, 1);
  for (const point of flowPoints) if (!phase.has(point.id)) phase.set(point.id, 1);

  const blocking = edges.filter(blockingEdge);
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of blocking) {
      if (!phase.has(edge.from) || !phase.has(edge.to)) continue;
      const required = (phase.get(edge.from) || 0) + 1;
      if ((phase.get(edge.to) || 0) < required) {
        phase.set(edge.to, required);
        changed = true;
      }
    }
    if (!changed) break;
  }

  return phase;
}

export function buildWorkflowLayout(graph, options = {}) {
  const config = { ...DEFAULTS, ...options };
  const nodes = graph?.nodes || [];
  const nodeIds = new Set(nodes.map(node => node.id));
  const edges = (graph?.edges || []).filter(edge => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const persistedFlowPoints = graph?.flowPoints || [];
  const flowEdges = (graph?.flowEdges || []).filter(edge => (
    (nodeIds.has(edge.from) || persistedFlowPoints.some(point => point.id === edge.from)) &&
    (nodeIds.has(edge.to) || persistedFlowPoints.some(point => point.id === edge.to))
  ));
  const phaseByNode = assignHorizontalPhases(nodes, [...edges, ...flowEdges], persistedFlowPoints);
  const layersByPhase = new Map();
  for (const node of nodes) {
    const phase = phaseByNode.get(node.id) || 0;
    if (!layersByPhase.has(phase)) layersByPhase.set(phase, []);
    layersByPhase.get(phase).push(node);
  }
  for (const layerNodes of layersByPhase.values()) {
    const ordered = orderedNodes(layerNodes);
    layerNodes.splice(0, layerNodes.length, ...ordered);
  }

  const layers = [...layersByPhase.entries()].sort((left, right) => left[0] - right[0]);
  const maxLayerSize = Math.max(1, ...layers.map(([, items]) => items.length));
  const stackHeight = maxLayerSize * config.nodeHeight + Math.max(0, maxLayerSize - 1) * config.verticalGap;
  const mainlineY = config.padding + stackHeight / 2 - config.nodeHeight / 2;
  const positions = new Map();

  for (const [phase, layerNodes] of layers) {
    const layerHeight = layerNodes.length * config.nodeHeight + Math.max(0, layerNodes.length - 1) * config.verticalGap;
    const layerTop = config.padding + (stackHeight - layerHeight) / 2;
    layerNodes.forEach((node, index) => {
      const manual = finitePosition(graph?.viewState?.positions?.[node.id]) || finitePosition(node.workflowPosition);
      positions.set(node.id, manual || {
        x: config.padding + phase * (config.nodeWidth + config.horizontalGap),
        y: layerTop + index * (config.nodeHeight + config.verticalGap),
      });
    });
  }

  const pointById = new Map();
  const flowPoints = persistedFlowPoints.map((point, index) => {
    const manual = finitePosition(graph?.viewState?.positions?.[point.id]);
    const phase = phaseByNode.get(point.id) || 1;
    return {
      ...point,
      phase,
      ...(manual || {
        x: config.padding + phase * (config.nodeWidth + config.horizontalGap) - config.horizontalGap / 2,
        y: mainlineY + config.nodeHeight / 2 + index * 36,
      }),
    };
  });
  for (const point of flowPoints) pointById.set(point.id, point);
  const extents = [...positions.values()].reduce((result, position) => ({
    maxX: Math.max(result.maxX, position.x + config.nodeWidth),
    maxY: Math.max(result.maxY, position.y + config.nodeHeight),
  }), { maxX: 720, maxY: 520 });
  for (const point of flowPoints) {
    extents.maxX = Math.max(extents.maxX, point.x + 34);
    extents.maxY = Math.max(extents.maxY, point.y + 34);
  }

  return {
    positions,
    layers,
    phaseByNode,
    flowPoints,
    flowEdges,
    pointById,
    mainlineY,
    width: Math.max(720, extents.maxX + config.padding),
    height: Math.max(520, extents.maxY + config.padding),
    ...config,
  };
}

export function workflowEdgePath(fromPosition, toPosition, nodeWidth = DEFAULTS.nodeWidth, nodeHeight = DEFAULTS.nodeHeight) {
  const startX = fromPosition.x + nodeWidth;
  const startY = fromPosition.y + nodeHeight / 2;
  const endX = toPosition.x;
  const endY = toPosition.y + nodeHeight / 2;
  const distance = Math.max(36, Math.abs(endX - startX) * 0.48);
  return `M ${startX} ${startY} C ${startX + distance} ${startY}, ${endX - distance} ${endY}, ${endX} ${endY}`;
}

export function workflowRailPath(from, to) {
  const distance = Math.max(28, Math.abs(to.x - from.x) * 0.45);
  return `M ${from.x} ${from.y} C ${from.x + distance} ${from.y}, ${to.x - distance} ${to.y}, ${to.x} ${to.y}`;
}
