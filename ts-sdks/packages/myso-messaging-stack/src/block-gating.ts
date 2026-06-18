// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

export interface BlockGatingClientOptions {
	/** Base URL for myso-social-server (no trailing slash). */
	socialServerUrl: string;
	fetch?: typeof fetch;
}

/**
 * Off-chain block checks for DM messaging.
 * Mirrors on-chain `either_blocked(a, b)`.
 */
export class BlockGatingClient {
	#baseUrl: string;
	#fetch: typeof fetch;

	constructor(options: BlockGatingClientOptions) {
		this.#baseUrl = options.socialServerUrl.replace(/\/$/, '');
		this.#fetch = options.fetch ?? fetch;
	}

	async checkEitherBlocked(a: string, b: string): Promise<boolean> {
		const response = await this.#fetch(
			`${this.#baseUrl}/blocklist/check/either/${encodeURIComponent(a)}/${encodeURIComponent(b)}`,
		);

		if (!response.ok) {
			throw new Error(
				`Failed to check block status for ${a} and ${b}: ${response.status} ${response.statusText}`,
			);
		}

		const body = (await response.json()) as { blocked?: boolean };
		return body.blocked ?? false;
	}

	async assertEitherNotBlocked(a: string, b: string): Promise<void> {
		const blocked = await this.checkEitherBlocked(a, b);
		if (blocked) {
			throw new Error('Messaging blocked between these users');
		}
	}
}

export function createBlockGatingClient(options: BlockGatingClientOptions) {
	return new BlockGatingClient(options);
}

export class BlockedMessagingError extends Error {
	constructor(message = 'Messaging blocked between these users') {
		super(message);
		this.name = 'BlockedMessagingError';
	}
}
