import { useEffect, useState } from 'react';
import { useGraphQLClient } from '../contexts/MessagingClientContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import {
  PROFILE_FULL_QUERY,
  mapGraphqlProfile,
  reservationPoolFillPercentFromGraphqlProfile,
  type WalletProfile,
} from '../lib/wallet-profile';

type OwnWalletProfileState = {
  profile: WalletProfile | null;
  reservationPoolFillPercent: number | null;
  loading: boolean;
  showRing: boolean;
  ringPercent: number;
};

/**
 * GraphQL ProfileFull + reservation ring state for the signed-in wallet.
 * Mirrors mysocial-frontend useUniversalAuth + useOwnProfileReservationRing
 * (GraphQL fill % first; social-indexer pool fallback when needed).
 */
export function useOwnWalletProfile(): OwnWalletProfileState {
  const { connectedAddress, session } = useMySocialAuth();
  const graphqlClient = useGraphQLClient();
  const [profile, setProfile] = useState<WalletProfile | null>(null);
  const [rawProfile, setRawProfile] = useState<Record<string, unknown> | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [indexerPct, setIndexerPct] = useState<number | null>(null);

  useEffect(() => {
    if (!session || !connectedAddress) {
      setProfile(null);
      setRawProfile(null);
      setIndexerPct(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const result = await graphqlClient.query({
          query: PROFILE_FULL_QUERY as unknown as Parameters<
            typeof graphqlClient.query
          >[0]['query'],
          variables: { address: connectedAddress },
        });
        if (cancelled) return;
        const data = result.data as
          | { profile?: Record<string, unknown> | null }
          | undefined;
        const node = data?.profile ?? null;
        setRawProfile(node);
        setProfile(mapGraphqlProfile(node));
      } catch {
        if (!cancelled) {
          setRawProfile(null);
          setProfile(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [session, connectedAddress, graphqlClient]);

  const gqlPct = reservationPoolFillPercentFromGraphqlProfile(rawProfile);
  const reservationPoolAddr = profile?.reservation_pool_address?.trim() ?? null;
  const hasLaunchedSpt = Boolean(profile?.social_proof_token_address?.trim());
  const inReservationPhase = Boolean(reservationPoolAddr && !hasLaunchedSpt);
  const useIndexer = inReservationPhase && profile != null && gqlPct == null;

  useEffect(() => {
    if (!useIndexer || !reservationPoolAddr) {
      setIndexerPct(null);
      return;
    }

    const base = (import.meta.env.VITE_SOCIAL_SERVER_URL || '').replace(
      /\/+$/,
      '',
    );
    if (!base) {
      setIndexerPct(null);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `${base}/spt/reservation-pools/${reservationPoolAddr}`,
        );
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as {
          total_reserved?: number;
          totalReserved?: number;
          required_threshold?: number;
          requiredThreshold?: number;
          percentage?: number;
        };
        const total = Number(json.total_reserved ?? json.totalReserved ?? 0);
        const required = Number(
          json.required_threshold ?? json.requiredThreshold ?? 0,
        );
        const pct =
          typeof json.percentage === 'number'
            ? json.percentage
            : required > 0
              ? (total / required) * 100
              : 0;
        if (!cancelled) setIndexerPct(pct);
      } catch {
        if (!cancelled) setIndexerPct(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [useIndexer, reservationPoolAddr]);

  const ringPercent = hasLaunchedSpt
    ? 100
    : gqlPct != null
      ? gqlPct
      : (indexerPct ?? 0);

  const showRing =
    Boolean(session && connectedAddress) &&
    (Boolean(reservationPoolAddr && inReservationPhase) || hasLaunchedSpt);

  return {
    profile,
    reservationPoolFillPercent: gqlPct ?? indexerPct,
    loading,
    showRing,
    ringPercent,
  };
}
