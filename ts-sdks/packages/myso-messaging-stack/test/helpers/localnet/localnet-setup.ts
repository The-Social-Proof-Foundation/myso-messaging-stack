// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { requestMySoFromFaucetV2 } from '@socialproof/myso/faucet';
import type { MovePackageConfig, PublishedPackages } from '../types.js';
import { startMySoLocalnet } from './myso-localnet.js';
import { publishPackages } from './publisher.js';
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
	publishedPackages: PublishedPackages;
	messagingNamespaceId: string;
	messagingVersionId: string;
}

/**
 * Boots a MySo localnet container, publishes Move packages, and extracts
 * shared singleton object IDs.
 *
 * Reusable across integration and e2e globalSetup functions.
 */
export async function bootstrapLocalnet(
	packages: MovePackageConfig[],
): Promise<LocalnetSetupResult> {
	const fixture = await startMySoLocalnet({
		packages,
		verbose: true,
	});

	const LOCALNET_PORT = fixture.ports.localnet;
	const FAUCET_PORT = fixture.ports.faucet;
	const MYSO_TOOLS_CONTAINER_ID = fixture.containerId;
	const MYSO_CLIENT_URL = `http://localhost:${LOCALNET_PORT}`;

	// Initialize myso client in container and configure localnet environment
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

	// `myso_messaging` no longer depends on mysons; publish uses Move.toml as copied into the container.

	console.log('Publishing Move packages...');
	const published = await publishPackages({
		packages,
		mysoClient,
		mysoToolsContainerId: MYSO_TOOLS_CONTAINER_ID,
	});

	// Find MessagingNamespace and Version shared objects from the messaging package's publish tx
	const messagingCreated = published['messaging'].createdObjects;

	const namespaceObj = messagingCreated.find((obj) =>
		obj.objectType.includes('MessagingNamespace'),
	);
	if (!namespaceObj) {
		throw new Error('MessagingNamespace not found in messaging publish transaction');
	}
	const messagingNamespaceId = namespaceObj.objectId;
	console.log(`Found MessagingNamespace at ${messagingNamespaceId}`);

	const versionObj = messagingCreated.find((obj) => obj.objectType.includes('::version::Version'));
	if (!versionObj) {
		throw new Error('Version shared object not found in messaging publish transaction');
	}
	const messagingVersionId = versionObj.objectId;
	console.log(`Found Version at ${messagingVersionId}`);

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
		publishedPackages: published,
		messagingNamespaceId,
		messagingVersionId,
	};
}
