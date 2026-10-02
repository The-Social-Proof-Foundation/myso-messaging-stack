import {describe, expect, it} from 'vitest';
import {bcs} from '@socialproof/myso/bcs';
import type {Transaction} from '@socialproof/myso/transactions';
import {normalizeMySoAddress, toBase64} from '@socialproof/myso/utils';

import {
  approveAgentSpendTx,
  createAgenticOrganizationTx,
  depositAiCreditTx,
  ensureAgentMemoryVaultTx,
  pauseAiCreditTx,
  reactivateAiCreditTx,
  registerSubAgentDelegatedTx,
  registerSubAgentTx,
  setAgentBudgetTx,
  withdrawAiCreditTx,
} from './tx';

const IDS = {
  socialPackageId: '0x50c1',
  memoryConfigId: '0xa1',
  aiCreditConfigId: '0xa2',
};
const ACCOUNT = '0xb1';
const ORG = '0xb2';
const BALANCE = '0xb3';
const AGENT = '0xb4';
const CLOCK = '0x6';

const obj = (id: string) => `obj:${normalizeMySoAddress(id)}`;
const pure = (bytes: Uint8Array) => `pure:${toBase64(bytes)}`;
const u8 = (v: number) => pure(bcs.u8().serialize(v).toBytes());
const u64 = (v: number | bigint) => pure(bcs.u64().serialize(v).toBytes());
const optU64 = (v: number | bigint | null) =>
  pure(bcs.option(bcs.u64()).serialize(v).toBytes());
const str = (v: string) => pure(bcs.string().serialize(v).toBytes());
const optStr = (v: string | null) =>
  pure(bcs.option(bcs.string()).serialize(v).toBytes());
const addr = (v: string) => pure(bcs.Address.serialize(v).toBytes());
const optAddr = (v: string | null) =>
  pure(bcs.option(bcs.Address).serialize(v).toBytes());
const vecU8 = (v: Uint8Array) => pure(bcs.vector(bcs.u8()).serialize(Array.from(v)).toBytes());

type Input =
  | {$kind: 'UnresolvedObject'; UnresolvedObject: {objectId: string}}
  | {$kind: 'Pure'; Pure: {bytes: string}};
type Arg = {$kind: 'Input'; Input: number} | {$kind: 'NestedResult'; NestedResult: [number, number]};

/** Renders the last Move call as `module::function` plus readable arguments. */
function lastMoveCall(tx: Transaction): {target: string; args: string[]} {
  const data = tx.getData() as unknown as {
    inputs: Input[];
    commands: {$kind: string; MoveCall?: {module: string; function: string; arguments: Arg[]}}[];
  };
  const call = [...data.commands].reverse().find((c) => c.$kind === 'MoveCall')?.MoveCall;
  if (!call) throw new Error('no MoveCall');
  const args = call.arguments.map((arg) => {
    if (arg.$kind === 'NestedResult') return `result:${arg.NestedResult[0]}`;
    const input = data.inputs[arg.Input]!;
    return input.$kind === 'Pure'
      ? `pure:${input.Pure.bytes}`
      : `obj:${input.UnresolvedObject.objectId}`;
  });
  return {target: `${call.module}::${call.function}`, args};
}

describe('ai_credit builders', () => {
  it('deposit(config, balance, coin split from gas)', () => {
    const tx = depositAiCreditTx(IDS, {balanceId: BALANCE, amountMist: 5_000n});
    const data = tx.getData() as unknown as {commands: {$kind: string}[]};
    expect(data.commands[0]!.$kind).toBe('SplitCoins');
    expect(lastMoveCall(tx)).toEqual({
      target: 'ai_credit::deposit',
      args: [obj(IDS.aiCreditConfigId), obj(BALANCE), 'result:0'],
    });
  });

  it('withdraw(config, balance, amount_mist)', () => {
    const tx = withdrawAiCreditTx(IDS, {balanceId: BALANCE, amountMist: 42n});
    expect(lastMoveCall(tx)).toEqual({
      target: 'ai_credit::withdraw',
      args: [obj(IDS.aiCreditConfigId), obj(BALANCE), u64(42)],
    });
  });

  it('set_agent_budget(config, balance, agent, budget, daily, monthly, approval_above, clock)', () => {
    const tx = setAgentBudgetTx(IDS, {
      balanceId: BALANCE,
      agentObjectId: AGENT,
      budgetMist: 1_000n,
      dailyCapMist: null,
      monthlyCapMist: 300n,
      requireApprovalAboveMist: 50n,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'ai_credit::set_agent_budget',
      args: [
        obj(IDS.aiCreditConfigId),
        obj(BALANCE),
        obj(AGENT),
        optU64(1_000),
        optU64(null),
        optU64(300),
        optU64(50),
        obj(CLOCK),
      ],
    });
  });

  it('pause_balance / reactivate_balance(config, balance)', () => {
    expect(lastMoveCall(pauseAiCreditTx(IDS, {balanceId: BALANCE}))).toEqual({
      target: 'ai_credit::pause_balance',
      args: [obj(IDS.aiCreditConfigId), obj(BALANCE)],
    });
    expect(lastMoveCall(reactivateAiCreditTx(IDS, {balanceId: BALANCE}))).toEqual({
      target: 'ai_credit::reactivate_balance',
      args: [obj(IDS.aiCreditConfigId), obj(BALANCE)],
    });
  });

  it('approve_agent_spend(config, balance, agent id, max, expires, clock)', () => {
    const tx = approveAgentSpendTx(IDS, {
      balanceId: BALANCE,
      agentObjectId: AGENT,
      maxAmountMist: 77n,
      expiresAtMs: 1_000,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'ai_credit::approve_agent_spend',
      args: [
        obj(IDS.aiCreditConfigId),
        obj(BALANCE),
        addr(AGENT),
        u64(77),
        u64(1_000),
        obj(CLOCK),
      ],
    });
  });
});

describe('memory builders', () => {
  const publicKey = new Uint8Array(32).fill(3);
  const derived = `0x${'d1'.repeat(32)}`;
  const policyArgs = (caps: number, expires: number | null) => [
    u8(1),
    u64(0),
    u64(caps),
    u64(0),
    u8(3),
    u64(0),
    optU64(null),
    optAddr(null),
    optU64(expires),
  ];

  it('create_agentic_organization(config, account, type, name, description, clock)', () => {
    const tx = createAgenticOrganizationTx(IDS, {
      accountId: ACCOUNT,
      orgType: 4,
      name: 'Lab',
      description: null,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'memory::create_agentic_organization',
      args: [obj(IDS.memoryConfigId), obj(ACCOUNT), u8(4), optStr('Lab'), optStr(null), obj(CLOCK)],
    });
  });

  it('register_sub_agent(config, account, org, pk, derived, label, policy..., clock)', () => {
    const tx = registerSubAgentTx(IDS, {
      accountId: ACCOUNT,
      organizationId: ORG,
      publicKey,
      derivedAddress: derived,
      label: 'helper',
      capabilities: 16387,
      expiresAtMs: 9_999,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'memory::register_sub_agent',
      args: [
        obj(IDS.memoryConfigId),
        obj(ACCOUNT),
        obj(ORG),
        vecU8(publicKey),
        addr(derived),
        str('helper'),
        ...policyArgs(16387, 9_999),
        obj(CLOCK),
      ],
    });
  });

  it('register_sub_agent_delegated(config, account, parent, pk, derived, label, policy..., relation, clock)', () => {
    const tx = registerSubAgentDelegatedTx(IDS, {
      accountId: ACCOUNT,
      parentAgentObjectId: AGENT,
      publicKey,
      derivedAddress: derived,
      label: 'child',
      capabilities: 3,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'memory::register_sub_agent_delegated',
      args: [
        obj(IDS.memoryConfigId),
        obj(ACCOUNT),
        obj(AGENT),
        vecU8(publicKey),
        addr(derived),
        str('child'),
        ...policyArgs(3, null),
        u8(1),
        obj(CLOCK),
      ],
    });
  });

  it('chains vault + budget into one transaction', () => {
    const tx = ensureAgentMemoryVaultTx(IDS, {accountId: ACCOUNT, agentObjectId: AGENT});
    setAgentBudgetTx(
      IDS,
      {
        balanceId: BALANCE,
        agentObjectId: AGENT,
        budgetMist: 10n,
        dailyCapMist: null,
        monthlyCapMist: null,
        requireApprovalAboveMist: null,
      },
      tx,
    );
    const data = tx.getData() as unknown as {
      commands: {MoveCall?: {function: string}}[];
    };
    expect(data.commands.map((c) => c.MoveCall?.function)).toEqual([
      'ensure_agent_memory_vault',
      'set_agent_budget',
    ]);
  });
});
