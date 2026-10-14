import {beforeEach, describe, expect, it} from 'vitest';
import {
  addSelfAlias,
  getSelfAliases,
  isSelfAddress,
  normalizeAddress,
  removeSelfAlias,
  type AliasStorage,
} from './self-aliases';

const ACCOUNT = '0x' + '31'.repeat(32);
const OLD = '0x' + 'c8'.repeat(32);
const NEW = '0x' + 'd9'.repeat(32);

let store: Map<string, string>;
let storage: AliasStorage;
beforeEach(() => {
  store = new Map();
  storage = {getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v)};
});

describe('self aliases', () => {
  it('normalizes padding and case', () => {
    expect(normalizeAddress('0xABC')).toBe('0xabc');
    expect(normalizeAddress('0x000abc')).toBe('0xabc');
    expect(normalizeAddress(' 0xAbC ')).toBe('0xabc');
  });

  it('remembers an address for an account, once', () => {
    expect(addSelfAlias(ACCOUNT, OLD, storage)).toBe(true);
    expect(addSelfAlias(ACCOUNT, OLD.toUpperCase().replace('0X', '0x'), storage)).toBe(false);
    expect(getSelfAliases(ACCOUNT, storage)).toEqual([normalizeAddress(OLD)]);
  });

  it('keeps accounts separate, so one person never inherits another', () => {
    addSelfAlias(ACCOUNT, OLD, storage);
    expect(getSelfAliases('0x' + '99'.repeat(32), storage)).toEqual([]);
  });

  it('removes an alias', () => {
    addSelfAlias(ACCOUNT, OLD, storage);
    expect(removeSelfAlias(ACCOUNT, OLD, storage)).toBe(true);
    expect(removeSelfAlias(ACCOUNT, OLD, storage)).toBe(false);
    expect(getSelfAliases(ACCOUNT, storage)).toEqual([]);
  });

  it('refuses things that are not addresses, and works with no storage', () => {
    expect(addSelfAlias(ACCOUNT, 'not-an-address', storage)).toBe(false);
    expect(addSelfAlias('nope', OLD, storage)).toBe(false);
    expect(addSelfAlias(null, OLD, storage)).toBe(false);
    expect(addSelfAlias(ACCOUNT, OLD, null)).toBe(true);
    expect(getSelfAliases(ACCOUNT, null)).toEqual([]);
  });

  it('survives corrupt stored data', () => {
    store.set('chat-app-self-aliases', '{{{');
    expect(getSelfAliases(ACCOUNT, storage)).toEqual([]);
    expect(addSelfAlias(ACCOUNT, OLD, storage)).toBe(true);
    store.set('chat-app-self-aliases', JSON.stringify({[normalizeAddress(ACCOUNT)]: ['junk', OLD, 7]}));
    expect(getSelfAliases(ACCOUNT, storage)).toEqual([normalizeAddress(OLD)]);
  });

  it('treats the current signer and any alias as me', () => {
    const aliases = [normalizeAddress(OLD)];
    expect(isSelfAddress(OLD, NEW, aliases)).toBe(true);
    expect(isSelfAddress(NEW, NEW, aliases)).toBe(true);
    expect(isSelfAddress('0x' + '55'.repeat(32), NEW, aliases)).toBe(false);
    expect(isSelfAddress(undefined, NEW, aliases)).toBe(false);
    expect(isSelfAddress(OLD, undefined, [])).toBe(false);
  });

  it('caps the list so it cannot grow without bound', () => {
    for (let i = 1; i <= 60; i += 1) addSelfAlias(ACCOUNT, '0x' + i.toString(16).padStart(64, '0'), storage);
    expect(getSelfAliases(ACCOUNT, storage)).toHaveLength(50);
  });
});
