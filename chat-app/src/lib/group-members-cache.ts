/**
 * Shared invalidation for member label + sidebar member caches.
 * Call when a membership system message arrives so avatars/labels refresh.
 */

type Listener = (groupId: string) => void;

const listeners = new Set<Listener>();

export function onGroupMembersInvalidated(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Notify all member-cache hooks for `groupId`. */
export function invalidateGroupMembers(groupId: string): void {
  if (!groupId) return;
  for (const listener of listeners) {
    listener(groupId);
  }
}
