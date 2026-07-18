import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGraphQLClient } from '../contexts/MessagingClientContext';
import {
  PROFILE_FULL_QUERY,
  mapGraphqlProfile,
} from '../lib/wallet-profile';

function truncateAddress(address: string): string {
  if (!address) return 'Someone';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function labelFromProfile(
  address: string,
  profile: { username: string | null; display_name: string | null } | null,
): string {
  const username = profile?.username?.trim();
  if (username) return `@${username.replace(/^@/, '')}`;
  const display = profile?.display_name?.trim();
  if (display) return display;
  return truncateAddress(address);
}

type CachedProfile = {
  photo: string | null;
  label: string;
};

/** Session-wide cache so repeated group views don't re-fetch. */
const profileCache = new Map<string, CachedProfile>();

export type WalletProfileBits = {
  photoFor: (address: string) => string | null;
  labelFor: (address: string) => string;
};

/**
 * Resolves profile photos + display labels for wallet addresses via GraphQL.
 * Label preference: @username → display name → truncated address.
 */
export function useWalletAvatarMap(
  addresses: readonly string[],
): WalletProfileBits {
  const graphqlClient = useGraphQLClient();
  const [version, setVersion] = useState(0);

  const uniqueKey = useMemo(() => {
    const normalized = [
      ...new Set(
        addresses
          .map((a) => a.trim())
          .filter((a) => a.length > 0),
      ),
    ].sort();
    return normalized.join(',');
  }, [addresses]);

  useEffect(() => {
    const list = uniqueKey ? uniqueKey.split(',') : [];
    if (list.length === 0) return;

    const missing = list.filter((a) => !profileCache.has(a));
    if (missing.length === 0) {
      setVersion((v) => v + 1);
      return;
    }

    let cancelled = false;

    void (async () => {
      await Promise.all(
        missing.map(async (address) => {
          try {
            const result = await graphqlClient.query({
              query: PROFILE_FULL_QUERY as unknown as Parameters<
                typeof graphqlClient.query
              >[0]['query'],
              variables: { address },
            });
            const data = result.data as
              | { profile?: Record<string, unknown> | null }
              | undefined;
            const mapped = mapGraphqlProfile(data?.profile ?? null);
            profileCache.set(address, {
              photo: mapped?.profile_photo ?? null,
              label: labelFromProfile(address, mapped),
            });
          } catch {
            profileCache.set(address, {
              photo: null,
              label: truncateAddress(address),
            });
          }
        }),
      );
      if (!cancelled) setVersion((v) => v + 1);
    })();

    return () => {
      cancelled = true;
    };
  }, [uniqueKey, graphqlClient]);

  const photoFor = useCallback(
    (address: string) => profileCache.get(address)?.photo ?? null,
    // version bumps after cache fills so consumers re-render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const labelFor = useCallback(
    (address: string) =>
      profileCache.get(address)?.label ?? truncateAddress(address),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  return { photoFor, labelFor };
}
