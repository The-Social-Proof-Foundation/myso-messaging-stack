import {useQuery} from '@tanstack/react-query';

import {useAuthenticatedAddress} from '../contexts/MySocialAuthContext';
import {useMessagingClient} from '../contexts/MessagingClientContext';

const MYSO_COIN_TYPE = '0x2::myso::MYSO';

function mistFromRaw(raw: string | number | null | undefined): bigint {
  try {
    return BigInt(raw ?? '0');
  } catch {
    return 0n;
  }
}

/** On-chain MySo coin balance for the signed-in wallet, in MIST. */
export function useMysoWalletBalance() {
  const client = useMessagingClient();
  const address = useAuthenticatedAddress();

  return useQuery({
    queryKey: ['myso-wallet-balance', address],
    enabled: Boolean(client && address),
    staleTime: 30_000,
    queryFn: async () => {
      const {balance} = await client!.core.getBalance({
        owner: address!,
        coinType: MYSO_COIN_TYPE,
      });
      return mistFromRaw(balance.balance ?? balance.addressBalance);
    },
  });
}
