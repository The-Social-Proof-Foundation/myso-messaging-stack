// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { MySoMessagingStackClientError } from '../error.js';

/**
 * A send to an MLS group is paused: some members' device certificates can't be verified right
 * now (fullnode unreachable, or a zkLogin proof that expired before this device saw it). Nothing
 * was sent and nobody was removed. Retry later; the owner's device renews its certificate on its
 * own. `retryable` is always true.
 */
export class MlsMembersUnverifiedError extends MySoMessagingStackClientError {
	readonly retryable = true;
	constructor(
		readonly groupId: string,
		/** Wallets with at least one unverifiable device. */
		readonly wallets: string[],
	) {
		super(`Waiting to verify ${wallets.length} member device(s) in ${groupId}; nothing was sent`);
		this.name = 'MlsMembersUnverifiedError';
	}
}

/**
 * Why an `mls1` group can't be read or written on this client right now:
 * - `no-device`: no MLS session here (MLS off in this build, or another tab owns this device).
 * - `not-joined`: this device isn't in the MLS group yet and couldn't join (retry later).
 * - `removed`: the wallet is no longer an on-chain reader.
 */
export type MlsUnavailableReason = 'no-device' | 'not-joined' | 'removed';

export class MlsGroupUnavailableError extends MySoMessagingStackClientError {
	constructor(
		readonly groupId: string,
		readonly reason: MlsUnavailableReason,
	) {
		super(`MLS group ${groupId} is unavailable on this device (${reason})`);
		this.name = 'MlsGroupUnavailableError';
	}
}
