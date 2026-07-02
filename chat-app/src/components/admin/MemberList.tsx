import { useState } from 'react';
import { useAuthenticatedAddress } from '../../contexts/MySocialAuthContext';
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
}: Readonly<MemberListProps>) {
  const accountAddress = useAuthenticatedAddress();
  const [expandedMember, setExpandedMember] = useState<string | null>(null);

  return (
    <section className="border-b border-secondary-100 p-4 dark:border-secondary-700">
      <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
        Members ({members.length})
      </h4>

      {loading && (
        <div className="flex items-center gap-2 py-4">
          <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-primary-500 border-t-transparent" />
          <span className="text-xs text-secondary-400 dark:text-secondary-500">Loading...</span>
        </div>
      )}

      {!loading && members.length === 0 && (
        <p className="text-xs text-secondary-400 dark:text-secondary-500">No members found.</p>
      )}

      {!loading && members.length > 0 && (
        <ul className="space-y-2">
          {members.map((m) => {
            const isSelf = m.address === accountAddress;
            return (
              <MemberItem
                key={m.address}
                address={m.address}
                permissions={m.permissions}
                isSelf={isSelf}
                isAdmin={isAdmin}
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
