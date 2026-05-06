// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { bcs } from '@socialproof/myso/bcs';
import { deriveDynamicFieldID } from '@socialproof/myso/utils';

import type { MySoMessagingStackBCS } from './bcs.js';
import type { MySoMessagingStackDerive } from './derive.js';
import type { ClientWithCoreApi } from '@socialproof/myso/client';
import { METADATA_SCHEMA_VERSION, metadataKeyType } from './constants.js';

import type { ParsedMetadata } from './bcs.js';
import type {
	EncryptedKeyViewOptions,
	EncryptionHistoryRef,
	MySoMessagingStackPackageConfig,
} from './types.js';

export interface MySoMessagingStackViewOptions {
	packageConfig: MySoMessagingStackPackageConfig;
	client: ClientWithCoreApi;
	derive: MySoMessagingStackDerive;
	bcs: MySoMessagingStackBCS;
}

/**
 * BCS type for TableVec dynamic field entries.
 * A TableVec stores entries as `Field<u64, V>` dynamic fields on its inner Table.
 */
const TableVecEntryField = bcs.struct('Field', {
	id: bcs.Address,
	name: bcs.u64(),
	value: bcs.vector(bcs.u8()),
});

/**
 * View methods for querying messaging group state.
 *
 * These methods fetch on-chain state via RPC (`getObject` + dynamic field derivation),
 * without requiring a signature or spending gas.
 *
 * For permission queries (hasPermission, isMember), use the
 * underlying permissioned-groups client: `client.groups.view.*`
 *
 * @example
 * ```ts
 * // By UUID (derives the EncryptionHistory ID internally)
 * const key = await client.messaging.view.currentEncryptedKey({ uuid: '...' });
 *
 * // By EncryptionHistory object ID
 * const key = await client.messaging.view.encryptedKey({
 *   encryptionHistoryId: '0x...',
 *   version: 0,
 * });
 * ```
 */
/**
 * Cached immutable fields from an EncryptionHistory object.
 * All fields are set at creation time and never change.
 */
interface EncryptionHistoryCache {
	tableId: string;
	groupId: string;
	uuid: string;
}

export class MySoMessagingStackView {
	#client: ClientWithCoreApi;
	#derive: MySoMessagingStackDerive;
	#bcs: MySoMessagingStackBCS;
	#packageConfig: MySoMessagingStackPackageConfig;
	/** Cache of immutable EncryptionHistory fields, keyed by encryptionHistoryId. */
	#encryptionHistoryCache = new Map<string, EncryptionHistoryCache>();
	/** Cache of group metadata, keyed by groupId. */
	#metadataCache = new Map<string, ParsedMetadata>();

	constructor(options: MySoMessagingStackViewOptions) {
		this.#client = options.client;
		this.#derive = options.derive;
		this.#bcs = options.bcs;
		this.#packageConfig = options.packageConfig;
	}

	/**
	 * Returns the encrypted DEK for a specific key version.
	 *
	 * When the table ID is cached, this makes a single RPC call (the dynamic field fetch).
	 * On first call for a given EncryptionHistory, it makes two RPC calls
	 * (one to fetch the object and populate the cache, one for the dynamic field).
	 *
	 * @param options - EncryptionHistory reference (by ID or UUID) + version
	 * @returns The encrypted DEK bytes for the requested version
	 */
	async encryptedKey(options: EncryptedKeyViewOptions): Promise<Uint8Array> {
		const encryptionHistoryId = this.#resolveEncryptionHistoryId(options);
		const { tableId } = await this.#getCachedMeta(encryptionHistoryId);
		return this.#getTableVecEntry(tableId, BigInt(options.version));
	}

	/**
	 * Returns the current (latest) key version for an EncryptionHistory.
	 *
	 * Makes one RPC call to fetch the EncryptionHistory object.
	 */
	async getCurrentKeyVersion(options: EncryptionHistoryRef): Promise<bigint> {
		const encryptionHistoryId = this.#resolveEncryptionHistoryId(options);
		const { size } = await this.#fetchEncryptionHistory(encryptionHistoryId);
		return size - 1n;
	}

	/**
	 * Returns the encrypted DEK for the current (latest) key version.
	 *
	 * Always makes at least two RPC calls: one to fetch the EncryptionHistory
	 * (to get the current size, which changes on key rotation), and one for
	 * the dynamic field entry.
	 *
	 * @param options - EncryptionHistory reference (by ID or UUID)
	 * @returns The encrypted DEK bytes for the latest version
	 */
	async currentEncryptedKey(options: EncryptionHistoryRef): Promise<Uint8Array> {
		const encryptionHistoryId = this.#resolveEncryptionHistoryId(options);
		const { tableId, size } = await this.#fetchEncryptionHistory(encryptionHistoryId);
		const currentVersion = size - 1n;
		return this.#getTableVecEntry(tableId, currentVersion);
	}

	/**
	 * Returns multiple group's metadata (name, uuid, creator, data).
	 *
	 * Results are cached since metadata changes infrequently and has no
	 * security implications. Use `{ refresh: true }` to bypass the cache.
	 *
	 * @param options.groupIds - Object IDs of the PermissionedGroup<Messaging>
	 * @param options.refresh - When true, bypasses the cache and fetches fresh data
	 * @returns The parsed Metadata struct
	 */
	async groupsMetadata(options: {
		groupIds: string[];
		refresh?: boolean;
	}): Promise<Record<string, ParsedMetadata>> {
		const result: Record<string, ParsedMetadata> = {};
		let idsToFetch: string[];

		if (!options.refresh) {
			idsToFetch = [];
			for (const groupId of options.groupIds) {
				const cached = this.#metadataCache.get(groupId);
				if (cached) {
					result[groupId] = cached;
				} else {
					idsToFetch.push(groupId);
				}
			}
		} else {
			idsToFetch = options.groupIds;
		}

		if (idsToFetch.length === 0) return result;

		const keyType = metadataKeyType(this.#packageConfig.originalPackageId);
		const keyBytes = bcs.u64().serialize(METADATA_SCHEMA_VERSION).toBytes();

		const dynamicFieldIds = idsToFetch.map((groupId) =>
			deriveDynamicFieldID(groupId, keyType, keyBytes),
		);

		const { objects: metadataObjects } = await this.#client.core.getObjects({
			objectIds: dynamicFieldIds,
			include: { content: true },
		});

		const MetadataField = bcs.struct('Field', {
			id: bcs.Address,
			name: bcs.u64(),
			value: this.#bcs.Metadata,
		});

		for (const obj of metadataObjects) {
			if (obj instanceof Error) continue;

			const parsed = MetadataField.parse(obj.content);
			const groupId = this.#derive.groupId({ uuid: parsed.value.uuid });
			this.#metadataCache.set(groupId, parsed.value);
			result[groupId] = parsed.value;
		}

		return result;
	}

	// === Private Helpers ===

	/**
	 * Resolves an EncryptionHistoryRef to an object ID.
	 * If `uuid` is provided, derives the ID. Otherwise uses the direct ID.
	 */
	#resolveEncryptionHistoryId(ref: EncryptionHistoryRef): string {
		if ('encryptionHistoryId' in ref && ref.encryptionHistoryId) {
			return ref.encryptionHistoryId;
		}
		return this.#derive.encryptionHistoryId({ uuid: ref.uuid! });
	}

	/**
	 * Returns cached immutable metadata for an EncryptionHistory.
	 * If not cached, fetches the object and populates the cache.
	 */
	async #getCachedMeta(encryptionHistoryId: string): Promise<EncryptionHistoryCache> {
		const cached = this.#encryptionHistoryCache.get(encryptionHistoryId);
		if (cached) {
			return cached;
		}
		const { tableId, groupId, uuid } = await this.#fetchEncryptionHistory(encryptionHistoryId);
		return { tableId, groupId, uuid };
	}

	/**
	 * Fetches the EncryptionHistory object from chain and populates the cache.
	 *
	 * @returns The table ID, current size (mutable — not cached), group ID, and UUID
	 */
	async #fetchEncryptionHistory(
		encryptionHistoryId: string,
	): Promise<EncryptionHistoryCache & { size: bigint }> {
		const { object } = await this.#client.core.getObject({
			objectId: encryptionHistoryId,
			include: { content: true },
		});
		const parsed = this.#bcs.EncryptionHistory.parse(object.content);

		const meta: EncryptionHistoryCache = {
			tableId: parsed.encrypted_keys.contents.id,
			groupId: parsed.group_id,
			uuid: parsed.uuid,
		};
		this.#encryptionHistoryCache.set(encryptionHistoryId, meta);

		return { ...meta, size: BigInt(parsed.encrypted_keys.contents.size) };
	}

	/**
	 * Fetches a single entry from a TableVec by its u64 index.
	 * Derives the dynamic field ID and fetches the Field<u64, vector<u8>> object.
	 */
	async #getTableVecEntry(tableId: string, index: bigint): Promise<Uint8Array> {
		const keyBytes = bcs.u64().serialize(index).toBytes();
		const dynamicFieldId = deriveDynamicFieldID(tableId, 'u64', keyBytes);

		const { object } = await this.#client.core.getObject({
			objectId: dynamicFieldId,
			include: { content: true },
		});
		const parsed = TableVecEntryField.parse(object.content);

		return new Uint8Array(parsed.value);
	}
}
