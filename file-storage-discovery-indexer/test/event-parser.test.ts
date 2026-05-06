// Unit test for BCS deserialization of BlobCertified events.
// Tests that parseFileStorageEvent correctly:
//   1. Filters out events with wrong package ID or event type
//   2. BCS-deserializes valid BlobCertified event contents
//   3. Converts blob_id from u256 to File Storage base64url format
//   4. Returns null for malformed or unrelated events

import { describe, it, expect } from 'vitest';
import { bcs } from '@socialproof/myso/bcs';
import { blobIdFromInt } from '@socialproof/file-storage';
import { parseFileStorageEvent } from '../src/event-parser.js';
import type { GrpcTypes } from '@socialproof/myso/grpc';

// The File Storage package ID we'll use in tests (fake but realistic format)
const TEST_PACKAGE_ID = '0x7e12d67a52106ddd5f26c6ff4fe740ba5dea7cfc138d5b1d33c6b3ef27b1c94f';

// Helper: create a BCS-encoded BlobCertified event
function encodeBlobCertified(params: {
  epoch: number;
  blobId: bigint;
  endEpoch: number;
  deletable: boolean;
  objectId: Uint8Array;
  isExtension: boolean;
}): Uint8Array {
  // Build the BCS struct manually — same layout as file_storage::events::BlobCertified
  const BlobCertifiedBcs = bcs.struct('BlobCertified', {
    epoch: bcs.u32(),
    blob_id: bcs.u256(),
    end_epoch: bcs.u32(),
    deletable: bcs.bool(),
    object_id: bcs.fixedArray(32, bcs.u8()),
    is_extension: bcs.bool(),
  });

  return BlobCertifiedBcs.serialize({
    epoch: params.epoch,
    blob_id: params.blobId,
    end_epoch: params.endEpoch,
    deletable: params.deletable,
    object_id: Array.from(params.objectId),
    is_extension: params.isExtension,
  }).toBytes();
}

// Helper: create a mock GrpcTypes.Event
function mockEvent(overrides: Partial<GrpcTypes.Event> = {}): GrpcTypes.Event {
  return {
    packageId: TEST_PACKAGE_ID,
    module: 'events',
    sender: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    eventType: `${TEST_PACKAGE_ID}::events::BlobCertified`,
    contents: undefined,
    json: undefined,
    ...overrides,
  };
}

describe('parseFileStorageEvent', () => {
  // A known blob ID value for testing
  const testBlobIdBigint = 12345678901234567890n;
  const expectedBlobId = blobIdFromInt(testBlobIdBigint);

  // A fake 32-byte object ID
  const testObjectId = new Uint8Array(32);
  testObjectId[0] = 0xab;
  testObjectId[31] = 0xcd;

  it('should parse a valid BlobCertified event', () => {
    const bcsBytes = encodeBlobCertified({
      epoch: 10,
      blobId: testBlobIdBigint,
      endEpoch: 20,
      deletable: true,
      objectId: testObjectId,
      isExtension: false,
    });

    const event = mockEvent({
      contents: { name: 'BlobCertified', value: bcsBytes },
    });

    const result = parseFileStorageEvent(event, TEST_PACKAGE_ID);

    expect(result).not.toBeNull();
    expect(result!.blobId).toBe(expectedBlobId);
    expect(result!.endEpoch).toBe(20);
    // object_id should be a hex string
    expect(result!.objectId).toBeTruthy();
  });

  it('should return null for a non-BlobCertified event type', () => {
    const event = mockEvent({
      eventType: `${TEST_PACKAGE_ID}::events::BlobRegistered`,
      contents: { name: 'BlobRegistered', value: new Uint8Array(10) },
    });

    const result = parseFileStorageEvent(event, TEST_PACKAGE_ID);
    expect(result).toBeNull();
  });

  it('should return null for a different package ID', () => {
    const differentPackage = '0x0000000000000000000000000000000000000000000000000000000000000001';
    const bcsBytes = encodeBlobCertified({
      epoch: 10,
      blobId: testBlobIdBigint,
      endEpoch: 20,
      deletable: false,
      objectId: testObjectId,
      isExtension: false,
    });

    const event = mockEvent({
      eventType: `${differentPackage}::events::BlobCertified`,
      contents: { name: 'BlobCertified', value: bcsBytes },
    });

    // We're filtering for TEST_PACKAGE_ID, so this should not match
    const result = parseFileStorageEvent(event, TEST_PACKAGE_ID);
    expect(result).toBeNull();
  });

  it('should return null when event contents are missing', () => {
    const event = mockEvent({
      contents: undefined,
    });

    const result = parseFileStorageEvent(event, TEST_PACKAGE_ID);
    expect(result).toBeNull();
  });

  it('should return null for malformed BCS data', () => {
    const event = mockEvent({
      contents: { name: 'BlobCertified', value: new Uint8Array([0, 1, 2, 3]) },
    });

    const result = parseFileStorageEvent(event, TEST_PACKAGE_ID);
    expect(result).toBeNull();
  });

  it('should handle package ID with or without 0x prefix', () => {
    const bcsBytes = encodeBlobCertified({
      epoch: 5,
      blobId: testBlobIdBigint,
      endEpoch: 15,
      deletable: false,
      objectId: testObjectId,
      isExtension: false,
    });

    const event = mockEvent({
      contents: { name: 'BlobCertified', value: bcsBytes },
    });

    // Pass package ID without 0x prefix
    const packageWithout0x = TEST_PACKAGE_ID.replace('0x', '');
    const result = parseFileStorageEvent(event, packageWithout0x);

    expect(result).not.toBeNull();
    expect(result!.blobId).toBe(expectedBlobId);
  });

  it('should be case-insensitive for package ID matching', () => {
    const bcsBytes = encodeBlobCertified({
      epoch: 1,
      blobId: testBlobIdBigint,
      endEpoch: 100,
      deletable: true,
      objectId: testObjectId,
      isExtension: true,
    });

    const event = mockEvent({
      eventType: `${TEST_PACKAGE_ID.toUpperCase()}::events::BlobCertified`,
      contents: { name: 'BlobCertified', value: bcsBytes },
    });

    const result = parseFileStorageEvent(event, TEST_PACKAGE_ID);
    expect(result).not.toBeNull();
  });
});
