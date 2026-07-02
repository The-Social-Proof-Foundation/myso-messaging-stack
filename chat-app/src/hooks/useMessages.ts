/**
 * Hook for fetching, sending, and subscribing to messages in a group.
 *
 * - Loads initial message history via getMessages()
 * - Subscribes to real-time message + reaction events via subscribe()
 * - Provides sendMessage / editMessage / deleteMessage / toggleReaction
 * - Deduplicates incoming messages by messageId
 * - Tracks per-message reactions keyed by relayer `order`
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BlockedMessagingError,
  RelayerTransportError,
} from '@socialproof/myso-messaging-stack';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';
import type {
  AttachmentFile,
  AttachmentHandle,
  RelayerReactionEntry,
  RelayerReactionEvent,
} from '@socialproof/myso-messaging-stack';
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

/** Reaction entries per message, keyed by the message's relayer `order`. */
export type MessageReactions = Map<number, RelayerReactionEntry[]>;

export interface UseMessagesResult {
  messages: Message[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  hasMore: boolean;
  reactions: MessageReactions;
  sendMessage: (text: string, files?: AttachmentFile[]) => Promise<void>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (order: number, emoji: string) => Promise<void>;
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

/** Group flat reaction rows by message order. */
function groupReactionsByOrder(rows: RelayerReactionEntry[]): MessageReactions {
  const byOrder: MessageReactions = new Map();
  for (const row of rows) {
    const entries = byOrder.get(row.chainSeq) ?? [];
    entries.push(row);
    byOrder.set(row.chainSeq, entries);
  }
  return byOrder;
}

/**
 * Apply an absolute-state reaction event: replace the (order, emoji) entry
 * with the event's count/reactors, dropping it when the count reaches zero.
 * Idempotent — re-applying the same event is a no-op.
 */
function applyReactionEvent(
  prev: MessageReactions,
  event: RelayerReactionEvent,
): MessageReactions {
  const next = new Map(prev);
  const entries = (next.get(event.chainSeq) ?? []).filter(
    (e) => e.emoji !== event.emoji,
  );
  if (event.count > 0) {
    entries.push({
      chainSeq: event.chainSeq,
      emoji: event.emoji,
      count: event.count,
      reactors: event.reactors,
    });
  }
  entries.sort((a, b) => a.emoji.localeCompare(b.emoji));
  if (entries.length > 0) {
    next.set(event.chainSeq, entries);
  } else {
    next.delete(event.chainSeq);
  }
  return next;
}

export function useMessages(uuid: string, groupId: string): UseMessagesResult {
  const { client, signer } = useRequiredMessagingClient();

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reactions, setReactions] = useState<MessageReactions>(new Map());

  // Track current uuid and latest order for subscription
  const uuidRef = useRef(uuid);
  uuidRef.current = uuid;
  const lastOrderRef = useRef<number | undefined>(undefined);
  // Latest reactions for toggle decisions without re-creating callbacks.
  const reactionsRef = useRef<MessageReactions>(reactions);
  reactionsRef.current = reactions;

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
    setReactions(new Map());
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

        // One listing covers all messages in the group (including older pages).
        try {
          const rows = await client.messaging.listReactions({
            signer,
            groupRef: {uuid},
          });
          if (cancelled || uuidRef.current !== uuid) return;
          setReactions(groupReactionsByOrder(rows));
        } catch (err) {
          console.warn('Failed to load reactions:', err);
        }
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
  // Real-time subscription (messages + reaction updates)
  // ------------------------------------------------------------------
  useEffect(() => {
    // Don't subscribe while still loading initial messages
    if (loading) return;

    const controller = new AbortController();

    async function startSubscription() {
      try {
        const stream = client.messaging.subscribe({
          signer,
          groupRef: {uuid},
          afterOrder: lastOrderRef.current,
          signal: controller.signal,
          mydataApproveContext: undefined
        });

        for await (const event of stream) {
          if (controller.signal.aborted || uuidRef.current !== uuid) break;
          if (event.type === 'message') {
            setMessages((prev) => mergeMessage(prev, event.message as Message));
          } else {
            setReactions((prev) => applyReactionEvent(prev, event.reaction));
          }
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
  // Toggle my reaction on a message (optimistic, reverted on error)
  // ------------------------------------------------------------------
  const toggleReaction = useCallback(
    async (order: number, emoji: string) => {
      const myAddress = signer.toMySoAddress();
      const entries = reactionsRef.current.get(order) ?? [];
      const entry = entries.find((e) => e.emoji === emoji);
      const hasReacted = entry?.reactors.includes(myAddress) ?? false;

      // Optimistic absolute-state update, shaped like a relayer event so the
      // eventual reaction.updated broadcast converges to the same state.
      const optimistic: RelayerReactionEvent = hasReacted
        ? {
            groupId,
            chainSeq: order,
            emoji,
            count: Math.max((entry?.count ?? 1) - 1, 0),
            reactors: (entry?.reactors ?? []).filter((a) => a !== myAddress),
          }
        : {
            groupId,
            chainSeq: order,
            emoji,
            count: (entry?.count ?? 0) + 1,
            reactors: [...(entry?.reactors ?? []), myAddress],
          };

      const snapshot = reactionsRef.current;
      setReactions((prev) => applyReactionEvent(prev, optimistic));

      try {
        if (hasReacted) {
          await client.messaging.removeReaction({
            signer,
            groupRef: {uuid: uuidRef.current},
            order,
            emoji,
          });
        } else {
          await client.messaging.addReaction({
            signer,
            groupRef: {uuid: uuidRef.current},
            order,
            emoji,
          });
        }
      } catch (err) {
        console.error('Failed to toggle reaction:', err);
        setReactions(snapshot);
        setError(
          err instanceof RelayerTransportError
            ? formatRelayerError(err)
            : err instanceof Error
              ? err.message
              : 'Failed to update reaction.',
        );
        throw err;
      }
    },
    [client, signer, groupId],
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
    reactions,
    sendMessage,
    editMessage,
    deleteMessage: deleteMessageFn,
    toggleReaction,
    loadMore,
  };
}

export {
  type AttachmentFile,
  type AttachmentHandle,
  type RelayerReactionEntry,
} from '@socialproof/myso-messaging-stack';