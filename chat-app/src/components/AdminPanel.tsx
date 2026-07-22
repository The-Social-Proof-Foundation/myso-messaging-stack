/**
 * Slide-out admin panel for group management.
 * Desktop: animated width rail. Mobile: full-view with back.
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { ChevronLeft } from 'lucide-react';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';
import { signAndExecuteTransactionAndWait } from '../lib/sign-and-wait';
import { updateStoredGroupName } from '../lib/group-store';
import type { Permissions } from '../hooks/usePermissions';
import { GroupNameSection } from './admin/GroupNameSection';
import { MemberList } from './admin/MemberList';
import { AddMemberForm } from './admin/AddMemberForm';
import { GroupActionsSection } from './admin/GroupActionsSection';
import type { WalletRingBits } from '../hooks/useWalletAvatarMap';
import { useIsMobileNav } from '../hooks/useMediaQuery';
import {
  CHAT_INFO_WIDTH_PX,
  CHAT_SIDEBAR_MOTION,
} from '../lib/chat-layout';

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
}: Readonly<AdminPanelProps>) {
  const { client, signer } = useRequiredMessagingClient();
  const isMobileNav = useIsMobileNav();

  const [members, setMembers] = useState<MemberWithPermissions[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const membersRef = useRef(members);
  membersRef.current = members;

  // Add member form
  const [newAddress, setNewAddress] = useState('');
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

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

  // Fetch members — keep existing rows mounted; only show the spinner on first load.
  const fetchMembers = useCallback(async () => {
    const showSpinner = membersRef.current.length === 0;
    if (showSpinner) setLoadingMembers(true);
    try {
      // System objects (GroupLeaver, GroupManager) — not human members.
      const systemAddresses = client.messaging.derive.systemObjectAddresses();
      const result = await client.groups.view.getMembers({
        groupId,
        exhaustive: true,
      });
      const next = (result.members as MemberWithPermissions[]).filter(
        (m) => !systemAddresses.has(m.address),
      );
      // Address keys stay stable — React adds/removes rows in place.
      setMembers(next);
    } catch (err) {
      console.error('Failed to fetch members:', err);
    } finally {
      if (showSpinner) setLoadingMembers(false);
    }
  }, [client, groupId]);

  // Clear cache when switching groups so we don't flash the wrong roster.
  useEffect(() => {
    setMembers([]);
    setLoadingMembers(false);
  }, [groupId]);

  useEffect(() => {
    if (open) {
      void fetchMembers();
      setNewName(groupName);
    }
  }, [open, fetchMembers, groupName]);

  // ------------------------------------------------------------------
  // Add member
  // ------------------------------------------------------------------
  async function handleAddMember(e: React.SyntheticEvent) {
    e.preventDefault();
    setAddError(null);

    const address = newAddress.trim();
    if (!address) { setAddError('Address is required.'); return; }
    if (!/^0x[a-fA-F0-9]{64}$/.test(address)) { setAddError('Invalid MySo address.'); return; }
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
      setSelectedPerms([]);
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
        const tx = client.groups.tx.grantPermission({
          groupId,
          member,
          permissionType: permType,
        });
        await signAndExecuteTransactionAndWait(client, signer, tx);
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

  // Permission checkbox helpers for Add Member form
  function togglePerm(permValue: string) {
    setSelectedPerms((prev) =>
      prev.includes(permValue) ? prev.filter((p) => p !== permValue) : [...prev, permValue],
    );
  }

  function selectAllPerms() {
    if (selectedPerms.length === messagingPermTypes.length) {
      setSelectedPerms([]);
    } else {
      setSelectedPerms(messagingPermTypes.map((p) => p.value));
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
          onlineMembers={onlineMembers}
          photoFor={photoFor}
          labelFor={labelFor}
          ringFor={ringFor}
        />

        {permissions.isAdmin && (
          <AddMemberForm
            newAddress={newAddress}
            selectedPerms={selectedPerms}
            adding={adding}
            addError={addError}
            messagingPermTypes={messagingPermTypes}
            onAddressChange={setNewAddress}
            onTogglePerm={togglePerm}
            onSelectAllPerms={selectAllPerms}
            onSubmit={handleAddMember}
          />
        )}

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
