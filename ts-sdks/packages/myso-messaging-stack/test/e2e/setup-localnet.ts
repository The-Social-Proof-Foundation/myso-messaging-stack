// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { TestProject } from 'vitest/node';
import { bootstrapLocalnet } from '../helpers/localnet/localnet-setup.js';
import { startRelayerContainer } from './fixtures/relayer-container.js';

/**
 * Localnet setup: spins up MySo localnet + relayer via testcontainers
 * using genesis system packages (no custom publish).
 */
export async function setupLocalnet(project: TestProject) {
	console.log('Setting up E2E test environment (localnet via testcontainers)...');

	const env = await bootstrapLocalnet();

	project.provide('network', 'localnet');
	project.provide('localnetPort', env.ports.localnet);
	project.provide('graphqlPort', env.ports.graphql);
	project.provide('faucetPort', env.ports.faucet);
	project.provide('mysoToolsContainerId', env.containerId);
	project.provide('mysoClientUrl', env.mysoClientUrl);
	project.provide('adminAccount', {
		secretKey: env.adminAccount.secretKey,
		address: env.adminAccount.address,
	});
	project.provide('genesisConfig', env.genesisConfig);
	project.provide('messagingNamespaceId', env.messagingNamespaceId);
	project.provide('messagingVersionId', env.messagingVersionId);

	console.log('Starting relayer container...');
	const relayer = await startRelayerContainer({
		mysoRpcUrl: `http://host.testcontainers.internal:${env.ports.localnet}`,
		groupsPackageId: env.genesisConfig.permissionedGroups.originalPackageId,
	});

	project.provide('relayerUrl', relayer.url);
	project.provide('mydataServerConfigs', []);
	project.provide('faucetUrl', `http://localhost:${env.ports.faucet}`);
	project.provide('indexerUrl', '');

	console.log('E2E localnet environment is ready.');
}
