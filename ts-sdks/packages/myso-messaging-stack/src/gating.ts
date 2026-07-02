// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { ClientWithCoreApi } from '@socialproof/myso/client';

export interface WalletMessagingPolicy {
	wallet: string;
	enabled: boolean;
	minCost: bigint | null;
}

export interface MessagingGatingClientOptions {
	/** Base URL for myso-social-server (no trailing slash). */
	socialServerUrl: string;
	fetch?: typeof fetch;
}

/**
 * Off-chain gating helpers for paid stranger DMs.
 *
 * Policy is wallet-keyed in `PaidMessagingRegistry` and indexed by the social server.
 */
export class MessagingGatingClient {
	#baseUrl: string;
	#fetch: typeof fetch;

	constructor(options: MessagingGatingClientOptions) {
		this.#baseUrl = options.socialServerUrl.replace(/\/$/, '');
		this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	async getWalletMessagingPolicy(wallet: string): Promise<WalletMessagingPolicy | null> {
		const response = await this.#fetch(
			`${this.#baseUrl}/wallets/${encodeURIComponent(wallet)}/messaging-policy`,
		);

		if (response.status === 404) {
			return null;
		}

		if (!response.ok) {
			throw new Error(
				`Failed to fetch messaging policy for ${wallet}: ${response.status} ${response.statusText}`,
			);
		}

		const body = (await response.json()) as {
			wallet?: string;
			enabled?: boolean;
			min_cost?: string | number | null;
		};

		return {
			wallet: body.wallet ?? wallet,
			enabled: body.enabled ?? false,
			minCost: body.min_cost === null || body.min_cost === undefined ? null : BigInt(body.min_cost),
		};
	}

	/**
	 * Returns whether a paid open is allowed off-chain before building a PTB.
	 * Does not check block/follow status — callers should combine with social graph APIs.
	 */
	async assertPaidOpenAllowed(options: {
		recipient: string;
		escrowAmount: bigint;
	}): Promise<WalletMessagingPolicy> {
		const policy = await this.getWalletMessagingPolicy(options.recipient);

		if (!policy?.enabled) {
			throw new Error(`Recipient ${options.recipient} has not enabled paid messaging.`);
		}

		if (policy.minCost !== null && options.escrowAmount < policy.minCost) {
			throw new Error(
				`Escrow amount ${options.escrowAmount} is below recipient minimum ${policy.minCost}.`,
			);
		}

		return policy;
	}
}

export function createMessagingGatingClient(options: MessagingGatingClientOptions) {
	return new MessagingGatingClient(options);
}

export type { ClientWithCoreApi };
