// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MySoCodegenConfig } from '@socialproof/codegen';

const config: MySoCodegenConfig = {
	output: './src/contracts',
	// Summaries are generated manually via the codegen script, which patches
	// address_mapping.json to use MVR names for dependencies before generation.
	generateSummaries: false,
	prune: true,
	packages: [
		{
			package: '@local-pkg/myso-messaging-stack',
			path: '../../../move/packages/myso_messaging_stack',
			// Explicit packageName avoids Move.toml parsing failures caused by
			// the `r.mvr` key syntax (not supported by the toml@3 parser).
			packageName: 'myso_messaging_stack',
		},
	],
};

export default config;
