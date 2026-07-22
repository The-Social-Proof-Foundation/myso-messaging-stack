import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { ChevronLeft, Info } from 'lucide-react';
import type { StoredGroup } from '../lib/group-store';
import { removeStoredGroup } from '../lib/group-store';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';
import { signAndExecuteTransactionAndWait } from '../lib/sign-and-wait';
import { useMessages } from '../hooks/useMessages';
import { usePaidDmGate } from '../hooks/usePaidDmGate';
import { usePermissions } from '../hooks/usePermissions';
import { useWalletAvatarMap } from '../hooks/useWalletAvatarMap';
import { mistToMyso } from '../lib/mys-coin';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { TypingIndicator } from './TypingIndicator';
import { AdminPanel } from './AdminPanel';
import { PaymentConfirmDialog } from './PaymentConfirmDialog';
import { useGroupMemberLabels } from '../hooks/useGroupMemberLabels';
import { useDisplayGroupTitle } from '../hooks/useDisplayGroupTitle';
import { dmPeerPresenceStatus } from '../lib/presence-utils';
import { dmPeerAddress } from '../lib/wallet-profile';
import {
  computeTimeMarkers,
  formatBeginningCreated,
  formatDaySeparator,
} from '../lib/message-time';
import { useIsMobileNav } from '../hooks/useMediaQuery';
import {
  chatInfoWidthBand,
  type ChatInfoWidthBand,
} from '../lib/chat-layout';
import {
  REACTION_CHIP_CLEARANCE_PX,
  estimatedBubbleWidth,
  needsClearance,
  visibleReactionCount,
} from '../lib/reaction-stack-clearance';

interface ChatAreaProps {
  selectedGroup: StoredGroup | null;
  onLeaveGroup?: () => void;
  /** Called after the read watermark advances — clears the sidebar badge. */
  onReadStateChanged?: (groupId: string) => void;
  /** Called when a message is sent or received in the open thread. */
  onGroupActivity?: (order: number) => void;
  /** Phone stack: return to the conversation list (clears selection). */
  onMobileBack?: () => void;
  devAgentPanel?: ReactNode;
}

/** Case-insensitive MySo address compare (0x-prefixed hex). */
function sameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Wrapper that requires a UUID to render the chat. */
export function ChatArea({
  selectedGroup,
  onLeaveGroup,
  onReadStateChanged,
  onGroupActivity,
  onMobileBack,
  devAgentPanel,
}: Readonly<ChatAreaProps>) {
  if (!selectedGroup) {
    return (
      <div className="relative flex min-w-0 flex-1 flex-col">
        {onMobileBack ? (
          <div className="relative flex h-14 shrink-0 items-center border-b border-secondary-200/40 bg-white/65 px-2 backdrop-blur-xl dark:border-secondary-700/40 dark:bg-secondary-950/55">
            <button
              type="button"
              onClick={onMobileBack}
              aria-label="Back to conversations"
              className="inline-flex h-11 min-w-11 items-center justify-center gap-0.5 rounded-full px-2 text-sm font-medium text-secondary-600 hover:bg-secondary-100/80 dark:text-secondary-300 dark:hover:bg-secondary-800/80"
            >
              <ChevronLeft className="h-5 w-5 shrink-0" strokeWidth={2} />
              <span className="pr-1">Back</span>
            </button>
          </div>
        ) : null}
        <div className="flex flex-1 items-center justify-center">
          <p className="text-secondary-400 dark:text-secondary-500">
            Select a group to start chatting
          </p>
        </div>
      </div>
    );
  }

  // Groups discovered via events may not have a UUID
  if (!selectedGroup.uuid) {
    return (
      <div className="flex flex-1 flex-col">
        <DisplayChatHeader
          officialName={selectedGroup.name}
          onMobileBack={onMobileBack}
        />
        <div className="flex flex-1 items-center justify-center px-8 text-center">
          <p className="text-sm text-secondary-400 dark:text-secondary-500">
            This group was discovered via on-chain events.
            <br />
            Chatting requires the group UUID — try joining via an invite link.
          </p>
        </div>
      </div>
    );
  }

  return (
    <ChatView
      key={selectedGroup.uuid}
      group={selectedGroup}
      onLeaveGroup={onLeaveGroup}
      onReadStateChanged={onReadStateChanged}
      onGroupActivity={onGroupActivity}
      onMobileBack={onMobileBack}
      devAgentPanel={devAgentPanel}
    />
  );
}

type DmPresenceView =
  | { kind: 'online' }
  | { kind: 'lastOnline'; label: string }
  | null;

/** Header title: 1:1 → peer label; groups → official name minus self. */
function DisplayChatHeader(
  props: Readonly<{
    officialName: string;
    memberAddresses?: readonly string[];
    dmPresence?: DmPresenceView;
    permissionsLoading?: boolean;
    onToggleAdmin?: () => void;
    adminPanelOpen?: boolean;
    onMobileBack?: () => void;
    recoveryEnabled?: boolean;
    restoring?: boolean;
    onRestoreHistory?: () => void;
  }>,
) {
  const { officialName, memberAddresses = [], ...rest } = props;
  const name = useDisplayGroupTitle(officialName, memberAddresses);
  return <ChatHeader name={name} {...rest} />;
}

function ChatHeader({
  name,
  dmPresence,
  permissionsLoading,
  onToggleAdmin,
  adminPanelOpen,
  onMobileBack,
  recoveryEnabled,
  restoring,
  onRestoreHistory,
}: Readonly<{
  name: string;
  dmPresence?: DmPresenceView;
  permissionsLoading?: boolean;
  onToggleAdmin?: () => void;
  adminPanelOpen?: boolean;
  onMobileBack?: () => void;
  recoveryEnabled?: boolean;
  restoring?: boolean;
  onRestoreHistory?: () => void;
}>) {
  return (
    <div className="relative flex min-h-14 shrink-0 items-center justify-center border-b border-secondary-200/40 bg-white/65 px-5 py-2 backdrop-blur-xl md:h-14 md:py-0 dark:border-secondary-700/40 dark:bg-secondary-950/55">
      {onMobileBack ? (
        <button
          type="button"
          onClick={onMobileBack}
          aria-label="Back to conversations"
          className="absolute left-2 top-1/2 z-10 inline-flex h-11 min-w-11 -translate-y-1/2 items-center justify-center gap-0.5 rounded-full px-2 text-sm font-medium text-secondary-600 hover:bg-secondary-100/80 dark:text-secondary-300 dark:hover:bg-secondary-800/80"
        >
          <ChevronLeft className="h-5 w-5 shrink-0" strokeWidth={2} />
          <span className="pr-1">Back</span>
        </button>
      ) : null}
      <div
        className={`flex min-w-0 flex-col items-center gap-1 text-center ${
          onMobileBack
            ? 'mx-auto w-full max-w-[calc(100%-9.5rem)] md:max-w-[min(100%,20rem)]'
            : 'max-w-[min(100%,20rem)]'
        }`}
      >
        <h3 className="w-full line-clamp-2 text-[15px] font-semibold leading-tight tracking-tight text-secondary-900 md:truncate md:line-clamp-none dark:text-secondary-100">
          {name}
        </h3>
        {permissionsLoading ? (
          <span className="text-[11px] leading-none text-secondary-400 dark:text-secondary-500">
            Checking permissions…
          </span>
        ) : dmPresence?.kind === 'online' ? (
          <span className="flex items-center justify-center gap-1.5 text-[11px] leading-none text-secondary-400 dark:text-secondary-500">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500" />
            online
          </span>
        ) : dmPresence?.kind === 'lastOnline' ? (
          <span className="text-[11px] leading-none text-secondary-400 dark:text-secondary-500">
            last online {dmPresence.label}
          </span>
        ) : null}
      </div>
      <div className="absolute right-2 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1 md:right-4">
        {recoveryEnabled && onRestoreHistory ? (
          <button
            type="button"
            onClick={onRestoreHistory}
            disabled={restoring}
            aria-label="Restore history"
            title="Restore history from archive"
            className="inline-flex h-11 min-h-11 items-center rounded-full px-3 py-1.5 text-xs font-medium text-secondary-500 hover:bg-secondary-100/80 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-800/80 md:h-auto md:min-h-0"
          >
            {restoring ? 'Restoring…' : 'Restore'}
          </button>
        ) : null}
        {onToggleAdmin && (
          <button
            type="button"
            onClick={onToggleAdmin}
            aria-label="Group info"
            title="Group info"
            className={`inline-flex h-11 min-h-11 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium md:h-auto md:min-h-0 ${
              adminPanelOpen
                ? 'bg-bubble-sent/10 text-bubble-sent dark:bg-bubble-sent-dark/20 dark:text-bubble-sent-dark'
                : 'text-secondary-500 hover:bg-secondary-100/80 dark:text-secondary-400 dark:hover:bg-secondary-800/80'
            }`}
          >
            <Info
              className="h-5 w-5 shrink-0 md:h-3.5 md:w-3.5"
              strokeWidth={2}
            />
            <span className="hidden md:inline">Info</span>
          </button>
        )}
      </div>
    </div>
  );
}

/** Inner component that renders when we have a valid UUID. */
function ChatView({
  group,
  onLeaveGroup,
  onReadStateChanged,
  onGroupActivity,
  onMobileBack,
  devAgentPanel,
}: Readonly<{
  group: StoredGroup;
  onLeaveGroup?: () => void;
  onReadStateChanged?: (groupId: string) => void;
  onGroupActivity?: (order: number) => void;
  onMobileBack?: () => void;
  devAgentPanel?: ReactNode;
}>) {
  const myAddress = useAuthenticatedAddress();
  const { client, signer } = useRequiredMessagingClient();
  const { permissions, loading: permissionsLoading, refresh: refreshPermissions } =
    usePermissions(group.groupId);
  const isMobileNav = useIsMobileNav();
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const chatShellRef = useRef<HTMLDivElement>(null);
  const chatColumnRef = useRef<HTMLDivElement>(null);
  const adminPanelOpenRef = useRef(adminPanelOpen);
  adminPanelOpenRef.current = adminPanelOpen;
  const infoWidthBandRef = useRef<ChatInfoWidthBand | null>(null);
  /** User closed Info while wide — honor until the shell leaves the wide band. */
  const infoDismissedWhileWideRef = useRef(false);
  const {
    labelFor,
    memberAddresses,
    refresh: refreshMemberLabels,
  } = useGroupMemberLabels(group.groupId, {
    refreshKey: adminPanelOpen ? 1 : 0,
  });

  const toggleAdminPanel = useCallback(() => {
    setAdminPanelOpen((open) => {
      const next = !open;
      if (!next && infoWidthBandRef.current === 'wide') {
        infoDismissedWhileWideRef.current = true;
      }
      if (next) infoDismissedWhileWideRef.current = false;
      return next;
    });
  }, []);

  // Auto info: narrow → close, wide → open (unless user dismissed), mid → manual.
  useLayoutEffect(() => {
    if (isMobileNav) return;
    const shell = chatShellRef.current;
    if (!shell) return;
    infoWidthBandRef.current = null;
    infoDismissedWhileWideRef.current = false;

    const applyBand = () => {
      const shellWidth = shell.clientWidth;
      // Skip pre-layout zeros so we don't lock into "narrow" forever.
      if (shellWidth < 80) return;
      const chatWidth = chatColumnRef.current?.clientWidth ?? shellWidth;
      const band = chatInfoWidthBand(
        shellWidth,
        chatWidth,
        adminPanelOpenRef.current,
      );
      const prev = infoWidthBandRef.current;
      infoWidthBandRef.current = band;

      if (band !== 'wide') {
        infoDismissedWhileWideRef.current = false;
      }

      if (band === 'narrow') {
        setAdminPanelOpen(false);
      } else if (
        band === 'wide' &&
        !infoDismissedWhileWideRef.current &&
        (prev !== 'wide' || !adminPanelOpenRef.current)
      ) {
        // Open on enter-wide and whenever wide but currently closed (e.g. mount).
        setAdminPanelOpen(true);
      }
    };

    applyBand();
    const ro = new ResizeObserver(() => {
      requestAnimationFrame(applyBand);
    });
    ro.observe(shell);
    const column = chatColumnRef.current;
    if (column) ro.observe(column);
    return () => ro.disconnect();
  }, [isMobileNav, group.groupId]);
  const paidGate = usePaidDmGate(group);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Measured bubble column widths for reaction stack clearance refine. */
  const [measuredBubbleWidths, setMeasuredBubbleWidths] = useState<
    Map<string, number>
  >(() => new Map());
  const [scrollContentWidth, setScrollContentWidth] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setScrollContentWidth(el.clientWidth);
    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [group.groupId]);

  // Drop stale measurements when the thread changes.
  useEffect(() => {
    setMeasuredBubbleWidths(new Map());
  }, [group.groupId]);

  const onBubbleWidthChange = useCallback((messageId: string, width: number) => {
    setMeasuredBubbleWidths((prev) => {
      if (prev.get(messageId) === width) return prev;
      const next = new Map(prev);
      next.set(messageId, width);
      return next;
    });
  }, []);
  /**
   * Snapshot right before older messages merge (post-fetch). Restored in
   * useLayoutEffect so mid-flight scroll isn’t snapped back.
   */
  const olderScrollAnchorRef = useRef<{
    height: number;
    top: number;
    oldestId: string | null;
  } | null>(null);
  const oldestMessageIdRef = useRef<string | null>(null);

  const captureOlderScrollAnchor = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    olderScrollAnchorRef.current = {
      height: el.scrollHeight,
      top: el.scrollTop,
      oldestId: oldestMessageIdRef.current,
    };
  }, []);

  const {
    messages,
    loading,
    sending,
    claiming,
    error,
    hasMore,
    loadingOlder,
    reactions,
    typingMembers,
    onlineMembers,
    presenceRecords,
    initialReadUpto,
    sendMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    sendTyping,
    loadMore,
    recoveryEnabled,
    restoring,
    restoreHistory,
    paymentRequired,
    paying,
    paymentError,
    confirmPayment,
    cancelPayment,
  } = useMessages(group.uuid, group.groupId, {
    onReadStateChanged,
    claimPending: paidGate.claimPending,
    onGroupActivity,
    onBeforeOlderMessagesApply: captureOlderScrollAnchor,
  });

  oldestMessageIdRef.current = messages[0]?.messageId ?? null;

  const profileAddresses = useMemo(() => {
    const addrs = new Set<string>();
    for (const m of messages) {
      if (m.senderAddress) addrs.add(m.senderAddress);
    }
    for (const address of typingMembers) {
      if (address) addrs.add(address);
    }
    for (const entries of reactions.values()) {
      for (const entry of entries) {
        for (const reactor of entry.reactors) {
          if (reactor) addrs.add(reactor);
        }
      }
    }
    for (const address of memberAddresses) {
      if (address) addrs.add(address);
    }
    return [...addrs];
  }, [messages, reactions, typingMembers, memberAddresses]);
  const {
    photoFor,
    labelFor: profileLabelFor,
    ringFor,
  } = useWalletAvatarMap(profileAddresses);

  const typingTypers = typingMembers.map((address) => {
    const ring = ringFor(address);
    return {
      address,
      label: profileLabelFor(address) || labelFor(address),
      avatarSrc: photoFor(address),
      showRing: ring.showRing,
      ringPercent: ring.ringPercent,
    };
  });

  /**
   * Same-sender typers join the tip pack only when the latest message is from
   * that peer (not after our own tip — that starts a new turn with avatar).
   */
  const timeMarkers = useMemo(
    () => computeTimeMarkers(messages),
    [messages],
  );

  const {stackTypers, newPackTypers} = useMemo(() => {
    const tip = messages[messages.length - 1];
    const tipIsPeer =
      Boolean(tip?.senderAddress) && !sameAddress(tip!.senderAddress, myAddress);
    if (!tip || !tipIsPeer) {
      return {stackTypers: [] as typeof typingTypers, newPackTypers: typingTypers};
    }
    const stack: typeof typingTypers = [];
    const fresh: typeof typingTypers = [];
    for (const t of typingTypers) {
      if (sameAddress(t.address, tip.senderAddress)) stack.push(t);
      else fresh.push(t);
    }
    return {stackTypers: stack, newPackTypers: fresh};
  }, [typingTypers, messages, myAddress]);

  const dmPresence = useMemo((): DmPresenceView => {
    const peer = dmPeerAddress(memberAddresses, myAddress);
    if (!peer) return null;
    const status = dmPeerPresenceStatus(presenceRecords, peer);
    if (status.kind === 'online') return { kind: 'online' };
    if (status.kind === 'lastOnline') {
      return { kind: 'lastOnline', label: status.label };
    }
    return null;
  }, [memberAddresses, myAddress, presenceRecords]);

  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  const handleLeave = useCallback(async () => {
    setLeaving(true);
    setLeaveError(null);

    try {
      // Build the leave transaction via the SDK's tx layer
      const tx = client.messaging.tx.leave({
        groupId: group.groupId,
      });

      await signAndExecuteTransactionAndWait(client, signer, tx);

      // Remove from localStorage and deselect
      removeStoredGroup(group.uuid);
      onLeaveGroup?.();
    } catch (err) {
      console.error('Failed to leave group:', err);
      setLeaveError(
        err instanceof Error ? err.message : 'Failed to leave group.',
      );
      throw err;
    } finally {
      setLeaving(false);
    }
  }, [client, group, signer, onLeaveGroup]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const prevMessageCountRef = useRef(0);
  const didInitialScrollRef = useRef(false);

  const scrollToBottomSmooth = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  /** Land on first unread (order > watermark) or the bottom of the thread. */
  const performOpenScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;

    // readUpto === 0 means no watermark yet (or fetch failed) → open at bottom.
    const firstUnread =
      initialReadUpto > 0
        ? messages.find((m) => m.order > initialReadUpto)
        : undefined;
    if (firstUnread) {
      const node = el.querySelector(
        `[data-message-order="${firstUnread.order}"]`,
      );
      if (node instanceof HTMLElement) {
        // Align unread near the top, below the sticky header (~3.5rem).
        const headerOffset = 56;
        const delta =
          node.getBoundingClientRect().top -
          el.getBoundingClientRect().top -
          headerOffset;
        el.scrollTop = Math.max(0, el.scrollTop + delta);
        return;
      }
    }
    el.scrollTop = el.scrollHeight;
  }, [messages, initialReadUpto]);

  // Track whether the user is scrolled to the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 60; // px tolerance
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setIsAtBottom(atBottom);
  }, []);

  // Initial open: watermark scroll (or bottom), with a layout retry for late height
  useLayoutEffect(() => {
    if (loading || messages.length === 0 || didInitialScrollRef.current) {
      return;
    }
    didInitialScrollRef.current = true;
    prevMessageCountRef.current = messages.length;

    performOpenScroll();
    const prevHeight = scrollRef.current?.scrollHeight ?? 0;
    const raf = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      if (el.scrollHeight !== prevHeight || el.scrollTop < 8) {
        performOpenScroll();
      }
      handleScroll();
    });
    return () => cancelAnimationFrame(raf);
  }, [loading, messages.length, performOpenScroll, handleScroll]);

  // After older pages prepend, pin the viewport to the post-fetch anchor.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const anchor = olderScrollAnchorRef.current;
    if (!el || !anchor) return;
    const oldestId = messages[0]?.messageId ?? null;
    // Wait until the oldest row changes — that’s the prepend, not a tip append.
    if (oldestId === anchor.oldestId) return;

    const apply = () => {
      const node = scrollRef.current;
      if (!node) return;
      const diff = node.scrollHeight - anchor.height;
      if (diff > 0) {
        node.scrollTop = anchor.top + diff;
      }
    };
    apply();
    // Second pass after late cell height (images / fonts), same idea as iOS.
    const raf = requestAnimationFrame(apply);
    olderScrollAnchorRef.current = null;
    prevMessageCountRef.current = messages.length;
    handleScroll();
    return () => cancelAnimationFrame(raf);
  }, [messages.length, messages[0]?.messageId, handleScroll]);

  // Drop a stale anchor if the older fetch finished without a prepend.
  useEffect(() => {
    if (loadingOlder) return;
    if (!olderScrollAnchorRef.current) return;
    const id = requestAnimationFrame(() => {
      // Still waiting on oldestId change → fetch was a no-op / duplicate page.
      olderScrollAnchorRef.current = null;
    });
    return () => cancelAnimationFrame(id);
  }, [loadingOlder]);

  // Auto-scroll when new messages arrive (only if already at bottom)
  useEffect(() => {
    // Never tip-scroll while restoring an older-page anchor.
    if (olderScrollAnchorRef.current) {
      prevMessageCountRef.current = messages.length;
      return;
    }
    if (
      !didInitialScrollRef.current ||
      !isAtBottom ||
      messages.length === 0 ||
      messages.length <= prevMessageCountRef.current
    ) {
      prevMessageCountRef.current = messages.length;
      return;
    }
    prevMessageCountRef.current = messages.length;
    scrollToBottomSmooth();
  }, [messages.length, isAtBottom, scrollToBottomSmooth]);

  // Keep typing bubble visible when near the bottom of the thread.
  useEffect(() => {
    if (isAtBottom && typingMembers.length > 0 && didInitialScrollRef.current) {
      scrollToBottomSmooth();
    }
  }, [typingMembers.length, isAtBottom, scrollToBottomSmooth]);

  // Infinite scroll: load older when the top sentinel enters the scrollport.
  const olderSentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = olderSentinelRef.current;
    if (!root || !sentinel || loading || !hasMore) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loadingOlder) {
          void loadMore();
        }
      },
      {root, rootMargin: '80px 0px 0px 0px', threshold: 0},
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loading, hasMore, loadingOlder, loadMore, messages.length]);

  const scrollToBottom = useCallback(() => {
    scrollToBottomSmooth();
  }, [scrollToBottomSmooth]);

  return (
    <div ref={chatShellRef} className="flex min-w-0 flex-1 overflow-hidden">
      {/* On mobile, Group Info is its own full view — hide chat while open */}
      <div
        ref={chatColumnRef}
        className={`min-w-0 flex-1 flex-col ${
          adminPanelOpen ? 'hidden md:flex' : 'flex'
        }`}
      >
      {/* Messages area — header sticky so content can scroll under the blur */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
        style={{overflowAnchor: 'none'}}
      >
        <div className="sticky top-0 z-30">
          <DisplayChatHeader
            officialName={group.name}
            memberAddresses={memberAddresses}
            dmPresence={dmPresence}
            permissionsLoading={permissionsLoading}
            onToggleAdmin={toggleAdminPanel}
            adminPanelOpen={adminPanelOpen}
            onMobileBack={onMobileBack}
            recoveryEnabled={recoveryEnabled}
            restoring={restoring}
            onRestoreHistory={() => {
              void restoreHistory();
            }}
          />
        </div>

        {/* Loading skeleton */}
        {loading && (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && messages.length === 0 && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6">
            <p className="text-sm text-secondary-400 dark:text-secondary-500">
              No messages yet. Send the first one!
            </p>
            {recoveryEnabled ? (
              <button
                type="button"
                onClick={() => {
                  void restoreHistory();
                }}
                disabled={restoring}
                className="text-xs font-medium text-primary-500 hover:text-primary-600 disabled:opacity-50"
              >
                {restoring ? 'Restoring history…' : 'Restore history'}
              </button>
            ) : null}
          </div>
        )}

        {/* Message list */}
        {!loading && messages.length > 0 && (
          <div className="flex flex-col pb-4 pt-6">
            {/* Older-page sentinel (iOS-style scroll-to-top paging) */}
            {hasMore ? (
              <div
                ref={olderSentinelRef}
                className="flex min-h-8 items-center justify-center py-2"
                aria-hidden={!loadingOlder}
              >
                {loadingOlder ? (
                  <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
                ) : null}
              </div>
            ) : (
              <div className="mb-4 flex flex-col items-center gap-2 px-4 pt-2 text-center">
                <p className="text-[13px] font-semibold text-secondary-600/80 dark:text-secondary-300/80">
                  Beginning of Chat
                </p>
                <p className="text-xs text-secondary-400/80 dark:text-secondary-500/70">
                  created on{' '}
                  {formatBeginningCreated(
                    group.createdAt > 0
                      ? group.createdAt
                      : messages[0]!.createdAt,
                  )}
                </p>
              </div>
            )}
            {messages.map((msg, index) => {
              const isOwn = sameAddress(msg.senderAddress, myAddress);
              const prev = messages[index - 1];
              const next = messages[index + 1];
              const marker = timeMarkers.get(msg.messageId);
              const nextMarker = next
                ? timeMarkers.get(next.messageId)
                : undefined;
              // Time markers cut packs (same as iOS).
              const breakAfterPrev = Boolean(marker);
              const breakBeforeNext = Boolean(nextMarker);
              const isFirstInGroup =
                !prev ||
                !sameAddress(prev.senderAddress, msg.senderAddress) ||
                breakAfterPrev;
              // Same-sender typing owns pack tip chrome — tip message is mid-stack.
              const typingContinuesPack =
                index === messages.length - 1 && stackTypers.length > 0;
              const isLastInGroup = typingContinuesPack
                ? false
                : !next ||
                  !sameAddress(next.senderAddress, msg.senderAddress) ||
                  breakBeforeNext;
              // Same-sender stack clearance (iOS ReactionStackClearance).
              const olderSameSender = !isFirstInGroup;
              const msgReactions = reactions.get(msg.order);
              const reactionCount = visibleReactionCount(msgReactions);
              const maxBubbleW = Math.max(
                (scrollContentWidth || 360) * 0.78,
                80,
              );
              const hasImage = (msg.attachments ?? []).some((a) =>
                a.mimeType?.startsWith('image/'),
              );
              const currWidth =
                measuredBubbleWidths.get(msg.messageId) ??
                estimatedBubbleWidth({
                  text: msg.isDeleted ? '' : msg.text,
                  isDeleted: msg.isDeleted,
                  hasImage,
                  maxWidth: maxBubbleW,
                });
              let prevWidth = 0;
              if (olderSameSender && prev) {
                const prevHasImage = (prev.attachments ?? []).some((a) =>
                  a.mimeType?.startsWith('image/'),
                );
                prevWidth =
                  measuredBubbleWidths.get(prev.messageId) ??
                  estimatedBubbleWidth({
                    text: prev.isDeleted ? '' : prev.text,
                    isDeleted: prev.isDeleted,
                    hasImage: prevHasImage,
                    maxWidth: maxBubbleW,
                  });
              }
              const reactionTopClearancePx = needsClearance({
                olderSameSender,
                prevWidth,
                currWidth,
                reactionCount,
              })
                ? REACTION_CHIP_CLEARANCE_PX
                : 0;
              return (
                <div key={msg.messageId}>
                  {marker && (
                    <div className="my-3 flex justify-center px-4">
                      <p className="text-[13px] font-semibold text-secondary-600/80 dark:text-secondary-300/80">
                        {formatDaySeparator(msg.createdAt, {
                          includeTime: marker.includeTime,
                        })}
                      </p>
                    </div>
                  )}
                  <MessageBubble
                    message={msg}
                    isOwnMessage={isOwn}
                    onEdit={isOwn && permissions.canEdit ? editMessage : undefined}
                    onDelete={
                      isOwn && permissions.canDelete ? deleteMessage : undefined
                    }
                    reactions={msgReactions}
                    onToggleReaction={
                      permissions.canSend ? toggleReaction : undefined
                    }
                    myAddress={myAddress ?? undefined}
                    preferReactionBelow={index === 0}
                    isFirstInGroup={isFirstInGroup}
                    isLastInGroup={isLastInGroup}
                    reactionTopClearancePx={reactionTopClearancePx}
                    onBubbleWidthChange={onBubbleWidthChange}
                    avatarSrc={
                      msg.senderAddress
                        ? photoFor(msg.senderAddress)
                        : null
                    }
                    labelForAddress={profileLabelFor}
                    avatarShowRing={
                      msg.senderAddress
                        ? ringFor(msg.senderAddress).showRing
                        : false
                    }
                    avatarRingPercent={
                      msg.senderAddress
                        ? ringFor(msg.senderAddress).ringPercent
                        : 0
                    }
                  />
                </div>
              );
            })}
          </div>
        )}

        {stackTypers.length > 0 && (
          <TypingIndicator typers={stackTypers} continueStack />
        )}
        {newPackTypers.length > 0 && (
          <TypingIndicator typers={newPackTypers} />
        )}

        <div ref={bottomRef} />
      </div>

      {/* Scroll to bottom FAB — z above message avatars (z-20) */}
      {!isAtBottom && messages.length > 0 && (
        <div className="relative z-30">
          <button
            onClick={scrollToBottom}
            className="absolute -top-12 right-4 flex h-9 w-9 items-center justify-center rounded-full border border-secondary-200/80 bg-white text-secondary-600 shadow-md transition-colors hover:bg-secondary-50 dark:border-secondary-600 dark:bg-secondary-800 dark:text-secondary-300 dark:hover:bg-secondary-700"
            aria-label="Scroll to bottom"
          >
            ↓
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="border-t border-danger-400 bg-danger-400/10 px-4 py-2 text-sm text-danger-500 dark:border-danger-500 dark:text-danger-400">
          {permissions.canSend &&
          (error.includes('relayer has not synced') ||
            error.includes('waiting for relayer sync'))
            ? 'On-chain permissions OK — waiting for relayer sync. Try again in a few seconds.'
            : error}
        </div>
      )}

      {devAgentPanel}

      {/* Reply-to-claim: the peer paid an escrow that our first reply claims */}
      {paidGate.claimPending && !permissionsLoading && permissions.canSend && (
        <div className="border-t border-amber-300 bg-amber-50 px-4 py-2 text-center text-xs font-medium text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100">
          Reply with at least 6 characters to claim{' '}
          {paidGate.peerEscrowAmount !== null
            ? `${mistToMyso(paidGate.peerEscrowAmount)} MYSO`
            : 'the escrow'}{' '}
          from this sender.
        </div>
      )}

      {/* Message input: while permissions load, show disabled composer (avoid false "no permission"). */}
      {permissionsLoading ? (
        <MessageInput
          onSend={async () => {}}
          disabled
          sending={false}
        />
      ) : permissions.canSend ? (
        <>
          {claiming && (
            <p className="border-t border-secondary-200 px-4 py-1 text-center text-xs text-secondary-500 dark:border-secondary-700 dark:text-secondary-400">
              Claiming escrow…
            </p>
          )}
          <MessageInput
            onSend={async (text, files) => {
              await sendMessage(text, files);
              paidGate.refresh();
            }}
            onTyping={sendTyping}
            sending={sending || claiming}
          />
        </>
      ) : (
        <div className="border-t border-secondary-200 px-4 py-3 text-center text-xs text-secondary-400 dark:border-secondary-700 dark:text-secondary-500">
          You don't have permission to send messages in this group.
        </div>
      )}

      {/* Paid-DM gate: confirm on-chain escrow, then the pending send retries */}
      <PaymentConfirmDialog
        open={paymentRequired !== null}
        recipient={paymentRequired?.recipient ?? null}
        minCost={paymentRequired?.minCost ?? null}
        busy={paying}
        error={paymentError}
        onConfirm={() => void confirmPayment()}
        onCancel={cancelPayment}
      />

    </div>

      {/* Admin / Group Info panel */}
      <AdminPanel
        open={adminPanelOpen}
        onClose={() => setAdminPanelOpen(false)}
        groupId={group.groupId}
        groupUuid={group.uuid}
        groupName={group.name}
        permissions={permissions}
        onPermissionsChanged={() => {
          refreshPermissions();
          refreshMemberLabels();
        }}
        onlineMembers={onlineMembers}
        onLeaveGroup={handleLeave}
        leaving={leaving}
        leaveError={leaveError}
        photoFor={photoFor}
        labelFor={profileLabelFor}
        ringFor={ringFor}
      />
    </div>
  );
}
