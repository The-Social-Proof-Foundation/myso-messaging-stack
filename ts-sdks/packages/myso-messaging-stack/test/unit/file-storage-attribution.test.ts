// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { fromFileStorageMessage } from '../../src/recovery/file-storage-message.js';

describe('file storage attribution recovery', () => {
	it('maps agent attribution fields from archived relayer wire', () => {
		const message = fromFileStorageMessage({
			id: 'msg-1',
			group_id: 'group-1',
			order: 1,
			sender_wallet_addr: '0xagent',
			encrypted_msg: [1, 2, 3],
			nonce: Array.from({ length: 12 }, () => 0),
			key_version: 0,
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-01-01T00:00:00.000Z',
			sync_status: 'SYNCED',
			quilt_patch_id: null,
			attachments: [],
			principal_owner: '0xprincipal',
			sub_agent_id: '0xsub',
			identity_class: 2,
		});

		expect(message.isAgentMessage).toBe(true);
		expect(message.principalOwner).toBe('0xprincipal');
		expect(message.subAgentId).toBe('0xsub');
		expect(message.identityClass).toBe(2);
	});
});
