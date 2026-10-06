import {normalizeMetadataHex} from './agent-chats';

/** Agent label keyed by canonical derived address, for inbox and chat titles. */
export function agentNamesByDerivedAddress(
  agents: readonly {derived_address: string; label: string}[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const agent of agents) {
    const address = normalizeMetadataHex(agent.derived_address);
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
  const address = normalizeMetadataHex(peer);
  if (!address) return profileLabel;
  return agentNames.get(address) ?? profileLabel;
}

/** Addresses that should render an agent orb: our agents, plus agent-chat creators. */
export function knownAgentAddressSet(
  derivedAddresses: readonly string[],
  creatorActors: readonly (string | null | undefined)[],
): ReadonlySet<string> {
  const known = new Set<string>();
  for (const address of derivedAddresses) {
    const key = normalizeMetadataHex(address);
    if (key) known.add(key);
  }
  for (const actor of creatorActors) {
    const key = normalizeMetadataHex(actor);
    if (key) known.add(key);
  }
  return known;
}

export function isKnownAgentAddress(
  address: string | null | undefined,
  known: ReadonlySet<string>,
): boolean {
  const key = normalizeMetadataHex(address);
  return Boolean(key && known.has(key));
}
