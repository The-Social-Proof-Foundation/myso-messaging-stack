// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { ClientWithCoreApi, MySoClientTypes } from '@socialproof/myso/client';
import { MySoJsonRpcClient } from '@socialproof/myso/jsonRpc';
import { MySoGrpcClient } from '@socialproof/myso/grpc';

/**
 * Supported transport types for the MySo client.
 *
 * - `'jsonRpc'` — uses `MySoJsonRpcClient` (HTTP JSON-RPC)
 * - `'grpc'` — uses `MySoGrpcClient` (gRPC-Web)
 *
 * Defaults to `'grpc'`. Can be overridden via the `MYSO_TRANSPORT`
 * environment variable (e.g. `MYSO_TRANSPORT=jsonRpc pnpm test`).
 */
export type MySoTransport = 'jsonRpc' | 'grpc';

export interface CreateMySoClientOptions {
	url: string;
	network: MySoClientTypes.Network;
	transport?: MySoTransport;
	mvr?: MySoClientTypes.MvrOptions;
}

/**
 * Resolves the transport type from an explicit option or the `MYSO_TRANSPORT` env var.
 * Falls back to `'grpc'`.
 */
export function resolveTransport(explicit?: MySoTransport): MySoTransport {
	if (explicit) return explicit;
	const env = process.env.MYSO_TRANSPORT;
	if (env === 'grpc' || env === 'jsonRpc') return env;
	return 'grpc';
}

/**
 * Creates a MySo client using the specified transport (or env-var default).
 *
 * Both `MySoJsonRpcClient` and `MySoGrpcClient` extend `BaseClient`, so
 * the returned client supports `.$extend()` identically.
 */
export function createMySoClient(options: CreateMySoClientOptions): ClientWithCoreApi {
	const { url, network, mvr } = options;
	const transport = resolveTransport(options.transport);

	switch (transport) {
		case 'grpc':
			return new MySoGrpcClient({ baseUrl: url, network, mvr });
		case 'jsonRpc':
			return new MySoJsonRpcClient({ url, network, mvr });
	}
}
