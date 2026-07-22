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
import { isMessageRecoveryEnabled } from '../lib/messaging-client-factory';
import { signAndExecuteTransactionAndWait } from '../lib/sign-and-wait';
import {
  applySnapshotEntries,
  applyWsPresence,
  presenceRecordsToOnlineMap,
  type PresenceRecord,
} from '../lib/presence-utils';
import {
  getCachedThread,
  setCachedThread,
  type CachedMessage,
} from '../lib/message-session-cache';
import {
  MESSAGE_CATCHUP_MAX_PAGES,
  MESSAGE_PAGE_SIZE,
  applyNewerOrdersToLedger,
  applyOlderPageToLedger,
  emptyPageLedger,
  ledgerFromMessages,
  shouldFetchOlderPage,
  shouldWarmCatchUpOnly,
  type ThreadPageLedger,
} from '../lib/message-page-ledger';
import { publishSidebarMessagePreview } from './useSidebarMessagePreviews';

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
  /** Older page fetch in flight (scroll sentinel / loadMore). */
  loadingOlder: boolean;
  reactions: MessageReactions;
  /** Members (excluding self) currently typing. */
  typingMembers: string[];
  /** Online state per member (presence snapshot + live events). */
  onlineMembers: Map<string, boolean>;
  /** Full presence records (includes lastSeenAt for offline peers). */
  presenceRecords: Map<string, PresenceRecord>;
  /**
   * Relayer read watermark at open time (exclusive). Messages with
   * `order > initialReadUpto` are unread for initial scroll positioning.
   */
  initialReadUpto: number;
  sendMessage: (text: string, files?: AttachmentFile[]) => Promise<void>;
  editMessage: (messageId: string, text: string) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  toggleReaction: (order: number, emoji: string) => Promise<void>;
  /** Broadcast the signer's typing state (fire-and-forget, ephemeral). */
  sendTyping: (typing: boolean) => void;
  loadMore: () => Promise<void>;
  /** True when Cloudflare archive recovery is enabled for this build. */
  recoveryEnabled: boolean;
  /** Archive restore in flight. */
  restoring: boolean;
  /** Opt-in restore from the configured archive (merge into live history). */
  restoreHistory: () => Promise<void>;
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
  /**
   * Called synchronously right before older-page messages are merged into state.
   * Use to snapshot scroll position after the fetch, not before it starts.
   */
  onBeforeOlderMessagesApply?: () => void;
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

  // Drop local optimistic stubs once the relayer echo for that order arrives.
  const confirmedOrders = new Set(
    [...byId.values()]
      .filter((m) => !m.messageId.startsWith('optimistic-'))
      .map((m) => m.order),
  );
  for (const [id, m] of byId) {
    if (id.startsWith('optimistic-') && confirmedOrders.has(m.order)) {
      byId.delete(id);
    }
  }

  return sortMessagesByOrder([...byId.values()]);
}

/** Deduplicate and merge a new message into the list (sorted by order). */
function mergeMessage(prev: Message[], incoming: Message): Message[] {
  return mergeMessages(prev, [incoming]);
}

/** Local preview handles so optimistic sends show images before upload finishes. */
function localAttachmentHandles(files: AttachmentFile[]): AttachmentHandle[] {
  return files.map((file) => {
    const bytes = file.data;
    return {
      fileName: file.fileName,
      mimeType: file.mimeType,
      fileSize: bytes.byteLength,
      extras: file.extras,
      wire: {
        storageId: '',
        nonce: '',
        encryptedMetadata: '',
        metadataNonce: '',
      },
      data: async () => bytes,
    };
  });
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

  const recoveryEnabled = isMessageRecoveryEnabled();
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [sending, setSending] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [initialReadUpto, setInitialReadUpto] = useState(0);
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
  const onBeforeOlderMessagesApplyRef = useRef(
    options?.onBeforeOlderMessagesApply,
  );
  onBeforeOlderMessagesApplyRef.current = options?.onBeforeOlderMessagesApply;
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
  const pageLedgerRef = useRef<ThreadPageLedger>(emptyPageLedger());
  const messageCountRef = useRef(0);
  const isLoadingInitialRef = useRef(false);
  const isLoadingOlderRef = useRef(false);
  const isCatchingUpRef = useRef(false);
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

  // Keep tip cursor + ledger window bounds in sync with the live list.
  useEffect(() => {
    messageCountRef.current = messages.length;
    if (messages.length === 0) return;
    lastOrderRef.current = messages.at(-1)?.order;
    const orders = messages.map((m) => m.order);
    pageLedgerRef.current = {
      ...pageLedgerRef.current,
      minOrder: Math.min(...orders),
      maxOrder: Math.max(...orders),
    };
  }, [messages]);

  // ------------------------------------------------------------------
  // Load initial messages (stale-while-revalidate via session memory cache)
  // Warm cache: after_order catch-up only (no tip re-query).
  // Cold cache: tip window + seed page ledger.
  // ------------------------------------------------------------------
  useEffect(() => {
    const cached = getCachedThread(uuid);
    const warm =
      Boolean(cached && cached.messages.length > 0) &&
      shouldWarmCatchUpOnly(cached!.pageLedger);

    if (cached && cached.messages.length > 0) {
      pageLedgerRef.current = cached.pageLedger;
      setMessages(cached.messages as Message[]);
      setHasMore(cached.pageLedger.hasMoreOlder);
      setReactions(cached.reactions);
      setLoading(false);
    } else {
      pageLedgerRef.current = emptyPageLedger();
      setMessages([]);
      setHasMore(false);
      setReactions(new Map());
      setLoading(true);
    }
    setLoadingOlder(false);
    setError(null);
    setInitialReadUpto(0);
    setTypingUntil(new Map());
    setPresenceRecords(new Map());
    setPaymentRequired(null);
    setPaymentError(null);
    pendingPaidSendRef.current = null;
    lastOrderRef.current = cached?.messages.at(-1)?.order;
    lastSentReadUptoRef.current = 0;
    isLoadingInitialRef.current = true;
    isLoadingOlderRef.current = false;
    isCatchingUpRef.current = false;

    let cancelled = false;

    async function loadReadState() {
      try {
        const readState = await client.messaging.getReadState({signer});
        if (cancelled || uuidRef.current !== uuid) return;
        const readUpto = readState?.groups[groupId]?.readUpto ?? 0;
        setInitialReadUpto(readUpto);
      } catch (err) {
        console.warn('Failed to load read state:', err);
      }
    }

    async function loadReactions(
      fallback: MessageReactions | undefined,
    ): Promise<MessageReactions> {
      try {
        const rows = await client.messaging.listReactions({
          signer,
          groupRef: {uuid},
        });
        if (cancelled || uuidRef.current !== uuid) {
          return fallback ?? new Map();
        }
        const next = groupReactionsByOrder(rows);
        setReactions(next);
        return next;
      } catch (err) {
        console.warn('Failed to load reactions:', err);
        if (fallback) {
          setReactions(fallback);
          return fallback;
        }
        return new Map();
      }
    }

    async function loadPresence() {
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
    }

    async function catchUpFrom(
      afterOrder: number,
      base: Message[],
      ledger: ThreadPageLedger,
    ): Promise<{messages: Message[]; ledger: ThreadPageLedger}> {
      let merged = base;
      let nextLedger = ledger;
      let cursor = afterOrder;
      for (let i = 0; i < MESSAGE_CATCHUP_MAX_PAGES; i++) {
        const result = (await client.messaging.getMessages({
          signer,
          groupRef: {uuid},
          afterOrder: cursor,
          limit: MESSAGE_PAGE_SIZE,
          mydataApproveContext: undefined,
        })) as SDKGetMessagesResult;
        if (cancelled || uuidRef.current !== uuid) {
          return {messages: merged, ledger: nextLedger};
        }
        if (result.messages.length === 0) {
          nextLedger = applyNewerOrdersToLedger(nextLedger, []);
          break;
        }
        const orders = result.messages.map((m) => m.order);
        merged = mergeMessages(merged, result.messages);
        nextLedger = applyNewerOrdersToLedger(nextLedger, orders);
        cursor = nextLedger.maxOrder ?? cursor;
        if (!result.hasNext) break;
      }
      return {messages: merged, ledger: nextLedger};
    }

    async function loadInitial() {
      try {
        void loadReadState();

        let initial: Message[];
        let nextLedger: ThreadPageLedger;

        if (warm && cached) {
          // Warm open: never re-fetch the tip window — catch up newer only.
          const caught = await catchUpFrom(
            cached.pageLedger.maxOrder!,
            cached.messages as Message[],
            cached.pageLedger,
          );
          initial = caught.messages;
          nextLedger = caught.ledger;
        } else {
          const result = (await client.messaging.getMessages({
            signer,
            groupRef: {uuid},
            limit: MESSAGE_PAGE_SIZE,
            mydataApproveContext: undefined,
          })) as SDKGetMessagesResult;

          if (cancelled || uuidRef.current !== uuid) return;

          initial = sortMessagesByOrder(result.messages);
          if (recoveryEnabled && initial.length === 0) {
            try {
              const recovered = await client.messaging.recoverMessages({
                groupRef: {uuid},
                limit: MESSAGE_PAGE_SIZE,
                mydataApproveContext: undefined,
              });
              if (cancelled || uuidRef.current !== uuid) return;
              const verified = recovered.messages.filter(
                (m) => m.senderVerified !== false,
              );
              const dropped = recovered.messages.length - verified.length;
              if (dropped > 0) {
                console.warn(
                  `Dropped ${dropped} unverified recovered message(s)`,
                );
              }
              initial = mergeMessages(verified as Message[], initial);
            } catch (err) {
              console.warn('Silent history restore failed:', err);
            }
          }

          if (cached && cached.messages.length > 0) {
            initial = mergeMessages(cached.messages as Message[], initial);
          }

          let hasMoreOlder = result.hasNext;
          if (cached && cached.messages.length > 0 && result.messages.length > 0) {
            const oldestFetched = Math.min(
              ...result.messages.map((m) => m.order),
            );
            const hasOlderCached = cached.messages.some(
              (m) => m.order < oldestFetched,
            );
            if (hasOlderCached) {
              hasMoreOlder = cached.pageLedger.hasMoreOlder;
            }
          }

          nextLedger = ledgerFromMessages(
            initial.map((m) => m.order),
            hasMoreOlder,
          );
          // Preserve older-page cursors when merging a cold tip onto a partial cache.
          if (cached?.pageLedger.fetchedBeforeOrders.length) {
            nextLedger = {
              ...nextLedger,
              fetchedBeforeOrders: [...cached.pageLedger.fetchedBeforeOrders],
              hasMoreOlder,
            };
          }
        }

        if (cancelled || uuidRef.current !== uuid) return;

        pageLedgerRef.current = nextLedger;
        setMessages(initial);
        setHasMore(nextLedger.hasMoreOlder);

        const nextReactions = await loadReactions(cached?.reactions);
        if (cancelled || uuidRef.current !== uuid) return;

        setCachedThread(uuid, {
          messages: initial as CachedMessage[],
          hasMore: nextLedger.hasMoreOlder,
          pageLedger: nextLedger,
          reactions: nextReactions,
        });

        await loadPresence();
      } catch (err) {
        if (cancelled || uuidRef.current !== uuid) return;
        console.error('Failed to load messages:', err);
        setError(
          err instanceof Error ? err.message : 'Failed to load messages.',
        );
      } finally {
        if (!cancelled && uuidRef.current === uuid) {
          isLoadingInitialRef.current = false;
          setLoading(false);
        }
      }
    }

    void loadInitial();

    return () => {
      cancelled = true;
      isLoadingInitialRef.current = false;
    };
  }, [uuid, groupId, client, signer, recoveryEnabled]);

  // Write-through: keep session cache warm across remounts (subscribe/send/edit/pages).
  useEffect(() => {
    if (loading && messages.length === 0) return;
    const stored = setCachedThread(uuid, {
      messages: messages as CachedMessage[],
      hasMore: pageLedgerRef.current.hasMoreOlder,
      pageLedger: pageLedgerRef.current,
      reactions,
    });
    // Trim may invalidate older cursors — keep the live ref aligned.
    pageLedgerRef.current = stored;
    if (stored.hasMoreOlder !== hasMore) {
      setHasMore(stored.hasMoreOlder);
    }
    const tip = messages[messages.length - 1];
    if (tip && groupId) {
      publishSidebarMessagePreview(groupId, tip);
    }
  }, [uuid, groupId, messages, hasMore, reactions, loading]);

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

  // Periodic presence reconciliation (snapshot). Live transitions arrive via WS.
  useEffect(() => {
    if (loading) return;

    const reconcileTimer = setInterval(() => {
      resyncPresence().then();
    }, 30_000);

    return () => {
      clearInterval(reconcileTimer);
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
  // Tip catch-up (after_order) — focus / visibility; never re-fetches tip window
  // ------------------------------------------------------------------
  const catchUpNewerMessages = useCallback(async () => {
    if (
      isCatchingUpRef.current ||
      isLoadingInitialRef.current ||
      loading ||
      pageLedgerRef.current.maxOrder === null
    ) {
      return;
    }
    isCatchingUpRef.current = true;
    try {
      let cursor = pageLedgerRef.current.maxOrder;
      for (let i = 0; i < MESSAGE_CATCHUP_MAX_PAGES; i++) {
        const result = (await client.messaging.getMessages({
          signer,
          groupRef: {uuid: uuidRef.current},
          afterOrder: cursor,
          limit: MESSAGE_PAGE_SIZE,
          mydataApproveContext: undefined,
        })) as SDKGetMessagesResult;
        if (uuidRef.current !== uuid) return;
        if (result.messages.length === 0) {
          pageLedgerRef.current = applyNewerOrdersToLedger(
            pageLedgerRef.current,
            [],
          );
          break;
        }
        const orders = result.messages.map((m) => m.order);
        setMessages((prev) => mergeMessages(prev, result.messages));
        pageLedgerRef.current = applyNewerOrdersToLedger(
          pageLedgerRef.current,
          orders,
        );
        cursor = pageLedgerRef.current.maxOrder ?? cursor;
        if (!result.hasNext) break;
      }
    } catch (err) {
      console.warn('Failed to catch up newer messages:', err);
    } finally {
      isCatchingUpRef.current = false;
    }
  }, [uuid, loading, client, signer]);

  useEffect(() => {
    if (loading) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        void catchUpNewerMessages();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [loading, catchUpNewerMessages]);

  // ------------------------------------------------------------------
  // Load older messages (before_order) — skip cursors already fetched
  // ------------------------------------------------------------------
  const loadMore = useCallback(async () => {
    const decision = shouldFetchOlderPage(pageLedgerRef.current, {
      isLoadingOlder: isLoadingOlderRef.current,
      isLoadingInitial: isLoadingInitialRef.current,
      messageCount: messageCountRef.current,
    });
    if (!decision.fetch) return;

    isLoadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const result = (await client.messaging.getMessages({
        signer,
        groupRef: {uuid: uuidRef.current},
        beforeOrder: decision.beforeOrder,
        limit: MESSAGE_PAGE_SIZE,
        mydataApproveContext: undefined,
      })) as SDKGetMessagesResult;

      if (uuidRef.current !== uuid) return;

      const orders = result.messages.map((m) => m.order);
      // Snapshot scroll *now* (post-fetch) so mid-flight scroll isn’t “corrected”.
      onBeforeOlderMessagesApplyRef.current?.();
      setMessages((prev) => mergeMessages(prev, result.messages));
      const nextLedger = applyOlderPageToLedger(
        pageLedgerRef.current,
        decision.beforeOrder,
        orders,
        result.hasNext,
      );
      pageLedgerRef.current = nextLedger;
      setHasMore(nextLedger.hasMoreOlder);
    } catch (err) {
      console.error('Failed to load more messages:', err);
    } finally {
      isLoadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [uuid, client, signer]);

  // ------------------------------------------------------------------
  // Send a new message
  // ------------------------------------------------------------------

  /**
   * Core send: relayer POST with membership-lag retries + optimistic append.
   * Throws on failure (including PaymentRequiredError from the paid-DM gate).
   */
  const performSend = useCallback(
    async (text: string, files?: AttachmentFile[]) => {
      // Show the bubble (with local image preview) immediately while uploading.
      const tempId = `optimistic-${crypto.randomUUID()}`;
      const optimisticOrder = (lastOrderRef.current ?? 0) + 1;
      lastOrderRef.current = optimisticOrder;
      const optimistic: Message = {
        messageId: tempId,
        groupId: '',
        order: optimisticOrder,
        text,
        senderAddress: signer.toMySoAddress(),
        createdAt: Date.now() / 1000,
        updatedAt: Date.now() / 1000,
        isEdited: false,
        isDeleted: false,
        syncStatus: 'SYNC_PENDING',
        attachments: files?.length ? localAttachmentHandles(files) : [],
        senderVerified: false,
      };
      setMessages((prev) => mergeMessage(prev, optimistic));
      onGroupActivityRef.current?.(optimistic.order);

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

      try {
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

        const confirmedId = messageId;

        // Swap temp id for the relayer id (keep local preview until echo arrives).
        setMessages((prev) => {
          const fromTemp = prev.find((m) => m.messageId === tempId);
          const fromServer = prev.find((m) => m.messageId === confirmedId);
          const rest = prev.filter(
            (m) => m.messageId !== tempId && m.messageId !== confirmedId,
          );
          if (fromServer) {
            return sortMessagesByOrder([...rest, fromServer]);
          }
          if (fromTemp) {
            return sortMessagesByOrder([
              ...rest,
              {
                ...fromTemp,
                messageId: confirmedId,
                syncStatus: 'SYNC_PENDING',
              },
            ]);
          }
          return prev;
        });
      } catch (err) {
        setMessages((prev) => prev.filter((m) => m.messageId !== tempId));
        throw err;
      }
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

  const restoreHistory = useCallback(async () => {
    if (!recoveryEnabled || restoring) return;
    setRestoring(true);
    setError(null);
    try {
      const recovered = await client.messaging.recoverMessages({
        groupRef: { uuid: uuidRef.current },
        limit: 100,
        mydataApproveContext: undefined,
      });
      const verified = recovered.messages.filter((m) => m.senderVerified !== false);
      const dropped = recovered.messages.length - verified.length;
      if (dropped > 0) {
        console.warn(`Dropped ${dropped} unverified recovered message(s)`);
      }
      setMessages((prev) => mergeMessages(verified as Message[], prev));
    } catch (err) {
      console.error('Failed to restore history:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to restore history.',
      );
    } finally {
      setRestoring(false);
    }
  }, [client, recoveryEnabled, restoring]);

  return {
    messages,
    loading,
    sending,
    error,
    hasMore,
    loadingOlder,
    reactions,
    typingMembers: [...typingUntil.keys()],
    onlineMembers,
    presenceRecords,
    initialReadUpto,
    sendMessage,
    editMessage,
    deleteMessage: deleteMessageFn,
    toggleReaction,
    sendTyping,
    loadMore,
    recoveryEnabled,
    restoring,
    restoreHistory,
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