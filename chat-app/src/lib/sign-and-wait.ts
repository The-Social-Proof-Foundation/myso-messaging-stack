import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Signer } from '@socialproof/myso/cryptography';
import type { Transaction } from '@socialproof/myso/transactions';

import { resolveGasPaymentForSigner } from './resolve-gas-payment';

/**
 * Sign and execute a PTB using a keypair signer, then wait for effects (same sequencing as messaging SDK internals).
 *
 * Pre-resolves gas payment so transaction build does not trust stale listCoins entries
 * from the local indexer (ghost coins after regenesis).
 */
export async function signAndExecuteTransactionAndWait(
  client: ClientWithCoreApi,
  signer: Signer,
  transaction: Transaction,
): Promise<void> {
  const sender = signer.toMySoAddress();
  transaction.setSenderIfNotSet(sender);

  const gas = await resolveGasPaymentForSigner(client, sender);
  if (gas.kind === 'coins') {
    transaction.setGasPayment(gas.refs);
  } else {
    // Truthy empty array skips SDK setGasPayment listCoins (address-balance gas).
    transaction.setGasPayment([]);
  }

  const result = await signer.signAndExecuteTransaction({
    transaction,
    client,
  });

  const tx = result.Transaction ?? result.FailedTransaction;
  if (!tx) {
    throw new Error('Transaction submission returned no result.');
  }

  if (tx.status.success === false) {
    throw new Error(
      tx.status.error?.message ?? 'On-chain transaction failed.',
    );
  }

  await client.core.waitForTransaction({ result });
}
