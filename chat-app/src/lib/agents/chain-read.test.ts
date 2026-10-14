import {describe, expect, it} from 'vitest';
import {
  accountBalance,
  cleanDigest,
  cleanUsername,
  findProfile,
  fullAddress,
  lookupObject,
  lookupTransaction,
  recentTransactions,
  resolveUsername,
  shortType,
  type Gql,
} from './chain-read';
import {SocialReadError} from './social-read';

const ADMIN = '0x2458950181e415250823d6ce1d55f2b3427826a111939e0d6d38e9a1397411d8';
const PROFILE_ID = '0xd100142cb096868a64fcdf9db2a4aff75e6e925daaf385e9b53f9f0f82963bc9';

/** A fake indexer that answers by looking at which field the query asks for. */
function indexer(overrides: Record<string, (vars: Record<string, any>) => any> = {}): {gql: Gql; calls: string[]} {
  const calls: string[] = [];
  const answers: Record<string, (vars: Record<string, any>) => any> = {
    usernameRegistryEntry: (v) => ({usernameRegistryEntry: v.u === 'myso_admin' ? {profileId: PROFILE_ID} : null}),
    'object(address: $id) { owner': () => ({object: {owner: {__typename: 'AddressOwner', address: {address: ADMIN}}}}),
    'profile(address: $a)': () => ({
      profile: {
        username: 'myso_admin',
        displayName: 'MySo Admin',
        bio: 'Hello world!!!!!',
        createdAt: 1791870411383,
        followersCount: 1,
        followingCount: 0,
        postCount: 0,
        subAgentsTotalCount: 0,
        agenticOrganizations: [],
        aiCreditBalance: {balanceMist: '0'},
        memoryAccountId: '0x6df6',
      },
      address: {balance: {totalBalance: '3001991462094'}},
    }),
    ...overrides,
  };
  const gql: Gql = async (query, variables = {}) => {
    calls.push(query);
    for (const [needle, answer] of Object.entries(answers)) if (query.includes(needle)) return answer(variables);
    return {};
  };
  return {gql, calls};
}

describe('input cleaning', () => {
  it('pads addresses and refuses junk', () => {
    expect(fullAddress('0xABC')).toBe('0x' + '0'.repeat(61) + 'abc');
    expect(() => fullAddress('abc')).toThrow(SocialReadError);
    expect(() => fullAddress('0xzz')).toThrow(SocialReadError);
  });
  it('accepts a handle with or without @, and refuses anything that could be a query', () => {
    expect(cleanUsername('@MySo_Admin')).toBe('myso_admin');
    expect(() => cleanUsername('a b')).toThrow(SocialReadError);
    expect(() => cleanUsername('x"){ y')).toThrow(SocialReadError);
    expect(() => cleanUsername('')).toThrow(SocialReadError);
  });
  it('checks digests and shortens types', () => {
    expect(cleanDigest('BxB2sutfu9s3DSF2nU1QYWpiRpKJUxVT4u3jbxoUzDbh')).toBeTruthy();
    expect(() => cleanDigest('nope')).toThrow(SocialReadError);
    expect(shortType('0x0000…50c1::platform::PlatformApprovalChangedEvent')).toBe('platform::PlatformApprovalChangedEvent');
    expect(shortType('0x2::permissioned_group::MemberAdded<0x50c1::platform::P>')).toBe('permissioned_group::MemberAdded');
    expect(shortType('plain')).toBe('plain');
  });
});

describe('findProfile', () => {
  it('finds someone from a username alone, through the registry and the profile object', async () => {
    const {gql, calls} = indexer();
    const text = await findProfile(gql, {username: '@myso_admin'});
    expect(text).toContain('@myso_admin — MySo Admin');
    expect(text).toContain(`Address: ${ADMIN}`);
    expect(text).toContain('Bio: Hello world!!!!!');
    expect(text).toContain('Followers: 1 · Following: 0 · Posts: 0');
    expect(text).toContain('Holds: 3001.991462094 MySo');
    expect(calls.length).toBe(3);
  });

  it('goes straight to the profile when it has an address', async () => {
    const {gql, calls} = indexer();
    await findProfile(gql, {address: ADMIN});
    expect(calls.length).toBe(1);
  });

  it('says plainly when a username or address has no profile', async () => {
    const {gql} = indexer();
    expect(await findProfile(gql, {username: 'ghost'})).toBe('No profile has the username @ghost.');
    const none = indexer({'profile(address: $a)': () => ({profile: null, address: {balance: {totalBalance: '5'}}})});
    expect(await findProfile(none.gql, {address: ADMIN})).toContain('No profile at');
    await expect(findProfile(gql, {})).rejects.toThrow('username or an address');
  });
});

describe('transactions', () => {
  const node = (digest: string, time: string, module: string, change?: string) => ({
    digest,
    sender: {address: ADMIN},
    effects: {
      status: 'SUCCESS',
      timestamp: time,
      gasEffects: {gasSummary: {computationCost: 1000, storageCost: 5000, storageRebate: 4000}},
      events: {nodes: module ? [{contents: {type: {repr: `0x50c1::${module}`}}}] : []},
      balanceChanges: {nodes: change ? [{owner: {address: ADMIN}, amount: change, coinType: {repr: '0x2::myso::MYSO'}}] : []},
    },
  });

  it('lists the newest first, with what each did and the MySo change', async () => {
    const {gql} = indexer({
      'transactions(last': () => ({
        transactions: {nodes: [node('d1', '2026-10-13T05:00:00.000Z', 'platform::Approved', '-1581'), node('d2', '2026-10-13T06:00:00.000Z', '', '1000000000')]},
      }),
    });
    const text = await recentTransactions(gql, {address: ADMIN, limit: 2});
    const lines = text.split('\n');
    expect(lines[0]).toContain('newest first');
    expect(lines[1]).toContain('d2');
    expect(lines[1]).toContain('+1 MySo');
    expect(lines[2]).toContain('platform::Approved');
    expect(lines[2]).toContain('−0.000001581 MySo');
  });

  it('asks for the right filter and clamps the limit', async () => {
    let seen: Record<string, any> = {};
    const {gql} = indexer({'transactions(last': (v) => ((seen = v), {transactions: {nodes: []}})});
    expect(await recentTransactions(gql, {address: ADMIN, involvement: 'affected', limit: 500})).toContain('No transactions touching');
    expect(seen.f).toEqual({affectedAddress: ADMIN});
    expect(seen.n).toBe(10);
    await recentTransactions(gql, {address: ADMIN});
    expect(seen.f).toEqual({sentAddress: ADMIN});
    expect(seen.n).toBe(5);
  });

  it('summarizes one transaction, and reports a missing one', async () => {
    const {gql} = indexer({'transaction(digest': () => ({transaction: node('BxB2sutfu9s3DSF2nU1QYWpiRpKJUxVT4u3jbxoUzDbh', '2026-10-13T05:47:02.438Z', 'platform::Approved', '-1581')})});
    const text = await lookupTransaction(gql, 'BxB2sutfu9s3DSF2nU1QYWpiRpKJUxVT4u3jbxoUzDbh');
    expect(text).toContain('SUCCESS at 2026-10-13 05:47:02 UTC');
    expect(text).toContain('Did: platform::Approved');
    expect(text).toContain('MySo moved');
    const none = indexer({'transaction(digest': () => ({transaction: null})});
    expect(await lookupTransaction(none.gql, 'BxB2sutfu9s3DSF2nU1QYWpiRpKJUxVT4u3jbxoUzDbh')).toContain('No transaction');
  });
});

describe('balance and objects', () => {
  it('reports a balance in MySo', async () => {
    const {gql} = indexer({'balance(coinType': () => ({address: {balance: {totalBalance: '1500000000'}}})});
    expect(await accountBalance(gql, ADMIN)).toBe(`${ADMIN} holds 1.5 MySo.`);
  });

  it('describes an object and cuts a huge one', async () => {
    const {gql} = indexer({
      'object(address: $id) {\n      address version': () => ({
        object: {
          version: 7,
          owner: {__typename: 'Shared'},
          asMoveObject: {contents: {type: {repr: '0x50c1::memory::MemoryConfig'}, json: {blob: 'x'.repeat(5000)}}},
        },
      }),
    });
    const text = await lookupObject(gql, PROFILE_ID);
    expect(text).toContain('version 7), shared');
    expect(text).toContain('Type: memory::MemoryConfig');
    expect(text).toContain('cut off');
    const none = indexer({'object(address: $id) {\n      address version': () => ({object: null})});
    expect(await lookupObject(none.gql, PROFILE_ID)).toContain('No object');
  });

  it('resolves a username to an address, or to nothing', async () => {
    const {gql} = indexer();
    expect(await resolveUsername(gql, 'myso_admin')).toBe(ADMIN);
    expect(await resolveUsername(gql, 'nope')).toBeNull();
  });
});
