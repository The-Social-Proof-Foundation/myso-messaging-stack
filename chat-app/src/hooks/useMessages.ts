/**
 * Hook for fetching, sending, and subscribing to messages in a group.
 *
 * - Loads initial message history via getMessages()
 * - Subscribes to real-time message/reaction/typing/presence events via subscribe()
 * - Provides sendMessage / editMessage / deleteMessage / toggleReaction / sendTyping
 * - Deduplicates incoming messages by messageId
 * - Tracks per-message reactions keyed by relayer `order`
 * - Advances the read watermark (deduped — only when maxOrder increases) and
 *   notifies `onReadStateChanged` so the sidebar badge clears instantly
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  BlockedMessagingError,
  createPaidMessagingClient,
  PAID_DM_MIN_REPLY_CHARS,
  PAID_MSG_NO_PLATFORM_FEE_RECIPIENT,
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
  formatPaidClaimError,
  formatRelayerError,
  isNotGroupMemberError,
  isPaymentRequiredError,
} from '../lib/format-relayer-error';
import { signAndExecuteTransactionAndWait } from '../lib/sign-and-wait';
import {
  applySnapshotEntries,
  applyWsPresence,
  presenceRecordsToOnlineMap,
  sweepStaleWsPresence,
  type PresenceRecord,
} from '../lib/presence-utils';

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

/** Paid-DM gate state: the relayer rejected a send with 402 PAYMENT_REQUIRED. */
export interface PaymentRequiredState {
  /** Required escrow in MIST (1 MYSO = 10^9 MIST). */
  minCost: bigint | null;
  /** Recipient wallet that requires payment. */
  recipient: string | null;
}

export interface UseMessagesResult {
  messages: Message[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  hasMore: boolean;
  reactions: MessageReactions;
  /** Members (excluding self) currently typing. */
  typingMembers: string[];
  /** Online state per member (presence snapshot + live events). */
  onlineMembers: Map<string, boolean>;
  sendMessage: (text: string, files?: AttachmentFile[]) => Promise<void>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (order: number, emoji: string) => Promise<void>;
  /** Broadcast the signer's typing state (fire-and-forget, ephemeral). */
  sendTyping: (typing: boolean) => void;
  loadMore: () => Promise<void>;
  /** Set when the last send hit the paid-DM gate; renders the payment dialog. */
  paymentRequired: PaymentRequiredState | null;
  /** Payment transaction + post-payment retry in flight. */
  paying: boolean;
  /** On-chain escrow claim transaction in flight (first reply to a paid DM). */
  claiming: boolean;
  paymentError: string | null;
  /** Pay the escrow on-chain, then retry the pending message. */
  confirmPayment: () => Promise<void>;
  /** Dismiss the payment dialog and drop the pending message. */
  cancelPayment: () => void;
}

export interface UseMessagesOptions {
  /** Called after the read watermark is successfully advanced on the relayer. */
  onReadStateChanged?: (groupId: string) => void;
  /** When true, the next outbound send claims peer escrow on-chain before relayer delivery. */
  claimPending?: boolean;
  /** Called when a message is sent or received — for sidebar activity ordering. */
  onGroupActivity?: (order: number) => void;
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

export function useMessages(
  uuid: string,
  groupId: string,
  options?: UseMessagesOptions,
): UseMessagesResult {
  const { client, signer } = useRequiredMessagingClient();

  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [reactions, setReactions] = useState<MessageReactions>(new Map());
  /** Typing members mapped to their expiry (ms epoch) — TTL is the recovery path. */
  const [typingUntil, setTypingUntil] = useState<Map<string, number>>(new Map());
  const [presenceRecords, setPresenceRecords] = useState<
    Map<string, PresenceRecord>
  >(new Map());
  const [minReplyChars, setMinReplyChars] = useState(PAID_DM_MIN_REPLY_CHARS);

  const onlineMembers = useMemo(
    () => presenceRecordsToOnlineMap(presenceRecords),
    [presenceRecords],
  );

  const onReadStateChangedRef = useRef(options?.onReadStateChanged);
  onReadStateChangedRef.current = options?.onReadStateChanged;
  const onGroupActivityRef = useRef(options?.onGroupActivity);
  onGroupActivityRef.current = options?.onGroupActivity;
  const claimPendingRef = useRef(options?.claimPending ?? false);
  claimPendingRef.current = options?.claimPending ?? false;

  // Paid-DM gate: dialog state + the message waiting on payment.
  const [paymentRequired, setPaymentRequired] =
    useState<PaymentRequiredState | null>(null);
  const [paying, setPaying] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const pendingPaidSendRef = useRef<{
    text: string;
    files?: AttachmentFile[];
  } | null>(null);

  // Track current uuid and latest order for subscription
  const uuidRef = useRef(uuid);
  uuidRef.current = uuid;
  const lastOrderRef = useRef<number | undefined>(undefined);
  // Latest reactions for toggle decisions without re-creating callbacks.
  const reactionsRef = useRef<MessageReactions>(reactions);
  reactionsRef.current = reactions;
  // Highest watermark already sent to the relayer — dedupes read-state writes.
  const lastSentReadUptoRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void client.messaging.view
      .getMessagingConfig()
      .then((config) => {
        if (!cancelled) {
          setMinReplyChars(config.minReplyChars);
        }
      })
      .catch((err) => {
        console.warn('Failed to load MessagingConfig; using default min reply chars', err);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  const resyncPresence = useCallback(async () => {
    try {
      const entries = await client.messaging.getGroupPresence({
        signer,
        groupRef: { uuid: uuidRef.current },
      });
      if (uuidRef.current !== uuid) return;
      setPresenceRecords((prev) => applySnapshotEntries(prev, entries));
    } catch (err) {
      console.warn('Failed to resync presence:', err);
    }
  }, [client, signer, uuid]);

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
    setTypingUntil(new Map());
    setPresenceRecords(new Map());
    setPaymentRequired(null);
    setPaymentError(null);
    pendingPaidSendRef.current = null;
    lastOrderRef.current = undefined;
    lastSentReadUptoRef.current = 0;

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

        // Presence snapshot; live transitions arrive on the group stream.
        try {
          const entries = await client.messaging.getGroupPresence({
            signer,
            groupRef: {uuid},
          });
          if (cancelled || uuidRef.current !== uuid) return;
          setPresenceRecords((prev) => applySnapshotEntries(prev, entries));
        } catch (err) {
          console.warn('Failed to load presence:', err);
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
  // Real-time subscription (messages, reactions, typing, presence)
  // ------------------------------------------------------------------
  useEffect(() => {
    // Don't subscribe while still loading initial messages
    if (loading) return;

    const controller = new AbortController();
    const myAddress = signer.toMySoAddress();

    async function startSubscription() {
      try {
        await resyncPresence();

        const stream = client.messaging.subscribe({
          signer,
          groupRef: {uuid},
          afterOrder: lastOrderRef.current,
          signal: controller.signal,
          mydataApproveContext: undefined
        });

        for await (const event of stream) {
          if (controller.signal.aborted || uuidRef.current !== uuid) break;
          switch (event.type) {
            case 'message':
              setMessages((prev) => mergeMessage(prev, event.message as Message));
              if (typeof event.message.order === 'number') {
                onGroupActivityRef.current?.(event.message.order);
              }
              break;
            case 'reaction':
              setReactions((prev) => applyReactionEvent(prev, event.reaction));
              break;
            case 'typing': {
              if (event.typing.member === myAddress) break;
              const member = event.typing.member;
              if (event.typing.typing) {
                const expiresMs = event.typing.expiresAt
                  ? event.typing.expiresAt * 1000
                  : Date.now() + 5_000;
                setTypingUntil((prev) => new Map(prev).set(member, expiresMs));
              } else {
                setTypingUntil((prev) => {
                  if (!prev.has(member)) return prev;
                  const next = new Map(prev);
                  next.delete(member);
                  return next;
                });
              }
              break;
            }
            case 'presence':
              setPresenceRecords((prev) =>
                applyWsPresence(
                  prev,
                  event.presence.member,
                  event.presence.online,
                ),
              );
              break;
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
  }, [uuid, client, signer, loading, resyncPresence]);

  // Periodic presence reconciliation + stale WS sweep.
  useEffect(() => {
    if (loading) return;

    const reconcileTimer = setInterval(() => {
      resyncPresence().then();
    }, 30_000);

    const sweepTimer = setInterval(() => {
      setPresenceRecords((prev) => sweepStaleWsPresence(prev));
    }, 5_000);

    return () => {
      clearInterval(reconcileTimer);
      clearInterval(sweepTimer);
    };
  }, [loading, resyncPresence]);

  // TTL fallback: clear typing indicators whose stop event never arrived.
  useEffect(() => {
    if (typingUntil.size === 0) return;
    const timer = setInterval(() => {
      const now = Date.now();
      setTypingUntil((prev) => {
        let changed = false;
        const next = new Map(prev);
        for (const [member, until] of next) {
          if (until <= now) {
            next.delete(member);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [typingUntil]);

  // Mark thread read + presence heartbeat for push gating.
  // Deduped: only writes when the watermark actually advances; on success the
  // sidebar badge is cleared instantly via onReadStateChanged.
  useEffect(() => {
    if (loading || !groupId || messages.length === 0) return;

    const maxOrder = Math.max(...messages.map((m) => m.order));
    if (!Number.isFinite(maxOrder)) return;

    if (maxOrder > lastSentReadUptoRef.current) {
      lastSentReadUptoRef.current = maxOrder;
      client.messaging
        .updateReadState({ signer, groupId, readUpto: maxOrder })
        .then(() => {
          onReadStateChangedRef.current?.(groupId);
        })
        .catch((err) => {
          // Allow a retry on the next messages change.
          if (lastSentReadUptoRef.current === maxOrder) {
            lastSentReadUptoRef.current = 0;
          }
          console.warn('Failed to update read state:', err);
        });
    }

    client.messaging.transport
      .postPresence({ signer, active: true })
      .catch((err) => console.warn('Failed to post presence:', err));
  }, [messages, loading, groupId, client, signer]);

  // ------------------------------------------------------------------
  // Typing broadcast (fire-and-forget, ephemeral)
  // ------------------------------------------------------------------
  const sendTyping = useCallback(
    (typing: boolean) => {
      client.messaging
        .sendTyping({ signer, groupRef: { uuid: uuidRef.current }, typing })
        .catch((err) => {
          console.warn('Failed to send typing:', err);
        });
    },
    [client, signer],
  );

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

  /**
   * Core send: relayer POST with membership-lag retries + optimistic append.
   * Throws on failure (including PaymentRequiredError from the paid-DM gate).
   */
  const performSend = useCallback(
    async (text: string, files?: AttachmentFile[]) => {
      const sendPayload = {
        signer,
        groupRef: { uuid: uuidRef.current },
        text: text || undefined,
        files,
        mydataApproveContext: undefined as undefined,
      };

      const maxAttempts = 5;
      let lastErr: unknown;
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
        text,
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
      onGroupActivityRef.current?.(optimistic.order);
    },
    [client, signer],
  );

  const sendMessage = useCallback(
    async (text: string, files?: AttachmentFile[]) => {
      const trimmed = text.trim();
      const hasFiles = files && files.length > 0;
      if (!trimmed && !hasFiles) return;

      if (claimPendingRef.current) {
        if (trimmed.length < minReplyChars) {
          setError(
            `Reply with at least ${minReplyChars} characters to claim the escrow.`,
          );
          return;
        }
      }

      setSending(true);
      setError(null);

      let claimCompleted = false;

      try {
        if (claimPendingRef.current) {
          setClaiming(true);
          const paid = createPaidMessagingClient({ messaging: client.messaging });
          const platformId = import.meta.env.VITE_PLATFORM_ID?.trim() || null;
          const { transaction } = platformId
            ? paid.buildReplyAndClaimSettledWithPlatform({
                groupRef: { uuid: uuidRef.current },
                paidMsgSeq: 0n,
                charCount: trimmed.length,
                platformId,
              })
            : paid.buildReplyAndClaimSettled({
                groupRef: { uuid: uuidRef.current },
                paidMsgSeq: 0n,
                charCount: trimmed.length,
                platformFeeRecipient: PAID_MSG_NO_PLATFORM_FEE_RECIPIENT,
              });
          await signAndExecuteTransactionAndWait(client, signer, transaction);
          claimCompleted = true;
        }

        await performSend(trimmed, hasFiles ? files : undefined);
      } catch (err) {
        if (claimPendingRef.current && !claimCompleted) {
          console.error('Failed to claim paid DM escrow:', err);
          setError(formatPaidClaimError(err, minReplyChars));
          return;
        }
        if (isPaymentRequiredError(err)) {
          // Paid-DM gate: stash the message and open the payment dialog.
          pendingPaidSendRef.current = {
            text: trimmed,
            files: hasFiles ? files : undefined,
          };
          setPaymentRequired({
            minCost: err.minCost ?? null,
            recipient: err.paymentRecipient ?? null,
          });
          setPaymentError(null);
          return;
        }
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
        setClaiming(false);
        setSending(false);
      }
    },
    [client, signer, groupId, performSend, minReplyChars],
  );

  // ------------------------------------------------------------------
  // Paid-DM gate: pay escrow on-chain, then retry the pending message
  // ------------------------------------------------------------------
  const confirmPayment = useCallback(async () => {
    const pending = pendingPaidSendRef.current;
    if (!pending || !paymentRequired) return;

    const { minCost, recipient } = paymentRequired;
    if (minCost === null || !recipient) {
      setPaymentError(
        'Missing payment details from the relayer. Close and try sending again.',
      );
      return;
    }

    setPaying(true);
    setPaymentError(null);

    try {
      // On-chain escrow via send_paid_message_digest (funded from gas). The
      // contract re-validates DM state, follow graph, and the recipient's
      // minimum — the relayer's 402 detail is advisory input only.
      // Built unsigned + signed through signAndExecuteTransactionAndWait so
      // gas coins are RPC-verified (a stale indexer after --force-regenesis
      // can list ghost coins that would become invalid PTB inputs).
      const paid = createPaidMessagingClient({ messaging: client.messaging });
      const { transaction } = paid.buildPayDmEscrow({
        groupRef: { uuid: uuidRef.current },
        recipient,
        escrowAmount: minCost,
      });
      await signAndExecuteTransactionAndWait(client, signer, transaction);

      // Retry until the relayer's checkpoint indexer sees PaidMessageSent.
      const maxAttempts = 10;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          await performSend(pending.text, pending.files);
          pendingPaidSendRef.current = null;
          setPaymentRequired(null);
          return;
        } catch (err) {
          if (isPaymentRequiredError(err) && attempt < maxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            continue;
          }
          throw err;
        }
      }
    } catch (err) {
      console.error('Failed to pay DM escrow:', err);
      setPaymentError(
        isPaymentRequiredError(err)
          ? 'Payment confirmed on-chain, but the relayer has not indexed it yet. Try sending again in a few seconds.'
          : formatRelayerError(err),
      );
    } finally {
      setPaying(false);
    }
  }, [client, signer, paymentRequired, performSend]);

  const cancelPayment = useCallback(() => {
    pendingPaidSendRef.current = null;
    setPaymentRequired(null);
    setPaymentError(null);
  }, []);

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
    typingMembers: [...typingUntil.keys()],
    onlineMembers,
    sendMessage,
    editMessage,
    deleteMessage: deleteMessageFn,
    toggleReaction,
    sendTyping,
    loadMore,
    paymentRequired,
    paying,
    claiming,
    paymentError,
    confirmPayment,
    cancelPayment,
  };
}

export {
  type AttachmentFile,
  type AttachmentHandle,
  type RelayerReactionEntry,
} from '@socialproof/myso-messaging-stack';