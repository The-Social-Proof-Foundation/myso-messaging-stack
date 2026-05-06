// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, inject } from 'vitest';
import { createMySoClient } from '../../helpers/index.js';

describe('Example Apps: Setup & Configuration', () => {
	it('should have published all packages', () => {
		const publishedPackages = inject('publishedPackages');
		expect(publishedPackages['permissioned-groups']).toBeDefined();
		expect(publishedPackages['messaging']).toBeDefined();
		expect(publishedPackages['example-app']).toBeDefined();
	});

	it('should have found the MessagingNamespace', () => {
		const namespaceId = inject('messagingNamespaceId');
		expect(namespaceId).toBeDefined();
		expect(namespaceId).toMatch(/^0x[0-9a-f]+$/);
	});

	it('should have found the Version shared object', () => {
		const versionId = inject('messagingVersionId');
		expect(versionId).toBeDefined();
		expect(versionId).toMatch(/^0x[0-9a-f]+$/);
	});

	it('should have a working myso client', async () => {
		const mysoClientUrl = inject('mysoClientUrl');
		const adminAccount = inject('adminAccount');

		const mysoClient = createMySoClient({ url: mysoClientUrl, network: 'localnet' });
		const { balance } = await mysoClient.core.getBalance({
			owner: adminAccount.address,
		});

		expect(BigInt(balance.balance)).toBeGreaterThan(0n);
	});
});
