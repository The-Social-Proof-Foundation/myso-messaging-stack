// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MySoClientTypes } from '@socialproof/myso/client';
import type { ResolvedGenesisMessagingConfig } from '../../../src/genesis.js';
import type { SerializableAccount } from '../helpers/types.js';

interface MyDataServerConfig {
	objectId: string;
	weight: number;
}

declare module 'vitest' {
	export interface ProvidedContext {
		network: MySoClientTypes.Network;
		localnetPort: number;
		graphqlPort: number;
		faucetPort: number;
		mysoToolsContainerId: string;
		mysoClientUrl: string;
		adminAccount: SerializableAccount;
		genesisConfig: ResolvedGenesisMessagingConfig;
		messagingNamespaceId: string;
		messagingVersionId: string;
		relayerUrl: string;
		mydataServerConfigs: MyDataServerConfig[];
		faucetUrl: string;
		mydataThreshold?: number;
		indexerUrl: string;
	}
}
