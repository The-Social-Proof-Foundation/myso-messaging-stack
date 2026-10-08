import {useMemo} from 'react';

import {normalizeMetadataHex} from '../../lib/agents/agent-chats';
import {useOrganizations} from './useOrganizations';
import {useAllSubAgents} from './useSubAgents';

/** Whether `address` is one of the caller's agents, and the name of its organization if any. */
export function useAgentOrganizationLabel(address: string | null | undefined): {
  isAgent: boolean;
  organizationName: string | null;
} {
  const agents = useAllSubAgents();
  const {organizations} = useOrganizations();
  return useMemo(() => {
    const key = address ? normalizeMetadataHex(address) : null;
    if (!key) return {isAgent: false, organizationName: null};
    const agent = agents.items.find(
      (row) => normalizeMetadataHex(row.derived_address) === key,
    );
    if (!agent) return {isAgent: false, organizationName: null};
    const orgId = agent.organization_id?.toLowerCase();
    const org = orgId
      ? organizations.find((row) => row.organization_id.toLowerCase() === orgId)
      : null;
    return {isAgent: true, organizationName: org?.name?.trim() || null};
  }, [address, agents.items, organizations]);
}
