// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { MySoMessagingStackDerive } from '../../src/derive.js';

import { MOCK_PACKAGE_CONFIG } from './helpers/mock-package-config.js';

function createDerive() {
	return new MySoMessagingStackDerive({
		packageConfig: MOCK_PACKAGE_CONFIG,
	});
}

describe('MySoMessagingStackDerive', () => {
	describe('groupId', () => {
		it('should return a deterministic ID for a given UUID', () => {
			const derive = createDerive();
			const id = derive.groupId({ uuid: 'test-uuid' });

			expect(id).toBeDefined();
			expect(typeof id).toBe('string');
			expect(id.startsWith('0x')).toBe(true);
		});

		it('should return different IDs for different UUIDs', () => {
			const derive = createDerive();
			const id1 = derive.groupId({ uuid: 'uuid-1' });
			const id2 = derive.groupId({ uuid: 'uuid-2' });

			expect(id1).not.toBe(id2);
		});

		it('should return same ID on repeated calls (pure function)', () => {
			const derive = createDerive();
			const id1 = derive.groupId({ uuid: 'stable-uuid' });
			const id2 = derive.groupId({ uuid: 'stable-uuid' });

			expect(id1).toBe(id2);
		});
	});

	describe('groupLeaverId', () => {
		it('should return a deterministic ID', () => {
			const derive = createDerive();
			const id = derive.groupLeaverId();

			expect(id).toBeDefined();
			expect(typeof id).toBe('string');
			expect(id.startsWith('0x')).toBe(true);
		});

		it('should return same ID on repeated calls (pure function)', () => {
			const derive = createDerive();
			expect(derive.groupLeaverId()).toBe(derive.groupLeaverId());
		});

		it('should differ from groupId and encryptionHistoryId', () => {
			const derive = createDerive();
			const leaverId = derive.groupLeaverId();
			const groupId = derive.groupId({ uuid: 'any-uuid' });
			const encHistId = derive.encryptionHistoryId({ uuid: 'any-uuid' });

			expect(leaverId).not.toBe(groupId);
			expect(leaverId).not.toBe(encHistId);
		});
	});

	describe('groupManagerId', () => {
		it('should return a deterministic ID', () => {
			const derive = createDerive();
			const id = derive.groupManagerId();

			expect(id).toBeDefined();
			expect(typeof id).toBe('string');
			expect(id.startsWith('0x')).toBe(true);
		});

		it('should return same ID on repeated calls (pure function)', () => {
			const derive = createDerive();
			expect(derive.groupManagerId()).toBe(derive.groupManagerId());
		});

		it('should differ from groupLeaverId and groupId', () => {
			const derive = createDerive();
			const managerId = derive.groupManagerId();
			const leaverId = derive.groupLeaverId();
			const groupId = derive.groupId({ uuid: 'any-uuid' });

			expect(managerId).not.toBe(leaverId);
			expect(managerId).not.toBe(groupId);
		});
	});

	describe('systemObjectAddresses', () => {
		it('should return a Set containing groupLeaverId and groupManagerId', () => {
			const derive = createDerive();
			const addresses = derive.systemObjectAddresses();

			expect(addresses).toBeInstanceOf(Set);
			expect(addresses.size).toBe(2);
			expect(addresses.has(derive.groupLeaverId())).toBe(true);
			expect(addresses.has(derive.groupManagerId())).toBe(true);
		});

		it('should not contain groupId or encryptionHistoryId', () => {
			const derive = createDerive();
			const addresses = derive.systemObjectAddresses();

			expect(addresses.has(derive.groupId({ uuid: 'any-uuid' }))).toBe(false);
			expect(addresses.has(derive.encryptionHistoryId({ uuid: 'any-uuid' }))).toBe(false);
		});

		it('should return same values on repeated calls (pure function)', () => {
			const derive = createDerive();
			const a = derive.systemObjectAddresses();
			const b = derive.systemObjectAddresses();

			expect([...a]).toEqual([...b]);
		});
	});

	describe('encryptionHistoryId', () => {
		it('should return a deterministic ID for a given UUID', () => {
			const derive = createDerive();
			const id = derive.encryptionHistoryId({ uuid: 'test-uuid' });

			expect(id).toBeDefined();
			expect(typeof id).toBe('string');
			expect(id.startsWith('0x')).toBe(true);
		});

		it('should differ from groupId for the same UUID', () => {
			const derive = createDerive();
			const uuid = 'same-uuid';
			const groupId = derive.groupId({ uuid });
			const encHistId = derive.encryptionHistoryId({ uuid });

			expect(groupId).not.toBe(encHistId);
		});

		it('should return same ID on repeated calls (pure function)', () => {
			const derive = createDerive();
			const id1 = derive.encryptionHistoryId({ uuid: 'stable-uuid' });
			const id2 = derive.encryptionHistoryId({ uuid: 'stable-uuid' });

			expect(id1).toBe(id2);
		});
	});
});
