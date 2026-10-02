import {useQuery} from '@tanstack/react-query';

import {fetchMemoryAccount} from '../../lib/agents/social-api';
import {useAuthenticatedAddress} from '../../contexts/MySocialAuthContext';
import {agentKeys} from './query-keys';

export function useMemoryAccount() {
  const address = useAuthenticatedAddress();
  return useQuery({
    queryKey: agentKeys.memoryAccount(address ?? ''),
    queryFn: () => fetchMemoryAccount(address!),
    enabled: Boolean(address),
  });
}
