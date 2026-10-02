import {useQuery} from '@tanstack/react-query';
import type {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';

import {findAgentKeypair} from '../../lib/agents/agent-keys';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {useMySocialAuth} from '../../contexts/MySocialAuthContext';

export function useDerivedAgentKey(
  agent: SubAgentRow | null,
  maxIndex: number,
) {
  const {keypair} = useMySocialAuth();
  return useQuery({
    queryKey: [
      'agents',
      'derived-key',
      agent?.agent_object_id ?? '',
      agent?.derived_address ?? '',
      agent?.organization_id ?? '',
      maxIndex,
    ],
    queryFn: () =>
      findAgentKeypair(
        keypair as Ed25519Keypair,
        agent!.derived_address,
        agent!.organization_id,
        Math.max(maxIndex, 32),
      ),
    enabled: Boolean(keypair && agent),
    staleTime: Infinity,
  });
}
