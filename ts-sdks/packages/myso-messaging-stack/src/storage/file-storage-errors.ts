// Copyright (c) Mysten Labs, Inc.
// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { HttpRequestError } from '../http/errors.js';

/** Base class for errors specific to the File Storage HTTP storage adapter. */
export class FileStorageStorageError extends HttpRequestError {
	constructor(message: string, status?: number, body?: string) {
		super(message, status, body);
		this.name = 'FileStorageStorageError';
	}
}

/** A quilt upload to the File Storage publisher failed. */
export class FileStorageUploadError extends FileStorageStorageError {
	constructor(status: number, body: string) {
		super(`File Storage quilt upload failed: ${status} — ${body}`, status, body);
		this.name = 'FileStorageUploadError';
	}
}

/** A quilt patch download from the File Storage aggregator failed. */
export class FileStorageDownloadError extends FileStorageStorageError {
	constructor(status: number, body: string) {
		super(`File Storage quilt patch download failed: ${status} — ${body}`, status, body);
		this.name = 'FileStorageDownloadError';
	}
}

/** The publisher response was missing expected data. */
export class FileStorageResponseError extends FileStorageStorageError {
	constructor(message: string) {
		super(message);
		this.name = 'FileStorageResponseError';
	}
}
