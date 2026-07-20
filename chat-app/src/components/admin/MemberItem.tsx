import { ChevronRight } from 'lucide-react';
import { ReservationNavAvatar } from '../ReservationNavAvatar';

interface PermType {
  key: string;
  value: string;
}

interface MemberItemProps {
  address: string;
  permissions: string[];
  isSelf: boolean;
  isAdmin: boolean;
  /** Wallet-scoped presence (one online state per wallet). */
  online?: boolean;
  isExpanded: boolean;
  removingMember: string | null;
  togglingPerm: string | null;
  messagingPermTypes: PermType[];
  onToggleExpand: () => void;
  onRemoveMember: (address: string) => void;
  onRemoveAndRotate: (address: string) => void;
  onTogglePermission: (member: string, permType: string, has: boolean) => void;
  avatarSrc?: string | null;
  /** @username / display name / truncated wallet */
  label?: string;
  showRing?: boolean;
  ringPercent?: number;
}

function permissionLabel(permType: string): string {
  if (permType.includes('MessagingSender')) return 'Send';
  if (permType.includes('MessagingReader')) return 'Read';
  if (permType.includes('MessagingEditor')) return 'Edit';
  if (permType.includes('MessagingDeleter')) return 'Delete';
  if (permType.includes('EncryptionKeyRotator')) return 'Rotate Key';
  if (permType.includes('MetadataAdmin')) return 'Metadata';
  if (permType.includes('PermissionsAdmin')) return 'Admin';
  if (permType.includes('ExtensionPermissionsAdmin')) return 'Ext Admin';
  if (permType.includes('ObjectAdmin')) return 'Obj Admin';
  if (permType.includes('GroupDeleter')) return 'Deleter';
  const parts = permType.split('::');
  return parts.at(-1) || permType;
}

function truncateAddress(address: string): string {
  if (!address) return 'unknown';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const MEMBER_AVATAR_SIZE = 28;

export function MemberItem({
  address,
  permissions,
  isSelf,
  isAdmin,
  online = false,
  isExpanded,
  removingMember,
  togglingPerm,
  messagingPermTypes,
  onToggleExpand,
  onRemoveMember,
  onRemoveAndRotate,
  onTogglePermission,
  avatarSrc = null,
  label,
  showRing = false,
  ringPercent = 0,
}: Readonly<MemberItemProps>) {
  const displayLabel = label?.trim() || truncateAddress(address);
  const isWalletLabel = displayLabel === truncateAddress(address);

  return (
    <li className="border-b border-secondary-200 last:border-b-0 dark:border-secondary-700">
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-secondary-700 transition-colors hover:bg-secondary-200/80 dark:text-secondary-300 dark:hover:bg-secondary-700"
        title={address}
        aria-expanded={isExpanded}
      >
        <span
          className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
            online ? 'bg-green-500' : 'bg-secondary-300 dark:bg-secondary-600'
          }`}
          title={online ? 'Online' : 'Offline'}
        />
        <ReservationNavAvatar
          address={address}
          imageSrc={avatarSrc}
          size={MEMBER_AVATAR_SIZE}
          showRing={showRing}
          ringPercent={ringPercent}
          className="shrink-0"
        />
        <span
          className={`min-w-0 flex-1 truncate font-medium ${
            isWalletLabel ? 'font-mono' : ''
          }`}
        >
          {displayLabel}
          {isSelf && (
            <span className="ml-1 font-sans text-primary-500">(you)</span>
          )}
        </span>
        <ChevronRight
          className={`h-4 w-4 shrink-0 text-secondary-400 transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
          aria-hidden
        />
      </button>

      {/* Permission toggles (expanded view, admin + not self) */}
      {isExpanded && isAdmin && !isSelf && (
        <div className="space-y-1 border-t border-secondary-200 bg-secondary-50/50 px-3 pb-3 pt-2 dark:border-secondary-700 dark:bg-secondary-900/60">
          {messagingPermTypes.map((perm) => {
            const has = permissions.some(
              (p) =>
                p === perm.value ||
                p === perm.value.replace(/^0x/, ''),
            );
            const toggleKey = `${address}:${perm.value}`;
            return (
              <label
                key={perm.key}
                className="flex items-center justify-between text-xs text-secondary-600 dark:text-secondary-400"
              >
                <span>{perm.key}</span>
                <button
                  type="button"
                  onClick={() => onTogglePermission(address, perm.value, has)}
                  disabled={togglingPerm === toggleKey}
                  className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors disabled:opacity-50 ${
                    has
                      ? 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400'
                      : 'bg-secondary-100 text-secondary-500 hover:bg-secondary-200 dark:bg-secondary-600 dark:text-secondary-400'
                  }`}
                >
                  {togglingPerm === toggleKey ? '...' : has ? 'ON' : 'OFF'}
                </button>
              </label>
            );
          })}

          <div className="mt-2 flex items-center justify-end gap-3 border-t border-secondary-200 pt-2 dark:border-secondary-700">
            <button
              type="button"
              onClick={() => onRemoveAndRotate(address)}
              disabled={removingMember === address}
              className="text-[10px] font-medium text-danger-500 hover:text-danger-600 disabled:opacity-50"
              title="Remove member and rotate encryption key"
            >
              {removingMember === address ? '...' : 'Remove+Key'}
            </button>
            <button
              type="button"
              onClick={() => onRemoveMember(address)}
              disabled={removingMember === address}
              className="text-[10px] font-medium text-danger-400 hover:text-danger-500 disabled:opacity-50"
              title="Remove member (no key rotation)"
            >
              Remove
            </button>
          </div>
        </div>
      )}

      {/* Read-only permissions (expanded, non-admin or self) */}
      {isExpanded && (!isAdmin || isSelf) && (
        <div className="space-y-1 border-t border-secondary-200 bg-secondary-50/50 px-3 pb-3 pt-2 dark:border-secondary-700 dark:bg-secondary-900/60">
          {permissions.map((p) => (
            <div
              key={p}
              className="flex items-center justify-between text-xs text-secondary-600 dark:text-secondary-400"
            >
              <span>{permissionLabel(p)}</span>
              <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                ON
              </span>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}
