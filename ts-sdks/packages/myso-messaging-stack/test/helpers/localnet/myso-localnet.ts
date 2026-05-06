// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { GenericContainer, Network, PullPolicy } from 'testcontainers';
import type { StartedNetwork } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';
import { resolve } from 'path';
import type { MovePackageConfig } from '../types.js';

const MYSO_TOOLS_TAG =
	process.env.MYSO_TOOLS_TAG ||
	(process.arch === 'arm64' ? 'mainnet-v1.67.3-arm64' : 'mainnet-v1.67.3');

export interface MySoLocalnetConfig {
	/** Move packages to copy into the container */
	packages: MovePackageConfig[];
	/** Whether to enable verbose logging from the container */
	verbose?: boolean;
}

export interface MySoLocalnetFixture {
	network: StartedNetwork;
	postgres: StartedTestContainer;
	localnet: StartedTestContainer;
	ports: {
		localnet: number;
		faucet: number;
		graphql: number;
		grpc: number;
	};
	containerId: string;
}

/**
 * Starts a MySo localnet environment with Postgres and the myso-tools container.
 * This is the base infrastructure needed for integration tests.
 */
export async function startMySoLocalnet(config: MySoLocalnetConfig): Promise<MySoLocalnetFixture> {
	console.log('Starting Docker network...');
	const network = await new Network().start();

	console.log('Starting Postgres...');
	const postgres = await new GenericContainer('postgres')
		.withEnvironment({
			POSTGRES_USER: 'postgres',
			POSTGRES_PASSWORD: 'postgrespw',
			POSTGRES_DB: 'myso_indexer_v2',
		})
		.withCommand(['-c', 'max_connections=500'])
		.withExposedPorts(5432)
		.withNetwork(network)
		.withPullPolicy(PullPolicy.alwaysPull())
		.start();

	console.log('Starting MySo localnet...');

	// Build copy directives for all packages
	// localPath is relative to repo root, which is 6 dirs up from test/helpers/localnet/
	const copyDirectives = config.packages.map((pkg) => ({
		source: resolve(__dirname, '../../../../../..', pkg.localPath),
		target: pkg.containerPath,
	}));

	const localnetBuilder = new GenericContainer(`socialproof/myso-tools:${MYSO_TOOLS_TAG}`)
		.withCommand([
			'myso',
			'start',
			'--with-faucet',
			'--force-regenesis',
			'--with-graphql',
			`--with-indexer=postgres://postgres:postgrespw@${postgres.getIpAddress(
				network.getName(),
			)}:5432/myso_indexer_v2`,
		])
		.withCopyDirectoriesToContainer(copyDirectives)
		.withNetwork(network)
		.withExposedPorts(9000, 9123, 9124, 9125);

	if (config.verbose) {
		localnetBuilder.withLogConsumer((stream) => {
			stream.on('data', (data) => {
				console.log(data.toString());
			});
		});
	}

	const localnet = await localnetBuilder.start();

	return {
		network,
		postgres,
		localnet,
		ports: {
			localnet: localnet.getMappedPort(9000),
			faucet: localnet.getMappedPort(9123),
			graphql: localnet.getMappedPort(9125),
			grpc: localnet.getMappedPort(9124),
		},
		containerId: localnet.getId(),
	};
}

/**
 * Stops all containers and cleans up the network.
 */
export async function stopMySoLocalnet(fixture: MySoLocalnetFixture): Promise<void> {
	console.log('Stopping MySo localnet...');
	await fixture.localnet.stop();
	await fixture.postgres.stop();
	await fixture.network.stop();
}
