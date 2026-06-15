// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { ResolvedGenesisMessagingConfig } from '../../../src/genesis.js';
import type { SerializableAccount } from '../../helpers/types.js';

declare module 'vitest' {
	export interface ProvidedContext {
		localnetPort: number;
		graphqlPort: number;
		faucetPort: number;
		mysoToolsContainerId: string;
		mysoClientUrl: string;
		adminAccount: SerializableAccount;
		genesisConfig: ResolvedGenesisMessagingConfig;
		messagingNamespaceId: string;
		messagingVersionId: string;
	}
}
