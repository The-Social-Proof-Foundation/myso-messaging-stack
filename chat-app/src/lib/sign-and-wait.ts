import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Signer } from '@socialproof/myso/cryptography';
import type { Transaction } from '@socialproof/myso/transactions';
import { toBase64 } from '@socialproof/myso/utils';

import {
  canAffordGas,
  executeSponsoredTransaction,
  extractSponsoredDigest,
  reserveGas,
} from './gas-pool';
import { getCurrentNetwork, isSponsoredGasAllowed } from './network-utils';
import { resolveGasPaymentForSigner } from './resolve-gas-payment';
import {
  sessionLooksLikeZkLogin,
  zkLoginChainAddress,
  zkLoginChainSignature,
} from './zklogin-signin';

export type SignAndWaitOptions = {
  signal?: AbortSignal;
  gasBudget?: number;
  reserveDurationSecs?: number;
  logPrefix?: string;
  /** Account that pays gas and is the on-chain sender. Defaults to the signer address. */
  senderAddress?: string;
  /** Replaces the signer's own signature. Used for zkLogin. */
  signTransactionBytes?: (txBytes: Uint8Array) => Promise<string>;
};

/**
 * Sign and execute a PTB with smart gas (mysocial-frontend parity):
 * - localnet: always user-pays (existing RPC-verified gas path)
 * - testnet/mainnet + MYSO >= 0.001: user-pays
 * - testnet/mainnet + MYSO < 0.001: gas-pool sponsor
 *
 * Pre-resolves user gas payment so builds do not trust stale listCoins entries
 * from the local indexer (ghost coins after regenesis).
 *
 * Resolves to the executed digest, or `null` when the gas pool returned none.
 */
export async function signAndExecuteTransactionAndWait(
  client: ClientWithCoreApi,
  signer: Signer,
  transaction: Transaction,
  options: SignAndWaitOptions = {},
): Promise<string | null> {
  const {
    gasBudget = 10_000_000,
    reserveDurationSecs = 420,
    logPrefix = 'SmartGas',
  } = options;

  options.signal?.throwIfAborted();
  const signerAddress = signer.toMySoAddress();
  const sender = options.senderAddress ?? signerAddress;
  transaction.setSender(sender);

  const network = getCurrentNetwork();
  const sponsoredAllowed = isSponsoredGasAllowed(network);
  const zkAddress = options.senderAddress ? null : zkLoginChainAddress();
  if (
    !options.senderAddress &&
    sessionLooksLikeZkLogin() &&
    !zkAddress
  ) {
    throw new Error('Sign in again so this zkLogin account can sign the transaction.');
  }

  const canAfford = await canAffordGas(client, sender);
  const zkPaysGas =
    zkAddress != null &&
    zkAddress.toLowerCase() !== signerAddress.toLowerCase() &&
    !canAfford &&
    (await canAffordGas(client, zkAddress));
  if (zkPaysGas && zkAddress) {
    return executeGasOwnerPaid(client, signer, transaction, zkAddress, options.signal);
  }

  console.log(
    `[${logPrefix}] network=${network} sponsoredAllowed=${sponsoredAllowed} canAfford=${canAfford}`,
  );

  if (!sponsoredAllowed && !canAfford) {
    throw new Error(
      'Insufficient MySo balance to pay for gas. Sponsored transactions are not available on localnet. Please ensure you have sufficient MySo balance.',
    );
  }

  if (canAfford || !sponsoredAllowed) {
    return executeUserPaid(client, signer, transaction, options.signTransactionBytes, options.signal);
  }

  return executeSponsored(
    client,
    signer,
    transaction,
    sender,
    gasBudget,
    reserveDurationSecs,
    logPrefix,
    options.signal,
  );
}

/** Messaging identity stays the ephemeral key. Gas is paid by the funded zkLogin account. */
async function executeGasOwnerPaid(
  client: ClientWithCoreApi,
  senderSigner: Signer,
  transaction: Transaction,
  gasOwner: string,
  signal?: AbortSignal,
): Promise<string> {
  transaction.setSender(senderSigner.toMySoAddress());
  transaction.setGasOwner(gasOwner);
  const gas = await resolveGasPaymentForSigner(client, gasOwner);
  transaction.setGasPayment(gas.kind === 'coins' ? gas.refs : []);

  const txBytes = await transaction.build({ client });
  signal?.throwIfAborted();
  const senderSig = await senderSigner.signTransaction(txBytes);
  const gasSig = await zkLoginChainSignature(txBytes);
  if (!gasSig) {
    throw new Error('Sign in again so this zkLogin account can sign the transaction.');
  }
  signal?.throwIfAborted();
  const result = await client.core.executeTransaction({
    transaction: txBytes,
    signatures: [senderSig.signature, gasSig],
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

async function executeUserPaid(
  client: ClientWithCoreApi,
  signer: Signer,
  transaction: Transaction,
  signTransactionBytes?: (txBytes: Uint8Array) => Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  const sender = transaction.getData().sender ?? signer.toMySoAddress();
  const gas = await resolveGasPaymentForSigner(client, sender);
  if (gas.kind === 'coins') {
    transaction.setGasPayment(gas.refs);
  } else {
    // Truthy empty array skips SDK setGasPayment listCoins (address-balance gas).
    transaction.setGasPayment([]);
  }

  signal?.throwIfAborted();
  const result = (signTransactionBytes || signal)
    ? await (async () => {
        const txBytes = await transaction.build({ client });
        signal?.throwIfAborted();
        const signature=signTransactionBytes?await signTransactionBytes(txBytes):(await signer.signTransaction(txBytes)).signature;
        signal?.throwIfAborted();
        return client.core.executeTransaction({transaction:txBytes,signatures:[signature]});
      })()
    : await signer.signAndExecuteTransaction({transaction,client});

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
  return tx.digest;
}

async function executeSponsored(
  client: ClientWithCoreApi,
  signer: Signer,
  transaction: Transaction,
  senderAddress: string,
  gasBudget: number,
  reserveDurationSecs: number,
  logPrefix: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const reservation = await reserveGas(gasBudget, reserveDurationSecs);
  const { sponsor_address, reservation_id, gas_coins } = reservation.result;

  console.log(
    `[${logPrefix}] reserved gas id=${reservation_id} sponsor=${sponsor_address.slice(0, 12)}… coins=${gas_coins.length}`,
  );

  transaction.setSender(senderAddress);
  transaction.setGasOwner(sponsor_address);
  transaction.setGasPayment(
    gas_coins.map((coin) => ({
      objectId: coin.objectId,
      version: String(coin.version),
      digest: coin.digest,
    })),
  );

  const txBytes = await transaction.build({ client });
  signal?.throwIfAborted();
  const { signature } = await signer.signTransaction(txBytes);
  const txBytesBase64 = toBase64(txBytes);

  signal?.throwIfAborted();
  const sponsoredResult = await executeSponsoredTransaction(
    reservation_id,
    txBytesBase64,
    signature,
  );

  const digest = extractSponsoredDigest(sponsoredResult);
  if (!digest) {
    console.warn(
      `[${logPrefix}] Sponsored execute returned no digest; skipping waitForTransaction`,
      sponsoredResult,
    );
    return null;
  }

  await client.core.waitForTransaction({ digest });
  return digest;
}
