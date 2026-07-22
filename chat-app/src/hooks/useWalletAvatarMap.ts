import { useCallback, useEffect, useMemo, useState } from 'react';
import { useGraphQLClient } from '../contexts/MessagingClientContext';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';
import {
  loadSidebarProfiles,
  saveSidebarProfiles,
  type StoredSidebarProfile,
} from '../lib/sidebar-chrome-store';
import {
  PROFILE_FULL_QUERY,
  mapGraphqlProfile,
  reservationPoolFillPercentFromGraphqlProfile,
  type WalletProfile,
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

/** GraphQL-only ring bits (no per-peer social-server indexer fetch). */
function ringBitsFromProfile(
  mapped: WalletProfile | null,
  rawProfile: Record<string, unknown> | null,
): { showRing: boolean; ringPercent: number } {
  if (!mapped) return { showRing: false, ringPercent: 0 };

  const reservationPoolAddr = mapped.reservation_pool_address?.trim() ?? null;
  const hasLaunchedSpt = Boolean(mapped.social_proof_token_address?.trim());
  const inReservationPhase = Boolean(reservationPoolAddr && !hasLaunchedSpt);
  const gqlPct = reservationPoolFillPercentFromGraphqlProfile(rawProfile);

  const showRing = Boolean(reservationPoolAddr && inReservationPhase) || hasLaunchedSpt;
  const ringPercent = hasLaunchedSpt ? 100 : (gqlPct ?? 0);

  return { showRing, ringPercent };
}

type CachedProfile = StoredSidebarProfile;

/** Session-wide cache so repeated group views don't re-fetch. */
const profileCache = new Map<string, CachedProfile>();
let hydratedWallet: string | null = null;

function ensureHydrated(wallet: string | null | undefined) {
  const key = wallet?.trim().toLowerCase() || null;
  if (!key || hydratedWallet === key) return;
  profileCache.clear();
  for (const [address, entry] of loadSidebarProfiles(key)) {
    profileCache.set(address, entry);
  }
  hydratedWallet = key;
}

function persistProfiles(wallet: string | null | undefined) {
  if (!wallet) return;
  saveSidebarProfiles(wallet, profileCache);
}

export type WalletRingBits = {
  showRing: boolean;
  ringPercent: number;
};

export type WalletProfileBits = {
  photoFor: (address: string) => string | null;
  labelFor: (address: string) => string;
  ringFor: (address: string) => WalletRingBits;
};

/**
 * Resolves profile photos + display labels for wallet addresses via GraphQL.
 * Label preference: @username → display name → truncated address.
 * Hydrates from localStorage so sidebar avatars paint on return visits.
 */
export function useWalletAvatarMap(
  addresses: readonly string[],
): WalletProfileBits {
  const graphqlClient = useGraphQLClient();
  const wallet = useAuthenticatedAddress();
  const [version, setVersion] = useState(0);

  const uniqueKey = useMemo(() => {
    const normalized = [
      ...new Set(
        addresses
          .map((a) => a.trim().toLowerCase())
          .filter((a) => a.length > 0),
      ),
    ].sort();
    return normalized.join(',');
  }, [addresses]);

  useEffect(() => {
    ensureHydrated(wallet);
    setVersion((v) => v + 1);
  }, [wallet]);

  useEffect(() => {
    ensureHydrated(wallet);
    const list = uniqueKey ? uniqueKey.split(',') : [];
    if (list.length === 0) return;

    const missing = list.filter((a) => {
      const cached = profileCache.get(a);
      return !cached || typeof cached.showRing !== 'boolean';
    });
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
            const raw = data?.profile ?? null;
            const mapped = mapGraphqlProfile(raw);
            const ring = ringBitsFromProfile(mapped, raw);
            profileCache.set(address, {
              photo: mapped?.profile_photo ?? null,
              label: labelFromProfile(address, mapped),
              showRing: ring.showRing,
              ringPercent: ring.ringPercent,
            });
          } catch {
            profileCache.set(address, {
              photo: null,
              label: truncateAddress(address),
              showRing: false,
              ringPercent: 0,
            });
          }
        }),
      );
      if (!cancelled) {
        persistProfiles(wallet);
        setVersion((v) => v + 1);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [uniqueKey, graphqlClient, wallet]);

  const photoFor = useCallback(
    (address: string) =>
      profileCache.get(address.trim().toLowerCase())?.photo ?? null,
    // version bumps after cache fills so consumers re-render
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const labelFor = useCallback(
    (address: string) =>
      profileCache.get(address.trim().toLowerCase())?.label ??
      truncateAddress(address),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const ringFor = useCallback(
    (address: string): WalletRingBits => {
      const cached = profileCache.get(address.trim().toLowerCase());
      return {
        showRing: cached?.showRing ?? false,
        ringPercent: cached?.ringPercent ?? 0,
      };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  return { photoFor, labelFor, ringFor };
}
