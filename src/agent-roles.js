export const DEFAULT_AGENT_ROLES = [
  { id: 'role-project-lead', name: 'Projektleiter' },
  { id: 'role-senior-developer', name: 'Senior Developer' },
  { id: 'role-qa-engineer', name: 'QA Engineer' },
  { id: 'role-ux-ui-designer', name: 'UX/UI Designer' },
  { id: 'role-product-manager', name: 'Product Manager' },
  { id: 'role-software-architect', name: 'Software Architect' },
  { id: 'role-devops-engineer', name: 'DevOps Engineer' },
  { id: 'role-scrum-master', name: 'Scrum Master' },
];

export function normalizeRoleName(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function comparableRoleName(value) {
  return normalizeRoleName(value).toLocaleLowerCase();
}

function roleIdFromName(name, usedIds) {
  const base = normalizeRoleName(name)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'agent';
  let id = `role-${base}`;
  let suffix = 2;
  while (usedIds.has(id)) {
    id = `role-${base}-${suffix}`;
    suffix += 1;
  }
  return id;
}

export function normalizeAgentRoleState(storedRoles, agentList = []) {
  const sourceRoles = Array.isArray(storedRoles) ? storedRoles : DEFAULT_AGENT_ROLES;
  const roles = [];
  const usedIds = new Set();
  const roleByName = new Map();

  const addRole = (candidate) => {
    const name = normalizeRoleName(typeof candidate === 'string' ? candidate : candidate?.name);
    if (!name) return null;
    const comparableName = comparableRoleName(name);
    const existing = roleByName.get(comparableName);
    if (existing) return existing;

    const requestedId = normalizeRoleName(typeof candidate === 'object' ? candidate?.id : '');
    const id = requestedId && !usedIds.has(requestedId)
      ? requestedId
      : roleIdFromName(name, usedIds);
    const role = { id, name };
    roles.push(role);
    usedIds.add(id);
    roleByName.set(comparableName, role);
    return role;
  };

  sourceRoles.forEach(addRole);

  const agents = (agentList || []).map(agent => {
    const byId = roles.find(role => role.id === agent?.roleId);
    const byName = roleByName.get(comparableRoleName(agent?.role));
    const role = byId || byName || addRole(agent?.role || 'Agent');
    return { ...agent, roleId: role.id, role: role.name };
  });

  if (!roles.length) addRole('Agent');
  return { roles, agents };
}

export function isRoleUsed(role, agents = []) {
  const comparableName = comparableRoleName(role?.name);
  return agents.some(agent => (
    agent?.roleId === role?.id || comparableRoleName(agent?.role) === comparableName
  ));
}
