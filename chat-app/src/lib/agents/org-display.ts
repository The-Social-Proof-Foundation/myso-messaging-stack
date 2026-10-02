import {formatRelativeMs} from './format';
import {orgPermissionSummary} from './org-permissions';

/** `pending` → `Pending`, `on_leave` → `On leave`. */
export function titleizeStatus(status: string): string {
  const cleaned = status.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!cleaned) return 'Unknown';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/** `memory_administrator` → `Memory administrator`. */
export function humanizeKey(value: string): string {
  const cleaned = value.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  if (!cleaned) return '—';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}

/** Bitmask → human permission list. Empty masks read as "No permissions". */
export function permissionSummary(mask: number): string {
  return orgPermissionSummary(mask) || 'No permissions';
}

export interface OrganizationMember {
  address: string;
  /** Bits the member currently holds. */
  permissionMask: number;
  /** Role names, active assignments first. */
  roles: string[];
  active: boolean;
}

/**
 * One row per wallet. Memory grants arrive as one row per permission bit, so the
 * same address would otherwise repeat once for every capability.
 */
export function groupOrganizationMembers(
  permissions: ReadonlyArray<{
    member_address: string;
    permission_kind: number;
    active: boolean;
  }>,
  assignments: ReadonlyArray<{
    member_address: string;
    role_name: string;
    active: boolean;
  }>,
): OrganizationMember[] {
  const order: string[] = [];
  const members = new Map<
    string,
    {permissionMask: number; inactiveMask: number; roles: Map<string, boolean>; active: boolean}
  >();

  function ensure(address: string) {
    let member = members.get(address);
    if (!member) {
      member = {permissionMask: 0, inactiveMask: 0, roles: new Map(), active: false};
      members.set(address, member);
      order.push(address);
    }
    return member;
  }

  for (const permission of permissions) {
    const member = ensure(permission.member_address);
    if (permission.active) {
      member.permissionMask |= permission.permission_kind;
      member.active = true;
    } else {
      member.inactiveMask |= permission.permission_kind;
    }
  }

  for (const assignment of assignments) {
    const member = ensure(assignment.member_address);
    const already = member.roles.get(assignment.role_name);
    if (already == null || assignment.active) {
      member.roles.set(assignment.role_name, assignment.active);
    }
    if (assignment.active) member.active = true;
  }

  return order.map((address) => {
    const member = members.get(address)!;
    const roles = [...member.roles.entries()]
      .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
      .map(([name]) => name);
    return {
      address,
      permissionMask: member.permissionMask || member.inactiveMask,
      roles,
      active: member.active,
    };
  });
}

/** ISO string or epoch ms → relative time. */
export function formatTimestamp(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  return formatRelativeMs(ms);
}
