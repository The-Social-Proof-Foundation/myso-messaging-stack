import type {AgentTreeNode} from './agent-tree';
import {
  CAPABILITY_LABELS,
  CAPABILITY_PRESETS,
  capabilityNames,
  presetForMask,
} from './capabilities';
import {truncateAddress} from './format';
import type {SubAgentRow} from './social-api';

export type AgentChartStatus = 'active' | 'inactive' | 'revoked';

export const AGENT_CHART_STATUS_LABEL: Record<AgentChartStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  revoked: 'Revoked',
};

export interface AgentChartNode {
  id: string;
  name: string;
  role: string;
  address: string;
  fullAddress: string;
  initials: string;
  status: AgentChartStatus;
  reportsCount: number;
  teamHeadcount: number;
  capabilities: string[];
  parentId?: string;
  parentName?: string;
  parentRole?: string;
  /** 0 is the organization root. Each child is one deeper. */
  depth: number;
  children?: AgentChartNode[];
}

export function agentChartStatus(
  agent: Pick<SubAgentRow, 'active' | 'revoked_at_ms'>,
): AgentChartStatus {
  if (agent.revoked_at_ms) return 'revoked';
  if (!agent.active) return 'inactive';
  return 'active';
}

export function agentRoleLabel(capabilities: number): string {
  const preset = presetForMask(capabilities);
  return CAPABILITY_PRESETS.find((item) => item.id === preset)?.label ?? 'Custom';
}

export function agentInitials(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const second = parts[1] ?? '';
  return `${first.charAt(0)}${second.charAt(0)}`.toUpperCase();
}

function descendantCount(node: AgentTreeNode): number {
  return node.children.reduce((total, child) => total + 1 + descendantCount(child), 0);
}

function toChartNode(
  node: AgentTreeNode,
  parent?: {id: string; name: string; role: string},
  depth = 0,
): AgentChartNode {
  const agent = node.agent;
  const chart: AgentChartNode = {
    id: agent.agent_object_id,
    name: agent.label.trim() || 'Untitled agent',
    role: agentRoleLabel(agent.capabilities),
    address: truncateAddress(agent.derived_address, 8, 8),
    fullAddress: agent.derived_address,
    initials: agentInitials(agent.label),
    status: agentChartStatus(agent),
    reportsCount: node.children.length,
    teamHeadcount: descendantCount(node),
    capabilities: capabilityNames(agent.capabilities).map((name) => CAPABILITY_LABELS[name]),
    parentId: parent?.id,
    parentName: parent?.name,
    parentRole: parent?.role,
    depth,
  };

  if (node.children.length > 0) {
    chart.children = node.children.map((child) =>
      toChartNode(child, {id: chart.id, name: chart.name, role: chart.role}, depth + 1),
    );
  }

  return chart;
}

/** Maps an agent forest (`buildAgentTree`) into chart nodes. Multiple roots stay siblings. */
export function agentForestToChart(nodes: AgentTreeNode[]): AgentChartNode[] {
  return nodes.map((node) => toChartNode(node));
}

export function flattenAgentChart(nodes: AgentChartNode[]): AgentChartNode[] {
  const out: AgentChartNode[] = [];
  const walk = (list: AgentChartNode[]) => {
    for (const node of list) {
      out.push(node);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(nodes);
  return out;
}
