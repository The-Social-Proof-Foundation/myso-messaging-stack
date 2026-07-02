/**
 * App-level subscription to the wallet-scoped user feed (`/v1/users/ws`).
 *
 * One socket per wallet carries every user-scoped synchronization event;
 * multiple consumers (unread counts, group discovery) hang off this single
 * subscription via handler callbacks. Events are notifications only — the
 * handlers re-fetch canonical state over REST.
 *
 * The SDK transport handles reconnect/backoff internally and falls back to
 * polling batch unread counts when the WebSocket is unavailable; this hook
 * additionally restarts the stream if it ends unexpectedly.
 */
import { useEffect, useRef } from 'react';
import { useMessagingClient } from '../contexts/MessagingClientContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import type { StoredGroup } from '../lib/group-store';

export interface UserFeedHandlers {
  /** A message landed in one of your groups (any group, any device). */
  onGroupActivity?: (groupId: string, latestOrder: number) => void;
  /** Your read state changed on another device/tab. */
  onReadStateUpdated?: () => void;
  /** A conversation appeared — re-fetch group metadata over REST. */
  onGroupDiscovered?: (groupId: string) => void;
  /** A conversation should leave the sidebar. */
  onGroupHidden?: (groupId: string) => void;
}

const RESTART_DELAY_MS = 5_000;

export function useUserFeed(
  groups: StoredGroup[],
  handlers: UserFeedHandlers,
): void {
  const client = useMessagingClient();
  const { keypair: signer } = useMySocialAuth();

  // Handlers live in a ref so changing identities never resubscribes.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  // Only used by the HTTP polling fallback; a stable key avoids resubscribing
  // when the groups array identity changes without membership changes.
  const groupIdsKey = groups
    .map((g) => g.groupId)
    .sort()
    .join(',');

  useEffect(() => {
    if (!client || !signer) return;

    const messagingClient = client;
    const messagingSigner = signer;
    const groupIds = groupIdsKey ? groupIdsKey.split(',') : [];
    const controller = new AbortController();

    async function run() {
      while (!controller.signal.aborted) {
        try {
          const stream = messagingClient.messaging.subscribeUserEvents({
            signer: messagingSigner,
            signal: controller.signal,
            groupIds,
          });

          for await (const event of stream) {
            if (controller.signal.aborted) return;
            const h = handlersRef.current;
            switch (event.type) {
              case 'group.activity':
                h.onGroupActivity?.(event.groupId, event.latestOrder);
                break;
              case 'read_state.updated':
                h.onReadStateUpdated?.();
                break;
              case 'group.discovered':
                h.onGroupDiscovered?.(event.groupId);
                break;
              case 'group.hidden':
                h.onGroupHidden?.(event.groupId);
                break;
            }
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          console.warn('User feed error (restarting):', err);
        }
        // Stream ended or failed — pause, then reconnect.
        await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
      }
    }

    run().then();

    return () => {
      controller.abort();
    };
  }, [client, signer, groupIdsKey]);
}
