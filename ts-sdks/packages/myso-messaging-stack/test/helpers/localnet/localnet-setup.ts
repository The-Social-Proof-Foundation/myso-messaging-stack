// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { requestMySoFromFaucetV2 } from '@socialproof/myso/faucet';
import {
	resolveGenesisMessagingConfig,
	clearGenesisMessagingConfigCache,
} from '../../../src/genesis.js';
import type { ResolvedGenesisMessagingConfig } from '../../../src/genesis.js';
import { startMySoLocalnet } from './myso-localnet.js';
import { execCommand } from './exec-command.js';
import { getNewAccount } from '../get-new-account.js';
import { createMySoClient } from '../create-myso-client.js';

export interface LocalnetSetupResult {
	ports: { localnet: number; graphql: number; faucet: number; grpc: number };
	containerId: string;
	mysoClientUrl: string;
	adminAccount: {
		secretKey: string;
		address: string;
		keypair: ReturnType<typeof getNewAccount>['keypair'];
	};
	genesisConfig: ResolvedGenesisMessagingConfig;
	messagingNamespaceId: string;
	messagingVersionId: string;
}

/**
 * Boots a MySo localnet with force-regenesis genesis packages and resolves
 * messaging/social shared singleton IDs via GraphQL.
 */
export async function bootstrapLocalnet(): Promise<LocalnetSetupResult> {
	clearGenesisMessagingConfigCache();

	const fixture = await startMySoLocalnet({
		packages: [],
		verbose: true,
	});

	const LOCALNET_PORT = fixture.ports.localnet;
	const FAUCET_PORT = fixture.ports.faucet;
	const MYSO_TOOLS_CONTAINER_ID = fixture.containerId;
	const MYSO_CLIENT_URL = `http://localhost:${LOCALNET_PORT}`;
	const GRAPHQL_URL = `http://localhost:${fixture.ports.graphql}/graphql`;

	await execCommand(['myso', 'client', '--yes'], MYSO_TOOLS_CONTAINER_ID);
	await execCommand(
		['myso', 'client', 'new-env', '--alias', 'localnet', '--rpc', 'http://127.0.0.1:9000'],
		MYSO_TOOLS_CONTAINER_ID,
	);
	await execCommand(['myso', 'client', 'switch', '--env', 'localnet'], MYSO_TOOLS_CONTAINER_ID);
	await execCommand(['myso', 'client', 'faucet', '--json'], MYSO_TOOLS_CONTAINER_ID);

	console.log('Preparing admin account...');
	const mysoClient = createMySoClient({ url: MYSO_CLIENT_URL, network: 'localnet' });
	const admin = getNewAccount();
	await requestMySoFromFaucetV2({
		host: `http://localhost:${FAUCET_PORT}`,
		recipient: admin.address,
	});

	console.log('Resolving genesis messaging shared objects...');
	const genesisConfig = await resolveGenesisMessagingConfig(mysoClient, {
		graphqlUrl: GRAPHQL_URL,
	});

	console.log(`Found MessagingNamespace at ${genesisConfig.messaging.namespaceId}`);
	console.log(`Found Version at ${genesisConfig.messaging.versionId}`);

	return {
		ports: {
			localnet: LOCALNET_PORT,
			graphql: fixture.ports.graphql,
			faucet: FAUCET_PORT,
			grpc: fixture.ports.grpc,
		},
		containerId: MYSO_TOOLS_CONTAINER_ID,
		mysoClientUrl: MYSO_CLIENT_URL,
		adminAccount: {
			secretKey: admin.keypair.getSecretKey(),
			address: admin.address,
			keypair: admin.keypair,
		},
		genesisConfig,
		messagingNamespaceId: genesisConfig.messaging.namespaceId,
		messagingVersionId: genesisConfig.messaging.versionId,
	};
}
