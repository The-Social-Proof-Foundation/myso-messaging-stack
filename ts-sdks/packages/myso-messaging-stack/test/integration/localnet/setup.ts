// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { TestProject } from 'vitest/node';
import { MESSAGING_PACKAGES } from '../../helpers/localnet/packages.js';
import { bootstrapLocalnet } from '../../helpers/localnet/localnet-setup.js';

export default async function setup(project: TestProject) {
	console.log('Setting up messaging-groups localnet test environment...');

	const env = await bootstrapLocalnet(MESSAGING_PACKAGES);

	project.provide('localnetPort', env.ports.localnet);
	project.provide('graphqlPort', env.ports.graphql);
	project.provide('faucetPort', env.ports.faucet);
	project.provide('mysoToolsContainerId', env.containerId);
	project.provide('mysoClientUrl', env.mysoClientUrl);
	project.provide('adminAccount', {
		secretKey: env.adminAccount.secretKey,
		address: env.adminAccount.address,
	});
	project.provide('publishedPackages', env.publishedPackages);
	project.provide('messagingNamespaceId', env.messagingNamespaceId);
	project.provide('messagingVersionId', env.messagingVersionId);

	console.log('messaging-groups localnet test environment is ready.');
}
