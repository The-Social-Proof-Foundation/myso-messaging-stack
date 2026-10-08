/**
 * localStorage-backed store for group data.
 *
 * Groups are persisted so the sidebar can render instantly on page load
 * without waiting for GraphQL event discovery to complete.
 */

const STORAGE_KEY = 'chat-app-groups';
const SELECTED_GROUP_KEY = 'chat-app-selected-group';
const SELECTED_ORGANIZATION_KEY = 'chat-app-selected-organization';

export interface StoredGroup {
  uuid: string;
  name: string;
  groupId: string;
  createdAt: number;
  /** Highest known relayer message order — used for sidebar sort before network refresh. */
  lastActivityOrder?: number;
}

/** Read the last-selected group key for a wallet (uuid or groupId). */
export function getSelectedGroupKey(walletAddress?: string | null): string | null {
  if (!walletAddress) return null;
  try {
    const raw = localStorage.getItem(SELECTED_GROUP_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, string>;
    const key = map[walletAddress.toLowerCase()];
    return typeof key === 'string' && key.length > 0 ? key : null;
  } catch {
    return null;
  }
}

/** Persist the selected group key for a wallet (uuid preferred). */
export function setSelectedGroupKey(
  walletAddress: string | null | undefined,
  selectedKey: string | null,
): void {
  if (!walletAddress) return;
  try {
    const addr = walletAddress.toLowerCase();
    let map: Record<string, string> = {};
    try {
      const raw = localStorage.getItem(SELECTED_GROUP_KEY);
      if (raw) map = JSON.parse(raw) as Record<string, string>;
    } catch {
      map = {};
    }
    if (selectedKey) {
      map[addr] = selectedKey;
    } else {
      delete map[addr];
    }
    localStorage.setItem(SELECTED_GROUP_KEY, JSON.stringify(map));
  } catch {
    // ignore (e.g. private mode / disabled storage)
  }
}

/** Read all stored groups from localStorage. */
export function getStoredGroups(): StoredGroup[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as StoredGroup[];
  } catch {
    return [];
  }
}

/**
 * Add a group to localStorage. No-ops when the group already exists (by
 * uuid or groupId), so replayed discovery events are harmless.
 */
export function addStoredGroup(group: StoredGroup): void {
  const groups = getStoredGroups();
  const exists = groups.some(
    (g) =>
      (group.uuid && g.uuid === group.uuid) || g.groupId === group.groupId,
  );
  if (exists) return;
  groups.push(group);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

/** Remove a group from localStorage by uuid. */
export function removeStoredGroup(groupId: string): void {
  const groups = getStoredGroups().filter((g) => g.groupId !== groupId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

/** Update a group's cached activity order in localStorage. */
export function updateStoredGroupActivityOrder(
  groupId: string,
  lastActivityOrder: number,
): void {
  const groups = getStoredGroups().map((g) =>
    g.groupId === groupId ? { ...g, lastActivityOrder } : g,
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

/** Update a group's name in localStorage. */
export function updateStoredGroupName(uuid: string, name: string): void {
  const groups = getStoredGroups().map((g) =>
    g.uuid === uuid ? { ...g, name } : g,
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

/** Read the last-open agentic organization for a wallet. */
export function getSelectedOrganizationId(walletAddress?: string | null): string | null {
  if (!walletAddress) return null;
  try {
    const raw = localStorage.getItem(SELECTED_ORGANIZATION_KEY);
    if (!raw) return null;
    const id = (JSON.parse(raw) as Record<string, string>)[walletAddress.toLowerCase()];
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Persist (or clear, with `null`) the open agentic organization for a wallet. */
export function setSelectedOrganizationId(
  walletAddress: string | null | undefined,
  organizationId: string | null,
): void {
  if (!walletAddress) return;
  try {
    let map: Record<string, string> = {};
    try {
      const raw = localStorage.getItem(SELECTED_ORGANIZATION_KEY);
      if (raw) map = JSON.parse(raw) as Record<string, string>;
    } catch {
      map = {};
    }
    const addr = walletAddress.toLowerCase();
    if (organizationId) map[addr] = organizationId;
    else delete map[addr];
    localStorage.setItem(SELECTED_ORGANIZATION_KEY, JSON.stringify(map));
  } catch {
    // ignore (e.g. private mode / disabled storage)
  }
}
