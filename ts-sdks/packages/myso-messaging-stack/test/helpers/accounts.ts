// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { requestMySoFromFaucetV2 } from '@socialproof/myso/faucet';
import { Transaction } from '@socialproof/myso/transactions';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import type { Keypair } from '@socialproof/myso/cryptography';
import type { Account } from './types.js';
import { getNewAccount } from './get-new-account.js';

/** Amount to send to each test account (0.5 MYSO) */
const FUNDING_AMOUNT = 300_000_000n;

export type AccountFunding = { faucetUrl: string } | { client: ClientWithCoreApi; signer: Keypair };

/**
 * Creates and funds a new account.
 *
 * - Pass `{ faucetUrl }` to fund via the faucet (localnet / integration tests).
 * - Pass `{ client, signer }` to fund via MYSO transfer from the admin wallet (testnet e2e).
 */
export async function createFundedAccount(funding: AccountFunding): Promise<Account> {
	const account = getNewAccount();

	if ('faucetUrl' in funding) {
		await requestMySoFromFaucetV2({
			host: funding.faucetUrl,
			recipient: account.address,
		});
	} else {
		const tx = new Transaction();
		const [coin] = tx.splitCoins(tx.gas, [FUNDING_AMOUNT]);
		tx.transferObjects([coin], account.address);

		const result = await funding.signer.signAndExecuteTransaction({
			transaction: tx,
			client: funding.client,
		});
		await funding.client.core.waitForTransaction({ result });
	}

	return account;
}
