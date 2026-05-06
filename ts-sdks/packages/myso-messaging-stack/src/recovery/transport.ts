// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { FetchMessagesResult } from '../relayer/types.js';

/** Parameters for recovering messages — no signer needed since recovery is read-only. */
export interface RecoverMessagesParams {
	groupId: string;
	afterOrder?: number;
	beforeOrder?: number;
	limit?: number;
}

/** Read-only transport for recovering messages from an alternative storage backend. */
export interface RecoveryTransport {
	recoverMessages(params: RecoverMessagesParams): Promise<FetchMessagesResult>;
}
