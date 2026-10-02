/**
 * Platform resolution for agent messaging groups.
 *
 * `messaging::create_agent_and_share_group` calls
 * `resolve_messaging_actor`, which asserts `platform::has_joined_platform(platform, principal)`.
 * So an agent group can only be created once the human owner has joined an approved
 * Platform — there is no way around it client-side. These helpers discover platforms and
 * membership from the indexer so the app needs no hard-coded platform id.
 */

import type { PageResult } from '../pagination';

const GRAPHQL_URL = import.meta.env.VITE_MYSO_GRAPHQL_URL || '/api/graphql';

const PLATFORMS_QUERY = `
  query AgentChatPlatforms($approvedOnly: Boolean, $limit: Int, $offset: Int) {
    platforms(approvedOnly: $approvedOnly, limit: $limit, offset: $offset) {
      platformId
      name
      tagline
    }
  }
`;

const PLATFORM_ACCESS_QUERY = `
  query AgentChatPlatformAccess($platform: ID!, $user: MySoAddress!) {
    platformUserAccess(platform: $platform, user: $user) {
      isMember
      isBlocked
    }
  }
`;

export interface ApprovedPlatform {
  platformId: string;
  name: string;
  tagline: string | null;
}

export interface PlatformAccess {
  isMember: boolean;
  isBlocked: boolean;
}

async function graphqlQuery<T>(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`GraphQL request failed: ${response.status} ${response.statusText}`);
  }
  const payload = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };
  if (payload.errors?.length) {
    throw new Error(`GraphQL error: ${payload.errors.map((e) => e.message).join('; ')}`);
  }
  if (!payload.data) throw new Error('GraphQL returned no data.');
  return payload.data;
}

/** Approved platforms, paged (the indexer supports `limit`/`offset`). */
export async function fetchApprovedPlatforms(
  request: { limit: number; offset: number },
  signal?: AbortSignal,
): Promise<PageResult<ApprovedPlatform>> {
  const data = await graphqlQuery<{ platforms: ApprovedPlatform[] }>(
    PLATFORMS_QUERY,
    { approvedOnly: true, limit: request.limit, offset: request.offset },
    signal,
  );
  const items = Array.isArray(data.platforms) ? data.platforms : [];
  // No total is reported; a short page terminates the walk in the pager.
  return { items, totalCount: null };
}

export async function fetchPlatformAccess(
  platformId: string,
  address: string,
  signal?: AbortSignal,
): Promise<PlatformAccess> {
  const data = await graphqlQuery<{ platformUserAccess: PlatformAccess | null }>(
    PLATFORM_ACCESS_QUERY,
    { platform: platformId, user: address },
    signal,
  );
  return data.platformUserAccess ?? { isMember: false, isBlocked: false };
}

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export interface PickPlatformArgs {
  /** `VITE_PLATFORM_ID` — an explicit operator choice, honoured when usable. */
  configuredPlatformId?: string | null;
  platforms: ApprovedPlatform[];
  access: Map<string, PlatformAccess>;
}

/**
 * Chooses the platform to create agent groups on.
 *
 * Order: the configured platform (when the user is a member, or when it is a listed
 * approved platform), then any approved platform the user has already joined. Returns null
 * when the user is a member of nothing — the UI must then offer to join one.
 */
export function pickAgentChatPlatform({
  configuredPlatformId,
  platforms,
  access,
}: PickPlatformArgs): ApprovedPlatform | null {
  const isMember = (id: string) => access.get(id.toLowerCase())?.isMember ?? false;

  if (configuredPlatformId) {
    const listed = platforms.find((p) => sameId(p.platformId, configuredPlatformId));
    if (listed && isMember(listed.platformId)) return listed;
    if (isMember(configuredPlatformId)) {
      return {
        platformId: configuredPlatformId,
        name: listed?.name ?? configuredPlatformId,
        tagline: listed?.tagline ?? null,
      };
    }
  }

  return platforms.find((p) => isMember(p.platformId)) ?? null;
}

/** Platforms the user may join (approved and not blocked by them). */
export function joinablePlatforms({
  platforms,
  access,
}: Pick<PickPlatformArgs, 'platforms' | 'access'>): ApprovedPlatform[] {
  return platforms.filter((p) => {
    const entry = access.get(p.platformId.toLowerCase());
    return !entry?.isBlocked && !entry?.isMember;
  });
}
