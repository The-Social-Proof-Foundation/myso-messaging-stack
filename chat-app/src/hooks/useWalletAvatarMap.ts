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
  profileHeaderTitle,
  profileSecondaryHandleLabel,
  reservationPoolFillPercentFromGraphqlProfile,
  truncateWalletAddress,
  type WalletProfile,
} from '../lib/wallet-profile';

function truncateAddress(address: string): string {
  if (!address) return 'Someone';
  return truncateWalletAddress(address);
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

function headerTitleFromCached(
  address: string,
  cached: StoredSidebarProfile | undefined,
): string {
  if (cached?.headerTitle?.trim()) return cached.headerTitle.trim();
  // Legacy cache only stored `label` (@username preferred) — use as header.
  if (cached?.label?.trim()) return cached.label.trim();
  return truncateAddress(address);
}

function handleFromCached(
  address: string,
  cached: StoredSidebarProfile | undefined,
): string | null {
  const header = headerTitleFromCached(address, cached);
  if (cached && 'handle' in cached) {
    const h = cached.handle?.trim();
    if (!h || h === header) return null;
    return h;
  }
  // Legacy: `@label` is now the header — no secondary handle.
  return null;
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
  /** Bubble / member lists: `@username` → display name → wallet. */
  labelFor: (address: string) => string;
  /** Inbox header: display name → `@username` → wallet. */
  headerTitleFor: (address: string) => string;
  /** Secondary `@username` beside a full-name header. */
  handleFor: (address: string) => string | null;
  ringFor: (address: string) => WalletRingBits;
};

/**
 * Resolves profile photos + display labels for wallet addresses via GraphQL.
 * `labelFor`: @username → display name → truncated address.
 * `headerTitleFor` / `handleFor`: inbox row (name or @handle; handle only with full name).
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
      return (
        !cached ||
        typeof cached.showRing !== 'boolean' ||
        cached.headerTitle === undefined
      );
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
              headerTitle: profileHeaderTitle(address, mapped),
              handle: profileSecondaryHandleLabel(mapped),
              showRing: ring.showRing,
              ringPercent: ring.ringPercent,
            });
          } catch {
            profileCache.set(address, {
              photo: null,
              label: truncateAddress(address),
              headerTitle: truncateAddress(address),
              handle: null,
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

  const headerTitleFor = useCallback(
    (address: string) =>
      headerTitleFromCached(
        address,
        profileCache.get(address.trim().toLowerCase()),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version],
  );

  const handleFor = useCallback(
    (address: string) =>
      handleFromCached(
        address,
        profileCache.get(address.trim().toLowerCase()),
      ),
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

  return { photoFor, labelFor, headerTitleFor, handleFor, ringFor };
}
