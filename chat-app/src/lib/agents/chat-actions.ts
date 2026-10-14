import {CAPABILITY_LABELS, CAPABILITY_NAMES, hasCapability, type CapabilityName} from './capabilities';
import {MODEL_FAMILY_LABEL} from './jury';
import {assertReadOnlyGraphql, normalizeSocialPath} from './social-read';
import {cleanDigest, cleanUsername, fullAddress, MAX_TRANSACTIONS} from './chain-read';
import {AUTOMATION_RULES, KEEPER_DUTIES, WORKER_DELEGATE_DAYS, ruleSummary, type AutomationRule} from './automation-chat';
import type {KeeperDuty} from './automation-job';

/**
 * Actions an agent can propose from chat. The model never executes: it emits one proposal line,
 * the app checks the agent really holds the capability, and anything that writes waits for the
 * owner's approval in the permission dialog.
 */
export type ChatActionName =
  | 'list_agents'
  | 'recall_memory'
  | 'remember'
  | 'remember_for_org'
  | 'grant_org_memory'
  | 'list_tasks'
  | 'create_task'
  | 'accept_task'
  | 'decline_task'
  | 'settle_task'
  | 'create_agent'
  | 'rename_agent'
  | 'update_agent_permissions'
  | 'automate_agent'
  | 'find_profile'
  | 'account_balance'
  | 'recent_transactions'
  | 'lookup_transaction'
  | 'lookup_object'
  | 'query_social_graphql'
  | 'social_api_get'
  | 'social_schema'
  | 'list_automations'
  | 'deactivate_agent'
  | 'join_jury_roster'
  | 'leave_jury_roster';

/** `auto` runs at once (reads, or writes confined to the agent's own private memory); `approval` waits for the owner. */
export type ChatActionRisk = 'auto' | 'approval';
export type AgentRelation = 'child' | 'sibling';

export interface ChatActionParams {
  taskId?: string;
  agentId?: string;
  sellerAgentId?: string;
  title?: string;
  scope?: string;
  /** Decimal MySo, as typed. */
  amountMyso?: string;
  acceptHours?: number;
  deliveryHours?: number;
  settleHours?: number;
  stars?: number;
  label?: string;
  relation?: AgentRelation;
  /** Place a new child under this agent instead of the proposer: itself or any agent below it. */
  parentAgentId?: string;
  capabilities?: CapabilityName[];
  /** `update_agent_permissions`: permissions to add and to take away. */
  grant?: CapabilityName[];
  revoke?: CapabilityName[];
  /** Whether the target may pass granted permissions on to agents it creates. */
  delegate?: boolean;
  modelFamily?: number;
  /** `find_profile`, `account_balance`, `recent_transactions`, `lookup_transaction`, `lookup_object`. */
  username?: string;
  address?: string;
  limit?: number;
  involvement?: 'sent' | 'affected';
  digest?: string;
  objectId?: string;
  /** `query_social_graphql`, `social_api_get`, `social_schema`: read-only indexer lookups. */
  graphql?: string;
  variables?: Record<string, unknown>;
  path?: string;
  search?: string;
  typeName?: string;
  /** `automate_agent` */
  rule?: AutomationRule;
  minAmountMyso?: string;
  maxAmountMyso?: string;
  maxOpenTasks?: number;
  role?: 'buyer' | 'seller';
  duty?: KeeperDuty;
  query?: string;
  memoryScope?: 'private' | 'org' | 'all';
  fact?: string;
  access?: 'read' | 'write' | 'both';
}

/** A labelled line in the permission dialog. A third item names an agent id the dialog can show by name. */
export type ChatActionRow = [label: string, value: string, agentId?: string];

export interface ChatActionDef {
  name: ChatActionName;
  /** Capability the agent's own key must hold; `null` when the action only reads public state. */
  capability: CapabilityName | null;
  risk: ChatActionRisk;
  title: string;
  /** One line for the model, including the JSON shape it must send. */
  usage: string;
  /** What approving does, shown in the permission dialog. */
  effect: (params: ChatActionParams) => string;
  /** Labelled parameter rows for the permission dialog. */
  rows: (params: ChatActionParams) => ChatActionRow[];
  /** The result goes back to the model, which then answers from it, instead of being posted as is. */
  feedsBack?: boolean;
  /** Whether approving signs a transaction from the owner's wallet (and so spends gas). */
  signs: boolean;
  /** A line the owner should not miss: money moving, something irreversible, or something shared. */
  warning?: (params: ChatActionParams) => string | null;
  validate: (raw: Record<string, unknown>) => ChatActionParams;
}

const OBJECT_ID_RE = /^0x[0-9a-fA-F]{1,64}$/;
const AMOUNT_RE = /^\d{1,12}(\.\d{1,9})?$/;
const MAX_HOURS = 24 * 90;

function objectId(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string' || !OBJECT_ID_RE.test(value)) throw new Error(`${key} must be a 0x object id.`);
  return value;
}

function text(raw: Record<string, unknown>, key: string, max: number): string {
  const value = raw[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required.`);
  if (new TextEncoder().encode(value.trim()).length > max) throw new Error(`${key} is too long.`);
  return value.trim();
}

function hours(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_HOURS) {
    throw new Error(`${key} must be a number of hours up to ${MAX_HOURS}.`);
  }
  return value;
}

function optionalAmount(raw: Record<string, unknown>, key: string): string | undefined {
  if (raw[key] === undefined || raw[key] === null) return undefined;
  const value = raw[key];
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !AMOUNT_RE.test(normalized) || Number(normalized) <= 0) {
    throw new Error(`${key} must be a positive MySo amount such as "2.5".`);
  }
  return normalized;
}

function amount(raw: Record<string, unknown>): string {
  const value = raw.amountMyso;
  const normalized = typeof value === 'number' ? String(value) : value;
  if (typeof normalized !== 'string' || !AMOUNT_RE.test(normalized) || Number(normalized) <= 0) {
    throw new Error('amountMyso must be a positive MySo amount such as "2.5".');
  }
  return normalized;
}

function namedCapabilities(value: unknown, key: string, allowEmpty: boolean): CapabilityName[] {
  if (value === undefined || value === null) {
    if (allowEmpty) return [];
    throw new Error(`${key} must list at least one permission.`);
  }
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${key} must list at least one permission.`);
  }
  const names = new Set<CapabilityName>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !(CAPABILITY_NAMES as string[]).includes(entry)) {
      throw new Error(`Unknown capability "${String(entry)}".`);
    }
    names.add(entry as CapabilityName);
  }
  return [...names];
}

function capabilityList(raw: Record<string, unknown>): CapabilityName[] {
  return namedCapabilities(raw.capabilities, 'capabilities', false);
}

/** Permissions that move money, create or remove agents, or change who may: worth a second look. */
export const SENSITIVE_CAPABILITIES: readonly CapabilityName[] = [
  'TRADE_EXECUTE',
  'AI_SPEND',
  'TASK_TRADE',
  'BUDGET_MANAGE',
  'AGENT_REGISTER',
  'AGENT_UPDATE',
  'AGENT_REVOKE',
];

const labels = (names: readonly CapabilityName[] | undefined) =>
  names?.length ? names.map((c) => CAPABILITY_LABELS[c]).join(', ') : '';

const short = (id: string) => `${id.slice(0, 10)}…`;
const hoursLabel = (h: number | undefined, fallback: string) => (h ? `${h}h` : fallback);

export const CHAT_ACTIONS: Record<ChatActionName, ChatActionDef> = {
  list_agents: {
    name: 'list_agents',
    signs: false,
    capability: null,
    risk: 'auto',
    title: 'List agents in my organization',
    usage: 'list_agents {} — read-only; shows each agent with its full id, so you can name one.',
    effect: () => 'Reads the agents in this organization. Nothing is signed.',
    rows: () => [],
    validate: () => ({}),
  },
  recall_memory: {
    name: 'recall_memory',
    signs: false,
    capability: 'MEMORY_READ',
    risk: 'auto',
    title: 'Search my memory',
    usage:
      'recall_memory {"query":"…","scope":"all"} — search stored memory; scope private (yours), org (shared with your organization, needs access) or all.',
    effect: () => 'Searches this agent’s memory. Nothing is signed.',
    rows: (p) => [['Query', p.query!], ['Searching', p.memoryScope === 'private' ? 'Private memory' : p.memoryScope === 'org' ? 'Organization memory' : 'All memory']],
    validate: (raw) => {
      const scope = raw.scope ?? 'all';
      if (scope !== 'private' && scope !== 'org' && scope !== 'all') throw new Error('scope must be private, org or all.');
      return {query: text(raw, 'query', 500), memoryScope: scope};
    },
  },
  remember: {
    name: 'remember',
    signs: false,
    capability: 'MEMORY_WRITE',
    risk: 'auto',
    title: 'Save to my memory',
    usage: 'remember {"fact":"…"} — save one durable fact to your own private memory.',
    effect: () => 'Saves a fact to this agent’s private memory.',
    rows: (p) => [['Fact', p.fact!]],
    validate: (raw) => ({fact: text(raw, 'fact', 1000)}),
  },
  remember_for_org: {
    name: 'remember_for_org',
    signs: false,
    warning: () => 'Everyone with org memory access can read this.',
    capability: 'MEMORY_WRITE',
    risk: 'approval',
    title: 'Share a fact with the organization',
    usage: 'remember_for_org {"fact":"…"} — save a fact to the shared org memory (needs org write access).',
    effect: () => 'Saves this to the organization’s shared memory, readable by every member and agent with org memory access.',
    rows: (p) => [['fact', p.fact!]],
    validate: (raw) => ({fact: text(raw, 'fact', 1000)}),
  },
  grant_org_memory: {
    name: 'grant_org_memory',
    signs: true,
    capability: 'AGENT_UPDATE',
    risk: 'approval',
    title: 'Give an agent org memory access',
    usage:
      'grant_org_memory {"agentId":"0x…","access":"both"} — let yourself or an agent below you read/write the org memory; access read, write or both.',
    effect: (p) =>
      `Lets the agent ${p.access === 'read' ? 'read' : p.access === 'write' ? 'write to' : 'read and write'} the organization’s shared memory.`,
    rows: (p) => [['Agent', short(p.agentId!), p.agentId], ['Access', p.access === 'both' ? 'Read and write' : p.access === 'read' ? 'Read only' : 'Write only']],
    validate: (raw) => {
      const access = raw.access ?? 'both';
      if (access !== 'read' && access !== 'write' && access !== 'both') throw new Error('access must be read, write or both.');
      return {agentId: objectId(raw, 'agentId'), access};
    },
  },
  list_tasks: {
    name: 'list_tasks',
    signs: false,
    capability: 'TASK_TRADE',
    risk: 'auto',
    title: 'List my tasks',
    usage: 'list_tasks {} — read-only; tasks where you are buyer or seller, with ids.',
    effect: () => 'Reads your tasks. Nothing is signed.',
    rows: () => [],
    validate: () => ({}),
  },
  create_task: {
    name: 'create_task',
    signs: true,
    warning: (p) => `${p.amountMyso} MySo leaves your wallet into escrow now.`,
    capability: 'TASK_TRADE',
    risk: 'approval',
    title: 'Offer a task',
    usage:
      'create_task {"sellerAgentId":"0x…","title":"…","scope":"what must be delivered","amountMyso":"2.5","deliveryHours":48} — ' +
      'escrows the amount; acceptHours/deliveryHours/settleHours optional. Get the seller id from list_agents.',
    effect: (p) => `Escrows ${p.amountMyso} MySo from your wallet until the seller delivers and you settle.`,
    rows: (p) => [
      ['Seller', short(p.sellerAgentId!), p.sellerAgentId],
      ['Title', p.title!],
      ['Scope', p.scope!],
      ['Escrow', `${p.amountMyso} MySo`],
      ['Accept within', hoursLabel(p.acceptHours, 'default')],
      ['Deliver within', hoursLabel(p.deliveryHours, 'default')],
      ['Settle within', hoursLabel(p.settleHours, 'default')],
    ],
    validate: (raw) => ({
      sellerAgentId: objectId(raw, 'sellerAgentId'),
      title: text(raw, 'title', 120),
      scope: text(raw, 'scope', 4000),
      amountMyso: amount(raw),
      acceptHours: hours(raw, 'acceptHours'),
      deliveryHours: hours(raw, 'deliveryHours'),
      settleHours: hours(raw, 'settleHours'),
    }),
  },
  accept_task: {
    name: 'accept_task',
    signs: true,
    capability: 'TASK_TRADE',
    risk: 'approval',
    title: 'Accept a task offer',
    usage: 'accept_task {"taskId":"0x…"} — accept an offer made to you as the seller.',
    effect: () => `Commits this agent to deliver the task.`,
    rows: (p) => [['Task', short(p.taskId!)]],
    validate: (raw) => ({taskId: objectId(raw, 'taskId')}),
  },
  decline_task: {
    name: 'decline_task',
    signs: true,
    capability: 'TASK_TRADE',
    risk: 'approval',
    title: 'Decline a task offer',
    usage: 'decline_task {"taskId":"0x…"} — decline an offer made to you as the seller.',
    effect: () => `Rejects the offer so the buyer is refunded.`,
    rows: (p) => [['task', short(p.taskId!)]],
    validate: (raw) => ({taskId: objectId(raw, 'taskId')}),
  },
  settle_task: {
    name: 'settle_task',
    signs: true,
    warning: () => 'This pays the seller and cannot be undone.',
    capability: 'TASK_TRADE',
    risk: 'approval',
    title: 'Pay out a delivered task',
    usage: 'settle_task {"taskId":"0x…","stars":5} — as buyer, release escrow for delivered work; stars 1-5 optional.',
    effect: (p) => `Releases the escrow to the seller${p.stars ? ` and rates them ${p.stars}★` : ''}. This cannot be undone.`,
    rows: (p) => [['Task', short(p.taskId!)], ...(p.stars ? ([['Rating', `${p.stars}★`]] as ChatActionRow[]) : [])],
    validate: (raw) => {
      const stars = raw.stars;
      if (stars !== undefined && stars !== null && (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5)) {
        throw new Error('stars must be 1 to 5.');
      }
      return {taskId: objectId(raw, 'taskId'), stars: typeof stars === 'number' ? stars : undefined};
    },
  },
  create_agent: {
    name: 'create_agent',
    signs: true,
    warning: () => 'A new agent gets its own key and the permissions listed above.',
    capability: 'AGENT_REGISTER',
    risk: 'approval',
    title: 'Create a new agent',
    usage:
      'create_agent {"label":"Name","relation":"child","capabilities":["MEMORY_READ","MEMORY_WRITE","MYDATA_READ","AI_SPEND"]} — ' +
      'relation "child" reports to you, "sibling" shares your manager. To build deeper (up to 8 levels), add "parentAgentId":"0x…" ' +
      'of yourself or any agent below you and the new child reports to it. Capability names as listed above.',
    effect: (p) =>
      `Registers a new ${p.relation} agent with a fresh key held in your vault. Your own permissions may be extended if it needs more than you can delegate.`,
    rows: (p) => [
      ['Name', p.label!],
      p.parentAgentId
        ? ['Reports to', short(p.parentAgentId), p.parentAgentId]
        : ['Placed', p.relation === 'child' ? 'Reports to this agent' : 'Beside this agent'],
      ['Permissions', p.capabilities!.map((c) => CAPABILITY_LABELS[c]).join(', ')],
    ],
    validate: (raw) => {
      const relation = raw.relation ?? 'child';
      if (relation !== 'child' && relation !== 'sibling') throw new Error('relation must be "child" or "sibling".');
      const parentAgentId = raw.parentAgentId === undefined || raw.parentAgentId === null ? undefined : objectId(raw, 'parentAgentId');
      if (parentAgentId && relation !== 'child') throw new Error('parentAgentId only works with relation "child".');
      return {label: text(raw, 'label', 64), relation, capabilities: capabilityList(raw), ...(parentAgentId ? {parentAgentId} : {})};
    },
  },
  rename_agent: {
    name: 'rename_agent',
    signs: true,
    capability: 'AGENT_UPDATE',
    risk: 'approval',
    title: 'Rename an agent',
    usage: 'rename_agent {"agentId":"0x…","label":"New name"} — yourself or an agent below you.',
    effect: () => `Changes the agent's public name.`,
    rows: (p) => [['Agent', short(p.agentId!), p.agentId], ['New name', p.label!]],
    validate: (raw) => ({agentId: objectId(raw, 'agentId'), label: text(raw, 'label', 64)}),
  },
  update_agent_permissions: {
    name: 'update_agent_permissions',
    signs: true,
    warning: (p) => {
      const risky = (p.grant ?? []).filter((c) => SENSITIVE_CAPABILITIES.includes(c));
      return risky.length ? `Includes powerful permissions: ${labels(risky)}.` : null;
    },
    capability: 'AGENT_UPDATE',
    risk: 'approval',
    title: 'Change an agent’s permissions',
    usage:
      'update_agent_permissions {"agentId":"0x…","grant":["AGENT_REGISTER"],"revoke":[],"delegate":true} — add or take away ' +
      'permissions on an agent below you (never yourself), only ones you may delegate. "delegate" (default true) lets it pass ' +
      'granted permissions on to agents it creates; an agent must hold AGENT_REGISTER to create agents.',
    effect: (p) => {
      const parts = [
        p.grant?.length ? `gives it ${labels(p.grant)}` : null,
        p.revoke?.length ? `removes ${labels(p.revoke)}` : null,
      ].filter(Boolean);
      return `Changes what this agent is allowed to do: ${parts.join(' and ')}.`;
    },
    rows: (p) => {
      const rows: ChatActionRow[] = [['Agent', short(p.agentId!), p.agentId]];
      if (p.grant?.length) rows.push(['Grant', labels(p.grant)]);
      if (p.revoke?.length) rows.push(['Remove', labels(p.revoke)]);
      if (p.grant?.length) rows.push(['Can pass on', p.delegate === false ? 'No' : 'Yes']);
      return rows;
    },
    validate: (raw) => {
      const grant = namedCapabilities(raw.grant, 'grant', true);
      const revoke = namedCapabilities(raw.revoke, 'revoke', true);
      if (!grant.length && !revoke.length) throw new Error('list at least one permission to grant or revoke.');
      const overlap = grant.filter((c) => revoke.includes(c));
      if (overlap.length) throw new Error(`${labels(overlap)} cannot be both granted and revoked.`);
      if (raw.delegate !== undefined && typeof raw.delegate !== 'boolean') throw new Error('delegate must be true or false.');
      return {agentId: objectId(raw, 'agentId'), grant, revoke, delegate: raw.delegate === false ? false : true};
    },
  },
  find_profile: {
    name: 'find_profile',
    feedsBack: true,
    signs: false,
    capability: null,
    risk: 'auto',
    title: 'Look up a profile',
    usage:
      'find_profile {"username":"myso_admin"} or {"address":"0x…"} — who someone is: handle, bio, created date, followers, posts, ' +
      'balance, AI credits, sub-agents, organizations. Works from a username alone.',
    effect: () => 'Reads a public profile from the social indexer. Nothing is signed.',
    rows: () => [],
    validate: (raw) => {
      const username = typeof raw.username === 'string' && raw.username.trim() ? cleanUsername(raw.username) : undefined;
      const address = typeof raw.address === 'string' && raw.address.trim() ? fullAddress(raw.address) : undefined;
      if (!username && !address) throw new Error('give a username or an address.');
      return {...(username ? {username} : {}), ...(address ? {address} : {})};
    },
  },
  account_balance: {
    name: 'account_balance',
    feedsBack: true,
    signs: false,
    capability: null,
    risk: 'auto',
    title: 'Check an account’s balance',
    usage: 'account_balance {"address":"0x…"} — how much MySo an address holds.',
    effect: () => 'Reads an account balance from the chain. Nothing is signed.',
    rows: () => [],
    validate: (raw) => ({address: fullAddress(typeof raw.address === 'string' ? raw.address : '')}),
  },
  recent_transactions: {
    name: 'recent_transactions',
    feedsBack: true,
    signs: false,
    capability: null,
    risk: 'auto',
    title: 'List recent transactions',
    usage:
      'recent_transactions {"address":"0x…","limit":5,"involvement":"sent"} — newest first, with time, status, what it did and the MySo ' +
      'change. involvement "sent" (default) is what the address signed; "affected" also includes payments it received. limit up to 10. ' +
      'Resolve a username with find_profile first.',
    effect: () => 'Reads recent transactions from the chain. Nothing is signed.',
    rows: () => [],
    validate: (raw) => {
      const involvement = raw.involvement ?? 'sent';
      if (involvement !== 'sent' && involvement !== 'affected') throw new Error('involvement must be "sent" or "affected".');
      const limit = raw.limit;
      if (limit !== undefined && limit !== null && (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_TRANSACTIONS)) {
        throw new Error(`limit must be a whole number from 1 to ${MAX_TRANSACTIONS}.`);
      }
      return {
        address: fullAddress(typeof raw.address === 'string' ? raw.address : ''),
        involvement,
        ...(typeof limit === 'number' ? {limit} : {}),
      };
    },
  },
  lookup_transaction: {
    name: 'lookup_transaction',
    feedsBack: true,
    signs: false,
    capability: null,
    risk: 'auto',
    title: 'Look up a transaction',
    usage: 'lookup_transaction {"digest":"…"} — status, time, sender, what it did, gas and the MySo that moved.',
    effect: () => 'Reads a transaction from the chain. Nothing is signed.',
    rows: () => [],
    validate: (raw) => ({digest: cleanDigest(typeof raw.digest === 'string' ? raw.digest : '')}),
  },
  lookup_object: {
    name: 'lookup_object',
    feedsBack: true,
    signs: false,
    capability: null,
    risk: 'auto',
    title: 'Look up an on-chain object',
    usage: 'lookup_object {"objectId":"0x…"} — what an object is (its type), who owns it, and its contents.',
    effect: () => 'Reads an object from the chain. Nothing is signed.',
    rows: () => [],
    validate: (raw) => ({objectId: fullAddress(typeof raw.objectId === 'string' ? raw.objectId : '')}),
  },
  query_social_graphql: {
    name: 'query_social_graphql',
    feedsBack: true,
    signs: false,
    capability: null,
    risk: 'auto',
    title: 'Query the social indexer',
    usage:
      'query_social_graphql {"query":"{ profile(address: \"0x…\") { username } }","variables":{}} — read-only GraphQL over the ' +
      'social indexer (profiles, posts, organizations, sub-agents, juries, governance, messaging and task config). ' +
      'Only for questions the purpose-built lookups above cannot answer. Ask for few fields and a small limit; use social_schema first ' +
      'if you are unsure of a field name (search a word, e.g. "username"), and do not conclude something does not exist until you have searched.',
    effect: () => 'Reads public data from the social indexer. Nothing is signed.',
    rows: () => [],
    validate: (raw) => {
      const query = typeof raw.query === 'string' ? raw.query : '';
      const variables =
        raw.variables === undefined || raw.variables === null
          ? undefined
          : typeof raw.variables === 'object' && !Array.isArray(raw.variables)
            ? (raw.variables as Record<string, unknown>)
            : (() => {
                throw new Error('variables must be an object.');
              })();
      assertReadOnlyGraphql(query, variables);
      return {graphql: query.trim(), ...(variables ? {variables} : {})};
    },
  },
  social_api_get: {
    name: 'social_api_get',
    feedsBack: true,
    signs: false,
    capability: null,
    risk: 'auto',
    title: 'Read from the social indexer',
    usage:
      'social_api_get {"path":"/tasks?status=0&limit=10"} — one public GET route: /tasks, /tasks/<id>, /task/config, /agents/top, ' +
      '/agents/<id>/reputation, /agents/<id>/receipts, /jury/cases, /governance/proposals, /groups/<id>/digests.',
    effect: () => 'Reads public data from the social indexer. Nothing is signed.',
    rows: () => [],
    validate: (raw) => ({path: normalizeSocialPath(typeof raw.path === 'string' ? raw.path : '')}),
  },
  social_schema: {
    name: 'social_schema',
    feedsBack: true,
    signs: false,
    capability: null,
    risk: 'auto',
    title: 'Look up the indexer’s schema',
    usage:
      'social_schema {"search":"task"} or {"typeName":"Profile"} — lists the GraphQL query fields (filtered by a word) or the fields ' +
      'of one type, plus the HTTP routes. Use before writing a query.',
    effect: () => 'Reads the social indexer’s schema. Nothing is signed.',
    rows: () => [],
    validate: (raw) => {
      const search = typeof raw.search === 'string' && raw.search.trim() ? raw.search.trim().slice(0, 60) : undefined;
      const typeName = typeof raw.typeName === 'string' && raw.typeName.trim() ? raw.typeName.trim() : undefined;
      if (typeName && !/^[A-Za-z_][A-Za-z0-9_]{0,60}$/.test(typeName)) throw new Error('typeName must be a GraphQL type name.');
      return {...(search ? {search} : {}), ...(typeName ? {typeName} : {})};
    },
  },
  list_automations: {
    name: 'list_automations',
    signs: false,
    capability: 'AGENT_UPDATE',
    risk: 'auto',
    title: 'List an agent’s automations',
    usage: 'list_automations {"agentId":"0x…"} — read-only; the rules set up for yourself or an agent below you.',
    effect: () => 'Reads the automation rules set up for this agent. Nothing is signed.',
    rows: (p) => [['Agent', short(p.agentId!), p.agentId]],
    validate: (raw) => ({agentId: objectId(raw, 'agentId')}),
  },
  automate_agent: {
    name: 'automate_agent',
    signs: true,
    warning: () =>
      `The automation server will act for this agent on its own for ${WORKER_DELEGATE_DAYS} days, until you revoke its worker.`,
    capability: 'AGENT_UPDATE',
    risk: 'approval',
    title: 'Set up an automation',
    usage:
      'automate_agent {"agentId":"0x…","rule":"auto_accept","minAmountMyso":"1","maxAmountMyso":"5","maxOpenTasks":3} — ' +
      'makes yourself or an agent below you act on its own by a rule. Rules: auto_accept (take task offers in a MySo range, ' +
      'optional maxOpenTasks), auto_review (needs "role":"buyer"|"seller" and "stars":1-5), keeper (needs "duty":' +
      '"expire_offers"|"refund_missed_delivery"|"release_to_seller"). The agent must be allowed to register agents and delegate ' +
      'task trading; grant that first if asked.',
    effect: (p) => `Once approved, this agent will ${ruleSummary(p as Parameters<typeof ruleSummary>[0])} with no one at the keyboard.`,
    rows: (p) => {
      const rows: ChatActionRow[] = [['Agent', short(p.agentId!), p.agentId]];
      if (p.rule === 'auto_accept') {
        rows.push(['Rule', 'Accept task offers']);
        if (p.minAmountMyso) rows.push(['Min amount', `${p.minAmountMyso} MySo`]);
        if (p.maxAmountMyso) rows.push(['Max amount', `${p.maxAmountMyso} MySo`]);
        if (p.maxOpenTasks) rows.push(['Open tasks', `at most ${p.maxOpenTasks}`]);
      } else if (p.rule === 'auto_review') {
        rows.push(['Rule', 'Rate after each settled task'], ['As', p.role === 'buyer' ? 'Buyer' : 'Seller'], ['Rating', `${p.stars}★`]);
      } else {
        rows.push(['Rule', 'Keep escrow moving'], ['Duty', ruleSummary(p as Parameters<typeof ruleSummary>[0])]);
      }
      return rows;
    },
    validate: (raw) => {
      const rule = raw.rule;
      if (typeof rule !== 'string' || !(AUTOMATION_RULES as readonly string[]).includes(rule)) {
        throw new Error(`rule must be one of: ${AUTOMATION_RULES.join(', ')}.`);
      }
      const agentId = objectId(raw, 'agentId');
      const kind = rule as AutomationRule;
      if (kind === 'auto_accept') {
        const minAmountMyso = optionalAmount(raw, 'minAmountMyso');
        const maxAmountMyso = optionalAmount(raw, 'maxAmountMyso');
        if (minAmountMyso && maxAmountMyso && Number(minAmountMyso) > Number(maxAmountMyso)) {
          throw new Error('minAmountMyso is above maxAmountMyso.');
        }
        const open = raw.maxOpenTasks;
        if (open !== undefined && open !== null && (typeof open !== 'number' || !Number.isInteger(open) || open < 1 || open > 1000)) {
          throw new Error('maxOpenTasks must be a whole number from 1 to 1000.');
        }
        return {
          agentId,
          rule: kind,
          ...(minAmountMyso ? {minAmountMyso} : {}),
          ...(maxAmountMyso ? {maxAmountMyso} : {}),
          ...(typeof open === 'number' ? {maxOpenTasks: open} : {}),
        };
      }
      if (kind === 'auto_review') {
        const role = raw.role;
        if (role !== 'buyer' && role !== 'seller') throw new Error('role must be "buyer" or "seller".');
        const stars = raw.stars;
        if (typeof stars !== 'number' || !Number.isInteger(stars) || stars < 1 || stars > 5) throw new Error('stars must be 1 to 5.');
        return {agentId, rule: kind, role, stars};
      }
      const duty = raw.duty;
      if (typeof duty !== 'string' || !(KEEPER_DUTIES as string[]).includes(duty)) {
        throw new Error(`duty must be one of: ${KEEPER_DUTIES.join(', ')}.`);
      }
      return {agentId, rule: kind, duty: duty as KeeperDuty};
    },
  },
  deactivate_agent: {
    name: 'deactivate_agent',
    signs: true,
    warning: () => 'The agent stops acting right away.',
    capability: 'AGENT_REVOKE',
    risk: 'approval',
    title: 'Deactivate an agent',
    usage: 'deactivate_agent {"agentId":"0x…"} — only an agent below you.',
    effect: () => `Stops the agent from acting. Its history stays.`,
    rows: (p) => [['Agent', short(p.agentId!), p.agentId]],
    validate: (raw) => ({agentId: objectId(raw, 'agentId')}),
  },
  join_jury_roster: {
    name: 'join_jury_roster',
    signs: true,
    capability: 'JURY',
    risk: 'approval',
    title: 'Join the juror roster',
    usage: 'join_jury_roster {"modelFamily":1} — modelFamily 1 Claude, 2 GPT, 3 Gemini, 4 Llama, 5 Other.',
    effect: () => `Puts this agent on the roster so it can be drafted onto disputes. Free, nothing is staked.`,
    rows: (p) => [['Model', MODEL_FAMILY_LABEL[p.modelFamily ?? 0] ?? 'Other']],
    validate: (raw) => {
      const family = raw.modelFamily ?? 0;
      if (typeof family !== 'number' || !Number.isInteger(family) || !(family in MODEL_FAMILY_LABEL)) {
        throw new Error('modelFamily must be 0–5.');
      }
      return {modelFamily: family};
    },
  },
  leave_jury_roster: {
    name: 'leave_jury_roster',
    signs: true,
    capability: 'JURY',
    risk: 'approval',
    title: 'Leave the juror roster',
    usage: 'leave_jury_roster {} — leave the roster.',
    effect: () => `Takes this agent off the roster.`,
    rows: () => [],
    validate: () => ({}),
  },
};

const holds = (agent: {capabilities: number}, def: ChatActionDef) =>
  def.capability === null || hasCapability(agent.capabilities, def.capability);

/** The actions an agent may propose: only those whose capability it actually holds. */
export function availableChatActions(agent: {capabilities: number}): ChatActionDef[] {
  return Object.values(CHAT_ACTIONS).filter((def) => holds(agent, def));
}

/** Added to the agent profile so the model knows the only way to act. */
export function chatActionProtocol(agent: {capabilities: number}): string {
  const actions = availableChatActions(agent);
  if (!actions.length) return '';
  return (
    'Actions you can propose: to act, START your reply with exactly one line `[[action:NAME {json}]]`, ' +
    'then one short sentence (under 40 words) on what you are doing; never narrate caveats first, ' +
    'because long replies are cut off and the action would be lost. You do not execute it; your ' +
    'owner approves every write in a permission dialog, and read-only actions run at once. Never ' +
    'invent an id: your own id is in your profile; for others use list_agents / list_tasks first or ask. ' +
    'At most one action per reply. Keep replies short (under about 250 words) unless asked for detail, so they are never cut off. ' +
    'Automations (automate_agent, list_automations) run on the owner\'s automation server, which acts for an agent on its own; ' +
    'you set the rules from chat and the server carries them out. ' +
    `Available: ${actions.map((a) => a.usage).join(' ')}`
  );
}

export interface ChatActionProposal {
  name: ChatActionName;
  params: ChatActionParams;
  def: ChatActionDef;
}

export interface ParsedReply {
  /** The reply with the proposal line removed. */
  text: string;
  proposal: ChatActionProposal | null;
  /** Set when a proposal line was present but unusable; the model's claim is never executed. */
  problem: string | null;
}

const PROPOSAL_RE = /\[\[action:([a-z_]+)\s*(\{[\s\S]*?\})?\s*\]\]/;

/**
 * Pull the proposal out of a model reply. A proposal for an action the agent does not hold, an
 * unknown name, or bad parameters is reported as a `problem` and never becomes executable.
 */
export function parseActionProposal(answer: string, agent: {capabilities: number}): ParsedReply {
  const match = PROPOSAL_RE.exec(answer);
  if (!match) return {text: answer.trim(), proposal: null, problem: null};
  const stripped = answer.replace(PROPOSAL_RE, '').trim();
  const name = match[1] as ChatActionName;
  const def = CHAT_ACTIONS[name];
  if (!def) return {text: stripped, proposal: null, problem: `I don't have an action called "${match[1]}".`};
  if (!holds(agent, def)) {
    return {text: stripped, proposal: null, problem: `I'm not permitted to ${def.title.toLowerCase()}.`};
  }
  let raw: Record<string, unknown> = {};
  if (match[2]) {
    try {
      const parsed: unknown = JSON.parse(match[2]);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      raw = parsed as Record<string, unknown>;
    } catch {
      return {text: stripped, proposal: null, problem: 'My action request was malformed, so nothing was run.'};
    }
  }
  try {
    return {text: stripped, proposal: {name, params: def.validate(raw), def}, problem: null};
  } catch (error) {
    return {
      text: stripped,
      proposal: null,
      problem: `${def.title} was not run: ${error instanceof Error ? error.message : 'invalid request'}`,
    };
  }
}

export function describeProposal(proposal: ChatActionProposal): string {
  const {params, def} = proposal;
  if (proposal.name === 'create_agent') return `${def.title}: ${params.label}`;
  if (proposal.name === 'create_task') return `${def.title}: ${params.title}`;
  return def.title;
}
