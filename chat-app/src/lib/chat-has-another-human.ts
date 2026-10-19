import { otherMemberAddresses, selfIdentityKeys } from './self-identity';

/**
 * Read receipts and online status are for people.
 * True when this chat includes a member who is not the viewer and not an agent.
 */
export function chatHasAnotherHuman(input: {
  memberAddresses: readonly string[];
  selfAddresses: readonly (string | null | undefined)[];
  isAgent: (address: string) => boolean;
}): boolean {
  const others = otherMemberAddresses(input.memberAddresses, selfIdentityKeys(input.selfAddresses));
  return others.some((address) => !input.isAgent(address));
}
