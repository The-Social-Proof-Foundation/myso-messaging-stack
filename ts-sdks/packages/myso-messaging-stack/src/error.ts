// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

export class MySoMessagingStackClientError extends Error {}

/**
 * Thrown when the MyData key servers deny access during encryption or decryption.
 * This typically means the user lacks on-chain permissions for the group.
 */
export class EncryptionAccessDeniedError extends MySoMessagingStackClientError {
	constructor(cause: unknown) {
		super(
			'Encryption access denied: user does not have permission to encrypt/decrypt for this group',
		);
		this.name = 'EncryptionAccessDeniedError';
		this.cause = cause;
	}
}
