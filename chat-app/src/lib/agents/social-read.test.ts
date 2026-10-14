import {describe, expect, it} from 'vitest';
import {
  SocialReadError,
  assertReadOnlyGraphql,
  formatGqlType,
  normalizeSocialPath,
  socialGet,
  socialGraphql,
  socialSchema,
  summarizeRootFields,
  summarizeTypeFields,
  truncateResult,
} from './social-read';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

describe('normalizeSocialPath', () => {
  it('accepts the public routes, with query strings', () => {
    for (const ok of [
      '/tasks',
      '/tasks?status=0&limit=10',
      '/tasks/0xabc',
      '/task/config',
      '/agents/top',
      '/agents/0xabc/reputation',
      '/agents/0xabc/receipts?limit=5',
      '/jury/cases',
      '/jury/cases/0x1/rationales',
      '/governance/proposals',
      '/groups/0x1/digests',
      '/messaging/configuration',
      '/ai-credit/config',
    ]) {
      expect(normalizeSocialPath(ok)).toBe(ok);
    }
  });

  it('refuses internal, signed, unknown and tricky paths', () => {
    for (const bad of [
      '/internal/organizations/x/memory-permissions',
      '/organizations/0x1/memory-permissions',
      '/organizations/0x1/audit-logs',
      '/ai-credit/0x1/usage-history',
      '/mydata/1/access-logs',
      'tasks',
      'https://evil.example.com/tasks',
      '//evil.example.com/tasks',
      '/tasks/../internal/x',
      '/tasks/%2e%2e/x',
      '/tasks#frag',
      '/tasks with space',
      '/',
      '/health',
    ]) {
      expect(() => normalizeSocialPath(bad), bad).toThrow(SocialReadError);
    }
  });
});

describe('assertReadOnlyGraphql', () => {
  it('accepts reads, including introspection and variables', () => {
    expect(() => assertReadOnlyGraphql('{ profile(address: "0x1") { username } }')).not.toThrow();
    expect(() => assertReadOnlyGraphql('query Q($a: String!) { profile(address: $a) { username } }', {a: '0x1'})).not.toThrow();
    expect(() => assertReadOnlyGraphql('{ __schema { queryType { name } } }')).not.toThrow();
  });

  it('refuses mutations and subscriptions however they are written', () => {
    expect(() => assertReadOnlyGraphql('mutation { x }')).toThrow('read-only');
    expect(() => assertReadOnlyGraphql('  MUTATION M { x }')).toThrow('read-only');
    expect(() => assertReadOnlyGraphql('subscription { x }')).toThrow('read-only');
    expect(() => assertReadOnlyGraphql('{ a } mutation { b }')).toThrow('read-only');
  });

  it('does not trip over the word inside a string or a comment', () => {
    expect(() => assertReadOnlyGraphql('{ posts(search: "mutation tips") { id } }')).not.toThrow();
    expect(() => assertReadOnlyGraphql('# mutation\n{ posts { id } }')).not.toThrow();
  });

  it('refuses empty, huge and non-queries', () => {
    expect(() => assertReadOnlyGraphql('   ')).toThrow('empty');
    expect(() => assertReadOnlyGraphql('{ ' + 'a '.repeat(3000) + '}')).toThrow('under');
    expect(() => assertReadOnlyGraphql('hello world')).toThrow('not a GraphQL');
    expect(() => assertReadOnlyGraphql('{ a }', {big: 'x'.repeat(3000)})).toThrow('variables');
  });
});

describe('result and schema formatting', () => {
  it('truncates a long result and says so', () => {
    expect(truncateResult('short')).toBe('short');
    const cut = truncateResult('x'.repeat(7000), 100);
    expect(cut.startsWith('x'.repeat(100))).toBe(true);
    expect(cut).toContain('6900 more characters');
  });

  it('prints GraphQL types', () => {
    expect(formatGqlType({kind: 'NON_NULL', ofType: {kind: 'LIST', ofType: {kind: 'NON_NULL', ofType: {kind: 'OBJECT', name: 'Profile'}}}})).toBe('[Profile!]!');
    expect(formatGqlType({kind: 'SCALAR', name: 'String'})).toBe('String');
  });

  it('summarizes root fields, filtered by search and capped', () => {
    const fields = [
      {name: 'profile', args: [{name: 'address', type: {kind: 'NON_NULL', ofType: {kind: 'SCALAR', name: 'String'}}}], type: {kind: 'OBJECT', name: 'Profile'}},
      {name: 'taskConfiguration', type: {kind: 'OBJECT', name: 'TaskConfig'}},
      {name: '__schema', type: {kind: 'OBJECT', name: '__Schema'}},
    ];
    expect(summarizeRootFields(fields)).toBe('profile(address: String!): Profile\ntaskConfiguration: TaskConfig');
    expect(summarizeRootFields(fields, 'task')).toBe('taskConfiguration: TaskConfig');
    expect(summarizeRootFields(fields, 'zzz')).toContain('No query fields match');
    expect(summarizeRootFields(fields, undefined, 1)).toContain('and 1 more');
    expect(summarizeTypeFields({name: 'Profile', fields: [{name: 'username', type: {kind: 'SCALAR', name: 'String'}}]})).toContain('username: String');
    expect(summarizeTypeFields(null)).toBe('No such type.');
  });
});

describe('requests', () => {
  it('GETs an allowed route against the configured base only', async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return json([{taskId: '0x1'}]);
    };
    expect(await socialGet('/tasks?limit=1', 'http://127.0.0.1:9126/', fetchImpl)).toBe('[{"taskId":"0x1"}]');
    expect(seen).toEqual(['http://127.0.0.1:9126/tasks?limit=1']);
    await expect(socialGet('/internal/x', 'http://x', fetchImpl)).rejects.toThrow(SocialReadError);
    await expect(socialGet('/tasks', '', fetchImpl)).rejects.toThrow('not configured');
    expect(seen).toHaveLength(1);
  });

  it('reports a failing indexer', async () => {
    await expect(socialGet('/tasks', 'http://x', async () => json({error: 'boom'}, 500))).rejects.toThrow('returned 500');
    await expect(socialGet('/tasks', 'http://x', async () => { throw new Error('refused'); })).rejects.toThrow('did not answer');
  });

  it('sends a read-only query and returns its data', async () => {
    let body = '';
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return json({data: {profile: {username: 'brandon'}}});
    };
    expect(await socialGraphql('{ profile { username } }', undefined, 'http://g', fetchImpl)).toBe('{"profile":{"username":"brandon"}}');
    expect(JSON.parse(body).query).toContain('profile');
    await expect(socialGraphql('mutation { x }', undefined, 'http://g', fetchImpl)).rejects.toThrow('read-only');
  });

  it('turns a rejected query into a readable error, and keeps partial data with errors', async () => {
    await expect(socialGraphql('{ nope }', undefined, 'http://g', async () => json({errors: [{message: 'Unknown field "nope"'}]}))).rejects.toThrow('Unknown field');
    const partial = await socialGraphql('{ a b }', undefined, 'http://g', async () => json({data: {a: 1, b: null}, errors: [{message: 'b failed'}]}));
    expect(partial).toContain('"a":1');
    expect(partial).toContain('b failed');
  });

  it('builds the schema guide from introspection', async () => {
    const fetchImpl = async (_u: string, init?: RequestInit) => {
      const q = JSON.parse(String(init?.body)).query as string;
      return q.includes('__type')
        ? json({data: {__type: {name: 'Profile', fields: [{name: 'username', type: {kind: 'SCALAR', name: 'String'}}]}}})
        : json({data: {__schema: {queryType: {fields: [{name: 'profile', type: {kind: 'OBJECT', name: 'Profile'}}]}}}});
    };
    const guide = await socialSchema({}, 'http://g', fetchImpl);
    expect(guide).toContain('profile: Profile');
    expect(guide).toContain('/tasks');
    expect(await socialSchema({typeName: 'Profile'}, 'http://g', fetchImpl)).toContain('username: String');
  });
});
