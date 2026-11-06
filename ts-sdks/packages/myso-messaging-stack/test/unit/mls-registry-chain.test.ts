// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { bcs } from '@socialproof/myso/bcs';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import { describe, expect, it, vi } from 'vitest';

import { ChainMlsDeviceRegistry } from '../../src/mls/registry.js';

const TABLE = '0x' + '7a'.repeat(32);
const OWNER = '0x' + '0b'.repeat(32);

function client(record: Uint8Array | 'missing' | 'down') {
	const getDynamicField = vi.fn(async (opts: { parentId: string; name: { type: string; bcs: Uint8Array } }) => {
		if (record === 'down') throw new Error('fetch failed');
		if (record === 'missing') throw Object.assign(new Error('Object does not exist'), { code: 'notExists' });
		return { dynamicField: { value: { type: 'x', bcs: record } }, opts };
	});
	const getObject = vi.fn(async () => ({
		// MlsDeviceRegistry { id: UID, devices: Table { id, size }, by_authority: Table }
		object: { content: Promise.resolve(new Uint8Array([...new Uint8Array(32).fill(1), ...Buffer.from('7a'.repeat(32), 'hex'), ...new Uint8Array(8), ...new Uint8Array(40)])) },
	}));
	return { core: { getObject, getDynamicField } } as unknown as ClientWithCoreApi & { core: { getDynamicField: typeof getDynamicField } };
}

const reg = (c: ClientWithCoreApi) =>
	new ChainMlsDeviceRegistry({ client: c, originalPackageId: '0xe110', latestPackageId: '0xe110', registryId: '0x99', versionId: '0x98' });

describe('ChainMlsDeviceRegistry', () => {
	it('reads a record from the devices table with the Move key/record layout', async () => {
		const record = bcs
			.struct('R', {
				a: bcs.vector(bcs.u8()), p: bcs.vector(bcs.u8()), until: bcs.u64(), gen: bcs.u64(), reg: bcs.u64(), rev: bcs.u64(),
			})
			.serialize({ a: new Uint8Array(32).fill(0xaa), p: [], until: 0, gen: 1, reg: 1_000, rev: 0 })
			.toBytes();
		const c = client(record);
		const got = await reg(c).lookup(OWNER, 'web-1');
		expect(got).toEqual({
			authorityKey: 'aa'.repeat(32), previousKey: '', previousValidUntilMs: 0, generation: 1, registeredAtMs: 1_000, revokedAtMs: 0,
		});
		const call = c.core.getDynamicField.mock.calls[0]![0];
		expect(call.parentId).toBe(TABLE);
		expect(call.name.type).toBe('0xe110::mls_device_registry::DeviceKey');
		// owner (32 bytes) || ULEB128 len || utf8
		expect(Array.from(call.name.bcs)).toEqual([...Buffer.from('0b'.repeat(32), 'hex'), 5, ...Buffer.from('web-1')]);
	});

	it('not found is null; a network failure throws (callers treat it as unknown)', async () => {
		expect(await reg(client('missing')).lookup(OWNER, 'x')).toBeNull();
		await expect(reg(client('down')).lookup(OWNER, 'x')).rejects.toThrow('fetch failed');
	});

	it('builds registry calls against the latest package', () => {
		const r = reg(client('missing'));
		const data = r.registerTx('web-1', 'aa'.repeat(32)).getData();
		const call = data.commands[0]!.MoveCall!;
		expect(`${call.package}::${call.module}::${call.function}`).toMatch(/::mls_device_registry::register$/);
		expect(r.rotateTx('bb'.repeat(32)).getData().commands[0]!.MoveCall!.function).toBe('rotate');
		expect(r.revokeByDeviceTx('web-1').getData().commands[0]!.MoveCall!.function).toBe('revoke_by_device');
	});
});
