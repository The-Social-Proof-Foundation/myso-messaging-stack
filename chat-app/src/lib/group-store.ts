/**
 * localStorage-backed store for group data.
 *
 * Groups are persisted so the sidebar can render instantly on page load
 * without waiting for GraphQL event discovery to complete.
 */

const STORAGE_KEY = 'chat-app-groups';

export interface StoredGroup {
  uuid: string;
  name: string;
  groupId: string;
  createdAt: number;
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

/** Add a group to localStorage (deduplicates by uuid). */
export function addStoredGroup(group: StoredGroup): void {
  const groups = getStoredGroups();
  groups.push(group);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

/** Remove a group from localStorage by uuid. */
export function removeStoredGroup(groupId: string): void {
  const groups = getStoredGroups().filter((g) => g.groupId !== groupId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}

/** Update a group's name in localStorage. */
export function updateStoredGroupName(uuid: string, name: string): void {
  const groups = getStoredGroups().map((g) =>
    g.uuid === uuid ? { ...g, name } : g,
  );
  localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
}
