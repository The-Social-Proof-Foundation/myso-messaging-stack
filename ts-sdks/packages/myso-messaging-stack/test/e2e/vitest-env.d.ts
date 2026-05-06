// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MySoClientTypes } from '@socialproof/myso/client';
import type { PublishedPackage, SerializableAccount } from '../helpers/types.js';

interface MyDataServerConfig {
	objectId: string;
	weight: number;
}

declare module 'vitest' {
	export interface ProvidedContext {
		/** Which network the tests are running against. */
		network: MySoClientTypes.Network;
		localnetPort: number;
		graphqlPort: number;
		faucetPort: number;
		mysoToolsContainerId: string;
		mysoClientUrl: string;
		adminAccount: SerializableAccount;
		publishedPackages: Record<string, PublishedPackage>;
		messagingNamespaceId: string;
		messagingVersionId: string;
		relayerUrl: string;
		/** Real MyData key server configs. Empty for localnet (uses mock MyDataClient). */
		mydataServerConfigs: MyDataServerConfig[];
		/** Faucet URL. Provided by both localnet and testnet setups. */
		faucetUrl: string;
		/** MyData threshold. Default: 2. */
		mydataThreshold?: number;
		/** File Storage discovery indexer URL. Empty string when not available. */
		indexerUrl: string;
	}
}
