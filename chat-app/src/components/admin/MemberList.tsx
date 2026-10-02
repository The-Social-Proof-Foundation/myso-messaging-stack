import { useState } from 'react';
import { ChevronRight, UserPlus } from 'lucide-react';
import { useAuthenticatedAddress } from '../../contexts/MySocialAuthContext';
import type { WalletRingBits } from '../../hooks/useWalletAvatarMap';
import { MemberItem } from './MemberItem';

interface MemberWithPermissions {
  address: string;
  permissions: string[];
}

interface PermType {
  key: string;
  value: string;
}

interface MemberListProps {
  members: MemberWithPermissions[];
  loading: boolean;
  isAdmin: boolean;
  removingMember: string | null;
  removeError: string | null;
  togglingPerm: string | null;
  messagingPermTypes: PermType[];
  onRemoveMember: (address: string) => void;
  onRemoveAndRotate: (address: string) => void;
  onTogglePermission: (member: string, permType: string, has: boolean) => void;
  /** Admin-only: opens the Add Member dialog. */
  onAddMember?: () => void;
  /** Presence per member for the online dots. */
  onlineMembers?: Map<string, boolean>;
  photoFor?: (address: string) => string | null;
  labelFor?: (address: string) => string;
  ringFor?: (address: string) => WalletRingBits;
}

export function MemberList({
  members,
  loading,
  isAdmin,
  removingMember,
  removeError,
  togglingPerm,
  messagingPermTypes,
  onRemoveMember,
  onRemoveAndRotate,
  onTogglePermission,
  onAddMember,
  onlineMembers,
  photoFor,
  labelFor,
  ringFor,
}: Readonly<MemberListProps>) {
  const accountAddress = useAuthenticatedAddress();
  const [expandedMember, setExpandedMember] = useState<string | null>(null);

  return (
    <section className="border-b border-secondary-100 p-4 dark:border-secondary-700">
      <h4 className="font-chakra mb-2 text-sm font-medium capitalize tracking-wide text-secondary-500 dark:text-secondary-400">
        Members ({members.length})
      </h4>

      {loading && members.length === 0 && (
        <div className="flex items-center justify-center py-6">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
        </div>
      )}

      {!loading && members.length === 0 && (
        <p className="text-xs text-secondary-400 dark:text-secondary-500">No members found.</p>
      )}

      {!loading && (isAdmin || members.length > 0) && (
        <ul className="overflow-hidden rounded-xl border border-secondary-200 bg-secondary-100 dark:border-secondary-700 dark:bg-secondary-800">
          {/* First clickable row: opens the Add Member dialog. */}
          {isAdmin && onAddMember && (
            <li className="border-b border-secondary-200 dark:border-secondary-700">
              <button
                type="button"
                onClick={onAddMember}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-secondary-600 transition-colors hover:bg-secondary-200/80 hover:text-secondary-900 dark:text-secondary-300 dark:hover:bg-secondary-700 dark:hover:text-secondary-100"
              >
                {/* h-6 box matches the member row avatar so row heights line up. */}
                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                  <UserPlus className="h-4 w-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate">Add Member</span>
                <ChevronRight
                  className="h-4 w-4 shrink-0 text-secondary-400"
                  aria-hidden
                />
              </button>
            </li>
          )}

          {members.map((m) => {
            const isSelf = m.address === accountAddress;
            const ring = ringFor?.(m.address);
            return (
              <MemberItem
                key={m.address}
                address={m.address}
                permissions={m.permissions}
                isSelf={isSelf}
                isAdmin={isAdmin}
                online={
                  onlineMembers?.get(m.address.toLowerCase()) ??
                  onlineMembers?.get(m.address) ??
                  false
                }
                isExpanded={expandedMember === m.address}
                removingMember={removingMember}
                togglingPerm={togglingPerm}
                messagingPermTypes={messagingPermTypes}
                onToggleExpand={() =>
                  setExpandedMember(
                    expandedMember === m.address ? null : m.address,
                  )
                }
                onRemoveMember={onRemoveMember}
                onRemoveAndRotate={onRemoveAndRotate}
                onTogglePermission={onTogglePermission}
                avatarSrc={photoFor?.(m.address) ?? null}
                label={labelFor?.(m.address)}
                showRing={ring?.showRing ?? false}
                ringPercent={ring?.ringPercent ?? 0}
              />
            );
          })}
        </ul>
      )}

      {removeError && (
        <p className="mt-2 text-xs text-danger-500 dark:text-danger-400">{removeError}</p>
      )}
    </section>
  );
}
