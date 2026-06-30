// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { fromWireMessage } from '../../src/relayer/wire.js';

describe('agent message attribution wire mapping', () => {
	it('maps agent attribution fields from relayer wire format', () => {
		const message = fromWireMessage({
			message_id: 'msg-1',
			group_id: 'group-1',
			order: 1,
			encrypted_text: '00',
			nonce: '00'.repeat(12),
			key_version: 0,
			sender_address: '0xagent',
			created_at: 1,
			updated_at: 1,
			attachments: null,
			is_edited: false,
			is_deleted: false,
			sync_status: 'SYNCED',
			quilt_patch_id: null,
			signature: '00',
			public_key: '00',
			principal_owner: '0xprincipal',
			sub_agent_id: '0xsubagent',
			identity_class: 1,
		});

		expect(message.isAgentMessage).toBe(true);
		expect(message.principalOwner).toBe('0xprincipal');
		expect(message.subAgentId).toBe('0xsubagent');
		expect(message.identityClass).toBe(1);
	});

	it('treats missing attribution as human message', () => {
		const message = fromWireMessage({
			message_id: 'msg-2',
			group_id: 'group-1',
			order: 2,
			encrypted_text: '00',
			nonce: '00'.repeat(12),
			key_version: 0,
			sender_address: '0xhuman',
			created_at: 1,
			updated_at: 1,
			attachments: null,
			is_edited: false,
			is_deleted: false,
			sync_status: 'SYNCED',
			quilt_patch_id: null,
			signature: '00',
			public_key: '00',
			principal_owner: null,
			sub_agent_id: null,
			identity_class: null,
		});

		expect(message.isAgentMessage).toBe(false);
	});
});
