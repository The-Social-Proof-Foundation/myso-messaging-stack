// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';
import { Transaction } from '@socialproof/myso/transactions';

import { PrincipalMyDataOversightPolicy } from '../../src/encryption/mydata-policy.js';

describe('PrincipalMyDataOversightPolicy', () => {
	it('targets mydata_approve_reader_with_oversight', () => {
		const policy = new PrincipalMyDataOversightPolicy({
			originalPackageId:
				'0x000000000000000000000000000000000000000000000000000000000000e110',
			latestPackageId:
				'0x000000000000000000000000000000000000000000000000000000000000e110',
			versionId: '0x0000000000000000000000000000000000000000000000000000000000000001',
			memoryAccountId: '0x0000000000000000000000000000000000000000000000000000000000000002',
			agentDerivedAddress: '0x0000000000000000000000000000000000000000000000000000000000000003',
		});

		const tx = new Transaction();
		const identity = new Uint8Array(40);
		policy.mydataApproveThunk(
			identity,
			'0x0000000000000000000000000000000000000000000000000000000000000004',
			'0x0000000000000000000000000000000000000000000000000000000000000005',
		)(tx);
		const json = tx.getData() as { commands: Array<{ MoveCall?: { function?: string } }> };
		const moveCall = json.commands.find((cmd) => cmd.MoveCall)?.MoveCall;
		expect(moveCall?.function).toBe('mydata_approve_reader_with_oversight');
	});
});
