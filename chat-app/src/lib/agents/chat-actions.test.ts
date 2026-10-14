import {describe, expect, it} from 'vitest';
import {CAP} from './capabilities';
import type {ChatActionName} from './chat-actions';
import {availableChatActions, chatActionProtocol, describeProposal, parseActionProposal} from './chat-actions';

const task = {capabilities: CAP.TASK_TRADE};
const nothing = {capabilities: CAP.REACT};
const ID = '0x' + 'ab'.repeat(32);
/** Read-only lookups open to every agent; the capability tests below look past them. */
const OPEN_TO_ALL = [
  'find_profile',
  'account_balance',
  'recent_transactions',
  'lookup_transaction',
  'lookup_object',
  'query_social_graphql',
  'social_api_get',
  'social_schema',
];
const gatedNames = (agent: {capabilities: number}) =>
  availableChatActions(agent).map((a) => a.name).filter((n) => !OPEN_TO_ALL.includes(n));

describe('chat actions', () => {
  it('offers only actions whose capability is held', () => {
    expect(gatedNames(nothing)).toEqual(['list_agents']);
    expect(gatedNames(task)).toEqual(['list_agents', 'list_tasks', 'create_task', 'accept_task', 'decline_task', 'settle_task']);
    expect(chatActionProtocol(nothing)).toContain('list_agents');
    expect(chatActionProtocol(nothing)).not.toContain('create_task');
    expect(chatActionProtocol({capabilities: CAP.JURY})).toContain('join_jury_roster');
    expect(chatActionProtocol({capabilities: CAP.JURY})).not.toContain('accept_task');
  });

  it('parses a proposal and strips the line', () => {
    const r = parseActionProposal(`Accepting it now.\n[[action:accept_task {"taskId":"${ID}"}]]`, task);
    expect(r.text).toBe('Accepting it now.');
    expect(r.proposal?.name).toBe('accept_task');
    expect(r.proposal?.params.taskId).toBe(ID);
    expect(r.proposal?.def.risk).toBe('approval');
    expect(describeProposal(r.proposal!)).toContain('Accept a task offer');
    expect(r.proposal!.def.rows(r.proposal!.params)[0]![0]).toBe('Task');
  });

  it('accepts a no-argument action', () => {
    expect(parseActionProposal('Looking. [[action:list_tasks]]', task).proposal?.name).toBe('list_tasks');
    expect(parseActionProposal('Looking. [[action:list_tasks {}]]', task).proposal?.def.risk).toBe('auto');
  });

  it('refuses an action the agent does not hold, and never returns a proposal', () => {
    const r = parseActionProposal(`[[action:accept_task {"taskId":"${ID}"}]]`, nothing);
    expect(r.proposal).toBeNull();
    expect(r.problem).toContain('not permitted');
  });

  it('refuses unknown actions, bad ids and malformed json', () => {
    expect(parseActionProposal('[[action:drain_wallet {}]]', task).proposal).toBeNull();
    expect(parseActionProposal('[[action:accept_task {"taskId":"nope"}]]', task).problem).toContain('taskId');
    expect(parseActionProposal('[[action:accept_task {"taskId":}]]', task).problem).toContain('malformed');
    expect(parseActionProposal('[[action:join_jury_roster {"modelFamily":9}]]', {capabilities: CAP.JURY}).proposal).toBeNull();
  });

  it('passes plain replies through untouched', () => {
    const r = parseActionProposal('  just chatting  ', task);
    expect(r).toEqual({text: 'just chatting', proposal: null, problem: null});
  });

  it('validates create_task and shows the escrow', () => {
    const body = {sellerAgentId: ID, title: 'Docs', scope: 'Write the docs', amountMyso: '2.5', deliveryHours: 48};
    const r = parseActionProposal(`[[action:create_task ${JSON.stringify(body)}]]`, task);
    expect(r.proposal?.params.amountMyso).toBe('2.5');
    expect(r.proposal?.def.effect(r.proposal.params)).toContain('2.5 MySo');
    expect(r.proposal?.def.rows(r.proposal.params).map(([k]) => k)).toContain('Escrow');
    for (const bad of [{amountMyso: '0'}, {amountMyso: '-1'}, {amountMyso: 'lots'}, {title: ''}, {sellerAgentId: 'x'}, {deliveryHours: 0}]) {
      const q = parseActionProposal(`[[action:create_task ${JSON.stringify({...body, ...bad})}]]`, task);
      expect(q.proposal).toBeNull();
      expect(q.problem).not.toBeNull();
    }
  });

  it('validates create_agent capabilities and relation', () => {
    const agent = {capabilities: CAP.AGENT_REGISTER};
    const ok = parseActionProposal('[[action:create_agent {"label":"Scout","relation":"sibling","capabilities":["MEMORY_READ","AI_SPEND"]}]]', agent);
    expect(ok.proposal?.params.relation).toBe('sibling');
    expect(ok.proposal?.def.rows(ok.proposal.params)[2]![1]).toContain('Read memory');
    expect(parseActionProposal('[[action:create_agent {"label":"x","capabilities":["ROOT"]}]]', agent).proposal).toBeNull();
    expect(parseActionProposal('[[action:create_agent {"label":"x","capabilities":[]}]]', agent).proposal).toBeNull();
    expect(parseActionProposal('[[action:create_agent {"label":"x","relation":"boss","capabilities":["REACT"]}]]', agent).proposal).toBeNull();
    expect(parseActionProposal('[[action:create_agent {"label":"x","capabilities":["REACT"]}]]', agent).proposal?.params.relation).toBe('child');
    expect(parseActionProposal('[[action:create_agent {"label":"x","capabilities":["REACT"]}]]', task).proposal).toBeNull();
  });

  it('validates settle stars and agent ids for revoke/rename', () => {
    expect(parseActionProposal(`[[action:settle_task {"taskId":"${ID}","stars":6}]]`, task).proposal).toBeNull();
    expect(parseActionProposal(`[[action:settle_task {"taskId":"${ID}","stars":4}]]`, task).proposal?.params.stars).toBe(4);
    expect(parseActionProposal(`[[action:deactivate_agent {"agentId":"${ID}"}]]`, {capabilities: CAP.AGENT_REVOKE}).proposal?.name).toBe('deactivate_agent');
    expect(parseActionProposal(`[[action:rename_agent {"agentId":"${ID}","label":"Ace"}]]`, {capabilities: CAP.AGENT_UPDATE}).proposal?.params.label).toBe('Ace');
    expect(parseActionProposal(`[[action:deactivate_agent {"agentId":"${ID}"}]]`, task).proposal).toBeNull();
  });

  it('gates memory actions on the memory capabilities', () => {
    const reader = {capabilities: CAP.MEMORY_READ};
    const writer = {capabilities: CAP.MEMORY_WRITE};
    expect(gatedNames(reader)).toEqual(['list_agents', 'recall_memory']);
    expect(gatedNames(writer)).toEqual(['list_agents', 'remember', 'remember_for_org']);
    const r = parseActionProposal('[[action:recall_memory {"query":"pricing","scope":"org"}]]', reader);
    expect(r.proposal?.params).toEqual({query: 'pricing', memoryScope: 'org'});
    expect(r.proposal?.def.risk).toBe('auto');
    expect(parseActionProposal('[[action:recall_memory {"query":"x","scope":"everyone"}]]', reader).proposal).toBeNull();
    expect(parseActionProposal('[[action:recall_memory {"query":"x"}]]', writer).proposal).toBeNull();
  });

  it('keeps private saves automatic but org sharing and grants behind approval', () => {
    const w = {capabilities: CAP.MEMORY_WRITE | CAP.AGENT_UPDATE};
    expect(parseActionProposal('[[action:remember {"fact":"likes tea"}]]', w).proposal?.def.risk).toBe('auto');
    expect(parseActionProposal('[[action:remember_for_org {"fact":"Q3 goal"}]]', w).proposal?.def.risk).toBe('approval');
    const g = parseActionProposal(`[[action:grant_org_memory {"agentId":"${ID}"}]]`, w);
    expect(g.proposal?.params.access).toBe('both');
    expect(g.proposal?.def.risk).toBe('approval');
    expect(parseActionProposal(`[[action:grant_org_memory {"agentId":"${ID}","access":"admin"}]]`, w).proposal).toBeNull();
    expect(parseActionProposal('[[action:remember {"fact":""}]]', w).proposal).toBeNull();
  });

  it('teaches the model to lead with the action so truncation cannot drop it', () => {
    const protocol = chatActionProtocol(task);
    expect(protocol).toContain('START your reply');
    expect(protocol).toContain('your own id is in your profile');
  });

  it('finds the action line wherever the model puts it', () => {
    const first = parseActionProposal(`[[action:list_tasks {}]] Checking now.`, task);
    expect(first.proposal?.name).toBe('list_tasks');
    expect(first.text).toBe('Checking now.');
  });

  it('says which actions sign a transaction, and warns where it matters', () => {
    const all = Object.values(CAP).reduce((a, b) => a | b, 0);
    const defs = availableChatActions({capabilities: all});
    expect(defs.find((d) => d.name === 'recall_memory')?.signs).toBe(false);
    expect(defs.find((d) => d.name === 'remember_for_org')?.signs).toBe(false);
    expect(defs.find((d) => d.name === 'accept_task')?.signs).toBe(true);
    const task = parseActionProposal(
      `[[action:create_task ${JSON.stringify({sellerAgentId: ID, title: 'T', scope: 's', amountMyso: '3'})}]]`,
      {capabilities: CAP.TASK_TRADE},
    );
    expect(task.proposal?.def.warning?.(task.proposal.params)).toContain('3 MySo');
    expect(defs.find((d) => d.name === 'accept_task')?.warning).toBeUndefined();
  });

  it('marks agent ids so the dialog can show a name', () => {
    const g = parseActionProposal(`[[action:grant_org_memory {"agentId":"${ID}"}]]`, {capabilities: CAP.AGENT_UPDATE});
    const rows = g.proposal!.def.rows(g.proposal!.params);
    expect(rows[0]).toEqual(['Agent', `${ID.slice(0, 10)}…`, ID]);
    expect(rows[1]?.[1]).toBe('Read and write');
  });

  it('lets create_agent name a deeper parent, for children only', () => {
    const agent = {capabilities: CAP.AGENT_REGISTER};
    const body = (extra: object) =>
      `[[action:create_agent ${JSON.stringify({label: 'Deep', capabilities: ['REACT'], ...extra})}]]`;
    const ok = parseActionProposal(body({parentAgentId: ID}), agent);
    expect(ok.proposal?.params.parentAgentId).toBe(ID);
    expect(ok.proposal?.def.rows(ok.proposal.params)[1]).toEqual(['Reports to', `${ID.slice(0, 10)}…`, ID]);
    expect(parseActionProposal(body({}), agent).proposal?.def.rows({label: 'x', relation: 'child', capabilities: ['REACT']})[1]?.[0]).toBe('Placed');
    expect(parseActionProposal(body({parentAgentId: 'nope'}), agent).proposal).toBeNull();
    expect(parseActionProposal(body({parentAgentId: ID, relation: 'sibling'}), agent).proposal).toBeNull();
  });

  it('parses update_agent_permissions and rejects bad requests', () => {
    const holder = {capabilities: CAP.AGENT_UPDATE};
    const ok = parseActionProposal(
      `[[action:update_agent_permissions {"agentId":"${ID}","grant":["AGENT_REGISTER","REACT"]}]]`,
      holder,
    );
    expect(ok.proposal?.params.grant).toEqual(['AGENT_REGISTER', 'REACT']);
    expect(ok.proposal?.params.revoke).toEqual([]);
    expect(ok.proposal?.params.delegate).toBe(true);
    const rows = ok.proposal!.def.rows(ok.proposal!.params);
    expect(rows.map((r) => r[0])).toEqual(['Agent', 'Grant', 'Can pass on']);
    expect(ok.proposal!.def.warning?.(ok.proposal!.params)).toContain('Register agents');
    // Nothing to do, overlapping lists, unknown names and a missing capability are all refused.
    expect(parseActionProposal(`[[action:update_agent_permissions {"agentId":"${ID}"}]]`, holder).proposal).toBeNull();
    expect(parseActionProposal(`[[action:update_agent_permissions {"agentId":"${ID}","grant":["REACT"],"revoke":["REACT"]}]]`, holder).proposal).toBeNull();
    expect(parseActionProposal(`[[action:update_agent_permissions {"agentId":"${ID}","grant":["GOD"]}]]`, holder).proposal).toBeNull();
    expect(parseActionProposal(`[[action:update_agent_permissions {"agentId":"${ID}","grant":["REACT"]}]]`, {capabilities: CAP.REACT}).proposal).toBeNull();
    // A harmless grant carries no warning; revoking alone shows its own row.
    const plain = parseActionProposal(`[[action:update_agent_permissions {"agentId":"${ID}","grant":["REACT"]}]]`, holder);
    expect(plain.proposal!.def.warning?.(plain.proposal!.params)).toBeNull();
    const take = parseActionProposal(`[[action:update_agent_permissions {"agentId":"${ID}","revoke":["REACT"]}]]`, holder);
    expect(take.proposal!.def.rows(take.proposal!.params).map((r) => r[0])).toEqual(['Agent', 'Remove']);
  });

  it('parses automate_agent for each rule and refuses bad ones', () => {
    const holder = {capabilities: CAP.AGENT_UPDATE};
    const run = (body: object) => parseActionProposal(`[[action:automate_agent ${JSON.stringify({agentId: ID, ...body})}]]`, holder);

    const accept = run({rule: 'auto_accept', minAmountMyso: '1', maxAmountMyso: '5', maxOpenTasks: 3});
    expect(accept.proposal?.params).toMatchObject({rule: 'auto_accept', minAmountMyso: '1', maxAmountMyso: '5', maxOpenTasks: 3});
    expect(accept.proposal!.def.effect(accept.proposal!.params)).toContain('accept task offers between 1 and 5 MySo');
    expect(accept.proposal!.def.rows(accept.proposal!.params).map((r) => r[0])).toEqual(['Agent', 'Rule', 'Min amount', 'Max amount', 'Open tasks']);
    expect(accept.proposal!.def.warning?.(accept.proposal!.params)).toContain('30 days');
    expect(accept.proposal!.def.signs).toBe(true);

    expect(run({rule: 'auto_accept'}).proposal?.params.rule).toBe('auto_accept');
    expect(run({rule: 'auto_review', role: 'seller', stars: 5}).proposal?.params).toMatchObject({role: 'seller', stars: 5});
    expect(run({rule: 'keeper', duty: 'release_to_seller'}).proposal?.params.duty).toBe('release_to_seller');

    for (const bad of [
      {rule: 'take_over_the_world'},
      {rule: 'auto_accept', minAmountMyso: '5', maxAmountMyso: '1'},
      {rule: 'auto_accept', maxAmountMyso: '-2'},
      {rule: 'auto_accept', maxOpenTasks: 0},
      {rule: 'auto_review', role: 'seller', stars: 6},
      {rule: 'auto_review', stars: 3},
      {rule: 'keeper', duty: 'drain'},
      {rule: 'keeper'},
    ]) {
      const r = run(bad);
      expect(r.proposal).toBeNull();
      expect(r.problem).not.toBeNull();
    }
    expect(parseActionProposal(`[[action:automate_agent {"agentId":"${ID}","rule":"auto_accept"}]]`, {capabilities: CAP.REACT}).proposal).toBeNull();
  });

  it('list_automations is a read that runs at once', () => {
    const r = parseActionProposal(`[[action:list_automations {"agentId":"${ID}"}]]`, {capabilities: CAP.AGENT_UPDATE});
    expect(r.proposal?.def.risk).toBe('auto');
    expect(r.proposal?.def.signs).toBe(false);
    expect(parseActionProposal('[[action:list_automations {}]]', {capabilities: CAP.AGENT_UPDATE}).proposal).toBeNull();
  });

  it('offers the indexer lookups to every agent, as reads that feed the answer', () => {
    const nobody = {capabilities: 0};
    const names = availableChatActions(nobody).map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(OPEN_TO_ALL));
    for (const name of OPEN_TO_ALL as ChatActionName[]) {
      const def = availableChatActions(nobody).find((a) => a.name === name)!;
      expect(def.risk).toBe('auto');
      expect(def.feedsBack).toBe(true);
      expect(def.signs).toBe(false);
    }
    expect(availableChatActions(nobody).find((a) => a.name === 'list_agents')?.feedsBack).toBeUndefined();
  });

  it('parses and validates indexer lookups', () => {
    const agent = {capabilities: 0};
    const q = parseActionProposal('[[action:query_social_graphql {"query":"{ profile(address: \\"0x1\\") { username } }","variables":{"a":1}}]]', agent);
    expect(q.proposal?.params.graphql).toContain('profile');
    expect(q.proposal?.params.variables).toEqual({a: 1});
    // Writes, bad shapes and unreachable routes never become proposals.
    expect(parseActionProposal('[[action:query_social_graphql {"query":"mutation { x }"}]]', agent).proposal).toBeNull();
    expect(parseActionProposal('[[action:query_social_graphql {"query":"{ a }","variables":[1]}]]', agent).proposal).toBeNull();
    expect(parseActionProposal('[[action:query_social_graphql {}]]', agent).proposal).toBeNull();

    expect(parseActionProposal('[[action:social_api_get {"path":"/tasks?limit=5"}]]', agent).proposal?.params.path).toBe('/tasks?limit=5');
    expect(parseActionProposal('[[action:social_api_get {"path":"/internal/x"}]]', agent).proposal).toBeNull();
    expect(parseActionProposal('[[action:social_api_get {}]]', agent).proposal).toBeNull();

    expect(parseActionProposal('[[action:social_schema {"search":"task"}]]', agent).proposal?.params.search).toBe('task');
    expect(parseActionProposal('[[action:social_schema {"typeName":"Profile"}]]', agent).proposal?.params.typeName).toBe('Profile');
    expect(parseActionProposal('[[action:social_schema {}]]', agent).proposal?.params).toEqual({});
    expect(parseActionProposal('[[action:social_schema {"typeName":"a b; drop"}]]', agent).proposal).toBeNull();
  });

  it('parses the purpose-built lookups and rejects bad input', () => {
    const agent = {capabilities: 0};
    const ADMIN = '0x2458950181e415250823d6ce1d55f2b3427826a111939e0d6d38e9a1397411d8';
    const run = (name: string, body: object) => parseActionProposal(`[[action:${name} ${JSON.stringify(body)}]]`, agent);

    expect(run('find_profile', {username: '@MySo_Admin'}).proposal?.params).toEqual({username: 'myso_admin'});
    expect(run('find_profile', {address: ADMIN}).proposal?.params.address).toBe(ADMIN);
    expect(run('find_profile', {}).proposal).toBeNull();
    expect(run('find_profile', {username: 'a b c'}).proposal).toBeNull();

    expect(run('account_balance', {address: '0xabc'}).proposal?.params.address).toBe('0x' + '0'.repeat(61) + 'abc');
    expect(run('account_balance', {address: 'nope'}).proposal).toBeNull();

    const txs = run('recent_transactions', {address: ADMIN, limit: 3, involvement: 'affected'});
    expect(txs.proposal?.params).toMatchObject({address: ADMIN, limit: 3, involvement: 'affected'});
    expect(run('recent_transactions', {address: ADMIN}).proposal?.params.involvement).toBe('sent');
    expect(run('recent_transactions', {address: ADMIN, limit: 50}).proposal).toBeNull();
    expect(run('recent_transactions', {address: ADMIN, involvement: 'all'}).proposal).toBeNull();

    expect(run('lookup_transaction', {digest: 'BxB2sutfu9s3DSF2nU1QYWpiRpKJUxVT4u3jbxoUzDbh'}).proposal?.name).toBe('lookup_transaction');
    expect(run('lookup_transaction', {digest: 'short'}).proposal).toBeNull();
    expect(run('lookup_object', {objectId: ADMIN}).proposal?.params.objectId).toBe(ADMIN);
    expect(run('lookup_object', {}).proposal).toBeNull();
  });
});
