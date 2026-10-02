import type {SubAgentRow} from './social-api';

export interface AgentTreeNode {
  agent: SubAgentRow;
  children: AgentTreeNode[];
}

/** Builds a forest from `parent_object_id`. Roots have no parent, or a parent not in the list. */
export function buildAgentTree(agents: SubAgentRow[]): AgentTreeNode[] {
  const byId = new Map(agents.map((agent) => [agent.agent_object_id, agent]));
  const children = new Map<string, SubAgentRow[]>();
  const roots: SubAgentRow[] = [];

  for (const agent of agents) {
    const parent = agent.parent_object_id;
    if (parent && byId.has(parent)) {
      const siblings = children.get(parent) ?? [];
      siblings.push(agent);
      children.set(parent, siblings);
    } else {
      roots.push(agent);
    }
  }

  const toNode = (agent: SubAgentRow): AgentTreeNode => ({
    agent,
    children: (children.get(agent.agent_object_id) ?? []).map(toNode),
  });

  return roots.map(toNode);
}

export function flattenAgentTree(nodes: AgentTreeNode[]): SubAgentRow[] {
  const out: SubAgentRow[] = [];
  const walk = (list: AgentTreeNode[]) => {
    for (const node of list) {
      out.push(node.agent);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export interface AgentOrganizationGroup {
  organizationId: string | null;
  agents: AgentTreeNode[];
}

/**
 * Buckets an agent forest by organization.
 *
 * Agents whose `organization_id` is null, or points at an organization the caller cannot
 * see (an inactive/other-owner org), land in the trailing `organizationId: null` bucket
 * rather than disappearing.
 */
export function groupAgentsByOrganization(
  organizations: {organization_id: string}[],
  agents: SubAgentRow[],
): AgentOrganizationGroup[] {
  const known = new Set(organizations.map((org) => org.organization_id.toLowerCase()));
  const byOrg = new Map<string, SubAgentRow[]>();
  const ungrouped: SubAgentRow[] = [];

  for (const agent of agents) {
    const orgId = agent.organization_id;
    if (!orgId || !known.has(orgId.toLowerCase())) {
      ungrouped.push(agent);
      continue;
    }
    const list = byOrg.get(orgId) ?? [];
    list.push(agent);
    byOrg.set(orgId, list);
  }

  const groups: AgentOrganizationGroup[] = organizations.map((org) => ({
    organizationId: org.organization_id,
    agents: buildAgentTree(byOrg.get(org.organization_id) ?? []),
  }));

  if (ungrouped.length > 0) {
    groups.push({organizationId: null, agents: buildAgentTree(ungrouped)});
  }

  return groups;
}
