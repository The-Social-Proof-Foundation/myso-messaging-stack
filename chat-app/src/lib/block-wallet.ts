import { Transaction } from '@socialproof/myso/transactions';
import { GENESIS_PACKAGE_IDS } from '@socialproof/myso-messaging-stack';

/**
 * `social_contracts::block_list::block_wallet`.
 * The transaction sender is the blocker. The address argument is the peer.
 * This call does not include message content.
 */

export interface BlockWalletIds {
  blockListRegistryId: string;
  socialGraphId: string;
  socialPackageId?: string;
}

function blockWalletTarget(packageId: string): `${string}::${string}::${string}` {
  return `${packageId}::block_list::block_wallet`;
}

export function blockWalletTx(
  ids: BlockWalletIds,
  peer: string,
  tx = new Transaction(),
): Transaction {
  const registry = ids.blockListRegistryId.trim();
  const graph = ids.socialGraphId.trim();
  if (!registry || !graph) {
    throw new Error('Block list is not configured for this network.');
  }
  const socialPackageId = ids.socialPackageId ?? GENESIS_PACKAGE_IDS.social;
  tx.moveCall({
    target: blockWalletTarget(socialPackageId),
    arguments: [
      tx.object(registry),
      tx.object(graph),
      tx.pure.address(peer.trim().toLowerCase()),
    ],
  });
  return tx;
}
