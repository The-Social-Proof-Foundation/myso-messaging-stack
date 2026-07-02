import { useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import type { StoredGroup } from '../lib/group-store';
import { removeStoredGroup } from '../lib/group-store';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';
import { useAuthenticatedAddress } from '../contexts/MySocialAuthContext';
import { signAndExecuteTransactionAndWait } from '../lib/sign-and-wait';
import { useMessages } from '../hooks/useMessages';
import { usePermissions } from '../hooks/usePermissions';
import { MessageBubble } from './MessageBubble';
import { MessageInput } from './MessageInput';
import { AdminPanel } from './AdminPanel';

interface ChatAreaProps {
  selectedGroup: StoredGroup | null;
  onLeaveGroup?: () => void;
  devAgentPanel?: ReactNode;
}

/** Wrapper that requires a UUID to render the chat. */
export function ChatArea({
  selectedGroup,
  onLeaveGroup,
  devAgentPanel,
}: Readonly<ChatAreaProps>) {
  if (!selectedGroup) {
    return (
      <div className="flex min-w-0 flex-1 items-center justify-center">
        <p className="text-secondary-400 dark:text-secondary-500">
          Select a group to start chatting
        </p>
      </div>
    );
  }

  // Groups discovered via events may not have a UUID
  if (!selectedGroup.uuid) {
    return (
      <div className="flex flex-1 flex-col">
        <ChatHeader name={selectedGroup.name} />
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
      group={selectedGroup}
      onLeaveGroup={onLeaveGroup}
      devAgentPanel={devAgentPanel}
    />
  );
}

function ChatHeader({
  name,
  onLeaveClick,
  leaving,
  onToggleAdmin,
  adminPanelOpen,
}: Readonly<{
  name: string;
  onLeaveClick?: () => void;
  leaving?: boolean;
  onToggleAdmin?: () => void;
  adminPanelOpen?: boolean;
}>) {
  return (
    <div className="flex items-center justify-between border-b border-secondary-200 px-6 py-3 dark:border-secondary-700">
      <h3 className="text-sm font-semibold text-secondary-800 dark:text-secondary-200">
        {name}
      </h3>
      <div className="flex items-center gap-2">
        {onLeaveClick && (
          <button
            onClick={onLeaveClick}
            disabled={leaving}
            className="rounded-lg px-3 py-1 text-xs font-medium text-danger-500 hover:bg-danger-400/10 disabled:opacity-50"
          >
            {leaving ? 'Leaving...' : 'Leave'}
          </button>
        )}
        {onToggleAdmin && (
          <button
            onClick={onToggleAdmin}
            className={`rounded-lg px-3 py-1 text-xs font-medium ${
              adminPanelOpen
                ? 'bg-primary-100 text-primary-700 dark:bg-primary-900/30 dark:text-primary-300'
                : 'text-secondary-500 hover:bg-secondary-100 dark:text-secondary-400 dark:hover:bg-secondary-700'
            }`}
          >
            ⚙ Info
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
  devAgentPanel,
}: Readonly<{
  group: StoredGroup;
  onLeaveGroup?: () => void;
  devAgentPanel?: ReactNode;
}>) {
  const myAddress = useAuthenticatedAddress();
  const { client, signer } = useRequiredMessagingClient();
  const { permissions, loading: permissionsLoading, refresh: refreshPermissions } =
    usePermissions(group.groupId);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const {
    messages,
    loading,
    sending,
    error,
    hasMore,
    reactions,
    sendMessage,
    editMessage,
    deleteMessage,
    toggleReaction,
    loadMore,
  } = useMessages(group.uuid, group.groupId);

  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
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
      setShowLeaveConfirm(false);
      onLeaveGroup?.();
    } catch (err) {
      console.error('Failed to leave group:', err);
      setLeaveError(
        err instanceof Error ? err.message : 'Failed to leave group.',
      );
    } finally {
      setLeaving(false);
    }
  }, [client, group, signer, onLeaveGroup]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const prevMessageCountRef = useRef(0);

  // Track whether the user is scrolled to the bottom
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 60; // px tolerance
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    setIsAtBottom(atBottom);
  }, []);

  // Auto-scroll to bottom on initial load
  useEffect(() => {
    if (!loading && messages.length > 0 && prevMessageCountRef.current === 0) {
      // Initial load — scroll instantly (no smooth animation)
      bottomRef.current?.scrollIntoView();
    }
    prevMessageCountRef.current = messages.length;
  }, [loading, messages.length]);

  // Auto-scroll when new messages arrive (only if already at bottom)
  useEffect(() => {
    if (isAtBottom && messages.length > 0) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages.length, isAtBottom]);

  // Preserve scroll position when loading older messages (prepending)
  const prevScrollHeightRef = useRef(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // If scrollHeight grew and we're at the top, maintain position
    if (el.scrollTop < 10 && prevScrollHeightRef.current > 0) {
      const diff = el.scrollHeight - prevScrollHeightRef.current;
      if (diff > 0) {
        el.scrollTop = diff;
      }
    }
    prevScrollHeightRef.current = el.scrollHeight;
  }, [messages.length]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <div className="flex min-w-0 flex-1 overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
      <ChatHeader
        name={group.name}
        onLeaveClick={() => setShowLeaveConfirm(true)}
        leaving={leaving}
        onToggleAdmin={() => setAdminPanelOpen((o) => !o)}
        adminPanelOpen={adminPanelOpen}
      />

      {/* Messages area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="relative flex min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto"
      >
        {/* Load more */}
        {hasMore && !loading && (
          <div className="py-2 text-center">
            <button
              onClick={loadMore}
              className="text-xs text-primary-500 hover:text-primary-600"
            >
              Load older messages
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="flex flex-1 items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
              <span className="text-xs text-secondary-400">
                Loading messages...
              </span>
            </div>
          </div>
        )}

        {/* Empty state */}
        {!loading && messages.length === 0 && (
          <div className="flex flex-1 items-center justify-center">
            <p className="text-sm text-secondary-400 dark:text-secondary-500">
              No messages yet. Send the first one!
            </p>
          </div>
        )}

        {/* Message list */}
        {!loading && messages.length > 0 && (
          <div className="flex flex-col gap-0.5 py-4">
            {messages.map((msg) => {
              const isOwn = msg.senderAddress === myAddress;
              return (
                <MessageBubble
                  key={msg.messageId}
                  message={msg}
                  isOwnMessage={isOwn}
                  onEdit={isOwn && permissions.canEdit ? editMessage : undefined}
                  onDelete={isOwn && permissions.canDelete ? deleteMessage : undefined}
                  reactions={reactions.get(msg.order)}
                  onToggleReaction={
                    permissions.canSend ? toggleReaction : undefined
                  }
                  myAddress={myAddress ?? undefined}
                />
              );
            })}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Scroll to bottom FAB */}
      {!isAtBottom && messages.length > 0 && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute -top-12 right-4 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-secondary-200 text-secondary-600 shadow-md transition-colors hover:bg-secondary-300 dark:bg-secondary-600 dark:text-secondary-300 dark:hover:bg-secondary-500"
            aria-label="Scroll to bottom"
          >
            ↓
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div className="border-t border-danger-400 bg-danger-400/10 px-4 py-2 text-sm text-danger-500">
          {permissions.canSend &&
          (error.includes('relayer has not synced') ||
            error.includes('waiting for relayer sync'))
            ? 'On-chain permissions OK — waiting for relayer sync. Try again in a few seconds.'
            : error}
        </div>
      )}

      {devAgentPanel}

      {/* Message input: while permissions load, show disabled composer (avoid false "no permission"). */}
      {permissionsLoading ? (
        <div className="border-t border-secondary-200 px-4 py-3 dark:border-secondary-700">
          <p className="mb-2 text-center text-xs text-secondary-400 dark:text-secondary-500">
            Checking permissions…
          </p>
          <MessageInput
            onSend={async () => {}}
            disabled
            sending={false}
          />
        </div>
      ) : permissions.canSend ? (
        <MessageInput
          onSend={(text, files) => sendMessage(text, files)}
          sending={sending}
        />
      ) : (
        <div className="border-t border-secondary-200 px-4 py-3 text-center text-xs text-secondary-400 dark:border-secondary-700 dark:text-secondary-500">
          You don't have permission to send messages in this group.
        </div>
      )}

      {/* Leave group confirmation dialog */}
      {showLeaveConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm rounded-xl bg-white p-6 shadow-2xl dark:bg-secondary-800">
            <h3 className="mb-2 text-base font-semibold text-secondary-900 dark:text-secondary-100">
              Leave Group
            </h3>
            <p className="mb-4 text-sm text-secondary-600 dark:text-secondary-400">
              Are you sure you want to leave{' '}
              <span className="font-medium">{group.name}</span>? You will no
              longer receive messages from this group.
            </p>

            {leaveError && (
              <p className="mb-3 text-sm text-danger-500">{leaveError}</p>
            )}

            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setShowLeaveConfirm(false);
                  setLeaveError(null);
                }}
                disabled={leaving}
                className="rounded-lg px-4 py-2 text-sm font-medium text-secondary-600 hover:bg-secondary-100 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleLeave}
                disabled={leaving}
                className="rounded-lg bg-danger-500 px-4 py-2 text-sm font-medium text-white hover:bg-danger-600 disabled:opacity-50"
              >
                {leaving ? 'Leaving...' : 'Leave'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>

      {/* Admin / Group Info panel */}
      <AdminPanel
        open={adminPanelOpen}
        onClose={() => setAdminPanelOpen(false)}
        groupId={group.groupId}
        groupUuid={group.uuid}
        groupName={group.name}
        permissions={permissions}
        onPermissionsChanged={refreshPermissions}
      />
    </div>
  );
}
