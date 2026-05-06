// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';

export interface IndexerContainerConfig {
	/** Network to connect to ('testnet' or 'mainnet') */
	network: 'testnet' | 'mainnet';
	/** Optional: File Storage publisher MySo address to filter BlobCertified events */
	publisherMySoAddress?: string;
	/** Port to expose on the host (default: auto-assigned) */
	hostPort?: number;
}

export interface StartedIndexer {
	container: StartedTestContainer;
	/** The indexer URL accessible from the host (e.g. http://localhost:12345) */
	url: string;
}

/**
 * Builds the file-storage-discovery-indexer Docker image from the local Dockerfile and starts it.
 */
export async function startIndexerContainer(
	config: IndexerContainerConfig,
): Promise<StartedIndexer> {
	const INDEXER_PORT = 3001;
	const indexerDockerfilePath = '../../../file-storage-discovery-indexer';

	const container = await GenericContainer.fromDockerfile(indexerDockerfilePath).build(
		'file-storage-discovery-indexer-test',
		{ deleteOnExit: false },
	);

	const env: Record<string, string> = {
		NETWORK: config.network,
		PORT: String(INDEXER_PORT),
	};

	if (config.publisherMySoAddress) {
		env.FILE_STORAGE_PUBLISHER_MYSO_ADDRESS = config.publisherMySoAddress;
	}

	let builder = container
		.withExposedPorts(INDEXER_PORT)
		.withEnvironment(env)
		.withWaitStrategy(Wait.forHttp('/health', INDEXER_PORT).forStatusCode(200))
		.withStartupTimeout(120_000);

	builder = builder.withLogConsumer((stream) => {
		stream.on('data', (data: Buffer) => {
			console.log(`[indexer] ${data.toString().trimEnd()}`);
		});
	});

	if (config.hostPort) {
		builder = builder.withExposedPorts({
			container: INDEXER_PORT,
			host: config.hostPort,
		});
	}

	const started = await builder.start();

	const mappedPort = started.getMappedPort(INDEXER_PORT);
	const host = started.getHost();
	const url = `http://${host}:${mappedPort}`;

	console.log(`Indexer container started at ${url}`);

	return { container: started, url };
}
