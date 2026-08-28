const MAX_EXCALIDRAW_ELEMENTS = 500;

export function parseExcalidrawElements(value) {
  let parsed = value;
  if (typeof value === 'string') parsed = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('Excalidraw-Elemente müssen ein JSON-Array sein.');
  return parsed
    .filter(element => element && typeof element === 'object' && !Array.isArray(element))
    .slice(0, MAX_EXCALIDRAW_ELEMENTS);
}

export function excalidrawElementBounds(elements = []) {
  const points = [];
  for (const element of elements) {
    const x = Number(element.x) || 0;
    const y = Number(element.y) || 0;
    if (Array.isArray(element.points) && element.points.length > 0) {
      for (const point of element.points) {
        points.push([x + (Number(point?.[0]) || 0), y + (Number(point?.[1]) || 0)]);
      }
      continue;
    }
    const width = Math.max(0, Number(element.width) || 0);
    const height = Math.max(0, Number(element.height) || (element.type === 'text' ? Number(element.fontSize) || 20 : 0));
    points.push([x, y], [x + width, y + height]);
  }
  if (!points.length) return { x: 0, y: 0, width: 640, height: 360 };
  const xs = points.map(point => point[0]);
  const ys = points.map(point => point[1]);
  const padding = 28;
  const minX = Math.min(...xs) - padding;
  const minY = Math.min(...ys) - padding;
  return {
    x: minX,
    y: minY,
    width: Math.max(120, Math.max(...xs) - minX + padding),
    height: Math.max(100, Math.max(...ys) - minY + padding),
  };
}

export function createExcalidrawDocument(elements = []) {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'agent-teams',
    elements,
    appState: { gridSize: null, viewBackgroundColor: '#ffffff' },
    files: {},
  };
}
