import React from 'react';

// App-owned icons share a single grid, stroke and sizing contract.
const paths = {
  play: 'm7 3 14 9-14 9V3Z',
  pause: 'M7 4v16M17 4v16',
  stop: 'M5 5h14v14H5Z',
  undo: 'M9 4 3 10l6 6 M3 10h11a6 6 0 0 1 6 6v4',
  idea: 'M9 18h6 M10 21h4 M8 14a6 6 0 1 1 8 0l-1 2H9l-1-2Z',
  target: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0Z M12 10v4 M10 12h4',
  chart: 'M4 3v18h17 M8 17v-5 M13 17V8 M18 17V4',
  palette: 'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-4 2 2 0 0 1 1-4h3a3 3 0 0 0 3-3c0-4-4-7-9-7Z M7 10h.01 M10 7h.01 M15 7h.01 M7 15h.01',
  rocket: 'M9 15 5 11l5-2c3-6 7-6 11-6 0 4 0 8-6 11l-2 5-4-4Z M14 7l3 3 M6 15l-3 6 6-3',
  code: 'M3 4h18v14H3Z M8 21h8 M12 18v3 M9 8l-3 3 3 3 M15 8l3 3-3 3',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-7l0-7Z',
  chat: 'M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z M7 9h10 M7 13h6',
  agents: 'M8 8h8a4 4 0 0 1 4 4v6H4v-6a4 4 0 0 1 4-4Z M12 8V4 M10 4h4 M8 12v2 M16 12v2 M9 18v2 M15 18v2 M1 12v4 M23 12v4',
  settings: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
  search: 'M16.5 16.5 21 21 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  edit: 'm14 5 5 5 M4 20l5-1L21 7a2.1 2.1 0 0 0-4-4L5 15l-1 5Z',
  trash: 'M3 6h18 M9 6V3h6v3 M5 6l1 15h12l1-15 M10 10v7 M14 10v7',
  plus: 'M12 5v14 M5 12h14',
  close: 'm6 6 12 12 M6 18 18 6',
  minus: 'M5 12h14',
  maximize: 'M5 5h14v14H5Z',
  panelLeft: 'M3 4h18v16H3Z M9 4v16 M15 9l-3 3 3 3',
  panelRight: 'M3 4h18v16H3Z M9 4v16 M13 9l3 3-3 3',
  arrowLeft: 'M20 12H4 M10 6l-6 6 6 6',
  workflow: 'M3 3h6v6H3Z M15 15h6v6h-6Z M6 9v9h9 M9 6h9v9',
  plan: 'M6 3h12v18H6Z M9 7h6 M9 11h6 M9 15h4',
  test: 'M9 3h6 M10 3v7l-6 9a1 1 0 0 0 1 2h14a1 1 0 0 0 1-2l-6-9V3 M8 15h8',
  attach: 'm8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8 M8 12l-2 2a1.5 1.5 0 0 0 2 2l8-8',
  send: 'm3 3 19 9-19 9 4-9-4-9Z M7 12h15',
  lock: 'M5 10h14v11H5Z M8 10V7a4 4 0 0 1 8 0 M12 14v3',
  folder: 'M3 5h7l2 3h9v12H3V5Z',
  shield: 'M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z m-4 10 3 3 5-6',
  globe: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z M2 21v-3a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v3 M17 4a4 4 0 0 1 0 7 M19 14a4 4 0 0 1 3 4v3',
  key: 'M14 8a5 5 0 1 1 3 4l-8 8H4v-5l6-6 M17 7h.01',
  plug: 'M8 3v5 M16 3v5 M6 8h12v3a6 6 0 0 1-12 0V8Z M12 17v4',
  info: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z M12 11v6 M12 7h.01',
  save: 'M4 3h13l4 4v14H3V3h1Z M7 3v6h10V3 M7 21v-7h10v7',
  transfer: 'M4 7h16 M16 3l4 4-4 4 M20 17H4 M8 13l-4 4 4 4',
  memory: 'M5 5h14v14H5Z M9 9h6v6H9Z M8 2v3 M16 2v3 M8 19v3 M16 19v3 M2 8h3 M2 16h3 M19 8h3 M19 16h3',
};

export default function Icon({ name, size = 18, className = '' }) {
  return <svg className={`app-icon ${className}`} width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false"><path d={paths[name] || paths.chat} /></svg>;
}
