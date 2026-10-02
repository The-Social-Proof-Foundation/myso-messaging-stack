import {useQuery} from '@tanstack/react-query';

import {fetchProfileOverview} from '../../lib/agents/profile-graphql';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {agentKeys} from './query-keys';

/** Signed-in profile: AI credits and organizations with statistics. */
export function useProfileOverview() {
  const address = useAuthenticatedAddress();
  return useQuery({
    queryKey: agentKeys.profileOverview(address ?? ''),
    queryFn: ({signal}) => fetchProfileOverview(address!, signal),
    enabled: Boolean(address),
    staleTime: 15_000,
  });
}
