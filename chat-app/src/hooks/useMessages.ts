/**
 * Hook for fetching, sending, and subscribing to messages in a group.
 *
 * - Loads initial message history via getMessages()
 * - Subscribes to real-time updates via subscribe() (polling-based)
 * - Provides a sendMessage function for composing new messages
 * - Deduplicates incoming messages by messageId
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BlockedMessagingError,
  RelayerTransportError,
} from '@socialproof/myso-messaging-stack';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';
import type { AttachmentFile, AttachmentHandle } from '@socialproof/myso-messaging-stack';
import {
  formatRelayerError,
  isNotGroupMemberError,
} from '../lib/format-relayer-error';

export interface Message {
  messageId: string;
  groupId: string;
  order: number;
  text: string;
  senderAddress: string;
  createdAt: number;
  updatedAt: number;
  isEdited: boolean;
  isDeleted: boolean;
  syncStatus?: string;
  attachments: AttachmentHandle[];
  senderVerified: boolean;
  isAgentMessage?: boolean;
  principalOwner?: string;
  subAgentId?: string;
}

export interface UseMessagesResult {
  messages: Message[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  hasMore: boolean;
  sendMessage: (text: string, files?: AttachmentFile[]) => Promise<void>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  loadMore: () => Promise<void>;
}

/** Shape returned by the SDK's getMessages method (messages may include attachments). */
interface SDKGetMessagesResult {
  messages: Message[];
  hasNext: boolean;
}

/** Stable ascending sort by order, then createdAt, then messageId. */
function sortMessagesByOrder(msgs: Message[]): Message[] {
  return [...msgs].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
    return a.messageId.localeCompare(b.messageId);
  });
}

/** Merge two lists, dedupe by messageId, return sorted ascending. */
function mergeMessages(prev: Message[], incoming: Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of prev) byId.set(m.messageId, m);
  for (const m of incoming) byId.set(m.messageId, m);
  return sortMessagesByOrder([...byId.values()]);
}

/** Deduplicate and merge a new message into the list (sorted by order). */
function mergeMessage(prev: Message[], incoming: Message): Message[] {
  return mergeMessages(prev, [incoming]);
}

export function useMessages(uuid: string, groupId: string): UseMessagesResult {
  const { client, signer } = useRequiredMessagingClient();

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  // Track current uuid and latest order for subscription
  const uuidRef = useRef(uuid);
  uuidRef.current = uuid;
  const lastOrderRef = useRef<number | undefined>(undefined);

  // Update lastOrderRef whenever messages change
  useEffect(() => {
    if (messages.length > 0) {
      lastOrderRef.current = messages.at(-1)?.order;
    }
  }, [messages]);

  // ------------------------------------------------------------------
  // Load initial messages
  // ------------------------------------------------------------------
  useEffect(() => {
    setMessages([]);
    setLoading(true);
    setError(null);
    setHasMore(false);
    lastOrderRef.current = undefined;

    let cancelled = false;

    async function loadInitial() {
      try {
        const result: SDKGetMessagesResult = await client.messaging.getMessages({
          signer,
          groupRef: {uuid},
          limit: 50,
          mydataApproveContext: undefined,
        });

        if (cancelled || uuidRef.current !== uuid) return;

        setMessages(sortMessagesByOrder(result.messages));
        setHasMore(result.hasNext);
      } catch (err) {
        if (cancelled || uuidRef.current !== uuid) return;
        console.error('Failed to load messages:', err);
        setError(
          err instanceof Error ? err.message : 'Failed to load messages.',
        );
      } finally {
        if (!cancelled && uuidRef.current === uuid) {
          setLoading(false);
        }
      }
    }

    loadInitial().then();

    return () => {
      cancelled = true;
    };
  }, [uuid, client, signer]);

  // ------------------------------------------------------------------
  // Real-time subscription (polling-based via SDK's subscribe)
  // ------------------------------------------------------------------
  useEffect(() => {
    // Don't subscribe while still loading initial messages
    if (loading) return;

    const controller = new AbortController();

    async function startSubscription() {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const stream: AsyncIterable<Message> = client.messaging.subscribe({
          signer,
          groupRef: {uuid},
          afterOrder: lastOrderRef.current,
          signal: controller.signal,
          mydataApproveContext: undefined
        });

        for await (const msg of stream) {
          if (controller.signal.aborted || uuidRef.current !== uuid) break;
          setMessages((prev) => mergeMessage(prev, msg));
        }
      } catch (err) {
        // AbortError is expected on cleanup
        if (controller.signal.aborted) return;
        console.error('Subscription error:', err);
      }
    }

    startSubscription().then();

    return () => {
      controller.abort();
    };
  }, [uuid, client, signer, loading]);

  // Mark thread read + presence heartbeat for push gating
  useEffect(() => {
    if (loading || !groupId || messages.length === 0) return;

    const maxOrder = Math.max(...messages.map((m) => m.order));
    if (!Number.isFinite(maxOrder)) return;

    client.messaging
      .updateReadState({ signer, groupId, readUpto: maxOrder })
      .catch((err) => console.warn('Failed to update read state:', err));

    client.messaging.transport
      .postPresence({ signer, active: true })
      .catch((err) => console.warn('Failed to post presence:', err));
  }, [messages, loading, groupId, client, signer]);

  // ------------------------------------------------------------------
  // Load older messages (pagination)
  // ------------------------------------------------------------------
  const loadMore = useCallback(async () => {
    if (messages.length === 0 || !hasMore) return;

    const oldestOrder = messages[0]?.order;
    if (oldestOrder === undefined) return;

    try {
      const result: SDKGetMessagesResult = await client.messaging.getMessages({
        signer,
        groupRef: {uuid: uuidRef.current},
        beforeOrder: oldestOrder,
        limit: 50,
        mydataApproveContext: undefined
      });

      if (uuidRef.current !== uuid) return;

      setMessages((prev) => mergeMessages(prev, result.messages));
      setHasMore(result.hasNext);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    }
  }, [uuid, messages, hasMore, client, signer]);

  // ------------------------------------------------------------------
  // Send a new message
  // ------------------------------------------------------------------
  const sendMessage = useCallback(
    async (text: string, files?: AttachmentFile[]) => {
      const trimmed = text.trim();
      const hasFiles = files && files.length > 0;
      if (!trimmed && !hasFiles) return;

      setSending(true);
      setError(null);

      const sendPayload = {
        signer,
        groupRef: { uuid: uuidRef.current },
        text: trimmed || undefined,
        files: hasFiles ? files : undefined,
        mydataApproveContext: undefined as undefined,
      };

      const maxAttempts = 5;
      let lastErr: unknown;

      try {
        let messageId: string | undefined;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          try {
            ({ messageId } = await client.messaging.sendMessage(sendPayload));
            break;
          } catch (err) {
            lastErr = err;
            if (isNotGroupMemberError(err) && attempt < maxAttempts - 1) {
              await new Promise((resolve) =>
                setTimeout(resolve, 500 * (attempt + 1)),
              );
              continue;
            }
            throw err;
          }
        }

        if (!messageId) {
          throw lastErr ?? new Error('Failed to send message.');
        }

        // Optimistic local append — the subscription will replace this with
        // the real message when it arrives from the relayer.
        const optimistic: Message = {
          messageId,
          groupId: '',
          order: (lastOrderRef.current ?? 0) + 1,
          text: trimmed,
          senderAddress: '',
          createdAt: Date.now() / 1000,
          updatedAt: Date.now() / 1000,
          isEdited: false,
          isDeleted: false,
          syncStatus: 'SYNC_PENDING',
          attachments: [],
          senderVerified: false,
        };

        setMessages((prev) => mergeMessage(prev, optimistic));
      } catch (err) {
        console.error('Failed to send message:', err);
        if (err instanceof BlockedMessagingError) {
          setError('You cannot message this user.');
        } else if (
          err instanceof RelayerTransportError ||
          isNotGroupMemberError(err)
        ) {
          setError(formatRelayerError(err));
        } else {
          setError(
            err instanceof Error ? err.message : 'Failed to send message.',
          );
        }
      } finally {
        setSending(false);
      }
    },
    [client, signer],
  );

  // ------------------------------------------------------------------
  // Edit an existing message
  // ------------------------------------------------------------------
  const editMessage = useCallback(
    async (messageId: string, text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      try {
        await client.messaging.editMessage({
          signer,
          groupRef: {uuid: uuidRef.current},
          messageId,
          text: trimmed,
          mydataApproveContext: undefined
        });

        // Optimistic local update
        setMessages((prev) =>
          prev.map((m) =>
            m.messageId === messageId
              ? {...m, text: trimmed, isEdited: true, updatedAt: Date.now() / 1000}
              : m,
          ),
        );
      } catch (err) {
        console.error('Failed to edit message:', err);
        setError(
          err instanceof Error ? err.message : 'Failed to edit message.',
        );
        throw err;
      }
    },
    [client, signer],
  );

  // ------------------------------------------------------------------
  // Delete a message
  // ------------------------------------------------------------------
  const deleteMessageFn = useCallback(
    async (messageId: string) => {
      try {
        await client.messaging.deleteMessage({
          signer,
          groupRef: {uuid: uuidRef.current},
          messageId,
        });

        // Optimistic local update — mark as deleted
        setMessages((prev) =>
          prev.map((m) =>
            m.messageId === messageId
              ? {...m, isDeleted: true, updatedAt: Date.now() / 1000}
              : m,
          ),
        );
      } catch (err) {
        console.error('Failed to delete message:', err);
        setError(
          err instanceof Error ? err.message : 'Failed to delete message.',
        );
        throw err;
      }
    },
    [client, signer],
  );

  return {
    messages,
    loading,
    sending,
    error,
    hasMore,
    sendMessage,
    editMessage,
    deleteMessage: deleteMessageFn,
    loadMore,
  };
}

export {type AttachmentFile, type AttachmentHandle} from '@socialproof/myso-messaging-stack';