import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { describe, expect, it, vi } from 'vitest';

import { RelayerArchiveRecoveryTransport } from '../../src/recovery/relayer-archive-recovery-transport.js';

describe('RelayerArchiveRecoveryTransport', () => {
	it('fetches archive messages from the relayer with namespace + wallet auth', async () => {
		const keypair = Ed25519Keypair.generate();
		const fetchMock = vi.fn(async () => {
			return new Response(
				JSON.stringify({
					groupId: '0xgroup',
					hasNext: false,
					messages: [
						{
							id: '11111111-1111-1111-1111-111111111111',
							group_id: '0xgroup',
							order: 2,
							sender_wallet_addr: keypair.toMySoAddress(),
							encrypted_msg: [1, 2, 3],
							nonce: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
							key_version: 0,
							created_at: '2024-01-01T00:00:00.000Z',
							updated_at: '2024-01-01T00:00:00.000Z',
							sync_status: 'SYNCED',
							quilt_patch_id: 'mysocial/groups/0xgroup/msg-11111111-1111-1111-1111-111111111111.json',
							attachments: [],
							signature: 'aa',
							public_key: '00bb',
						},
					],
				}),
				{ status: 200, headers: { 'Content-Type': 'application/json' } },
			);
		});

		const transport = new RelayerArchiveRecoveryTransport({
			relayerUrl: 'https://relayer.example.com',
			namespace: 'mysocial',
			signer: keypair,
			fetch: fetchMock as unknown as typeof fetch,
		});

		const result = await transport.recoverMessages({ groupId: '0xgroup', limit: 50 });

		expect(fetchMock).toHaveBeenCalledOnce();
		const [url, init] = fetchMock.mock.calls[0]!;
		expect(String(url)).toContain('/v1/archive/groups/0xgroup/messages');
		expect(String(url)).toContain('namespace=mysocial');
		expect((init as RequestInit).headers).toMatchObject({
			'x-sender-address': keypair.toMySoAddress(),
			'x-group-id': '0xgroup',
		});
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]!.order).toBe(2);
	});
});
