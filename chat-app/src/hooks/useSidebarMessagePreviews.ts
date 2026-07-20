import { useEffect, useMemo, useRef, useState } from 'react';
import { useMessagingClient } from '../contexts/MessagingClientContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import type { StoredGroup } from '../lib/group-store';
import { getCachedThread } from '../lib/message-session-cache';

type PreviewEntry = {
  text: string;
  order: number;
  /** Set after a successful relayer fetch (or live publish from an open thread). */
  verified: boolean;
};

/** Session cache of last-message previews keyed by groupId. */
const previewCache = new Map<string, PreviewEntry>();

const listeners = new Set<() => void>();

function notifyPreviewListeners() {
  for (const listener of listeners) listener();
}

function formatPreview(message: {
  text?: string;
  isDeleted?: boolean;
  attachments?: unknown[];
}): string {
  if (message.isDeleted) return 'Message deleted';
  const text = message.text?.trim();
  if (text) return text.replace(/\s+/g, ' ');
  if (message.attachments && message.attachments.length > 0) {
    return 'Attachment';
  }
  return '';
}

function previewFromSessionCache(uuid: string): PreviewEntry | null {
  if (!uuid) return null;
  const thread = getCachedThread(uuid);
  if (!thread?.messages.length) return null;
  const last = thread.messages[thread.messages.length - 1]!;
  return {
    text: formatPreview(last),
    order: last.order,
    // Session cache can lag the true tip until the open thread finishes loading.
    verified: false,
  };
}

function applyPreview(groupId: string, next: PreviewEntry): boolean {
  const prev = previewCache.get(groupId);
  if (prev) {
    if (next.order < prev.order) return false;
    if (next.order === prev.order) {
      if (prev.text === next.text && prev.verified === next.verified) {
        return false;
      }
      // Don't let an unverified seed clobber a verified tip at the same order.
      if (prev.verified && !next.verified) return false;
    }
  }
  previewCache.set(groupId, next);
  return true;
}

/**
 * Push the latest message from an open thread into the sidebar preview cache.
 * Call whenever the active conversation's tip changes.
 */
export function publishSidebarMessagePreview(
  groupId: string,
  message: {
    order: number;
    text?: string;
    isDeleted?: boolean;
    attachments?: unknown[];
  },
): void {
  if (!groupId || !Number.isFinite(message.order)) return;
  const changed = applyPreview(groupId, {
    text: formatPreview(message),
    order: message.order,
    verified: true,
  });
  if (changed) notifyPreviewListeners();
}

/**
 * Last-message preview text for sidebar rows.
 * Instant paint from the thread session cache, then always verifies against
 * the relayer (limit 5 → newest decryptable) so a stale cache cannot stick.
 */
export function useSidebarMessagePreviews(
  groups: readonly StoredGroup[],
  latestOrders: Record<string, number>,
): Map<string, string> {
  const client = useMessagingClient();
  const { keypair: signer } = useMySocialAuth();
  const [version, setVersion] = useState(0);
  const latestOrdersRef = useRef(latestOrders);
  latestOrdersRef.current = latestOrders;

  const groupKey = useMemo(
    () =>
      groups
        .map((g) => `${g.groupId}:${g.uuid}`)
        .sort()
        .join('|'),
    [groups],
  );

  const ordersKey = useMemo(() => {
    return groups
      .map((g) => `${g.groupId}:${latestOrders[g.groupId] ?? 0}`)
      .sort()
      .join('|');
  }, [groups, latestOrders]);

  useEffect(() => {
    const onBump = () => setVersion((v) => v + 1);
    listeners.add(onBump);
    return () => {
      listeners.delete(onBump);
    };
  }, []);

  useEffect(() => {
    if (!client || !signer || groups.length === 0) return;

    let cancelled = false;

    // Fast paint from whatever the open-thread cache already has.
    let seeded = false;
    for (const group of groups) {
      const fromCache = previewFromSessionCache(group.uuid);
      if (!fromCache) continue;
      if (applyPreview(group.groupId, fromCache)) seeded = true;
    }
    if (seeded) setVersion((v) => v + 1);

    // Always hit the relayer until verified and caught up with activity.
    const toFetch = groups.filter((group) => {
      if (!group.uuid) return false;
      const cached = previewCache.get(group.groupId);
      const latest = latestOrdersRef.current[group.groupId] ?? 0;
      if (!cached) return true;
      if (!cached.verified) return true;
      if (latest > 0 && cached.order < latest) return true;
      return false;
    });

    if (toFetch.length === 0) return;

    void (async () => {
      await Promise.all(
        toFetch.map(async (group) => {
          try {
            // Fetch a small newest window so one decrypt failure cannot hide the tip.
            const result = await client.messaging.getMessages({
              signer,
              groupRef: { uuid: group.uuid },
              limit: 5,
              mydataApproveContext: undefined,
            });
            if (cancelled) return;
            const last = result.messages.reduce<
              (typeof result.messages)[number] | null
            >(
              (best, msg) =>
                !best || msg.order > best.order ? msg : best,
              null,
            );
            if (!last) {
              if ((latestOrdersRef.current[group.groupId] ?? 0) === 0) {
                applyPreview(group.groupId, {
                  text: '',
                  order: 0,
                  verified: true,
                });
              }
              return;
            }
            applyPreview(group.groupId, {
              text: formatPreview(last),
              order: last.order,
              verified: true,
            });
          } catch (err) {
            console.warn(
              `[sidebar] failed to load preview for ${group.groupId.slice(0, 10)}…`,
              err,
            );
          }
        }),
      );
      if (!cancelled) setVersion((v) => v + 1);
    })();

    return () => {
      cancelled = true;
    };
    // groups identity via groupKey; latest via ordersKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, signer, groupKey, ordersKey]);

  return useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groups) {
      const entry = previewCache.get(group.groupId);
      map.set(group.groupId, entry?.text ?? '');
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupKey, version]);
}
