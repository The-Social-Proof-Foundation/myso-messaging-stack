import {useQuery} from '@tanstack/react-query';

import {
  ORGANIZATION_CATEGORIES,
  type OrganizationCategory,
} from '../../lib/agents/org-types';
import {useGraphQLClient} from '../../contexts/MessagingClientContext';
import {agentKeys} from './query-keys';

const QUERY = `
  query OrganizationCategories {
    organizationCategories {
      value
      slug
      displayName
    }
  }
`;

export function useOrganizationCategories() {
  const graphql = useGraphQLClient();
  return useQuery({
    queryKey: agentKeys.organizationCategories(),
    queryFn: async (): Promise<OrganizationCategory[]> => {
      try {
        const result = await graphql.query({
          query: QUERY as unknown as Parameters<typeof graphql.query>[0]['query'],
          variables: {},
        });
        const rows = (result.data as {organizationCategories?: OrganizationCategory[]} | undefined)
          ?.organizationCategories;
        if (rows?.length) return rows;
      } catch {
        // fall through to the on-chain enum list
      }
      return [...ORGANIZATION_CATEGORIES];
    },
    staleTime: 60 * 60_000,
  });
}
