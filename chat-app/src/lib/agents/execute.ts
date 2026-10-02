import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Signer } from '@socialproof/myso/cryptography';
import type { Transaction } from '@socialproof/myso/transactions';

import { canAffordGas } from '../gas-pool';
import { isSponsoredGasAllowed } from '../network-utils';
import { resolveGasPaymentForSigner } from '../resolve-gas-payment';
import { signAndExecuteTransactionAndWait } from '../sign-and-wait';

/** Human-signed agent/credit transaction through the app's smart-gas path. */
export function executeAsHuman(
  client: ClientWithCoreApi,
  humanSigner: Signer,
  transaction: Transaction,
): Promise<string | null> {
  return signAndExecuteTransactionAndWait(client, humanSigner, transaction, {
    logPrefix: 'Agents',
  });
}

/**
 * Agent-signed transaction (e.g. `register_sub_agent_delegated`, where the parent
 * agent must be the sender). Derived agent addresses hold no MYSO, so gas comes from
 * the gas pool where sponsorship is allowed, otherwise from the human as gas owner.
 */
export async function executeAsAgent(
  client: ClientWithCoreApi,
  agentSigner: Signer,
  humanSigner: Signer,
  transaction: Transaction,
): Promise<string> {
  const agentAddress = agentSigner.toMySoAddress();
  if (isSponsoredGasAllowed() || (await canAffordGas(client, agentAddress))) {
    const digest = await signAndExecuteTransactionAndWait(
      client,
      agentSigner,
      transaction,
      { logPrefix: 'Agents' },
    );
    if (!digest) {
      throw new Error('Agent transaction executed without a digest.');
    }
    return digest;
  }

  const humanAddress = humanSigner.toMySoAddress();
  transaction.setSender(agentAddress);
  transaction.setGasOwner(humanAddress);
  const gas = await resolveGasPaymentForSigner(client, humanAddress);
  transaction.setGasPayment(gas.kind === 'coins' ? gas.refs : []);

  const bytes = await transaction.build({ client });
  const [agentSig, humanSig] = await Promise.all([
    agentSigner.signTransaction(bytes),
    humanSigner.signTransaction(bytes),
  ]);
  const result = await client.core.executeTransaction({
    transaction: bytes,
    signatures: [agentSig.signature, humanSig.signature],
  });
  const tx = result.Transaction ?? result.FailedTransaction;
  if (!tx) {
    throw new Error('Transaction submission returned no result.');
  }
  if (tx.status.success === false) {
    throw new Error(tx.status.error?.message ?? 'On-chain transaction failed.');
  }
  await client.core.waitForTransaction({ result });
  return tx.digest;
}

/** Id of the object of `module::Struct` created by `digest`, or null. */
export async function findCreatedObjectId(
  client: ClientWithCoreApi,
  digest: string,
  structSuffix: string,
): Promise<string | null> {
  const { Transaction: tx, FailedTransaction } = await client.core.getTransaction({
    digest,
    include: { effects: true, objectTypes: true },
  });
  const result = tx ?? FailedTransaction;
  if (!result?.effects) return null;
  const types = result.objectTypes ?? {};
  const created = result.effects.changedObjects.find(
    (obj) =>
      obj.idOperation === 'Created' &&
      (types[obj.objectId] ?? '').endsWith(`::${structSuffix}`),
  );
  return created?.objectId ?? null;
}

export async function requireCreatedObjectId(
  client: ClientWithCoreApi,
  digest: string | null,
  structSuffix: string,
): Promise<string> {
  if (!digest) {
    throw new Error(
      `Transaction was sponsored without a digest; cannot find the new ${structSuffix}. Refresh and retry.`,
    );
  }
  const id = await findCreatedObjectId(client, digest, structSuffix);
  if (!id) {
    throw new Error(`Transaction ${digest} did not create a ${structSuffix}.`);
  }
  return id;
}
