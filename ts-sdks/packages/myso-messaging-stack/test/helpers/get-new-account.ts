// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import type { Account } from './types.js';

/**
 * Creates a new Ed25519 keypair and returns an Account object.
 */
export function getNewAccount(): Account {
	const keypair = new Ed25519Keypair();
	const address = keypair.getPublicKey().toMySoAddress();
	return { keypair, address };
}
