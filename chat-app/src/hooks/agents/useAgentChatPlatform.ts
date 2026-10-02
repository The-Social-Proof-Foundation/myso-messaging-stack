import {useCallback, useMemo, useState} from 'react';
import type {ClientWithCoreApi} from '@socialproof/myso/client';
import {useQuery, useQueryClient} from '@tanstack/react-query';

import {
  fetchApprovedPlatforms,
  fetchPlatformAccess,
  joinablePlatforms,
  pickAgentChatPlatform,
  type ApprovedPlatform,
  type PlatformAccess,
} from '../../lib/agents/platforms';
import {resolveAgentChainIds} from '../../lib/agents/chain-ids';
import {executeAsHuman} from '../../lib/agents/execute';
import {joinPlatformTx} from '../../lib/agents/tx';
import {useAuthenticatedAddress, useMySocialAuth} from '../../contexts/MySocialAuthContext';
import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {usePaginatedList} from '../usePaginatedList';

export interface AgentChatPlatformState {
  /** Platform agent chats will be created on, when the wallet is already a member. */
  active: ApprovedPlatform | null;
  isLoading: boolean;
  error: unknown;
  /**
   * Returns a platform the wallet is a member of, joining one when necessary.
   *
   * `create_agent_and_share_group` asserts `platform::has_joined_platform`, so this cannot be
   * avoided — but it is an implementation detail, not a user decision: the join is sent
   * automatically and the caller only shows one progress state.
   */
  ensureMembership: () => Promise<ApprovedPlatform>;
  refresh: () => void;
}

/**
 * Resolves and, when required, establishes the platform membership agent chats need.
 *
 * `VITE_PLATFORM_ID` is honoured first, then any approved platform the wallet has already
 * joined. Membership is read from `platformUserAccess`, which is what lets the app work
 * without a hard-coded platform id.
 */
export function useAgentChatPlatform(options: {enabled?: boolean} = {}): AgentChatPlatformState {
  const address = useAuthenticatedAddress();
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const queryClient = useQueryClient();
  const [isJoining, setIsJoining] = useState(false);
  const enabled = (options.enabled ?? true) && Boolean(address);

  const platforms = usePaginatedList<ApprovedPlatform>({
    queryKey: ['agents', 'platforms'],
    fetchPage: (request, signal) => fetchApprovedPlatforms(request, signal),
    keyOf: (platform) => platform.platformId,
    enabled,
    limit: 50,
    staleTime: 5 * 60_000,
  });

  const platformIds = useMemo(
    () => platforms.items.map((platform) => platform.platformId),
    [platforms.items],
  );
  const configured = (import.meta.env.VITE_PLATFORM_ID || '').trim() || null;
  const accessKey = useMemo(() => platformIds.join(','), [platformIds]);

  const access = useQuery({
    queryKey: ['agents', 'platform-access', address ?? '', configured ?? '', accessKey],
    enabled: enabled && platformIds.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, PlatformAccess>> => {
      const ids =
        configured && !platformIds.includes(configured)
          ? [...platformIds, configured]
          : platformIds;
      const entries = await Promise.all(
        ids.map(async (id) => {
          const result = await fetchPlatformAccess(id, address!);
          return [id.toLowerCase(), result] as const;
        }),
      );
      return new Map(entries);
    },
  });

  const active = useMemo(
    () =>
      pickAgentChatPlatform({
        configuredPlatformId: configured,
        platforms: platforms.items,
        access: access.data ?? new Map(),
      }),
    [configured, platforms.items, access.data],
  );

  const ensureMembership = useCallback(async (): Promise<ApprovedPlatform> => {
    if (active) return active;
    if (!client || !keypair) {
      throw new Error('Sign in before starting an agent chat.');
    }

    const candidates = joinablePlatforms({
      platforms: platforms.items,
      access: access.data ?? new Map(),
    });
    const target = candidates[0];
    if (!target) {
      throw new Error(
        platforms.items.length === 0
          ? 'No approved platform is available on this network yet, so agent chats cannot be created.'
          : 'This wallet is blocked from every approved platform, so agent chats cannot be created.',
      );
    }

    setIsJoining(true);
    try {
      const ids = await resolveAgentChainIds();
      await executeAsHuman(
        client as ClientWithCoreApi,
        keypair,
        joinPlatformTx(ids, {platformId: target.platformId}),
      );
      await queryClient.invalidateQueries({queryKey: ['agents', 'platform-access']});
      return target;
    } finally {
      setIsJoining(false);
    }
  }, [active, client, keypair, platforms.items, access.data, queryClient]);

  const refresh = useCallback(() => {
    platforms.refetch();
    void queryClient.invalidateQueries({queryKey: ['agents', 'platform-access']});
  }, [platforms, queryClient]);

  return {
    active,
    isLoading: platforms.isInitialLoading || access.isLoading || isJoining,
    error: platforms.error ?? access.error ?? null,
    ensureMembership,
    refresh,
  };
}
