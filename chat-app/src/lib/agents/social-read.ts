/**
 * Read-only access to the social indexer for agents: custom GraphQL queries, plain GET routes,
 * and a schema guide so a query can be written without guessing field names.
 *
 * Everything here only reads public indexer data. Mutations, subscriptions, non-GET calls, internal
 * routes and anything that needs a signature are refused before a request is made.
 */

export const MAX_QUERY_CHARS = 4_000;
export const MAX_VARIABLES_CHARS = 2_000;
export const MAX_RESULT_CHARS = 6_000;
export const SOCIAL_READ_TIMEOUT_MS = 10_000;

export class SocialReadError extends Error {}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Public GET routes of the social server. Every other path is refused. */
const GET_ALLOWLIST: readonly RegExp[] = [
  /^\/tasks(\/[^/?]+(\/(dispute|reviews|receipt))?)?$/,
  /^\/task\/config$/,
  /^\/agents(\/(top|rooms))?$/,
  /^\/agents\/[^/?]+\/(receipts|reputation)$/,
  /^\/jury\/(cases|roster|cranks|health)$/,
  /^\/jury\/cases\/[^/?]+(\/rationales)?$/,
  /^\/jury\/jurors\/[^/?]+(\/assignments)?$/,
  /^\/governance\/(proposals|delegates|nominees|registries|events)$/,
  /^\/governance\/(proposals|delegates|registries)\/[^/?]+$/,
  /^\/groups\/[^/?]+\/digests$/,
  /^\/(messaging|memory)\/configuration$/,
  /^\/ai-credit\/config$/,
  /^\/badges(\/[^/?]+)?$/,
];

/** The allowlist in words, for the schema guide. */
export const SOCIAL_GET_ROUTES = [
  '/tasks?status=&limit=&offset=  ·  /tasks/<id>  ·  /task/config',
  '/agents  ·  /agents/top  ·  /agents/rooms  ·  /agents/<id>/reputation  ·  /agents/<id>/receipts',
  '/jury/cases  ·  /jury/cases/<id>  ·  /jury/roster  ·  /jury/jurors/<agentId>',
  '/governance/proposals  ·  /governance/delegates  ·  /governance/registries',
  '/groups/<id>/digests  ·  /messaging/configuration  ·  /memory/configuration  ·  /ai-credit/config  ·  /badges',
] as const;

/**
 * A path the agent may GET: public, relative to the social server, and on the allowlist. Returns the
 * path with its query string, or throws.
 */
export function normalizeSocialPath(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('/') || text.length > 300) throw new SocialReadError('The path must start with / and be short.');
  if (/[\\\s#]|\.\.|\/\/|%2e|%2f|[\u0000-\u001f]/i.test(text)) throw new SocialReadError('That path is not allowed.');
  let url: URL;
  try {
    url = new URL(text, 'http://placeholder.invalid');
  } catch {
    throw new SocialReadError('That is not a valid path.');
  }
  if (url.host !== 'placeholder.invalid') throw new SocialReadError('Only paths on the social server are allowed.');
  if (!GET_ALLOWLIST.some((rule) => rule.test(url.pathname))) {
    throw new SocialReadError(`That route is not available to agents. Allowed: ${SOCIAL_GET_ROUTES.join(' | ')}`);
  }
  return `${url.pathname}${url.search}`;
}

/** Remove comments and string literals so a keyword inside either is not mistaken for an operation. */
function stripGraphql(query: string): string {
  return query
    .replace(/"""[\s\S]*?"""/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/#[^\n]*/g, '');
}

/** A single read-only query: no mutations, no subscriptions, a sane size. Throws otherwise. */
export function assertReadOnlyGraphql(query: string, variables?: unknown): void {
  const text = query.trim();
  if (!text) throw new SocialReadError('The query is empty.');
  if (text.length > MAX_QUERY_CHARS) throw new SocialReadError(`Keep the query under ${MAX_QUERY_CHARS} characters.`);
  const bare = stripGraphql(text);
  if (/(^|[\s{}()])(mutation|subscription)\b/i.test(bare)) {
    throw new SocialReadError('Only read-only queries are allowed.');
  }
  const operations = bare.match(/(^|[\s}])(query|fragment)\b|^\s*\{/g) ?? [];
  if (operations.length === 0) throw new SocialReadError('That is not a GraphQL query.');
  if (variables !== undefined) {
    const json = JSON.stringify(variables);
    if (json === undefined || json.length > MAX_VARIABLES_CHARS) {
      throw new SocialReadError(`Keep the variables under ${MAX_VARIABLES_CHARS} characters.`);
    }
  }
}

/** Cut a long result so it fits the model's context, and say what was cut. */
export function truncateResult(text: string, max = MAX_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…(cut off: ${text.length - max} more characters. Ask for fewer fields, a smaller limit, or a narrower filter.)`;
}

interface GqlType {
  kind: string;
  name?: string | null;
  ofType?: GqlType | null;
}

/** `[Profile!]!` from the introspection shape. */
export function formatGqlType(type: GqlType | null | undefined): string {
  if (!type) return '?';
  if (type.kind === 'NON_NULL') return `${formatGqlType(type.ofType)}!`;
  if (type.kind === 'LIST') return `[${formatGqlType(type.ofType)}]`;
  return type.name ?? '?';
}

interface RootField {
  name: string;
  description?: string | null;
  args?: {name: string; type: GqlType}[];
  type: GqlType;
}

const TYPE_FRAGMENT = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }';

export const ROOT_FIELDS_QUERY = `{ __schema { queryType { fields { name description args { name type { ${TYPE_FRAGMENT} } } type { ${TYPE_FRAGMENT} } } } } }`;
export const TYPE_FIELDS_QUERY = `query($name: String!) { __type(name: $name) { name kind fields { name description type { ${TYPE_FRAGMENT} } } } }`;

/** Root query fields as `name(arg: Type): Return`, filtered by a search word, at most `limit` lines. */
export function summarizeRootFields(fields: readonly RootField[], search?: string, limit = 30): string {
  const needle = search?.trim().toLowerCase();
  const rows = fields
    .filter((f) => !f.name.startsWith('__'))
    .filter((f) => !needle || f.name.toLowerCase().includes(needle) || (f.description ?? '').toLowerCase().includes(needle));
  if (!rows.length) return needle ? `No query fields match "${search}".` : 'No query fields found.';
  const lines = rows.slice(0, limit).map((f) => {
    const args = (f.args ?? []).map((a) => `${a.name}: ${formatGqlType(a.type)}`).join(', ');
    return `${f.name}${args ? `(${args})` : ''}: ${formatGqlType(f.type)}`;
  });
  const more = rows.length > limit ? `\n…and ${rows.length - limit} more. Add a search word to narrow it.` : '';
  return `${lines.join('\n')}${more}`;
}

export function summarizeTypeFields(
  type: {name: string; fields?: {name: string; type: GqlType}[] | null} | null | undefined,
  limit = 60,
): string {
  if (!type) return 'No such type.';
  if (!type.fields?.length) return `${type.name} has no selectable fields.`;
  const lines = type.fields.slice(0, limit).map((f) => `${f.name}: ${formatGqlType(f.type)}`);
  const more = type.fields.length > limit ? `\n…and ${type.fields.length - limit} more.` : '';
  return `type ${type.name} {\n${lines.join('\n')}\n}${more}`;
}

async function request(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<unknown> {
  const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(SOCIAL_READ_TIMEOUT_MS) : undefined;
  let res: Response;
  try {
    res = await fetchImpl(url, {...init, signal});
  } catch (error) {
    throw new SocialReadError(`The indexer did not answer: ${error instanceof Error ? error.message : 'network error'}`);
  }
  const body = await res.text();
  if (!res.ok) throw new SocialReadError(`The indexer returned ${res.status}${body ? `: ${body.slice(0, 300)}` : ''}`);
  try {
    return JSON.parse(body);
  } catch {
    throw new SocialReadError('The indexer returned something that is not JSON.');
  }
}

export async function socialGet(path: string, base: string, fetchImpl: FetchLike = fetch): Promise<string> {
  if (!base) throw new SocialReadError('The social server URL is not configured.');
  const safe = normalizeSocialPath(path);
  const json = await request(fetchImpl, `${base.replace(/\/+$/, '')}${safe}`, {headers: {Accept: 'application/json'}});
  return truncateResult(JSON.stringify(json));
}

/**
 * Run a read-only query and hand back the parsed `data`. A query the server rejects outright throws;
 * partial data with field errors is returned, with the errors under `errors`.
 */
export async function runGraphql<T = Record<string, any>>(
  query: string,
  variables: Record<string, unknown> | undefined,
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<{data: T; errors: string[]}> {
  assertReadOnlyGraphql(query, variables);
  const json = (await request(fetchImpl, url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Accept: 'application/json'},
    body: JSON.stringify({query, ...(variables ? {variables} : {})}),
  })) as {data?: T | null; errors?: {message?: string}[]};
  const errors = (json.errors ?? []).map((e) => e.message ?? 'error');
  if (json.data == null) {
    throw new SocialReadError(`The query was rejected: ${errors.join('; ').slice(0, 500) || 'no data'}`);
  }
  return {data: json.data, errors};
}

export async function socialGraphql(
  query: string,
  variables: Record<string, unknown> | undefined,
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  assertReadOnlyGraphql(query, variables);
  const json = (await request(fetchImpl, url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Accept: 'application/json'},
    body: JSON.stringify({query, ...(variables ? {variables} : {})}),
  })) as {data?: unknown; errors?: {message?: string}[]};
  if (json.errors?.length && json.data == null) {
    throw new SocialReadError(`The query was rejected: ${json.errors.map((e) => e.message).join('; ').slice(0, 500)}`);
  }
  const errors = json.errors?.length ? ` errors=${json.errors.map((e) => e.message).join('; ').slice(0, 300)}` : '';
  return truncateResult(`${JSON.stringify(json.data)}${errors}`);
}

export async function socialSchema(
  options: {search?: string; typeName?: string},
  url: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const post = (query: string, variables?: Record<string, unknown>) =>
    request(fetchImpl, url, {
      method: 'POST',
      headers: {'Content-Type': 'application/json', Accept: 'application/json'},
      body: JSON.stringify({query, ...(variables ? {variables} : {})}),
    }) as Promise<{data?: Record<string, any>; errors?: {message?: string}[]}>;

  if (options.typeName) {
    const json = await post(TYPE_FIELDS_QUERY, {name: options.typeName});
    return summarizeTypeFields(json.data?.__type);
  }
  const json = await post(ROOT_FIELDS_QUERY);
  const fields = (json.data?.__schema?.queryType?.fields ?? []) as RootField[];
  const guide = summarizeRootFields(fields, options.search);
  return `GraphQL query fields:\n${guide}\n\nHTTP GET routes:\n${SOCIAL_GET_ROUTES.join('\n')}`;
}
