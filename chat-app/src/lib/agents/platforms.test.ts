import {describe, expect, it} from 'vitest';

import {
  joinablePlatforms,
  pickAgentChatPlatform,
  type ApprovedPlatform,
  type PlatformAccess,
} from './platforms';

function platform(id: string, name = id): ApprovedPlatform {
  return {platformId: id, name, tagline: null};
}

function access(entries: Record<string, Partial<PlatformAccess>>): Map<string, PlatformAccess> {
  return new Map(
    Object.entries(entries).map(([id, value]) => [
      id.toLowerCase(),
      {isMember: false, isBlocked: false, ...value},
    ]),
  );
}

describe('pickAgentChatPlatform', () => {
  it('returns null when the wallet has joined nothing', () => {
    const picked = pickAgentChatPlatform({
      platforms: [platform('0xaaa'), platform('0xbbb')],
      access: access({}),
    });

    expect(picked).toBeNull();
  });

  it('picks the first approved platform the wallet has joined', () => {
    const picked = pickAgentChatPlatform({
      platforms: [platform('0xaaa'), platform('0xbbb', 'Beta')],
      access: access({'0xbbb': {isMember: true}}),
    });

    expect(picked?.platformId).toBe('0xbbb');
    expect(picked?.name).toBe('Beta');
  });

  it('honours VITE_PLATFORM_ID when the wallet is a member', () => {
    const picked = pickAgentChatPlatform({
      configuredPlatformId: '0xbbb',
      platforms: [platform('0xaaa'), platform('0xbbb', 'Beta')],
      access: access({'0xaaa': {isMember: true}, '0xbbb': {isMember: true}}),
    });

    expect(picked?.platformId).toBe('0xbbb');
  });

  it('falls back to another joined platform when the configured one is not joined', () => {
    const picked = pickAgentChatPlatform({
      configuredPlatformId: '0xbbb',
      platforms: [platform('0xaaa'), platform('0xbbb')],
      access: access({'0xaaa': {isMember: true}}),
    });

    expect(picked?.platformId).toBe('0xaaa');
  });

  it('accepts a configured platform the indexer does not list, when joined', () => {
    const picked = pickAgentChatPlatform({
      configuredPlatformId: '0xccc',
      platforms: [platform('0xaaa')],
      access: access({'0xccc': {isMember: true}}),
    });

    expect(picked?.platformId).toBe('0xccc');
    expect(picked?.name).toBe('0xccc');
  });

  it('rejects a configured platform the wallet has not joined', () => {
    const picked = pickAgentChatPlatform({
      configuredPlatformId: '0xccc',
      platforms: [platform('0xaaa')],
      access: access({}),
    });

    expect(picked).toBeNull();
  });

  it('matches platform ids case-insensitively', () => {
    const picked = pickAgentChatPlatform({
      configuredPlatformId: '0xAAA',
      platforms: [platform('0xaaa', 'Alpha')],
      access: access({'0xAAA': {isMember: true}}),
    });

    expect(picked?.name).toBe('Alpha');
  });
});

describe('joinablePlatforms', () => {
  it('offers approved platforms the wallet has neither joined nor been blocked by', () => {
    const joinable = joinablePlatforms({
      platforms: [platform('0xaaa'), platform('0xbbb'), platform('0xccc')],
      access: access({
        '0xaaa': {isMember: true},
        '0xbbb': {isBlocked: true},
      }),
    });

    expect(joinable.map((p) => p.platformId)).toEqual(['0xccc']);
  });
});
