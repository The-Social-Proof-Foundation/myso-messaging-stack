import { ChevronRight } from 'lucide-react';
import { ReservationNavAvatar } from '../ReservationNavAvatar';
import { AgentOrb } from '../agents/AgentOrb';

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
  /** Agent member: orb instead of the empty photo. */
  showAgentOrb?: boolean;
}

function permissionLabel(permType: string): string {
  if (permType.includes('MessagingSender')) return 'Send';
  if (permType.includes('MessagingReader')) return 'Read';
  if (permType.includes('MessagingEditor')) return 'Edit';
  if (permType.includes('MessagingDeleter')) return 'Delete';
  if (permType.includes('EncryptionKeyRotator')) return 'Rotate Key';
  if (permType.includes('MetadataAdmin')) return 'Metadata';
  // Check this before PermissionsAdmin: the longer name contains that substring.
  if (permType.includes('ExtensionPermissionsAdmin')) return 'Ext Admin';
  if (permType.includes('PermissionsAdmin')) return 'Admin';
  if (permType.includes('ObjectAdmin')) return 'Obj Admin';
  if (permType.includes('GroupDeleter')) return 'Deleter';
  const parts = permType.split('::');
  return parts.at(-1) || permType;
}

/**
 * Extension-admin is granted automatically so Admin can turn on Send.
 * It is not a second admin role in this list.
 */
function isExtensionPermissionsAdmin(permType: string): boolean {
  return permType.includes('ExtensionPermissionsAdmin');
}

function visibleHeldPermissions(
  permissions: string[],
  messagingPermTypes: PermType[],
): string[] {
  const seen = new Set<string>();
  const visible: string[] = [];
  for (const held of permissions) {
    if (isExtensionPermissionsAdmin(held)) continue;
    if (messagingPermTypes.some((perm) => memberHasPermission([held], perm.value))) continue;
    const label = permissionLabel(held);
    if (seen.has(label)) continue;
    seen.add(label);
    visible.push(held);
  }
  return visible;
}

/** `module::Type` suffix — package ID may be short vs padded / V1 vs latest. */
function typeSuffix(typeName: string): string {
  const parts = typeName.replace(/^0x/i, '').split('::').filter(Boolean);
  if (parts.length < 2) return typeName.toLowerCase();
  return parts.slice(-2).join('::').toLowerCase();
}

function memberHasPermission(permissions: string[], permType: string): boolean {
  const target = permType.replace(/^0x/i, '').toLowerCase();
  const targetSuffix = typeSuffix(permType);
  return permissions.some((raw) => {
    const normalized = raw.replace(/^0x/i, '').toLowerCase();
    return normalized === target || typeSuffix(raw) === targetSuffix;
  });
}

function truncateAddress(address: string): string {
  if (!address) return 'unknown';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

const MEMBER_AVATAR_SIZE = 24;

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
  showAgentOrb = false,
}: Readonly<MemberItemProps>) {
  const displayLabel = label?.trim() || truncateAddress(address);
  const isWalletLabel = displayLabel === truncateAddress(address);

  return (
    <li className="border-b border-secondary-200 last:border-b-0 dark:border-secondary-700">
      <button
        type="button"
        onClick={onToggleExpand}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-secondary-700 transition-colors hover:bg-secondary-200/80 dark:text-secondary-300 dark:hover:bg-secondary-700"
        title={address}
        aria-expanded={isExpanded}
      >
        <span className="relative shrink-0">
          <ReservationNavAvatar
            address={address}
            imageSrc={avatarSrc}
            face={
              showAgentOrb ? (
                <AgentOrb
                  agentKey={address}
                  size={MEMBER_AVATAR_SIZE}
                  label={displayLabel}
                />
              ) : undefined
            }
            size={MEMBER_AVATAR_SIZE}
            showRing={showRing}
            ringPercent={ringPercent}
            className="shrink-0"
          />
          {!showAgentOrb && (
            <span
              className={`absolute bottom-[2px] left-[2px] h-2 w-2 rounded-full ring-2 ring-secondary-100 dark:ring-secondary-800 ${
                online ? 'bg-green-500' : 'bg-secondary-300 dark:bg-secondary-600'
              }`}
              title={online ? 'Online' : 'Offline'}
            />
          )}
        </span>
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

      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          isExpanded
            ? 'grid-rows-[1fr] opacity-100'
            : 'pointer-events-none grid-rows-[0fr] opacity-0'
        }`}
        aria-hidden={!isExpanded}
      >
        <div className="min-h-0 overflow-hidden">
      {/* Permission toggles when the signed-in member is an admin, including their own row. */}
      {isAdmin ? (
        <div className="space-y-1 border-t border-secondary-200 bg-secondary-50/50 px-3 pb-3 pt-2 dark:border-secondary-700 dark:bg-secondary-900/60">
          {messagingPermTypes.map((perm) => {
            const has = memberHasPermission(permissions, perm.value);
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
                      ? 'bg-green-100 text-green-700 hover:bg-green-200 dark:bg-green-900/30 dark:text-green-400 dark:hover:bg-green-900/50'
                      : 'bg-secondary-100 text-secondary-500 hover:bg-secondary-200 dark:bg-secondary-600 dark:text-secondary-400 dark:hover:bg-secondary-500'
                  }`}
                >
                  {togglingPerm === toggleKey ? '...' : has ? 'ON' : 'OFF'}
                </button>
              </label>
            );
          })}

          {visibleHeldPermissions(permissions, messagingPermTypes).map((held) => (
              <div
                key={held}
                className="flex items-center justify-between text-xs text-secondary-600 dark:text-secondary-400"
              >
                <span>{permissionLabel(held)}</span>
                <span className="rounded bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  ON
                </span>
              </div>
            ))}

          {isSelf ? null : (
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
          )}
        </div>
      ) : (
        <div className="space-y-1 border-t border-secondary-200 bg-secondary-50/50 px-3 pb-3 pt-2 dark:border-secondary-700 dark:bg-secondary-900/60">
          {visibleHeldPermissions(permissions, []).map((p) => (
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
        </div>
      </div>
    </li>
  );
}
