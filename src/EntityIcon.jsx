import React from 'react';
import Icon from './Icon';

// Preserve existing saved/exported identities; render them through the shared icon set.
const identities = {
  '🤖': ['agents', 'Agent'], '💡': ['idea', 'Idee'], '⚙️': ['settings', 'Technik'],
  '🧠': ['memory', 'Wissen'], '🎯': ['target', 'Ziel'], '📊': ['chart', 'Analyse'],
  '🔬': ['test', 'Forschung'], '🎨': ['palette', 'Design'], '📝': ['edit', 'Redaktion'],
  '🚀': ['rocket', 'Projekt'], '💻': ['code', 'Entwicklung'], '🌍': ['globe', 'Global'],
  '💬': ['users', 'Team'], '⚡': ['bolt', 'Automatisierung'], '🌐': ['globe', 'Netzwerk'],
  '🔧': ['settings', 'Werkzeuge'], '📋': ['plan', 'Planung'], '🧪': ['test', 'Prüfung'],
  '🏗️': ['workflow', 'Architektur'], '🔄': ['transfer', 'Koordination'], '✅': ['shield', 'Qualität'],
};
export function entityIconLabel(value) { return identities[value]?.[1] || 'Symbol'; }
export default function EntityIcon({ value, group = false, size = 20 }) {
  return <Icon name={identities[value]?.[0] || (group ? 'users' : 'agents')} size={size} className="entity-icon" />;
}
