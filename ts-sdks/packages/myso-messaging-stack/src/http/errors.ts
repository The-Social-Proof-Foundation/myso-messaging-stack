// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Base error for any HTTP request failure.
 *
 * Shared across all HTTP-backed clients (File Storage adapter, future Relayer
 * transport, etc.). Carries the HTTP status and response body when available.
 */
export class HttpRequestError extends Error {
	/** HTTP status code, or `undefined` for network-level failures. */
	readonly status: number | undefined;
	/** Raw response body (text), if available. */
	readonly body: string | undefined;

	constructor(message: string, status?: number, body?: string) {
		super(message);
		this.name = 'HttpRequestError';
		this.status = status;
		this.body = body;
	}
}

/** The request timed out before a response was received. */
export class HttpTimeoutError extends HttpRequestError {
	constructor(url: string, timeoutMs: number) {
		super(`Request timed out after ${timeoutMs}ms: ${url}`);
		this.name = 'HttpTimeoutError';
	}
}
