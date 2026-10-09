/**
 * Which addresses count as "me" in a group.
 *
 * A zkLogin account is two wallets in one chat: the chain/principal address the group
 * contract added, and the ephemeral messaging key the relayer authenticates and that
 * actually holds the membership row. Sidebar rows used to be filtered with only one of
 * them, so the viewer's other wallet was counted as a second member — which is what made
 * a 1:1 chat render two avatars. Self is therefore always the *union* of every identity
 * the app knows for the signed-in user.
 */

/** Lowercased keys for a set of self addresses; blanks are dropped. */
export function selfIdentityKeys(
  addresses: readonly (string | null | undefined)[],
): Set<string> {
  const keys = new Set<string>();
  for (const candidate of addresses) {
    const key = candidate?.trim().toLowerCase();
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Members of a group that are not the viewer, deduplicated by wallet.
 *
 * The same wallet appearing twice (case or padding differences) is one member, not two
 * faces — a duplicate would otherwise make a 1:1 chat look like a group.
 */
export function otherMemberAddresses(
  memberAddresses: readonly string[],
  selfKeys: ReadonlySet<string>,
): string[] {
  const seen = new Set<string>();
  const others: string[] = [];
  for (const address of memberAddresses) {
    const key = address.trim().toLowerCase();
    if (!key || selfKeys.has(key) || seen.has(key)) continue;
    seen.add(key);
    others.push(address);
  }
  return others;
}

/**
 * The single other member of a 1:1 chat, or `null` when that cannot be claimed.
 *
 * A 1:1 chat has exactly one non-self member, so any other count is unresolved rather
 * than a peer: a group, an empty roster, or a roster that still holds a *different*
 * address of the viewer (a rotated messaging key whose permissions row was never
 * revoked, which the client has no way to map back to its owner). Returning null keeps
 * a guess that is really the viewer from being persisted as the conversation's peer.
 */
export function pickDmPeer(
  memberAddresses: readonly string[],
  selfKeys: ReadonlySet<string>,
): string | null {
  const others = otherMemberAddresses(memberAddresses, selfKeys);
  return others.length === 1 ? others[0]! : null;
}
