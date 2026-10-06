/**
 * Slide-out admin panel for group management.
 * Desktop: animated width rail. Mobile: full-view with back.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';
import { grantMessagingPermission } from '../lib/agents/agent-chat-permissions';
import { signAndExecuteTransactionAndWait } from '../lib/sign-and-wait';
import { updateStoredGroupName } from '../lib/group-store';
import { clearEitherBlockCache } from '../lib/block-check';
import { blockWalletTx } from '../lib/block-wallet';
import {
  submitConversationReport,
  type ReportReason,
} from '../lib/report-conversation';
import { dmPeerAddress } from '../lib/wallet-profile';
import type { Permissions } from '../hooks/usePermissions';
import { GroupNameSection } from './admin/GroupNameSection';
import { MemberList } from './admin/MemberList';
import { AddMemberDialog } from './admin/AddMemberDialog';
import { GroupActionsSection } from './admin/GroupActionsSection';
import {
  ChatSettingsSection,
  type ChatSettingsSavingKey,
} from './admin/ChatSettingsSection';
import type { WalletRingBits } from '../hooks/useWalletAvatarMap';
import { useIsMobileNav } from '../hooks/useMediaQuery';
import {
  CHAT_INFO_WIDTH_PX,
  CHAT_SIDEBAR_MOTION,
} from '../lib/chat-layout';
import type { ReceiptMode } from '@socialproof/myso-messaging-stack';

interface MemberWithPermissions {
  address: string;
  permissions: string[];
}

interface AdminPanelProps {
  open: boolean;
  onClose: () => void;
  groupId: string;
  groupUuid: string;
  groupName: string;
  permissions: Permissions;
  onPermissionsChanged?: () => void;
  onGroupRenamed?: (newName: string) => void;
  onGroupArchived?: () => void;
  /** Presence per member (snapshot + live events) for the online dots. */
  onlineMembers?: Map<string, boolean>;
  /** Leave the group (shown for all members in Group Actions). */
  onLeaveGroup?: () => Promise<void>;
  leaving?: boolean;
  leaveError?: string | null;
  photoFor?: (address: string) => string | null;
  labelFor?: (address: string) => string;
  ringFor?: (address: string) => WalletRingBits;
  isAgentAddress?: (address: string) => boolean;
  /** Fired after a successful prefs PUT so the open thread can sync receiptMode. */
  onPrefsChanged?: (prefs: {
    notificationsEnabled: boolean;
    receiptMode: ReceiptMode;
  }) => void;
}

export function AdminPanel({
  open,
  onClose,
  groupId,
  groupUuid,
  groupName,
  permissions,
  onPermissionsChanged,
  onGroupRenamed,
  onGroupArchived,
  onlineMembers,
  onLeaveGroup,
  leaving = false,
  leaveError = null,
  photoFor,
  labelFor,
  ringFor,
  isAgentAddress,
  onPrefsChanged,
}: Readonly<AdminPanelProps>) {
  const { client, signer } = useRequiredMessagingClient();
  const isMobileNav = useIsMobileNav();

  const [members, setMembers] = useState<MemberWithPermissions[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [membersLoaded, setMembersLoaded] = useState(false);
  const membersRef = useRef(members);
  membersRef.current = members;
  const memberFetchGen = useRef(0);

  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [readReceiptsEnabled, setReadReceiptsEnabled] = useState(true);
  const [onlinePresenceEnabled, setOnlinePresenceEnabled] = useState(true);
  const [prefsLoading, setPrefsLoading] = useState(true);
  const [prefsSavingKey, setPrefsSavingKey] =
    useState<ChatSettingsSavingKey>(null);
  const [prefsError, setPrefsError] = useState<string | null>(null);

  // Available messaging permission types
  const messagingPermTypes = [
    { key: 'Send', value: client.messaging.bcs.MessagingSender.name },
    { key: 'Read', value: client.messaging.bcs.MessagingReader.name },
    { key: 'Edit', value: client.messaging.bcs.MessagingEditor.name },
    { key: 'Delete', value: client.messaging.bcs.MessagingDeleter.name },
    { key: 'Rotate Key', value: client.messaging.bcs.EncryptionKeyRotator.name },
    { key: 'Metadata', value: client.messaging.bcs.MetadataAdmin.name },
    { key: 'Group handle', value: client.messaging.bcs.GroupHandleAdmin.name },
  ];

  // Add member form
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [newAddress, setNewAddress] = useState('');
  // All permissions are granted by default; the multi-select prunes them.
  const [selectedPerms, setSelectedPerms] = useState<string[]>(() =>
    messagingPermTypes.map((p) => p.value),
  );
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [addMemberBlocked, setAddMemberBlocked] = useState(false);

  // Remove member state
  const [removingMember, setRemovingMember] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  // Permission toggle state
  const [togglingPerm, setTogglingPerm] = useState<string | null>(null);

  // Rename state
  const [editingName, setEditingName] = useState(false);
  const [newName, setNewName] = useState(groupName);
  const [renaming, setRenaming] = useState(false);

  // Action error
  const [actionError, setActionError] = useState<string | null>(null);

  // Fetch members — keep existing rows mounted; only show the spinner on first load.
  const fetchMembers = useCallback(async () => {
    const gen = ++memberFetchGen.current;
    const showSpinner = membersRef.current.length === 0;
    if (showSpinner) setLoadingMembers(true);
    try {
      // System objects (GroupLeaver, GroupManager) — not human members.
      const systemAddresses = client.messaging.derive.systemObjectAddresses();
      const result = await client.groups.view.getMembers({
        groupId,
        exhaustive: true,
      });
      if (gen !== memberFetchGen.current) return;
      const next = (result.members as MemberWithPermissions[]).filter(
        (m) => !systemAddresses.has(m.address),
      );
      // Address keys stay stable — React adds/removes rows in place.
      setMembers(next);
    } catch (err) {
      console.error('Failed to fetch members:', err);
    } finally {
      if (gen !== memberFetchGen.current) return;
      if (showSpinner) setLoadingMembers(false);
      setMembersLoaded(true);
    }
  }, [client, groupId]);

  // Clear cache when switching groups so we don't flash the wrong roster.
  useEffect(() => {
    setMembers([]);
    setLoadingMembers(false);
    setMembersLoaded(false);
    setNotificationsEnabled(true);
    setReadReceiptsEnabled(true);
    setOnlinePresenceEnabled(true);
    setPrefsLoading(true);
    setPrefsError(null);
    setPrefsSavingKey(null);
  }, [groupId]);

  const applyPrefsLocal = useCallback(
    (prefs: {
      notificationMode: string;
      receiptMode: ReceiptMode;
      hideOnlinePresence: boolean;
    }) => {
      setNotificationsEnabled(prefs.notificationMode === 'all');
      setReadReceiptsEnabled(prefs.receiptMode === 'full');
      setOnlinePresenceEnabled(!prefs.hideOnlinePresence);
      onPrefsChanged?.({
        notificationsEnabled: prefs.notificationMode === 'all',
        receiptMode: prefs.receiptMode,
      });
    },
    [onPrefsChanged],
  );

  const fetchPrefs = useCallback(async () => {
    setPrefsLoading(true);
    setPrefsError(null);
    try {
      const prefs = await client.messaging.getConversationPrefs({
        signer,
        groupRef: { uuid: groupUuid },
      });
      applyPrefsLocal(prefs);
    } catch (err) {
      console.warn('Failed to load conversation prefs:', err);
      setPrefsError(
        err instanceof Error ? err.message : 'Failed to load chat settings.',
      );
    } finally {
      setPrefsLoading(false);
    }
  }, [client, signer, groupUuid, applyPrefsLocal]);

  useEffect(() => {
    if (open) {
      void fetchMembers();
      void fetchPrefs();
      setNewName(groupName);
    }
  }, [open, fetchMembers, fetchPrefs, groupName]);

  async function handleToggleNotifications(enabled: boolean) {
    const prev = notificationsEnabled;
    setNotificationsEnabled(enabled);
    setPrefsSavingKey('notifications');
    setPrefsError(null);
    try {
      const prefs = await client.messaging.putConversationPrefs({
        signer,
        groupRef: { uuid: groupUuid },
        notificationMode: enabled ? 'all' : 'none',
      });
      applyPrefsLocal(prefs);
    } catch (err) {
      setNotificationsEnabled(prev);
      setPrefsError(
        err instanceof Error ? err.message : 'Failed to update notifications.',
      );
    } finally {
      setPrefsSavingKey(null);
    }
  }

  async function handleToggleReadReceipts(enabled: boolean) {
    const prev = readReceiptsEnabled;
    setReadReceiptsEnabled(enabled);
    setPrefsSavingKey('readReceipts');
    setPrefsError(null);
    try {
      const prefs = await client.messaging.putConversationPrefs({
        signer,
        groupRef: { uuid: groupUuid },
        receiptMode: enabled ? 'full' : 'delivered_only',
      });
      applyPrefsLocal(prefs);
    } catch (err) {
      setReadReceiptsEnabled(prev);
      setPrefsError(
        err instanceof Error ? err.message : 'Failed to update read receipts.',
      );
    } finally {
      setPrefsSavingKey(null);
    }
  }

  async function handleToggleOnlinePresence(enabled: boolean) {
    const prev = onlinePresenceEnabled;
    setOnlinePresenceEnabled(enabled);
    setPrefsSavingKey('onlinePresence');
    setPrefsError(null);
    try {
      const prefs = await client.messaging.putConversationPrefs({
        signer,
        groupRef: { uuid: groupUuid },
        hideOnlinePresence: !enabled,
      });
      applyPrefsLocal(prefs);
    } catch (err) {
      setOnlinePresenceEnabled(prev);
      setPrefsError(
        err instanceof Error
          ? err.message
          : 'Failed to update online presence.',
      );
    } finally {
      setPrefsSavingKey(null);
    }
  }

  // ------------------------------------------------------------------
  // Add member
  // ------------------------------------------------------------------
  /** Close the dialog and drop the in-flight pick so the next open is clean. */
  function closeAddMemberDialog() {
    setAddMemberOpen(false);
    setNewAddress('');
    setAddError(null);
    setAddMemberBlocked(false);
    setSelectedPerms(messagingPermTypes.map((p) => p.value));
  }

  async function handleAddMember(e: React.SyntheticEvent) {
    e.preventDefault();
    setAddError(null);

    const address = newAddress.trim();
    if (!address) { setAddError('Address is required.'); return; }
    if (!/^0x[a-fA-F0-9]{64}$/.test(address)) { setAddError('Invalid MySo address.'); return; }
    if (addMemberBlocked) {
      setAddError('You cannot add this user (blocked).');
      return;
    }
    if (selectedPerms.length === 0) { setAddError('Select at least one permission.'); return; }

    setAdding(true);
    try {
      const tx = client.groups.tx.grantPermissions({
        groupId,
        member: address,
        permissionTypes: selectedPerms,
      });
      await signAndExecuteTransactionAndWait(client, signer, tx);
      setNewAddress('');
      // Reset to the full default set so the next add starts from all permissions.
      setSelectedPerms(messagingPermTypes.map((p) => p.value));
      setAddMemberOpen(false);
      // Append immediately; silent refetch reconciles permissions / ordering.
      setMembers((prev) =>
        prev.some((m) => m.address.toLowerCase() === address.toLowerCase())
          ? prev
          : [...prev, { address, permissions: selectedPerms }],
      );
      void fetchMembers();
      onPermissionsChanged?.();
    } catch (err) {
      console.error('Failed to add member:', err);
      setAddError(err instanceof Error ? err.message : 'Failed to add member.');
    } finally {
      setAdding(false);
    }
  }

  // ------------------------------------------------------------------
  // Remove member
  // ------------------------------------------------------------------
  async function handleRemoveMember(member: string) {
    setRemovingMember(member);
    setRemoveError(null);
    try {
      const tx = client.groups.tx.removeMember({ groupId, member });
      await signAndExecuteTransactionAndWait(client, signer, tx);
      setMembers((prev) =>
        prev.filter((m) => m.address.toLowerCase() !== member.toLowerCase()),
      );
      void fetchMembers();
      onPermissionsChanged?.();
    } catch (err) {
      console.error('Failed to remove member:', err);
      setRemoveError(err instanceof Error ? err.message : 'Failed to remove.');
    } finally {
      setRemovingMember(null);
    }
  }

  // ------------------------------------------------------------------
  // Toggle a single permission
  // ------------------------------------------------------------------
  async function handleTogglePermission(
    member: string,
    permType: string,
    currentlyHas: boolean,
  ) {
    const key = `${member}:${permType}`;
    setTogglingPerm(key);
    try {
      if (currentlyHas) {
        const tx = client.groups.tx.revokePermission({
          groupId,
          member,
          permissionType: permType,
        });
        await signAndExecuteTransactionAndWait(client, signer, tx);
      } else {
        await grantMessagingPermission({
          client,
          signer,
          groupId,
          member,
          permissionType: permType,
        });
      }
      await fetchMembers();
      onPermissionsChanged?.();
    } catch (err) {
      console.error('Failed to toggle permission:', err);
      setActionError(err instanceof Error ? err.message : 'Failed to update permission.');
    } finally {
      setTogglingPerm(null);
    }
  }

  // ------------------------------------------------------------------
  // Atomic remove + rotate key
  // ------------------------------------------------------------------
  async function handleRemoveAndRotate(member: string) {
    setRemovingMember(member);
    setRemoveError(null);
    try {
      const tx = client.messaging.tx.removeMembersAndRotateKey({
        uuid: groupUuid,
        members: [member],
      });
      await signAndExecuteTransactionAndWait(client, signer, tx);
      setMembers((prev) =>
        prev.filter((m) => m.address.toLowerCase() !== member.toLowerCase()),
      );
      void fetchMembers();
      onPermissionsChanged?.();
    } catch (err) {
      console.error('Failed to remove & rotate:', err);
      setRemoveError(err instanceof Error ? err.message : 'Failed to remove & rotate.');
    } finally {
      setRemovingMember(null);
    }
  }

  // ------------------------------------------------------------------
  // Rename group
  // ------------------------------------------------------------------
  async function handleRename() {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === groupName) {
      setEditingName(false);
      setNewName(groupName);
      return;
    }

    setRenaming(true);
    try {
      const tx = client.messaging.tx.setGroupName({
        groupId,
        name: trimmed,
      });
      await signAndExecuteTransactionAndWait(client, signer, tx);
      updateStoredGroupName(groupUuid, trimmed);
      setEditingName(false);
      onGroupRenamed?.(trimmed);
    } catch (err) {
      console.error('Failed to rename group:', err);
      setActionError(err instanceof Error ? err.message : 'Failed to rename.');
    } finally {
      setRenaming(false);
    }
  }

  // ------------------------------------------------------------------
  // Rotate encryption key
  // ------------------------------------------------------------------
  async function handleRotateKey() {
    setActionError(null);
    try {
      const tx = client.messaging.tx.rotateEncryptionKey({
        uuid: groupUuid,
      });
      await signAndExecuteTransactionAndWait(client, signer, tx);
    } catch (err) {
      console.error('Failed to rotate key:', err);
      setActionError(err instanceof Error ? err.message : 'Failed to rotate key.');
    }
  }

  // ------------------------------------------------------------------
  // Archive group
  // ------------------------------------------------------------------
  async function handleArchive() {
    try {
      const tx = client.messaging.tx.archiveGroup({ groupId });
      await signAndExecuteTransactionAndWait(client, signer, tx);
      onGroupArchived?.();
    } catch (err) {
      console.error('Failed to archive group:', err);
      setActionError(err instanceof Error ? err.message : 'Failed to archive.');
    }
  }

  // Permission multi-select for the Add Member form.
  function handlePermsChange(permValues: string[]) {
    setSelectedPerms(permValues);
  }

  const peerAddress = membersLoaded
    ? dmPeerAddress(
        members.map((member) => member.address),
        signer.toMySoAddress(),
      )
    : undefined;

  async function handleReport(input: { reason: ReportReason; note?: string }) {
    await submitConversationReport(signer, {
      groupId,
      reportedWallet: peerAddress ?? null,
      reason: input.reason,
      note: input.note,
    });
  }

  async function handleBlock() {
    if (!peerAddress) {
      throw new Error('This chat does not have a single person to block.');
    }
    const tx = blockWalletTx(
      {
        blockListRegistryId: client.messaging.packageConfig.blockListRegistryId,
        socialGraphId: client.messaging.packageConfig.socialGraphId,
      },
      peerAddress,
    );
    await signAndExecuteTransactionAndWait(client, signer, tx);
    clearEitherBlockCache();
    if (onLeaveGroup) {
      await onLeaveGroup();
    }
  }

  // Mobile: unmount when closed (full-screen takeover when open).
  if (isMobileNav && !open) return null;

  const title = 'Details';

  const body = (
    <>
      {/* Mobile-only header: back + title (desktop has no chrome) */}
      <div className="relative flex h-14 shrink-0 items-center justify-center border-b border-secondary-200/40 px-5 dark:border-secondary-700/40 md:hidden">
        <button
          type="button"
          onClick={onClose}
          aria-label="Back to chat"
          className="absolute left-2 top-1/2 z-10 inline-flex h-11 min-w-11 -translate-y-1/2 items-center justify-center gap-0.5 rounded-full px-2 text-sm font-medium text-secondary-600 hover:bg-secondary-100/80 dark:text-secondary-300 dark:hover:bg-secondary-800/80"
        >
          <ChevronLeft className="h-5 w-5 shrink-0" strokeWidth={2} />
          <span className="pr-1">Back</span>
        </button>
        <h3 className="mx-auto max-w-[calc(100%-9.5rem)] truncate text-center text-[15px] font-semibold text-secondary-900 dark:text-secondary-100">
          {title}
        </h3>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {permissions.canEditMetadata && (
          <GroupNameSection
            groupName={groupName}
            editingName={editingName}
            newName={newName}
            renaming={renaming}
            onEditStart={() => setEditingName(true)}
            onEditCancel={() => {
              setEditingName(false);
              setNewName(groupName);
            }}
            onNameChange={setNewName}
            onRename={handleRename}
          />
        )}

        <MemberList
          members={members}
          loading={loadingMembers}
          isAdmin={permissions.isAdmin}
          removingMember={removingMember}
          removeError={removeError}
          togglingPerm={togglingPerm}
          messagingPermTypes={messagingPermTypes}
          onRemoveMember={handleRemoveMember}
          onRemoveAndRotate={handleRemoveAndRotate}
          onTogglePermission={handleTogglePermission}
          onAddMember={
            permissions.isAdmin ? () => setAddMemberOpen(true) : undefined
          }
          onlineMembers={onlineMembers}
          photoFor={photoFor}
          labelFor={labelFor}
          ringFor={ringFor}
          isAgentAddress={isAgentAddress}
        />

        <AddMemberDialog
          open={addMemberOpen}
          onClose={closeAddMemberDialog}
          newAddress={newAddress}
          selectedPerms={selectedPerms}
          adding={adding}
          addError={addError}
          messagingPermTypes={messagingPermTypes}
          existingMemberAddresses={members.map((m) => m.address)}
          onAddressChange={setNewAddress}
          onPermsChange={handlePermsChange}
          onSubmit={handleAddMember}
          onBlockedChange={setAddMemberBlocked}
        />

        <ChatSettingsSection
          notificationsEnabled={notificationsEnabled}
          readReceiptsEnabled={readReceiptsEnabled}
          onlinePresenceEnabled={onlinePresenceEnabled}
          loading={prefsLoading}
          savingKey={prefsSavingKey}
          error={prefsError}
          onToggleNotifications={handleToggleNotifications}
          onToggleReadReceipts={handleToggleReadReceipts}
          onToggleOnlinePresence={handleToggleOnlinePresence}
        />

        {(permissions.isAdmin || onLeaveGroup) && (
          <GroupActionsSection
            canRotateKey={permissions.isAdmin && permissions.canRotateKey}
            canArchive={permissions.isAdmin}
            actionError={actionError}
            onRotateKey={handleRotateKey}
            onArchive={handleArchive}
            onLeave={
              onLeaveGroup ??
              (async () => {
                /* no-op when leave is unavailable */
              })
            }
            leaving={leaving}
            leaveError={leaveError}
            peerAddress={peerAddress}
            onReport={handleReport}
            onBlock={handleBlock}
          />
        )}
      </div>
    </>
  );

  if (isMobileNav) {
    return (
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col bg-white dark:bg-secondary-900">
        {body}
      </div>
    );
  }

  // Desktop: keep mounted and tween width so open/close is snappy.
  return (
    <div
      className={`hidden min-h-0 shrink-0 overflow-hidden border-secondary-200 bg-white dark:border-secondary-700 dark:bg-secondary-900 md:flex md:flex-col ${CHAT_SIDEBAR_MOTION} ${
        open ? 'w-80 border-l' : 'w-0 border-l-0'
      }`}
      aria-hidden={!open}
    >
      <div
        className="flex h-full min-h-0 flex-col"
        style={{ width: CHAT_INFO_WIDTH_PX }}
      >
        {body}
      </div>
    </div>
  );
}
