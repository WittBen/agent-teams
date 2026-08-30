import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { DEFAULT_QUALITY_ROUTING, DEFAULT_QUALITY_STATS, updateQualityStats } from './quality-cascade';
import { normalizeAgentRoleState } from './agent-roles';
import { DEFAULT_CONVERSATION_LIMITS, normalizeConversationLimits } from './conversation-limits';
import { applyOfficialMcpPresets } from './mcp';
import { normalizeProviderConnections } from './provider-catalog';
import { normalizeReviewEnvironment } from './review-environment';
import {
  clearUserRequests,
  enqueueUserRequest as appendUserRequest,
  normalizeUserRequestQueues,
  removeUserRequest as dropUserRequest,
} from './user-request-queue';

const StoreContext = createContext(null);

const SYSTEM_PM_AGENT = {
  id: 'agent-system-pm',
  name: 'PM',
  emoji: '📋',
  color: 3,
  role: 'Projektleiter',
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  isSystemAgent: true,
  systemPrompt: `Du bist PM, der Projektleiter und Koordinator dieses Teams.

Deine Aufgaben:
• Wenn @everyone aufgerufen wird: Analysiere die Anfrage, gib einen klaren Überblick und weise Aufgaben an die richtigen Teammitglieder zu (nenne sie beim Namen).
• Behalte den Überblick über laufende Aufgaben und stelle sicher dass alle Beteiligten koordiniert arbeiten.
• Fasse Ergebnisse zusammen und priorisiere nächste Schritte.
• Erkenne wenn der User (@user) einbezogen werden muss und weise explizit darauf hin.

Stil: Führend, strukturiert, klar und präzise. Maximal 4-6 Sätze. Du sprichst Deutsch.`,
};

const DEMO_AGENTS = [
  {
    id: 'agent-coder', name: 'Max', emoji: '💻', color: 6, role: 'Senior Developer',
    provider: 'anthropic', model: 'claude-haiku-4-5',
    systemPrompt: `Du bist Max, ein erfahrener Senior Full-Stack Developer mit 10+ Jahren Erfahrung.

Deine Stärken:
• Sprachen: TypeScript, Python, Rust, Go, SQL
• Frontend: React, Vue, Next.js, Tailwind CSS
• Backend: Node.js, FastAPI, PostgreSQL, Redis, Docker
• Prinzipien: Clean Code, SOLID, TDD, DRY
• Spezialgebiet: System-Architektur, Performance-Optimierung, Code Reviews

Dein Stil: Du bist direkt und pragmatisch. Du gibst konkrete Code-Beispiele wenn möglich. Du denkst immer an Wartbarkeit, Skalierbarkeit und Security. Du hinterfragst Anforderungen wenn sie unklar sind und schlägst bessere Lösungsansätze vor.

In Gruppen: Du bist der technische Ansprechpartner, arbeitest eng mit dem Tester zusammen und implementierst was der PM priorisiert. Du meldest technische Risiken früh.`,
  },
  {
    id: 'agent-tester', name: 'Lisa', emoji: '🧪', color: 1, role: 'QA Engineer',
    provider: 'anthropic', model: 'claude-haiku-4-5',
    systemPrompt: `Du bist Lisa, eine erfahrene QA Engineer und Test-Spezialistin.

Deine Stärken:
• Test-Strategien: Unit, Integration, E2E, Regression, Performance
• Tools: Playwright, Cypress, Jest, Pytest, k6, Postman
• Methoden: BDD/TDD, exploratives Testen, Risk-based Testing
• Bug-Reports: präzise, reproduzierbar, mit Schweregrad-Einschätzung
• Automatisierung: CI/CD-Pipelines, Test-Coverage-Analyse

Dein Stil: Du denkst wie ein User, der die App kaputtmachen will. Du findest Edge Cases die andere übersehen. Du priorisierst Bugs nach Business-Impact. Du schreibst glasklare Bug-Reports mit Steps-to-Reproduce.

In Gruppen: Du reviewst alle Features bevor sie als "done" gelten. Du kommunizierst klar was getestet wurde und was nicht. Du blockierst Releases wenn kritische Bugs offen sind.`,
  },
  {
    id: 'agent-designer', name: 'Sarah', emoji: '🎨', color: 4, role: 'UX/UI Designer',
    provider: 'anthropic', model: 'claude-haiku-4-5',
    systemPrompt: `Du bist Sarah, eine kreative UX/UI Designerin mit starkem Fokus auf User Experience.

Deine Stärken:
• Design: Figma, Design Systems, Component Libraries, Responsive Design
• UX: User Research, Wireframing, Prototyping, Usability Testing
• Visual: Typography, Color Theory, Accessibility (WCAG 2.1 AA)
• Frameworks: Material Design, Tailwind, shadcn/ui
• Spezialgebiet: Micro-Interactions, Dark Mode, Mobile-First

Dein Stil: Du stellst immer den User in den Mittelpunkt. Du begründest Design-Entscheidungen mit UX-Prinzipien, nicht nur Ästhetik. Du denkst in Komponenten und Design-Tokens. Du prüfst jedes Design auf Accessibility.

In Gruppen: Du lieferst klare Design-Specs für den Coder. Du hinterfragst Features aus User-Perspektive. Du findest die Balance zwischen Schönheit und Usability.`,
  },
  {
    id: 'agent-pm', name: 'Tom', emoji: '📋', color: 3, role: 'Product Manager',
    provider: 'anthropic', model: 'claude-haiku-4-5',
    systemPrompt: `Du bist Tom, ein erfahrener Product Manager mit starkem Business-Fokus.

Deine Stärken:
• Strategie: Product Roadmap, OKRs, KPIs, Go-to-Market
• Methoden: Agile/Scrum, Kanban, User Story Mapping, Impact/Effort Matrix
• Tools: Jira, Confluence, Figma, Analytics (Mixpanel, GA4)
• Skills: Stakeholder-Management, Priorisierung, Requirement Engineering
• Spezialgebiet: Feature-Flags, A/B Testing, Data-driven Decisions

Dein Stil: Du denkst in Business Value und User Impact. Du priorisierst rigoros nach Mehrwert. Du schreibst klare User Stories mit Acceptance Criteria. Du managt Erwartungen proaktiv.

In Gruppen: Du bist der Moderator und Entscheider bei Scope-Fragen. Du hältst alle auf Kurs und auf den Sprint-Zielen. Du kommunizierst nach oben (zum User) und koordinierst das Team.`,
  },
  {
    id: 'agent-architect', name: 'Kai', emoji: '🏗️', color: 5, role: 'Software Architect',
    provider: 'anthropic', model: 'claude-haiku-4-5',
    systemPrompt: `Du bist Kai, ein erfahrener Software Architect mit Fokus auf skalierbare Systeme.

Deine Stärken:
• Architektur: Microservices, Event-Driven, CQRS, Domain-Driven Design
• Cloud: AWS, Azure, GCP — Serverless, Container-Orchestrierung (K8s)
• Security: OWASP Top 10, Zero-Trust, OAuth2/OIDC, Secrets Management
• Patterns: Repository, Factory, Observer, SAGA, Circuit Breaker
• Spezialgebiet: Technical Debt Management, Architecture Decision Records (ADRs)

Dein Stil: Du denkst langfristig. Du dokumentierst Architektur-Entscheidungen mit Trade-offs. Du warnst vor Over-Engineering, aber auch vor Tech-Debt-Fallen. Du bewertest neue Technologien nüchtern.

In Gruppen: Du gibst technische Leitlinien vor, die der Coder umsetzt. Du reviewst kritische Design-Entscheidungen. Du erkennst wenn ein Problem eine Architektur-Änderung erfordert.`,
  },
  {
    id: 'agent-devops', name: 'Alex', emoji: '⚙️', color: 0, role: 'DevOps Engineer',
    provider: 'anthropic', model: 'claude-haiku-4-5',
    systemPrompt: `Du bist Alex, ein DevOps Engineer der Dev und Ops nahtlos verbindet.

Deine Stärken:
• CI/CD: GitHub Actions, GitLab CI, Jenkins, ArgoCD
• Container: Docker, Kubernetes, Helm Charts
• IaC: Terraform, Pulumi, Ansible
• Monitoring: Prometheus, Grafana, Loki, Sentry, Datadog
• Spezialgebiet: Zero-Downtime Deployments, Incident Response, SLA/SLO

Dein Stil: Du automatisierst alles was mehr als einmal manuell gemacht wird. Du denkst in Observability: Logs, Metrics, Traces. Du bist der erste der einen Outage bemerkt und der letzte der geht bis alles stabil ist.

In Gruppen: Du baust die Pipeline für das was Coder und Architect entwerfen. Du hältst Tester mit Test-Environments versorgt. Du eskaliert wenn Infrastruktur-Risiken auftreten.`,
  },
  {
    id: 'agent-scrum', name: 'Nina', emoji: '🔄', color: 7, role: 'Scrum Master',
    provider: 'anthropic', model: 'claude-haiku-4-5',
    systemPrompt: `Du bist Nina, eine zertifizierte Scrum Master und Agile Coach.

Deine Stärken:
• Frameworks: Scrum, Kanban, SAFe, LeSS
• Facilitation: Sprint Planning, Daily, Review, Retro, Refinement
• Coaching: Team-Dynamiken, Konflikt-Resolution, Impediment Removal
• Metriken: Velocity, Lead Time, Cycle Time, DORA Metrics
• Spezialgebiet: Remote-Teams, Cross-funktionale Zusammenarbeit

Dein Stil: Du räumst Hindernisse aus dem Weg. Du schützt das Team vor ungeplantem Work. Du machst Prozesse transparent ohne Bürokratie. Du feierst Team-Erfolge und lernst aus Fehlern in Retros.

In Gruppen: Du hältst die Konversation fokussiert und zeitboxed. Du erkennst wenn das Team im Kreis dreht und bringst es zurück auf den Punkt. Du sorgst dass alle zu Wort kommen.`,
  },
];

function ensureSystemPM(agentList, groupList) {
  // Ensure PM is in agents list
  const hasPM = agentList.some(a => a.id === SYSTEM_PM_AGENT.id);
  const agents = hasPM ? agentList : [SYSTEM_PM_AGENT, ...agentList];
  // Ensure PM is in every group and normalize obsolete/invalid memory providers.
  const groups = groupList.map(g => {
    const usesJsonFile = g.memory?.provider === 'file' && !!g.memory?.filePath?.trim();
    return {
      ...g,
      memory: {
        enabled: g.memory?.enabled ?? true,
        provider: usesJsonFile ? 'file' : 'local',
        namespace: g.memory?.namespace || (g.name || g.id || 'shared').toLowerCase().trim().replace(/[^a-z0-9äöüß_-]+/gi, '-').replace(/^-+|-+$/g, ''),
        ...(usesJsonFile ? { filePath: g.memory.filePath.trim() } : {}),
      },
      mcpServers: Array.isArray(g.mcpServers) ? g.mcpServers : [],
      reviewEnvironment: normalizeReviewEnvironment(g.reviewEnvironment),
      agentIds: (g.agentIds || []).includes(SYSTEM_PM_AGENT.id)
        ? g.agentIds
        : [SYSTEM_PM_AGENT.id, ...(g.agentIds || [])],
    };
  });
  return { agents, groups };
}

const DEMO_GROUPS = [
  {
    id: 'group-dev-team', name: 'Dev Team', emoji: '🚀', type: 'group',
    agentIds: ['agent-system-pm', 'agent-coder', 'agent-tester', 'agent-designer', 'agent-pm', 'agent-architect', 'agent-devops', 'agent-scrum'],
  },
  {
    id: 'group-tech-core', name: 'Tech Core', emoji: '💡', type: 'group',
    agentIds: ['agent-coder', 'agent-architect', 'agent-devops'],
  },
  {
    id: 'group-product', name: 'Product & Design', emoji: '🎯', type: 'group',
    agentIds: ['agent-pm', 'agent-designer', 'agent-scrum'],
  },
  {
    id: 'group-qa-review', name: 'QA & Review', emoji: '✅', type: 'group',
    agentIds: ['agent-tester', 'agent-coder', 'agent-architect'],
  },
];

export function StoreProvider({ children }) {
  const [agents, setAgents] = useState([]);
  const [groups, setGroups] = useState([]);
  const [messages, setMessages] = useState({});
  const [conversationStates, setConversationStates] = useState({});
  const [userRequestQueues, setUserRequestQueues] = useState({});
  const [taskGraphs, setTaskGraphs] = useState({});
  const [groupMemory, setGroupMemoryState] = useState({}); // { chatId: MemoryEntry[] }
  // Provider secrets remain in Electron's main process. The renderer receives
  // configuration status only, never reusable API keys.
  const [apiKeys, setApiKeysState] = useState({
    openai: '', anthropic: '', openaiConfigured: false, anthropicConfigured: false, providerConfigured: {},
  });
  const [providerConnections, setProviderConnectionsState] = useState([]);
  const [kbPath, setKbPathState] = useState('');
  const [projectPath, setProjectPathState] = useState('');
  const [mcpServers, setMcpServersState] = useState([]);
  const [mcpPermissions, setMcpPermissionsState] = useState({});
  const [agentRoles, setAgentRolesState] = useState([]);
  const [conversationLimits, setConversationLimitsState] = useState({ ...DEFAULT_CONVERSATION_LIMITS });
  const [qualityRouting, setQualityRoutingState] = useState({ ...DEFAULT_QUALITY_ROUTING });
  const [qualityStats, setQualityStatsState] = useState({ ...DEFAULT_QUALITY_STATS });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    async function load() {
      if (window.electronAPI) {
        const storedAgents = await window.electronAPI.appStateGet('agents');
        const storedGroups = await window.electronAPI.appStateGet('groups');
        const storedMessages = await window.electronAPI.appStateGet('messages');
        const credentialStatus = await window.electronAPI.providerCredentialsStatus();
        const storedProviderConnections = await window.electronAPI.appStateGet('providerConnections') || [];
        const storedAgentRoles = await window.electronAPI.appStateGet('agentRoles');
        const storedMcpServers = await window.electronAPI.appStateGet('mcpServers') || [];
        const storedMcpPresetVersion = await window.electronAPI.appStateGet('mcpPresetVersion') || 0;
        const mcpPresetState = applyOfficialMcpPresets(storedMcpServers, storedMcpPresetVersion);
        const rawAgents = storedAgents || DEMO_AGENTS;
        const rawGroups = storedGroups || DEMO_GROUPS;
        const { agents: fixedAgents, groups: fixedGroups } = ensureSystemPM(rawAgents, rawGroups);
        const normalizedRoles = normalizeAgentRoleState(storedAgentRoles, fixedAgents);
        setAgents(normalizedRoles.agents);
        setAgentRolesState(normalizedRoles.roles);
        setGroups(fixedGroups);
        // Persist if changed
        if (!storedAgents || !storedGroups ||
            JSON.stringify(rawAgents) !== JSON.stringify(normalizedRoles.agents) ||
            JSON.stringify(rawGroups) !== JSON.stringify(fixedGroups)) {
          await window.electronAPI.appStateSet('agents', normalizedRoles.agents);
          await window.electronAPI.appStateSet('groups', fixedGroups);
        }
        if (JSON.stringify(storedAgentRoles || null) !== JSON.stringify(normalizedRoles.roles)) {
          await window.electronAPI.appStateSet('agentRoles', normalizedRoles.roles);
        }
        setMessages(storedMessages || {});
        setConversationStates(await window.electronAPI.appStateGet('conversationStates') || {});
        setUserRequestQueues(normalizeUserRequestQueues(
          await window.electronAPI.appStateGet('userRequestQueues') || {},
        ));
        setTaskGraphs(await window.electronAPI.appStateGet('taskGraphs') || {});
        setGroupMemoryState(await window.electronAPI.appStateGet('groupMemory') || {});
        setApiKeysState({ openai: '', anthropic: '', ...(credentialStatus || {}) });
        const normalizedProviders = normalizeProviderConnections(storedProviderConnections);
        setProviderConnectionsState(normalizedProviders);
        if (JSON.stringify(storedProviderConnections) !== JSON.stringify(normalizedProviders)) {
          await window.electronAPI.appStateSet('providerConnections', normalizedProviders);
        }
        setKbPathState(await window.electronAPI.appStateGet('kbPath') || '');
        setProjectPathState(await window.electronAPI.appStateGet('projectPath') || '');
        setMcpServersState(mcpPresetState.servers);
        setMcpPermissionsState(await window.electronAPI.appStateGet('mcpPermissions') || {});
        if (mcpPresetState.changed) await window.electronAPI.appStateSet('mcpServers', mcpPresetState.servers);
        if (storedMcpPresetVersion !== mcpPresetState.presetVersion) {
          await window.electronAPI.appStateSet('mcpPresetVersion', mcpPresetState.presetVersion);
        }
        setConversationLimitsState(normalizeConversationLimits(
          await window.electronAPI.appStateGet('conversationLimits') || {},
        ));
        setQualityRoutingState({
          ...DEFAULT_QUALITY_ROUTING,
          ...(await window.electronAPI.appStateGet('qualityRouting') || {}),
        });
        setQualityStatsState({
          ...DEFAULT_QUALITY_STATS,
          ...(await window.electronAPI.appStateGet('qualityStats') || {}),
        });
      } else {
        const storedAgents = JSON.parse(localStorage.getItem('agents') || 'null');
        const storedGroups = JSON.parse(localStorage.getItem('groups') || 'null');
        const { agents: fixedAgents, groups: fixedGroups } = ensureSystemPM(
          storedAgents || DEMO_AGENTS,
          storedGroups || DEMO_GROUPS,
        );
        const storedAgentRoles = JSON.parse(localStorage.getItem('agentRoles') || 'null');
        const normalizedRoles = normalizeAgentRoleState(storedAgentRoles, fixedAgents);
        setAgents(normalizedRoles.agents);
        setAgentRolesState(normalizedRoles.roles);
        setGroups(fixedGroups);
        localStorage.setItem('agents', JSON.stringify(normalizedRoles.agents));
        localStorage.setItem('agentRoles', JSON.stringify(normalizedRoles.roles));
        localStorage.setItem('groups', JSON.stringify(fixedGroups));
        setMessages(JSON.parse(localStorage.getItem('messages') || '{}'));
        setConversationStates(JSON.parse(localStorage.getItem('conversationStates') || '{}'));
        setUserRequestQueues(normalizeUserRequestQueues(
          JSON.parse(localStorage.getItem('userRequestQueues') || '{}'),
        ));
        setTaskGraphs(JSON.parse(localStorage.getItem('taskGraphs') || '{}'));
        setApiKeysState({ openai: '', anthropic: '', openaiConfigured: false, anthropicConfigured: false, providerConfigured: {}, providerSecrets: {} });
        const storedProviderConnections = JSON.parse(localStorage.getItem('providerConnections') || '[]');
        const normalizedProviders = normalizeProviderConnections(storedProviderConnections);
        setProviderConnectionsState(normalizedProviders);
        localStorage.setItem('providerConnections', JSON.stringify(normalizedProviders));
        setKbPathState(localStorage.getItem('kbPath') || '');
        setProjectPathState(localStorage.getItem('projectPath') || '');
        const storedMcpServers = JSON.parse(localStorage.getItem('mcpServers') || '[]');
        const storedMcpPresetVersion = Number(localStorage.getItem('mcpPresetVersion') || 0);
        const mcpPresetState = applyOfficialMcpPresets(storedMcpServers, storedMcpPresetVersion);
        setMcpServersState(mcpPresetState.servers);
        setMcpPermissionsState(JSON.parse(localStorage.getItem('mcpPermissions') || '{}'));
        if (mcpPresetState.changed) localStorage.setItem('mcpServers', JSON.stringify(mcpPresetState.servers));
        localStorage.setItem('mcpPresetVersion', String(mcpPresetState.presetVersion));
        setConversationLimitsState(normalizeConversationLimits(
          JSON.parse(localStorage.getItem('conversationLimits') || '{}'),
        ));
        setQualityRoutingState({
          ...DEFAULT_QUALITY_ROUTING,
          ...JSON.parse(localStorage.getItem('qualityRouting') || '{}'),
        });
        setQualityStatsState({
          ...DEFAULT_QUALITY_STATS,
          ...JSON.parse(localStorage.getItem('qualityStats') || '{}'),
        });
      }
      setLoaded(true);
    }
    load();
  }, []);

  const persist = useCallback(async (key, value) => {
    try {
      if (window.electronAPI) {
        return await window.electronAPI.appStateSet(key, value);
      }
      localStorage.setItem(key, JSON.stringify(value));
      return { ok: true, value };
    } catch (error) {
      console.error(`App-State „${key}“ konnte nicht gespeichert werden:`, error.message);
      return { error: error.message };
    }
  }, []);

  const saveAgents = useCallback((a) => { setAgents(a); persist('agents', a); }, [persist]);
  const saveGroups = useCallback((g) => {
    setGroups(g);
    persist('groups', g).then(result => {
      if (Array.isArray(result?.value)) setGroups(result.value);
    });
  }, [persist]);
  const setApiKeys = useCallback(async (updates) => {
    if (window.electronAPI?.providerCredentialsUpdate) {
      const status = await window.electronAPI.providerCredentialsUpdate(updates);
      setApiKeysState({ openai: '', anthropic: '', ...(status || {}) });
      return status;
    }
    // Browser-only development deliberately keeps credentials in memory.
    setApiKeysState(current => ({
      ...current,
      ...updates,
      openaiConfigured: Boolean(updates.openai || current.openai),
      anthropicConfigured: Boolean(updates.anthropic || current.anthropic),
      providerConfigured: {
        ...(current.providerConfigured || {}),
        ...Object.fromEntries(Object.entries(updates.providers || {}).map(([id, value]) => [id, Boolean(value)])),
      },
      providerSecrets: { ...(current.providerSecrets || {}), ...(updates.providers || {}) },
    }));
    return null;
  }, []);

  const setProviderConnections = useCallback(async (connections) => {
    const normalized = normalizeProviderConnections(connections);
    setProviderConnectionsState(normalized);
    const result = await persist('providerConnections', normalized);
    if (result?.error) throw new Error(result.error);
    if (Array.isArray(result?.value)) setProviderConnectionsState(normalizeProviderConnections(result.value));
    return result;
  }, [persist]);

  const setKbPath = useCallback((p) => { setKbPathState(p); persist('kbPath', p); }, [persist]);
  const setProjectPath = useCallback((p) => { setProjectPathState(p); persist('projectPath', p); }, [persist]);
  const setMcpServers = useCallback((servers) => {
    setMcpServersState(servers);
    persist('mcpServers', servers).then(result => {
      if (Array.isArray(result?.value)) setMcpServersState(result.value);
    });
  }, [persist]);
  const grantMcpPermission = useCallback((chatId, grantKey, grant) => {
    setMcpPermissionsState(previous => {
      const updated = {
        ...previous,
        [chatId]: { ...(previous[chatId] || {}), [grantKey]: grant },
      };
      persist('mcpPermissions', updated);
      return updated;
    });
  }, [persist]);
  const consumeMcpPermission = useCallback((chatId, grantKey) => {
    setMcpPermissionsState(previous => {
      const currentGrant = previous[chatId]?.[grantKey];
      if (!currentGrant || currentGrant.scope === 'chat') return previous;
      const chatPermissions = { ...(previous[chatId] || {}) };
      delete chatPermissions[grantKey];
      const updated = { ...previous, [chatId]: chatPermissions };
      persist('mcpPermissions', updated);
      return updated;
    });
  }, [persist]);
  const clearMcpPermissions = useCallback((chatId) => {
    setMcpPermissionsState(previous => {
      if (!previous[chatId]) return previous;
      const updated = { ...previous };
      delete updated[chatId];
      persist('mcpPermissions', updated);
      return updated;
    });
  }, [persist]);
  const setAgentRoles = useCallback((roles) => {
    const normalized = normalizeAgentRoleState(roles, agents);
    setAgentRolesState(normalized.roles);
    setAgents(normalized.agents);
    persist('agentRoles', normalized.roles);
    persist('agents', normalized.agents);
  }, [agents, persist]);
  const setConversationLimits = useCallback((limits) => {
    const normalized = normalizeConversationLimits(limits);
    setConversationLimitsState(normalized);
    persist('conversationLimits', normalized);
  }, [persist]);
  const setQualityRouting = useCallback((config) => {
    const requestedMax = config?.maxEscalations ?? DEFAULT_QUALITY_ROUTING.maxEscalations;
    const normalized = { ...DEFAULT_QUALITY_ROUTING, ...config, maxEscalations: Math.min(1, Math.max(0, Number(requestedMax) || 0)) };
    setQualityRoutingState(normalized);
    persist('qualityRouting', normalized);
  }, [persist]);
  const recordQualityEvent = useCallback((event) => {
    setQualityStatsState(current => {
      const updated = updateQualityStats(current, event);
      persist('qualityStats', updated);
      return updated;
    });
  }, [persist]);
  const clearQualityStats = useCallback(() => {
    const empty = { ...DEFAULT_QUALITY_STATS };
    setQualityStatsState(empty);
    persist('qualityStats', empty);
  }, [persist]);

  const addMessage = useCallback((chatId, msg) => {
    setMessages(prev => {
      const updated = { ...prev, [chatId]: [...(prev[chatId] || []), msg] };
      persist('messages', updated);
      return updated;
    });
  }, [persist]);

  const appendGroupMemory = useCallback((chatId, entries) => {
    if (!entries || entries.length === 0) return;
    setGroupMemoryState(prev => {
      const updated = { ...prev, [chatId]: [...(prev[chatId] || []), ...entries] };
      persist('groupMemory', updated);
      return updated;
    });
  }, [persist]);

  const clearGroupMemory = useCallback((chatId) => {
    setGroupMemoryState(prev => {
      const updated = { ...prev, [chatId]: [] };
      persist('groupMemory', updated);
      return updated;
    });
  }, [persist]);

  const addAgent = useCallback((agent) => {
    const newAgents = [...agents, { ...agent, id: uuidv4() }];
    saveAgents(newAgents);
  }, [agents, saveAgents]);

  const updateAgent = useCallback((id, updates) => {
    saveAgents(agents.map(a => a.id === id ? { ...a, ...updates } : a));
  }, [agents, saveAgents]);

  const deleteAgent = useCallback((id) => {
    saveAgents(agents.filter(a => a.id !== id));
    saveGroups(groups.map(g => ({ ...g, agentIds: g.agentIds.filter(aid => aid !== id) })));
  }, [agents, groups, saveAgents, saveGroups]);

  const addGroup = useCallback((group) => {
    const agentIds = group.agentIds?.includes(SYSTEM_PM_AGENT.id)
      ? group.agentIds
      : [SYSTEM_PM_AGENT.id, ...(group.agentIds || [])];
    saveGroups([...groups, { ...group, agentIds, id: uuidv4(), type: 'group' }]);
  }, [groups, saveGroups]);

  const updateGroup = useCallback((id, updates) => {
    saveGroups(groups.map(g => {
      if (g.id !== id) return g;
      const updated = { ...g, ...updates };
      updated.agentIds = updated.agentIds?.includes(SYSTEM_PM_AGENT.id)
        ? updated.agentIds
        : [SYSTEM_PM_AGENT.id, ...(updated.agentIds || [])];
      return updated;
    }));
  }, [groups, saveGroups]);

  const deleteGroup = useCallback((id) => {
    saveGroups(groups.filter(g => g.id !== id));
    const withoutChat = previous => {
      if (!previous[id]) return previous;
      const updated = { ...previous };
      delete updated[id];
      return updated;
    };
    setMessages(previous => {
      const updated = withoutChat(previous);
      persist('messages', updated);
      return updated;
    });
    setConversationStates(previous => {
      const updated = withoutChat(previous);
      persist('conversationStates', updated);
      return updated;
    });
    setUserRequestQueues(previous => {
      const updated = clearUserRequests(previous, id);
      persist('userRequestQueues', updated);
      return updated;
    });
    setTaskGraphs(previous => {
      const updated = withoutChat(previous);
      persist('taskGraphs', updated);
      return updated;
    });
    setGroupMemoryState(previous => {
      const updated = withoutChat(previous);
      persist('groupMemory', updated);
      return updated;
    });
    setMcpPermissionsState(previous => {
      const updated = withoutChat(previous);
      persist('mcpPermissions', updated);
      return updated;
    });
    window.electronAPI?.deleteConversationData?.(id).catch(error => {
      console.error('Gruppendaten konnten nicht vollständig gelöscht werden:', error.message);
    });
  }, [groups, persist, saveGroups]);

  const clearMessages = useCallback((chatId) => {
    setMessages(prev => {
      const updated = { ...prev, [chatId]: [] };
      persist('messages', updated);
      return updated;
    });
  }, [persist]);

  const saveConversationState = useCallback((chatId, state) => {
    setConversationStates(prev => {
      const updated = { ...prev, [chatId]: state };
      persist('conversationStates', updated);
      return updated;
    });
  }, [persist]);

  const clearConversationState = useCallback((chatId) => {
    setConversationStates(prev => {
      if (!prev[chatId]) return prev;
      const updated = { ...prev };
      delete updated[chatId];
      persist('conversationStates', updated);
      return updated;
    });
  }, [persist]);

  const enqueueUserRequest = useCallback((chatId, request) => {
    setUserRequestQueues(previous => {
      const updated = appendUserRequest(previous, chatId, request);
      persist('userRequestQueues', updated);
      return updated;
    });
  }, [persist]);

  const removeUserRequest = useCallback((chatId, requestId) => {
    setUserRequestQueues(previous => {
      const updated = dropUserRequest(previous, chatId, requestId);
      persist('userRequestQueues', updated);
      return updated;
    });
  }, [persist]);

  const clearUserRequestQueue = useCallback((chatId) => {
    setUserRequestQueues(previous => {
      const updated = clearUserRequests(previous, chatId);
      persist('userRequestQueues', updated);
      return updated;
    });
  }, [persist]);

  const saveTaskGraph = useCallback((chatId, graph) => {
    setTaskGraphs(prev => {
      const updated = { ...prev, [chatId]: graph };
      persist('taskGraphs', updated);
      return updated;
    });
  }, [persist]);

  const clearTaskGraph = useCallback((chatId) => {
    setTaskGraphs(prev => {
      if (!prev[chatId]) return prev;
      const updated = { ...prev };
      delete updated[chatId];
      persist('taskGraphs', updated);
      return updated;
    });
  }, [persist]);

  if (!loaded) return null;

  return (
    <StoreContext.Provider value={{
      agents, groups, messages, conversationStates, userRequestQueues, taskGraphs, apiKeys, providerConnections, kbPath, projectPath, groupMemory, mcpServers, mcpPermissions, agentRoles,
      qualityRouting, qualityStats, conversationLimits,
      addMessage, addAgent, updateAgent, deleteAgent,
      addGroup, updateGroup, deleteGroup, clearMessages,
      saveConversationState, clearConversationState,
      enqueueUserRequest, removeUserRequest, clearUserRequestQueue,
      saveTaskGraph, clearTaskGraph,
      setApiKeys, setProviderConnections, setKbPath, setProjectPath, setMcpServers, grantMcpPermission, consumeMcpPermission, clearMcpPermissions, setAgentRoles, setConversationLimits, setQualityRouting,
      recordQualityEvent, clearQualityStats,
      appendGroupMemory, clearGroupMemory,
    }}>
      {children}
    </StoreContext.Provider>
  );
}

export function useStore() {
  return useContext(StoreContext);
}

export { uuidv4 };
