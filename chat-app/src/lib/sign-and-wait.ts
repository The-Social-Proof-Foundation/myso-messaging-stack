import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Signer } from '@socialproof/myso/cryptography';
import type { Transaction } from '@socialproof/myso/transactions';

/**
 * Sign and execute a PTB using a keypair signer, then wait for effects (same sequencing as messaging SDK internals).
 */
export async function signAndExecuteTransactionAndWait(
  client: ClientWithCoreApi,
  signer: Signer,
  transaction: Transaction,
): Promise<void> {
  transaction.setSenderIfNotSet(signer.toMySoAddress());

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
