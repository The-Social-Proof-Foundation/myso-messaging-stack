// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MySoCodegenConfig } from '@socialproof/codegen';

const config: MySoCodegenConfig = {
	output: './src/contracts',
	generateSummaries: false,
	prune: true,
	packages: [
		{
			package: '@local-pkg/messaging',
			path: '../../../../myso-core/crates/myso-framework/packages/messaging',
			packageName: 'messaging',
		},
	],
};

export default config;
