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

export type SignAndWaitOptions = {
  gasBudget?: number;
  reserveDurationSecs?: number;
  logPrefix?: string;
};

/**
 * Sign and execute a PTB with smart gas (mysocial-frontend parity):
 * - localnet: always user-pays (existing RPC-verified gas path)
 * - testnet/mainnet + MYSO >= 0.001: user-pays
 * - testnet/mainnet + MYSO < 0.001: gas-pool sponsor
 *
 * Pre-resolves user gas payment so builds do not trust stale listCoins entries
 * from the local indexer (ghost coins after regenesis).
 */
export async function signAndExecuteTransactionAndWait(
  client: ClientWithCoreApi,
  signer: Signer,
  transaction: Transaction,
  options: SignAndWaitOptions = {},
): Promise<void> {
  const {
    gasBudget = 10_000_000,
    reserveDurationSecs = 420,
    logPrefix = 'SmartGas',
  } = options;

  const sender = signer.toMySoAddress();
  transaction.setSenderIfNotSet(sender);

  const network = getCurrentNetwork();
  const sponsoredAllowed = isSponsoredGasAllowed(network);
  const canAfford = await canAffordGas(client, sender);

  console.log(
    `[${logPrefix}] network=${network} sponsoredAllowed=${sponsoredAllowed} canAfford=${canAfford}`,
  );

  if (!sponsoredAllowed && !canAfford) {
    throw new Error(
      'Insufficient MySo balance to pay for gas. Sponsored transactions are not available on localnet. Please ensure you have sufficient MySo balance.',
    );
  }

  if (canAfford || !sponsoredAllowed) {
    await executeUserPaid(client, signer, transaction);
    return;
  }

  await executeSponsored(
    client,
    signer,
    transaction,
    sender,
    gasBudget,
    reserveDurationSecs,
    logPrefix,
  );
}

async function executeUserPaid(
  client: ClientWithCoreApi,
  signer: Signer,
  transaction: Transaction,
): Promise<void> {
  const sender = signer.toMySoAddress();
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

async function executeSponsored(
  client: ClientWithCoreApi,
  signer: Signer,
  transaction: Transaction,
  senderAddress: string,
  gasBudget: number,
  reserveDurationSecs: number,
  logPrefix: string,
): Promise<void> {
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
  const { signature } = await signer.signTransaction(txBytes);
  const txBytesBase64 = toBase64(txBytes);

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
    return;
  }

  await client.core.waitForTransaction({ digest });
}
