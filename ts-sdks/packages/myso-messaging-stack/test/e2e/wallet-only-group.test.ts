// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E: wallet-only group create → relayer membership sync → sendMessage.

import { describe, expect, it, inject } from 'vitest';
import { RelayerTransportError, waitForMembership } from '@socialproof/myso-messaging-stack';

import { createFundedAccount, createMySoMessagingStackClient } from '../helpers/index.js';

function isRelayerMembershipPending(err: unknown): boolean {
	if (err instanceof RelayerTransportError) {
		return err.code === 'NOT_GROUP_MEMBER' || err.status === 403;
	}
	if (err instanceof Error) {
		return err.message.includes('is not a member of group');
	}
	return false;
}

describe('Wallet-only group + relayer send', () => {
	const network = inject('network');
	const relayerUrl = inject('relayerUrl');
	const mysoClientUrl = inject('mysoClientUrl');
	const genesisConfig = inject('genesisConfig');
	const faucetPort = inject('faucetPort');
	const mydataServerConfigs = inject('mydataServerConfigs');

	const faucetUrl = `http://localhost:${faucetPort}`;

	it('creates a wallet-only group and sends a message through the relayer', async () => {
		const walletAccount = await createFundedAccount({ faucetUrl });
		const walletClient = createMySoMessagingStackClient({
			url: mysoClientUrl,
			network,
			packageConfig: genesisConfig,
			keypair: walletAccount.keypair,
			relayer: { relayerUrl },
			mydata:
				mydataServerConfigs.length > 0
					? { serverConfigs: mydataServerConfigs, verifyKeyServers: false }
					: undefined,
		});

		const memoryAccountId = await walletClient.messaging.view.memoryAccountIdForOwner({
			owner: walletAccount.address,
		});
		expect(memoryAccountId).toBeNull();

		const uuid = crypto.randomUUID();
		const { digest } = await walletClient.messaging.createAndShareGroup({
			signer: walletAccount.keypair,
			uuid,
			name: 'Wallet-only E2E Group',
		});
		expect(digest).toBeDefined();

		const groupId = walletClient.messaging.derive.groupId({ uuid });

		await waitForMembership({
			messaging: walletClient.messaging,
			groupId,
			memberAddress: walletAccount.address,
			permission: 'MessagingSender',
		});

		const sendPayload = {
			signer: walletAccount.keypair,
			groupRef: { uuid },
			text: 'Hello from wallet-only group',
		};

		const deadline = Date.now() + 30_000;
		let messageId: string | undefined;
		let lastErr: unknown;

		while (Date.now() < deadline) {
			try {
				({ messageId } = await walletClient.messaging.sendMessage(sendPayload));
				break;
			} catch (err) {
				lastErr = err;
				if (!isRelayerMembershipPending(err)) {
					throw err;
				}
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}

		if (!messageId) {
			throw lastErr ?? new Error('Timed out waiting for relayer membership sync');
		}

		expect(messageId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

		const msg = await walletClient.messaging.getMessage({
			signer: walletAccount.keypair,
			groupRef: { uuid },
			messageId,
		});

		expect(msg.text).toBe('Hello from wallet-only group');
	}, 180_000);
});
