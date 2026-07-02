/**
 * Hook for discovering the connected user's groups via MySo GraphQL event queries.
 *
 * Queries MemberAdded<Messaging> and MemberRemoved<Messaging> events, then
 * client-side filters by the connected address to compute net group membership.
 *
 * Results are cached in localStorage for instant sidebar render on next load;
 * GraphQL queries refresh in the background.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import type { MySoGraphQLClient } from '@socialproof/myso/graphql';
import {
  useGraphQLClient,
  useMessagingClient,
} from '../contexts/MessagingClientContext';
import {
  getStoredGroups,
  addStoredGroup,
  type StoredGroup,
  removeStoredGroup,
} from '../lib/group-store';

// ---------------------------------------------------------------------------
// GraphQL query for paginated event discovery
// ---------------------------------------------------------------------------

const DISCOVER_GROUPS_QUERY = `
  query DiscoverGroups($eventType: String!, $cursor: String) {
    events(filter: { type: $eventType }, first: 50, after: $cursor) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        contents {
          json
        }
      }
    }
  }
`;

// ---------------------------------------------------------------------------
// Response types matching the GraphQL query shape
// ---------------------------------------------------------------------------

interface EventsQueryResult {
  events: {
    pageInfo: {
      hasNextPage: boolean;
      endCursor: string | null;
    };
    nodes: Array<{
      contents: {
        json: {
          group_id: string;
          member: string;
        };
      } | null;
    }>;
  };
}

// ---------------------------------------------------------------------------
// Helper: paginate through all events of a given type
// ---------------------------------------------------------------------------

async function queryAllEventGroupIds(
  graphqlClient: MySoGraphQLClient,
  eventType: string,
  memberAddress: string,
): Promise<string[]> {
  const groupIds: string[] = [];
  let cursor: string | null = null;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const result = await graphqlClient.query({
      // Cast the string query as any — MySoGraphQLClient accepts GraphQLDocument
      // which gql.tada produces, but a raw string also works at runtime.
      query: DISCOVER_GROUPS_QUERY as unknown as Parameters<typeof graphqlClient.query>[0]['query'],
      variables: { eventType, cursor },
    });

    const data = result.data as EventsQueryResult | undefined;
    const events = data?.events;
    if (!events) break;

    for (const node of events.nodes) {
      const json = node.contents?.json;
      if (!json) continue;

      // Client-side filter: only keep events targeting our address
      if (json.member === memberAddress) {
        groupIds.push(json.group_id);
      }
    }

    if (!events.pageInfo.hasNextPage || !events.pageInfo.endCursor) break;
    cursor = events.pageInfo.endCursor;
  }

  return groupIds;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface UseGroupDiscoveryResult {
  /** All groups the user belongs to (localStorage cache + GraphQL discovery). */
  groups: StoredGroup[];
  /** Whether a background GraphQL discovery is in progress. */
  loading: boolean;
  /** Manually re-read localStorage and trigger a fresh discovery. */
  refresh: () => void;
  /**
   * `group.discovered` user-feed handler: re-fetches the group's canonical
   * metadata over REST (the event is a refresh hint, never trusted as state)
   * and adds it to the sidebar. Idempotent — replayed events are harmless.
   */
  handleDiscovered: (groupId: string) => void;
  /** `group.hidden` user-feed handler: drops the group from the sidebar. */
  handleHidden: (groupId: string) => void;
}

export function useGroupDiscovery(
  address: string | undefined,
): UseGroupDiscoveryResult {
  const graphqlClient = useGraphQLClient();
  const client = useMessagingClient();

  // Start with cached groups from localStorage
  const [groups, setGroups] = useState<StoredGroup[]>(getStoredGroups);
  const [loading, setLoading] = useState(false);

  // Track the latest address to avoid stale closures
  const addressRef = useRef(address);
  addressRef.current = address;

  const refresh = useCallback(() => {
    setGroups(getStoredGroups());
  }, []);

  const handleDiscovered = useCallback(
    (groupId: string) => {
      if (!client) return;
      const known = getStoredGroups().some((g) => g.groupId === groupId);
      if (known) return;

      client.messaging.view
        .groupsMetadata({ groupIds: [groupId], refresh: true })
        .then((metadata) => {
          const meta = metadata[groupId];
          if (!meta) return;
          addStoredGroup({
            uuid: meta.uuid,
            name: meta.name,
            groupId,
            createdAt: Date.now(),
          });
          setGroups(getStoredGroups());
        })
        .catch((err) => {
          console.warn('Failed to fetch metadata for discovered group:', err);
        });
    },
    [client],
  );

  const handleHidden = useCallback((groupId: string) => {
    removeStoredGroup(groupId);
    setGroups(getStoredGroups());
  }, []);

  useEffect(() => {
    if (!address || !client) {
      setGroups(getStoredGroups());
      return;
    }

    const controller = new AbortController();

    async function discover() {
      setLoading(true);
      try {
        // Get event type strings from the SDK's BCS module.
        // These include the resolved package IDs:
        //   {pkgId}::permissioned_group::MemberAdded<{witnessPkgId}::messaging::Messaging>
        const memberAddedType = client!.groups.bcs.MemberAdded.name;
        const memberRemovedType = client!.groups.bcs.MemberRemoved.name;
    
        // Paginate through all events of each type
        const [addedGroupIds, removedGroupIds] = await Promise.all([
          queryAllEventGroupIds(graphqlClient, memberAddedType, address!),
          queryAllEventGroupIds(graphqlClient, memberRemovedType, address!),
        ]);
    
        // Abort check
        if (controller.signal.aborted) return;
    
        // A member can be removed then added back again, so we check net count
        const counts = removedGroupIds.reduce(
          (acc, g) => acc.set(g, (acc.get(g) ?? 0) - 1),
          addedGroupIds.reduce(
            (acc, g) => acc.set(g, (acc.get(g) ?? 0) + 1),
            new Map<string, number>()
          )
        );
    
        // Groups where added count > removed count = active
        const activeGroupIds = [...counts.entries()]
          .filter(([, count]) => count > 0)
          .map(([groupId]) => groupId);
    
        // Merge discovered groups with localStorage
        // (Keep existing names/UUIDs for groups we already know about)
        const stored = getStoredGroups();
        const storedByGroupId = new Map(stored.map((g) => [g.groupId, g]));
    
        // Fetch metadata (name, uuid) only for active groups not already in storage
        const newGroupIds = activeGroupIds.filter((id) => !storedByGroupId.has(id));
        const groupMetadata = newGroupIds.length > 0
          ? await client!.messaging.view.groupsMetadata({ groupIds: newGroupIds, refresh: true })
          : {};
    
        // Remove stored groups that are no longer active
        for (const storedId of storedByGroupId.keys()) {
          if (!activeGroupIds.includes(storedId)) {
            removeStoredGroup(storedId);
          }
        }
    
        // If the group is not in the stored groups, add it
        for (const groupId of newGroupIds) {
          const meta = groupMetadata[groupId];
          if (!meta) continue;
          addStoredGroup({
            uuid: meta.uuid,
            name: meta.name,
            groupId,
            createdAt: Date.now(),
          });
        }
    
        if (!controller.signal.aborted) {
          setGroups(getStoredGroups());
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error('Group discovery failed:', err);
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    discover().then();

    return () => {
      controller.abort();
    };
  }, [address, client, graphqlClient]);

  return { groups, loading, refresh, handleDiscovered, handleHidden };
}
