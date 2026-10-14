import {describe, expect, it} from 'vitest';
import {
  MAX_ANCHOR_URI_BYTES,
  anchorDedupeKey,
  anchorNonce,
  anchorUri,
  anchoredMessageIds,
  contentDigestV1,
  contentDigestV2,
  expectedDigestHex,
  parseAnchorUri,
  transactionDigestOf,
} from './anchor';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('anchor helpers', () => {
  it('v1 is plain sha256 of the text', () => {
    expect(contentDigestV1('hello')).toHaveLength(32);
    expect(hex(contentDigestV1('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('v2 binds the digest to its room and message', () => {
    const base = contentDigestV2('yes', 'room-1', 'm-1');
    expect(base).toHaveLength(32);
    expect(base).toEqual(contentDigestV2('yes', 'room-1', 'm-1'));
    // The same words in another message or room never share a digest, and it is not plain sha256.
    expect(base).not.toEqual(contentDigestV2('yes', 'room-1', 'm-2'));
    expect(base).not.toEqual(contentDigestV2('yes', 'room-2', 'm-1'));
    expect(base).not.toEqual(contentDigestV1('yes'));
    expect(base).not.toEqual(contentDigestV2('no', 'room-1', 'm-1'));
  });

  it('builds and parses pointers, keeping old anchors readable', () => {
    expect(anchorUri('g-1', 'm-9')).toBe('myso-chat+v2://g-1/m-9');
    expect(parseAnchorUri('myso-chat+v2://g-1/m-9')).toEqual({version: 2, groupUuid: 'g-1', messageId: 'm-9'});
    expect(parseAnchorUri('myso-chat://g-1/m-9')).toEqual({version: 1, groupUuid: 'g-1', messageId: 'm-9'});
    expect(parseAnchorUri('https://x.dev/a')).toBeNull();
    expect(parseAnchorUri('myso-chat+v2://nope')).toBeNull();
    expect(() => anchorUri('g', 'x'.repeat(MAX_ANCHOR_URI_BYTES))).toThrow('too long');
  });

  it('recomputes the digest by the scheme the pointer declares', () => {
    const v2 = parseAnchorUri(anchorUri('g', 'm'))!;
    expect(expectedDigestHex('hi', v2)).toBe(hex(contentDigestV2('hi', 'g', 'm')));
    const v1 = parseAnchorUri('myso-chat://g/m')!;
    expect(expectedDigestHex('hi', v1)).toBe(hex(contentDigestV1('hi')));
  });

  it('derives a stable dedupe key per message and room', () => {
    expect(anchorDedupeKey('g', 'm')).toEqual(anchorDedupeKey('g', 'm'));
    expect(anchorDedupeKey('g', 'm')).not.toEqual(anchorDedupeKey('g', 'n'));
    expect(anchorDedupeKey('g', 'm')).not.toEqual(anchorDedupeKey('h', 'm'));
    expect(anchorDedupeKey('g', 'm')).toHaveLength(32);
  });

  it('makes a 128-bit nonce', () => {
    expect(anchorNonce(() => new Uint8Array(16).fill(0xff))).toBe((1n << 128n) - 1n);
    expect(anchorNonce(() => new Uint8Array(16))).toBe(0n);
    expect(anchorNonce()).toBeLessThan(1n << 128n);
  });

  it('strips the indexer event index off a transaction id', () => {
    expect(transactionDigestOf('7o5PzzD39wabc:0')).toBe('7o5PzzD39wabc');
    expect(transactionDigestOf('7o5PzzD39wabc')).toBe('7o5PzzD39wabc');
  });

  it('maps matched messages to their anchor details', () => {
    const map = anchoredMessageIds([
      {matchedMessageId: 'a', seq: 0, transactionId: 'tx-a:0', contentDigest: 'aa'},
      {matchedMessageId: null, seq: 1, transactionId: 'tx-n:0', contentDigest: 'nn'},
      {matchedMessageId: 'b', seq: 2, transactionId: 'tx-b:3', contentDigest: 'bb'},
    ]);
    expect([...map]).toEqual([
      ['a', {seq: 0, transactionId: 'tx-a', contentDigest: 'aa'}],
      ['b', {seq: 2, transactionId: 'tx-b', contentDigest: 'bb'}],
    ]);
  });
});
