// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { isValidMySoAddress } from '@socialproof/myso/utils';
import { describe, expect, it } from 'vitest';

import { GENESIS_MESSAGING_WITNESS_TYPE, GENESIS_PACKAGE_IDS } from '../../src/genesis.js';

describe('GENESIS_PACKAGE_IDS', () => {
	it('should use valid 32-byte MySo addresses for every genesis package', () => {
		for (const [name, address] of Object.entries(GENESIS_PACKAGE_IDS)) {
			expect(address, `${name} must be 0x + 64 hex chars`).toHaveLength(66);
			expect(isValidMySoAddress(address), `${name} must pass isValidMySoAddress`).toBe(true);
		}
	});

	it('should build a valid witness type from the messaging package ID', () => {
		expect(GENESIS_MESSAGING_WITNESS_TYPE).toBe(
			`${GENESIS_PACKAGE_IDS.messaging}::messaging::Messaging`,
		);
		const [address] = GENESIS_MESSAGING_WITNESS_TYPE.split('::');
		expect(isValidMySoAddress(address)).toBe(true);
	});
});
