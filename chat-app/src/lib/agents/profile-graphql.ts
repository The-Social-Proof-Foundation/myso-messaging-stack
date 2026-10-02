/**
 * Trimmed profile read for the home organizations view.
 *
 * Uses the same GraphQL endpoint as platform discovery. Badges, follows, bio, and
 * mydata are intentionally not requested.
 */

const GRAPHQL_URL = import.meta.env.VITE_MYSO_GRAPHQL_URL || '/api/graphql';

const PROFILE_OVERVIEW_QUERY = `
  query ProfileOverview($address: MySoAddress!) {
    profile(address: $address) {
      aiCreditBalance {
        credits
        balanceMist
        spentTotalMist
        active
      }
      agenticOrganizations {
        organizationId
        name
        description
        orgType
        active
        createdAt
        statistics {
          totalAgents
          activeAgents
          totalRevenueMyso
          totalOutboundSpendMyso
          netCashFlowMyso
          totalActionsExecuted
          totalEngagement
          memoryEntries
          memoryBytes
          aiCreditUsageEvents
          aiCreditSpentMist
        }
      }
    }
  }
`;

export interface ProfileAiCreditBalance {
  credits: number | null;
  balanceMist: string | number | null;
  spentTotalMist: string | number | null;
  active: boolean | null;
}

export interface ProfileOrganizationStatistics {
  totalAgents: string | number | null;
  activeAgents: string | number | null;
  totalRevenueMyso: string | number | null;
  totalOutboundSpendMyso: string | number | null;
  netCashFlowMyso: string | number | null;
  totalActionsExecuted: string | number | null;
  totalEngagement: string | number | null;
  memoryEntries: string | number | null;
  memoryBytes: string | number | null;
  aiCreditUsageEvents: string | number | null;
  aiCreditSpentMist: string | number | null;
}

export interface ProfileOrganization {
  organizationId: string;
  name: string | null;
  description: string | null;
  orgType: string | null;
  active: boolean;
  createdAt: string | number | null;
  statistics: ProfileOrganizationStatistics | null;
}

export interface ProfileOverview {
  aiCreditBalance: ProfileAiCreditBalance | null;
  organizations: ProfileOrganization[];
}

export function graphqlNumber(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** `1 agent` / `12 agents`, and `12 agents · 3 active` when some are inactive. */
export function agentCountLabel(
  total: string | number | null | undefined,
  active: string | number | null | undefined,
): string {
  const totalCount = graphqlNumber(total) ?? 0;
  const activeCount = graphqlNumber(active);
  const noun = totalCount === 1 ? 'agent' : 'agents';
  const base = `${totalCount} ${noun}`;
  if (activeCount == null || activeCount === totalCount) return base;
  return `${base} · ${activeCount} active`;
}

/** Numeric MySo amount from a GraphQL statistic, without the unit. */
export function formatMysoAmount(value: string | number | null | undefined): string {
  const amount = graphqlNumber(value);
  if (amount == null) return '—';
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(4).replace(/\.?0+$/, '');
}

export function formatMysoUnits(value: string | number | null | undefined): string {
  const amount = formatMysoAmount(value);
  return amount === '—' ? amount : `${amount} MySo`;
}

export function formatCount(value: string | number | null | undefined): string {
  const amount = graphqlNumber(value);
  if (amount == null) return '—';
  return Number.isInteger(amount) ? String(amount) : String(Math.trunc(amount));
}

export function formatByteSize(value: string | number | null | undefined): string {
  const bytes = graphqlNumber(value);
  if (bytes == null) return '—';
  if (bytes < 1024) return `${Math.trunc(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function graphqlQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({query, variables}),
    signal,
  });
  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as {
    data?: T;
    errors?: {message: string}[];
  };
  if (payload.errors?.length) {
    throw new Error(`GraphQL error: ${payload.errors.map((error) => error.message).join('; ')}`);
  }
  if (!payload.data) throw new Error('GraphQL returned no data.');
  return payload.data;
}

interface ProfileOverviewResponse {
  profile: {
    aiCreditBalance: ProfileAiCreditBalance | null;
    agenticOrganizations: ProfileOrganization[] | null;
  } | null;
}

export async function fetchProfileOverview(
  address: string,
  signal?: AbortSignal,
): Promise<ProfileOverview> {
  const data = await graphqlQuery<ProfileOverviewResponse>(
    PROFILE_OVERVIEW_QUERY,
    {address},
    signal,
  );
  return {
    aiCreditBalance: data.profile?.aiCreditBalance ?? null,
    organizations: data.profile?.agenticOrganizations ?? [],
  };
}
