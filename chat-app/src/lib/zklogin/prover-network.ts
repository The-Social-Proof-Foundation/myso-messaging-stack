import { getCurrentNetwork, type NetworkType } from '../network-utils'

/**
 * Network label sent to the zkLogin prover. Local fullnodes use testnet ceremony params;
 * the prover service expects `testnet` even when the wallet UI is on localnet.
 */
export function zkLoginProverNetwork(chainNetwork?: NetworkType): NetworkType {
  const fromEnv = import.meta.env.VITE_ZKLOGIN_PROVER_NETWORK
  if (fromEnv === 'mainnet' || fromEnv === 'testnet' || fromEnv === 'localnet') {
    return fromEnv
  }
  const chain = chainNetwork ?? getCurrentNetwork()
  if (chain === 'localnet') return 'testnet'
  return chain
}
