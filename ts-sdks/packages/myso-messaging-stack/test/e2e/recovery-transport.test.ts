// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// E2E test for FileStorageRecoveryTransport.
// Tests the recovery transport against patches discovered by the indexer.
//
// This test depends on earlier E2E tests (messages, file-storage-sync) having sent messages
// through the relayer, which syncs them to File Storage as quilts. The indexer listens for
// BlobCertified checkpoint events and discovers those quilts. We poll the indexer until
// it has discovered patches, with a timeout to account for checkpoint processing lag.
//
// The indexer URL is injected by the E2E global setup (testcontainers or pre-deployed).
// Falls back to INDEXER_URL env var for standalone runs.
// File Storage aggregator defaults to testnet; override with AGGREGATOR_URL env var.

import { describe, expect, inject, it } from 'vitest';

import { FileStorageRecoveryTransport } from '../../examples/recovery-transport/file-storage-recovery-transport.js';
import type { RelayerMessage } from '../../src/relayer/types.js';

const INDEXER_URL = inject('indexerUrl') || process.env.INDEXER_URL;
const AGGREGATOR_URL =
	process.env.AGGREGATOR_URL || 'https://aggregator.file-storage-testnet.mysocial.network';

/** Poll the indexer until it has discovered at least one patch, or timeout. */
async function waitForIndexerPatches(
	indexerUrl: string,
	timeoutMs = 180_000,
	intervalMs = 5_000,
): Promise<{ groupIds: string[]; summary: any }> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		const summary = (await fetch(`${indexerUrl}/v1/patches`).then((r) => r.json())) as any;
		const groupIds = Object.keys(summary.groups || {});
		if (groupIds.length > 0) {
			return { groupIds, summary };
		}
		const elapsed = Math.round((Date.now() - start) / 1000);
		const health = (await fetch(`${indexerUrl}/health`)
			.then((r) => r.json())
			.catch(() => null)) as any;
		const checkpoint = health?.lastCheckpoint ?? '?';
		const totalPatches = health?.totalPatches ?? 0;
		console.log(
			`Waiting for indexer to discover patches... (${elapsed}s, checkpoint: ${checkpoint}, patches: ${totalPatches})`,
		);
		await new Promise((r) => setTimeout(r, intervalMs));
	}

	throw new Error(`Indexer did not discover any patches within ${timeoutMs / 1000}s`);
}

describe.skipIf(!INDEXER_URL)('FileStorageRecoveryTransport', () => {
	function validateMessage(msg: RelayerMessage, expectedGroupId: string) {
		expect(typeof msg.messageId).toBe('string');
		expect(msg.messageId.length).toBeGreaterThan(0);
		expect(msg.groupId).toBe(expectedGroupId);
		expect(msg.encryptedText).toBeInstanceOf(Uint8Array);
		expect(msg.encryptedText.length).toBeGreaterThan(0);
		expect(msg.nonce).toBeInstanceOf(Uint8Array);
		expect(typeof msg.keyVersion).toBe('bigint');
		expect(typeof msg.createdAt).toBe('number');
		expect(msg.createdAt).toBeGreaterThan(0);
		expect(typeof msg.isEdited).toBe('boolean');
		expect(typeof msg.isDeleted).toBe('boolean');
		expect(Array.isArray(msg.attachments)).toBe(true);
	}

	it('should verify indexer is running', async () => {
		const healthRes = await fetch(`${INDEXER_URL}/health`);
		expect(healthRes.ok).toBe(true);
	});

	it('should recover messages for a group with patches', async () => {
		// Wait for the indexer to process BlobCertified events from earlier tests.
		// The publisher address filter speeds this up significantly on testnet.
		const { groupIds } = await waitForIndexerPatches(INDEXER_URL!);

		// Pick the group with the most patches
		let testGroupId = groupIds[0];
		let maxCount = 0;
		const summary = (await fetch(`${INDEXER_URL}/v1/patches`).then((r) => r.json())) as any;
		for (const gid of groupIds) {
			const count = summary.groups[gid]?.count ?? 0;
			if (count > maxCount) {
				maxCount = count;
				testGroupId = gid;
			}
		}

		const indexerRes = (await fetch(`${INDEXER_URL}/v1/groups/${testGroupId}/patches`).then((r) =>
			r.json(),
		)) as any;
		const allPatches = indexerRes.patches || [];
		const activePatches = allPatches.filter(
			(p: any) => p.syncStatus !== 'DELETED' && p.syncStatus !== 'DELETE_PENDING',
		);

		const recovery = new FileStorageRecoveryTransport({
			indexerUrl: INDEXER_URL!,
			aggregatorUrl: AGGREGATOR_URL,
			onError: (err) => console.error(`[recovery error] ${err.message}`),
		});

		const result = await recovery.recoverMessages({ groupId: testGroupId });

		if (activePatches.length === 0) {
			expect(result.messages.length).toBe(0);
		} else {
			expect(result.messages.length).toBe(activePatches.length);
		}

		for (const msg of result.messages) {
			validateMessage(msg, testGroupId);
		}
	}, 240_000);

	it('should read from aggregator for DELETED patches', async () => {
		const summary = (await fetch(`${INDEXER_URL}/v1/patches`).then((r) => r.json())) as any;
		const groupIds = Object.keys(summary.groups || {});

		// Find a group where all patches are DELETED
		let deletedGroupId: string | undefined;
		for (const gid of groupIds) {
			const indexerRes = (await fetch(`${INDEXER_URL}/v1/groups/${gid}/patches`).then((r) =>
				r.json(),
			)) as any;
			const patches = indexerRes.patches || [];
			const activePatches = patches.filter(
				(p: any) => p.syncStatus !== 'DELETED' && p.syncStatus !== 'DELETE_PENDING',
			);
			if (patches.length > 0 && activePatches.length === 0) {
				deletedGroupId = gid;
				break;
			}
		}

		if (!deletedGroupId) {
			// No group with all-DELETED patches found; skip gracefully
			return;
		}

		const indexerRes = (await fetch(`${INDEXER_URL}/v1/groups/${deletedGroupId}/patches`).then(
			(r) => r.json(),
		)) as any;
		const testPatch = indexerRes.patches[0];

		// List patches in the quilt to get the quilt patch ID
		const patchList = (await fetch(`${AGGREGATOR_URL}/v1/quilts/${testPatch.blobId}/patches`).then(
			(r) => r.json(),
		)) as any[];
		const matchingPatch = patchList.find((p: any) => p.identifier === testPatch.identifier);
		expect(matchingPatch).toBeDefined();

		// Read raw content via the aggregator
		const patchRes = await fetch(
			`${AGGREGATOR_URL}/v1/blobs/by-quilt-patch-id/${matchingPatch.patch_id}`,
		);
		const rawText = await patchRes.text();
		const wire = JSON.parse(rawText) as any;

		expect(typeof wire.id).toBe('string');
		expect(Array.isArray(wire.encrypted_msg)).toBe(true);
		expect(Array.isArray(wire.nonce)).toBe(true);
		expect(typeof wire.created_at).toBe('string');
		expect(wire.created_at).toContain('T');
		expect(typeof wire.key_version).toBe('number');
	});

	it('should return empty for non-existent group', async () => {
		const recovery = new FileStorageRecoveryTransport({
			indexerUrl: INDEXER_URL!,
			aggregatorUrl: AGGREGATOR_URL,
			onError: (err) => console.error(`[recovery error] ${err.message}`),
		});

		const result = await recovery.recoverMessages({
			groupId: '0x0000000000000000000000000000000000000000000000000000000000000000',
		});

		expect(result.messages.length).toBe(0);
	});
});
