// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared HTTP client configuration used by any component that makes
 * HTTP requests (e.g. {@link FileStorageHttpStorageAdapter}, future `HttpRelayerTransport`).
 */
export interface HttpClientConfig {
	/**
	 * Custom `fetch` implementation.
	 * @default globalThis.fetch
	 */
	fetch?: typeof globalThis.fetch;

	/**
	 * Request timeout in milliseconds.
	 * @default 30_000
	 */
	timeout?: number;

	/**
	 * Called when a request fails. Useful for logging / telemetry.
	 * The error is still thrown after this callback returns.
	 */
	onError?: (error: Error) => void;
}

/** Default timeout used when none is specified. */
export const DEFAULT_HTTP_TIMEOUT = 30_000;
