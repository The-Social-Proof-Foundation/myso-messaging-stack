/**
 * Network helpers for smart-gas sponsorship gates.
 * Chat-app uses VITE_MYSO_NETWORK (not cookies like mysocial-frontend).
 */

export type NetworkType = 'mainnet' | 'testnet' | 'localnet';

export function getCurrentNetwork(): NetworkType {
  const raw = (import.meta.env.VITE_MYSO_NETWORK || 'testnet').toLowerCase().trim();
  if (raw === 'mainnet' || raw === 'testnet' || raw === 'localnet') {
    return raw;
  }
  return 'testnet';
}

/** Sponsored gas is allowed on testnet/mainnet only — never localnet. */
export function isSponsoredGasAllowed(network?: NetworkType): boolean {
  const current = network ?? getCurrentNetwork();
  return current === 'testnet' || current === 'mainnet';
}
