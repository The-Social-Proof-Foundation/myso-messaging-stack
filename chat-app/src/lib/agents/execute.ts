import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Signer } from '@socialproof/myso/cryptography';
import type { Transaction } from '@socialproof/myso/transactions';

import { canAffordGas } from '../gas-pool';
import { isSponsoredGasAllowed } from '../network-utils';
import { resolveGasPaymentForSigner } from '../resolve-gas-payment';
import { signAndExecuteTransactionAndWait } from '../sign-and-wait';
import { sessionLooksLikeZkLogin, zkLoginChainAddress, zkLoginChainSignature } from '../zklogin-signin';

/** Human-signed agent/credit transaction through the app's smart-gas path. */
export function executeAsHuman(
  client: ClientWithCoreApi,
  humanSigner: Signer,
  transaction: Transaction,
): Promise<string | null> {
  const zkAddress = zkLoginChainAddress();
  if (sessionLooksLikeZkLogin() && !zkAddress) {
    return Promise.reject(
      new Error('Sign in again so this zkLogin account can sign the transaction.'),
    );
  }
  return signAndExecuteTransactionAndWait(client, humanSigner, transaction, {
    logPrefix: 'Agents',
    ...(zkAddress
      ? {
          senderAddress: zkAddress,
          signTransactionBytes: (txBytes) => {
            return zkLoginChainSignature(txBytes).then((signature) => {
              if (!signature) {
                throw new Error('Sign in again so this zkLogin account can sign the transaction.');
              }
              return signature;
            });
          },
        }
      : {}),
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
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const agentAddress = agentSigner.toMySoAddress();
  if (isSponsoredGasAllowed() || (await canAffordGas(client, agentAddress))) {
    const digest = await signAndExecuteTransactionAndWait(
      client,
      agentSigner,
      transaction,
      { logPrefix: 'Agents', signal },
    );
    if (!digest) {
      throw new Error('Agent transaction executed without a digest.');
    }
    return digest;
  }

  const zkAddress = zkLoginChainAddress();
  if (sessionLooksLikeZkLogin() && !zkAddress) {
    throw new Error('Sign in again so this zkLogin account can sign the transaction.');
  }
  const gasPayer = zkAddress ?? humanSigner.toMySoAddress();
  if (!(await canAffordGas(client, gasPayer))) {
    throw new Error(
      'Insufficient MySo balance to pay for gas. Sponsored transactions are not available on localnet. Please ensure you have sufficient MySo balance.',
    );
  }
  transaction.setSender(agentAddress);
  transaction.setGasOwner(gasPayer);
  const gas = await resolveGasPaymentForSigner(client, gasPayer);
  transaction.setGasPayment(gas.kind === 'coins' ? gas.refs : []);

  const bytes = await transaction.build({ client });
  signal?.throwIfAborted();
  const agentSig = await agentSigner.signTransaction(bytes);
  const gasSig = zkAddress
    ? await zkLoginChainSignature(bytes)
    : (await humanSigner.signTransaction(bytes)).signature;
  if (!gasSig) {
    throw new Error('Sign in again so this zkLogin account can sign the transaction.');
  }
  signal?.throwIfAborted();
  const result = await client.core.executeTransaction({
    transaction: bytes,
    signatures: [agentSig.signature, gasSig],
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
