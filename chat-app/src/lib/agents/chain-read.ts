/**
 * Purpose-built, read-only lookups an agent runs against the indexer: who someone is, what an
 * account holds, what it has done lately. Each one does the multi-step plumbing (a username is a
 * profile id, which is an object, which has an owner address) and answers in a few plain lines,
 * so the model reads a summary instead of working out GraphQL.
 */
import {formatMistAsMyso} from './format';
import {SocialReadError, truncateResult} from './social-read';

/** Runs a read-only query and returns its data. Injected so the lookups are testable without a network. */
export type Gql = (query: string, variables?: Record<string, unknown>) => Promise<Record<string, any>>;

export const MYSO_COIN_TYPE = '0x2::myso::MYSO';
export const MAX_TRANSACTIONS = 10;

const USERNAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const ADDRESS_RE = /^0x[0-9a-fA-F]{1,64}$/;
const DIGEST_RE = /^[1-9A-HJ-NP-Za-km-z]{32,50}$/;

/** `0x` plus 64 hex digits, lowercase: the one spelling the indexer always accepts. */
export function fullAddress(value: string): string {
  const text = value.trim();
  if (!ADDRESS_RE.test(text)) throw new SocialReadError('That is not a 0x address.');
  return `0x${text.slice(2).toLowerCase().padStart(64, '0')}`;
}

export function cleanUsername(value: string): string {
  const name = value.trim().replace(/^@/, '');
  if (!USERNAME_RE.test(name)) throw new SocialReadError('A username is letters, digits, dots, dashes and underscores.');
  return name.toLowerCase();
}

export function cleanDigest(value: string): string {
  const digest = value.trim();
  if (!DIGEST_RE.test(digest)) throw new SocialReadError('That is not a transaction digest.');
  return digest;
}

const short = (id: string) => (id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id);

/**
 * `0xabc…::platform::PlatformApprovalChangedEvent<0x1::x::Y>` → `platform::PlatformApprovalChangedEvent`:
 * the package and any type arguments are noise to a reader.
 */
export function shortType(repr: string): string {
  const bare = repr.split('<')[0] ?? repr;
  const parts = bare.split('::');
  return parts.length >= 3 ? parts.slice(1).join('::') : bare;
}

const when = (iso: string | number | null | undefined) => {
  if (iso == null) return 'unknown time';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? String(iso) : date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
};

function mist(value: string | number | null | undefined): string {
  if (value == null || value === '') return '—';
  try {
    return formatMistAsMyso(BigInt(value));
  } catch {
    return String(value);
  }
}

const signedMyso = (amount: bigint) => `${amount < 0n ? '−' : '+'}${formatMistAsMyso(amount < 0n ? -amount : amount)}`;

// ---------------------------------------------------------------------------------------------

/** A wallet address from a username, via the username registry and the profile object's owner. */
export async function resolveUsername(gql: Gql, username: string): Promise<string | null> {
  const name = cleanUsername(username);
  const entry = (await gql('query($u: String!) { usernameRegistryEntry(username: $u) { profileId } }', {u: name})).usernameRegistryEntry;
  if (!entry?.profileId) return null;
  const owned = await gql(
    'query($id: MySoAddress!) { object(address: $id) { owner { __typename ... on AddressOwner { address { address } } } } }',
    {id: entry.profileId},
  );
  return owned.object?.owner?.address?.address ?? null;
}

const PROFILE_QUERY = `query($a: MySoAddress!, $coin: String!) {
  profile(address: $a) {
    username displayName bio createdAt followersCount followingCount postCount website location xUsername
    memoryAccountId subAgentsTotalCount
    agenticOrganizations { organizationId name active }
    aiCreditBalance { balanceMist }
  }
  address(address: $a) { balance(coinType: $coin) { totalBalance } }
}`;

export interface ProfileLookup {
  username?: string;
  address?: string;
}

export async function findProfile(gql: Gql, lookup: ProfileLookup): Promise<string> {
  let address: string | null;
  if (lookup.address) address = fullAddress(lookup.address);
  else if (lookup.username) {
    address = await resolveUsername(gql, lookup.username);
    if (!address) return `No profile has the username @${cleanUsername(lookup.username)}.`;
  } else throw new SocialReadError('Give a username or an address.');

  const data = await gql(PROFILE_QUERY, {a: address, coin: MYSO_COIN_TYPE});
  const profile = data.profile;
  const balance = data.address?.balance?.totalBalance;
  if (!profile) {
    return `No profile at ${address}. It holds ${mist(balance)}.`;
  }
  const lines = [
    `@${profile.username ?? '?'}${profile.displayName ? ` — ${profile.displayName}` : ''}`,
    `Address: ${address}`,
    profile.bio ? `Bio: ${String(profile.bio).slice(0, 300)}` : null,
    `Created: ${when(profile.createdAt)}`,
    `Followers: ${profile.followersCount ?? 0} · Following: ${profile.followingCount ?? 0} · Posts: ${profile.postCount ?? 0}`,
    `Holds: ${mist(balance)} · AI credits: ${mist(profile.aiCreditBalance?.balanceMist)}`,
    `Sub-agents: ${profile.subAgentsTotalCount ?? 0}`,
    profile.agenticOrganizations?.length
      ? `Organizations: ${profile.agenticOrganizations
          .slice(0, 5)
          .map((o: any) => `${o.name ?? 'Unnamed'}${o.active ? '' : ' (inactive)'} ${o.organizationId}`)
          .join('; ')}`
      : null,
    [profile.website && `Website: ${profile.website}`, profile.location && `Location: ${profile.location}`, profile.xUsername && `X: @${profile.xUsername}`]
      .filter(Boolean)
      .join(' · ') || null,
    profile.memoryAccountId ? `Memory account: ${profile.memoryAccountId}` : null,
  ];
  return lines.filter(Boolean).join('\n');
}

// ---------------------------------------------------------------------------------------------

export async function accountBalance(gql: Gql, rawAddress: string): Promise<string> {
  const address = fullAddress(rawAddress);
  const data = await gql(
    'query($a: MySoAddress!, $coin: String!) { address(address: $a) { balance(coinType: $coin) { totalBalance } } }',
    {a: address, coin: MYSO_COIN_TYPE},
  );
  return `${address} holds ${mist(data.address?.balance?.totalBalance)}.`;
}

const TX_FIELDS = `digest sender { address }
  effects {
    status timestamp
    gasEffects { gasSummary { computationCost storageCost storageRebate } }
    events(first: 4) { nodes { contents { type { repr } } } }
    balanceChanges(first: 20) { nodes { owner { address } amount coinType { repr } } }
  }`;

interface TxNode {
  digest: string;
  sender?: {address?: string} | null;
  effects?: {
    status?: string;
    timestamp?: string;
    gasEffects?: {gasSummary?: {computationCost?: number; storageCost?: number; storageRebate?: number}};
    events?: {nodes?: {contents?: {type?: {repr?: string}}}[]};
    balanceChanges?: {nodes?: {owner?: {address?: string}; amount?: string; coinType?: {repr?: string}}[]};
  } | null;
}

function gasTotal(node: TxNode): bigint {
  const g = node.effects?.gasEffects?.gasSummary;
  if (!g) return 0n;
  return BigInt(g.computationCost ?? 0) + BigInt(g.storageCost ?? 0) - BigInt(g.storageRebate ?? 0);
}

function whatItDid(node: TxNode): string {
  const types = (node.effects?.events?.nodes ?? [])
    .map((e) => e.contents?.type?.repr)
    .filter((t): t is string => Boolean(t))
    .map(shortType);
  const unique = [...new Set(types)];
  return unique.length ? unique.slice(0, 3).join(', ') : 'no events';
}

function myso(node: TxNode, address: string): bigint {
  let total = 0n;
  for (const change of node.effects?.balanceChanges?.nodes ?? []) {
    if (change.owner?.address?.toLowerCase() === address && change.coinType?.repr?.endsWith('::myso::MYSO') && change.amount) {
      total += BigInt(change.amount);
    }
  }
  return total;
}

function txLine(node: TxNode, address?: string): string {
  const change = address ? myso(node, address) : null;
  const net = change === null || change === 0n ? '' : ` · ${signedMyso(change)}`;
  return `${when(node.effects?.timestamp)} · ${node.effects?.status ?? '?'} · ${whatItDid(node)}${net} · tx ${node.digest}`;
}

export interface RecentTransactions {
  address: string;
  /** `sent`: transactions this address signed. `affected`: any that touched it, such as payments it received. */
  involvement?: 'sent' | 'affected';
  limit?: number;
}

export async function recentTransactions(gql: Gql, options: RecentTransactions): Promise<string> {
  const address = fullAddress(options.address);
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? 5)), MAX_TRANSACTIONS);
  const involvement = options.involvement ?? 'sent';
  const filter = involvement === 'affected' ? {affectedAddress: address} : {sentAddress: address};
  const data = await gql(
    `query($f: TransactionFilter!, $n: Int!) { transactions(last: $n, filter: $f) { nodes { ${TX_FIELDS} } } }`,
    {f: filter, n: limit},
  );
  const nodes = ((data.transactions?.nodes ?? []) as TxNode[]).slice().reverse();
  if (!nodes.length) {
    return `No transactions ${involvement === 'sent' ? 'sent by' : 'touching'} ${address}.`;
  }
  const lines = nodes.map((node) => `• ${txLine(node, address)}`);
  return `Latest ${nodes.length} transaction${nodes.length === 1 ? '' : 's'} ${involvement === 'sent' ? 'sent by' : 'touching'} ${address} (newest first):\n${lines.join('\n')}`;
}

export async function lookupTransaction(gql: Gql, rawDigest: string): Promise<string> {
  const digest = cleanDigest(rawDigest);
  const data = await gql(`query($d: String!) { transaction(digest: $d) { ${TX_FIELDS} } }`, {d: digest});
  const node = data.transaction as TxNode | null;
  if (!node) return `No transaction ${digest}.`;
  const changes = (node.effects?.balanceChanges?.nodes ?? [])
    .filter((c) => c.amount && c.coinType?.repr?.endsWith('::myso::MYSO'))
    .slice(0, 6)
    .map((c) => `${short(c.owner?.address ?? '?')} ${signedMyso(BigInt(c.amount!))}`);
  return [
    `Transaction ${node.digest}`,
    `${node.effects?.status ?? '?'} at ${when(node.effects?.timestamp)}`,
    `Sender: ${node.sender?.address ?? '?'}`,
    `Did: ${whatItDid(node)}`,
    `Gas: ${formatMistAsMyso(gasTotal(node) < 0n ? 0n : gasTotal(node))}`,
    changes.length ? `MySo moved: ${changes.join('; ')}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function lookupObject(gql: Gql, rawId: string): Promise<string> {
  const id = fullAddress(rawId);
  const data = await gql(
    `query($id: MySoAddress!) { object(address: $id) {
      address version
      owner { __typename ... on AddressOwner { address { address } } ... on Shared { initialSharedVersion } }
      asMoveObject { contents { type { repr } json } }
    } }`,
    {id},
  );
  const object = data.object;
  if (!object) return `No object ${id}.`;
  const owner = object.owner;
  const ownedBy =
    owner?.__typename === 'AddressOwner' ? `owned by ${owner.address?.address}` : owner?.__typename === 'Shared' ? 'shared' : (owner?.__typename ?? 'unknown owner').toLowerCase();
  const type = object.asMoveObject?.contents?.type?.repr;
  const json = object.asMoveObject?.contents?.json;
  return truncateResult(
    [`Object ${id} (version ${object.version}), ${ownedBy}`, type ? `Type: ${shortType(type)}` : null, json ? `Contents: ${JSON.stringify(json)}` : null]
      .filter(Boolean)
      .join('\n'),
    3000,
  );
}
