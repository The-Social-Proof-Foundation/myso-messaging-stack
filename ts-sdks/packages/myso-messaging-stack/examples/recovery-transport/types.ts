// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

// In your project, replace this import with:
//   import type { HttpClientConfig } from '@socialproof/myso-messaging-stack';
import type { HttpClientConfig } from '../../src/http/types.js';

/** Configuration for the File Storage recovery transport reference implementation. */
export interface FileStorageRecoveryConfig extends HttpClientConfig {
	indexerUrl: string;
	aggregatorUrl: string;
}

/** Response from GET /v1/groups/:groupId/patches on the Discovery Indexer. */
export interface IndexerPatchesResponse {
	groupId: string;
	count: number;
	hasMore: boolean;
	patches: IndexerPatch[];
}

/** A discovered patch from the Discovery Indexer. */
export interface IndexerPatch {
	identifier: string;
	messageId: string;
	groupId: string;
	senderAddress: string;
	syncStatus: string;
	blobId: string;
	order: number | null;
	checkpoint: string;
}

/** A patch entry from the File Storage aggregator's quilt patches list. */
export interface AggregatorPatchInfo {
	identifier: string;
	patch_id: string;
}
