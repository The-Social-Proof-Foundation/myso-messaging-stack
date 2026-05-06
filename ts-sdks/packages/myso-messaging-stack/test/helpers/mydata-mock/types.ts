// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { ClientWithCoreApi } from '@socialproof/myso/client';

export interface MockMyDataClientOptions {
	/** MySo client for dry-running mydata_approve transactions. */
	mysoClient: ClientWithCoreApi;
	/** Messaging package ID (used in EncryptedObject BCS serialization). */
	packageId: string;
}
