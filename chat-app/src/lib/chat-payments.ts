import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Signer } from '@socialproof/myso/cryptography';
import { Transaction } from '@socialproof/myso/transactions';
import {
  mistToMyso,
  type PaymentAssetRef,
  type PaymentMetadata,
} from '@socialproof/myso-messaging-stack';

import { executeAsHuman } from './agents/execute';
import { GAS_AFFORDABILITY_MIST } from './gas-pool';
import { zkLoginChainAddress } from './zklogin-signin';

/** Chat payments are 1:1 DM only. Native MYSO is the web v1 asset (no web SPT transfer flow yet). */
export const NATIVE_MYSO_ASSET: PaymentAssetRef = {
  kind: 'native',
  id: '0x2::myso::MYSO',
  symbol: 'MYSO',
  name: 'MySo',
  decimals: 9,
};

const MYSO_COIN_TYPE = '0x2::myso::MYSO';

/** Funded wallet address (zkLogin account when present, otherwise the messaging signer). */
export function fundedWalletAddress(signer: Signer): string {
  return zkLoginChainAddress() ?? signer.toMySoAddress();
}

/**
 * The funded wallet only needs to be reported to the relayer when it differs from the
 * messaging key (zkLogin). Returns `undefined` when the messaging key signed the transfer.
 */
export function senderWalletForRelayer(signer: Signer): string | undefined {
  const funded = fundedWalletAddress(signer);
  return funded.toLowerCase() === signer.toMySoAddress().toLowerCase() ? undefined : funded;
}

/**
 * Submit a native MYSO transfer from the funded wallet and return its digest.
 *
 * Splits from the gas coin, so the user must pay their own gas: sponsored gas would split the
 * sponsor's coin. A balance of `amount + 0.001 MYSO` keeps the app's smart-gas path on
 * user-pays (it only sponsors below 0.001 MYSO).
 */
export async function submitNativeMysoTransfer(input: {
  client: ClientWithCoreApi;
  signer: Signer;
  recipient: string;
  amountMist: bigint;
}): Promise<string> {
  const { client, signer, recipient, amountMist } = input;
  if (amountMist <= 0n) throw new Error('Enter an amount greater than zero.');

  const owner = fundedWalletAddress(signer);
  const { balance } = await client.core.getBalance({ owner, coinType: MYSO_COIN_TYPE });
  const total = BigInt(balance.balance ?? balance.addressBalance ?? '0');
  const needed = amountMist + BigInt(GAS_AFFORDABILITY_MIST);
  if (total < needed) {
    throw new Error(
      `Insufficient MYSO. You need ${mistToMyso(needed)} MYSO (amount plus ~0.001 for network fees).`,
    );
  }

  const tx = new Transaction();
  const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
  tx.transferObjects([coin], tx.pure.address(recipient));

  const digest = await executeAsHuman(client, signer, tx);
  if (!digest) throw new Error('Transfer was submitted but no transaction digest was returned.');
  return digest;
}

/** Base units -> display string, trimming trailing zeros ("1.5"). */
export function formatBaseUnits(amount: string, decimals: number): string {
  let value: bigint;
  try {
    value = BigInt(amount);
  } catch {
    return amount;
  }
  if (decimals <= 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

/** Link target for transaction details, from `VITE_EXPLORER_TX_URL` (e.g. `https://…/tx/{digest}`). */
export function transactionDetailsUrl(digest: string): string | null {
  const template = import.meta.env.VITE_EXPLORER_TX_URL as string | undefined;
  if (!template || !template.includes('{digest}')) return null;
  return template.replace('{digest}', encodeURIComponent(digest));
}

export type PaymentCardStatus =
  | 'pending'
  | 'success'
  | 'failed'
  | 'open'
  | 'paid'
  | 'rejected'
  | 'cancelled'
  | 'expired';

export function paymentCardStatus(meta: PaymentMetadata | undefined): PaymentCardStatus | null {
  return meta ? meta.status : null;
}

export function isPaymentKind(kind: string | null | undefined): boolean {
  return kind === 'token_transfer' || kind === 'request_payment';
}
