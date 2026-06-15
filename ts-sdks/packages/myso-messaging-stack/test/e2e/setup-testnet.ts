// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { TestProject } from 'vitest/node';
import { MySoJsonRpcClient } from '@socialproof/myso/jsonRpc';
import { startRelayerContainer } from './fixtures/relayer-container.js';
import { startIndexerContainer } from './fixtures/indexer-container.js';
import { resolveGenesisMessagingConfig } from '../../src/genesis.js';

const TESTNET_MYDATA_KEY_SERVERS =
	'0x73d05d62c18d9374e3ea529e8e0ed6161da1a141a94d3f76ae3fe4e99356db75,0xf5d14a81a982144ae441cd7d64b09027f116a468bd36e7eca494f750591623c8';

/**
 * Testnet setup: resolves genesis messaging config from chain state,
 * starts a relayer container pointing at the real MySo testnet.
 */
export async function setupTestnet(project: TestProject) {
	console.log('Setting up E2E test environment (testnet)...');

	const mysoRpcUrl = process.env.MYSO_RPC_URL ?? 'https://fullnode.testnet.mysocial.network:443';
	const faucetUrl = process.env.FAUCET_URL ?? 'https://faucet.testnet.mysocial.network';

	const adminSecretKey = process.env.TEST_WALLET_PRIVATE_KEY;
	if (!adminSecretKey) {
		throw new Error('Missing required env var for testnet E2E: TEST_WALLET_PRIVATE_KEY');
	}

	const baseClient = new MySoJsonRpcClient({ url: mysoRpcUrl, network: 'testnet' });
	const genesisConfig = await resolveGenesisMessagingConfig(baseClient, {
		graphqlUrl: process.env.MYSO_GRAPHQL_URL,
	});

	let relayerUrl: string;
	if (process.env.RELAYER_URL) {
		relayerUrl = process.env.RELAYER_URL;
		console.log(`Using pre-deployed relayer at ${relayerUrl}`);
	} else {
		console.log('Starting relayer container for testnet...');
		const relayer = await startRelayerContainer({
			mysoRpcUrl,
			groupsPackageId: genesisConfig.permissionedGroups.originalPackageId,
		});
		relayerUrl = relayer.url;
	}

	let indexerUrl = '';
	if (process.env.INDEXER_URL) {
		indexerUrl = process.env.INDEXER_URL;
		console.log(`Using pre-deployed indexer at ${indexerUrl}`);
	} else {
		console.log('Starting indexer container for testnet...');
		const indexer = await startIndexerContainer({ network: 'testnet' });
		indexerUrl = indexer.url;
	}

	const mydataKeyServerIds = (process.env.MYDATA_KEY_SERVERS ?? TESTNET_MYDATA_KEY_SERVERS)
		.split(',')
		.filter(Boolean);
	const mydataThreshold = parseInt(process.env.MYDATA_THRESHOLD ?? '2', 10);
	const mydataServerConfigs = mydataKeyServerIds.map((objectId) => ({
		objectId,
		weight: 1,
	}));

	const { Ed25519Keypair } = await import('@socialproof/myso/keypairs/ed25519');
	const adminKeypair = Ed25519Keypair.fromSecretKey(adminSecretKey);
	const adminAddress = adminKeypair.toMySoAddress();

	project.provide('network', 'testnet');
	project.provide('localnetPort', 0);
	project.provide('graphqlPort', 0);
	project.provide('faucetPort', 0);
	project.provide('mysoToolsContainerId', '');
	project.provide('mysoClientUrl', mysoRpcUrl);
	project.provide('adminAccount', {
		secretKey: adminSecretKey,
		address: adminAddress,
	});
	project.provide('genesisConfig', genesisConfig);
	project.provide('messagingNamespaceId', genesisConfig.messaging.namespaceId);
	project.provide('messagingVersionId', genesisConfig.messaging.versionId);
	project.provide('relayerUrl', relayerUrl);
	project.provide('mydataServerConfigs', mydataServerConfigs);
	project.provide('faucetUrl', faucetUrl);
	project.provide('mydataThreshold', mydataThreshold);
	project.provide('indexerUrl', indexerUrl);

	console.log('E2E testnet environment is ready.');
	console.log(`  MySo RPC:     ${mysoRpcUrl}`);
	console.log(`  Relayer:     ${relayerUrl}`);
	console.log(`  Indexer:     ${indexerUrl || '(not available)'}`);
	console.log(`  Admin:       ${adminAddress}`);
	console.log(`  Framework:   ${genesisConfig.permissionedGroups.originalPackageId}`);
	console.log(`  Messaging:   ${genesisConfig.messaging.originalPackageId}`);
}
