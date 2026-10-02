/** Agent label keyed by derived address, for inbox and chat-header titles. */
export function agentNamesByDerivedAddress(
  agents: readonly {derived_address: string; label: string}[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const agent of agents) {
    const address = agent.derived_address.trim().toLowerCase();
    const label = agent.label.trim();
    if (!address || !label) continue;
    names.set(address, label);
  }
  return names;
}

/**
 * Prefer the agent name over a wallet profile label when this address is an agent.
 * Human conversations keep their profile label.
 */
export function conversationPeerLabel(
  peer: string | null,
  agentNames: ReadonlyMap<string, string>,
  profileLabel: string | null,
): string | null {
  if (!peer) return profileLabel;
  return agentNames.get(peer.trim().toLowerCase()) ?? profileLabel;
}
