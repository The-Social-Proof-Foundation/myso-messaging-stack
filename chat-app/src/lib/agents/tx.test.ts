import {describe, expect, it} from 'vitest';
import {bcs} from '@socialproof/myso/bcs';
import type {Transaction} from '@socialproof/myso/transactions';
import {normalizeMySoAddress, toBase64} from '@socialproof/myso/utils';

import {
  acceptDisputeSettlementTx,
  acceptRefundTx,
  acceptTaskTx,
  appealDisputeTx,
  cancelDisputeTx,
  clearDisputeSettlementTx,
  disputeEvidenceTx,
  executeNeutralResolutionTx,
  executeVerdictTx,
  joinRosterTx,
  leaveRosterTx,
  openDisputeTx,
  proposeDisputeSettlementTx,
  respondDisputeTx,
  settleDisputeFeesTx,
  startNeutralResolutionTx,
  approveAgentSpendTx,
  cancelOfferTx,
  createTaskTx,
  declineTaskTx,
  expireOfferTx,
  markTaskDeliveredTx,
  proposeRefundTx,
  refundTaskTx,
  rejectRefundTx,
  releaseTaskTx,
  reviewBuyerAgentTx,
  reviewBuyerPrincipalTx,
  reviewSellerTx,
  settleTaskTx,
  withdrawRefundTx,
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
type Arg = {$kind: string; Input?: number; NestedResult?: [number, number]};

/** Renders the last Move call as `module::function` plus readable arguments. */
function lastMoveCall(tx: Transaction): {target: string; args: string[]} {
  const data = tx.getData() as unknown as {
    inputs: Input[];
    commands: {$kind: string; MoveCall?: {module: string; function: string; arguments: Arg[]}}[];
  };
  const call = [...data.commands].reverse().find((c) => c.$kind === 'MoveCall')?.MoveCall;
  if (!call) throw new Error('no MoveCall');
  const args = call.arguments.map((arg) => {
    if (arg.$kind === 'NestedResult') return `result:${arg.NestedResult![0]}`;
    // A coin built from an intent (a case fee) is not an input; its value is not what is under test.
    if (arg.$kind !== 'Input') return `coin:${arg.$kind}`;
    const input = data.inputs[arg.Input!]!;
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

const TASK_IDS = {...IDS, taskConfigId: '0xc0'};
const TASK = '0xc1';
const BUYER_ACCOUNT = '0xc2';
const SELLER_ACCOUNT = '0xc3';
const SELLER_AGENT = '0xc4';
const BUYER_AGENT = '0xc5';
const PLATFORM = '0xc6';
const PAYMENT = '0xc7';
const ROOM = '0xc8';
const DIGEST = new Uint8Array(32).fill(0x11);
const u8arg = u8;

describe('agent_task builders', () => {
  it('create_task(config, memory_config, buyer, seller, seller_agent, payment, amount, scope, title, windows, room, platform, clock)', () => {
    const tx = createTaskTx(TASK_IDS, {
      buyerAccountId: BUYER_ACCOUNT,
      sellerAccountId: SELLER_ACCOUNT,
      sellerAgentId: SELLER_AGENT,
      amountMist: 1_000_000_000n,
      scopeDigest: DIGEST,
      title: 'write the report',
      acceptWindowMs: 86_400_000,
      deliveryWindowMs: 172_800_000,
      settleWindowMs: 259_200_000,
      roomGroupId: ROOM,
      platformId: null,
      paymentCoinId: PAYMENT,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'agent_task::create_task',
      args: [
        obj(TASK_IDS.taskConfigId),
        obj(IDS.memoryConfigId),
        obj(BUYER_ACCOUNT),
        obj(SELLER_ACCOUNT),
        obj(SELLER_AGENT),
        obj(PAYMENT),
        u64(1_000_000_000),
        vecU8(DIGEST),
        str('write the report'),
        u64(86_400_000),
        u64(172_800_000),
        u64(259_200_000),
        optAddr(ROOM),
        optAddr(null),
        obj(CLOCK),
      ],
    });
  });

  it('accept_task(config, task, memory_config, seller_account, seller_agent, terms_digest, clock)', () => {
    const tx = acceptTaskTx(TASK_IDS, {
      taskId: TASK,
      sellerAccountId: SELLER_ACCOUNT,
      sellerAgentId: SELLER_AGENT,
      termsDigest: DIGEST,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'agent_task::accept_task',
      args: [
        obj(TASK_IDS.taskConfigId),
        obj(TASK),
        obj(IDS.memoryConfigId),
        obj(SELLER_ACCOUNT),
        obj(SELLER_AGENT),
        vecU8(DIGEST),
        obj(CLOCK),
      ],
    });
  });

  it('decline_task / cancel_offer / expire_offer', () => {
    expect(
      lastMoveCall(
        declineTaskTx(TASK_IDS, {taskId: TASK, sellerAccountId: SELLER_ACCOUNT, sellerAgentId: SELLER_AGENT}),
      ),
    ).toEqual({
      target: 'agent_task::decline_task',
      args: [obj(TASK), obj(IDS.memoryConfigId), obj(SELLER_ACCOUNT), obj(SELLER_AGENT), obj(CLOCK)],
    });
    expect(lastMoveCall(cancelOfferTx(TASK_IDS, {taskId: TASK, buyerAccountId: BUYER_ACCOUNT}))).toEqual({
      target: 'agent_task::cancel_offer',
      args: [obj(TASK), obj(IDS.memoryConfigId), obj(BUYER_ACCOUNT), obj(CLOCK)],
    });
    expect(lastMoveCall(expireOfferTx(IDS, {taskId: TASK}))).toEqual({
      target: 'agent_task::expire_offer',
      args: [obj(TASK), obj(CLOCK)],
    });
  });

  it('mark_delivered(config, task, seller_agent, digest, uri, clock)', () => {
    const tx = markTaskDeliveredTx(TASK_IDS, {
      taskId: TASK,
      sellerAgentId: SELLER_AGENT,
      digest: DIGEST,
      uri: 'walrus://x',
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'agent_task::mark_delivered',
      args: [
        obj(TASK_IDS.taskConfigId),
        obj(TASK),
        obj(SELLER_AGENT),
        vecU8(DIGEST),
        str('walrus://x'),
        obj(CLOCK),
      ],
    });
  });

  it('settle_task and release_task take both accounts and a platform', () => {
    const args = {
      taskId: TASK,
      buyerAccountId: BUYER_ACCOUNT,
      sellerAccountId: SELLER_ACCOUNT,
      platformObjectId: PLATFORM,
    };
    expect(lastMoveCall(settleTaskTx(TASK_IDS, args))).toEqual({
      target: 'agent_task::settle_task',
      args: [
        obj(TASK_IDS.taskConfigId),
        obj(TASK),
        obj(IDS.memoryConfigId),
        obj(BUYER_ACCOUNT),
        obj(SELLER_ACCOUNT),
        obj(PLATFORM),
        obj(CLOCK),
      ],
    });
    // release_task has no memory_config: it needs no actor resolution.
    expect(lastMoveCall(releaseTaskTx(TASK_IDS, args))).toEqual({
      target: 'agent_task::release_task',
      args: [
        obj(TASK_IDS.taskConfigId),
        obj(TASK),
        obj(BUYER_ACCOUNT),
        obj(SELLER_ACCOUNT),
        obj(PLATFORM),
        obj(CLOCK),
      ],
    });
  });

  it('refund_task is permissionless: task and clock only', () => {
    expect(lastMoveCall(refundTaskTx(IDS, {taskId: TASK}))).toEqual({
      target: 'agent_task::refund_task',
      args: [obj(TASK), obj(CLOCK)],
    });
  });

  it('mutual refund calls share one argument shape', () => {
    const args = {taskId: TASK, buyerAccountId: BUYER_ACCOUNT, sellerAgentId: SELLER_AGENT};
    const shape = [obj(TASK), obj(IDS.memoryConfigId), obj(BUYER_ACCOUNT), obj(SELLER_AGENT), obj(CLOCK)];
    for (const [build, fn] of [
      [proposeRefundTx, 'propose_refund'],
      [acceptRefundTx, 'accept_refund'],
      [rejectRefundTx, 'reject_refund'],
      [withdrawRefundTx, 'withdraw_refund'],
    ] as const) {
      expect(lastMoveCall(build(TASK_IDS, args))).toEqual({target: `agent_task::${fn}`, args: shape});
    }
  });

  it('review builders pass stars as a u8 after the objects', () => {
    expect(
      lastMoveCall(
        reviewSellerTx(TASK_IDS, {
          taskId: TASK,
          buyerAccountId: BUYER_ACCOUNT,
          sellerAccountId: SELLER_ACCOUNT,
          sellerAgentId: SELLER_AGENT,
          stars: 5,
        }),
      ),
    ).toEqual({
      target: 'agent_task::review_seller',
      args: [
        obj(TASK_IDS.taskConfigId),
        obj(TASK),
        obj(IDS.memoryConfigId),
        obj(BUYER_ACCOUNT),
        obj(SELLER_ACCOUNT),
        obj(SELLER_AGENT),
        u8arg(5),
        obj(CLOCK),
      ],
    });
    expect(
      lastMoveCall(
        reviewBuyerAgentTx(TASK_IDS, {
          taskId: TASK,
          buyerAccountId: BUYER_ACCOUNT,
          buyerAgentId: BUYER_AGENT,
          sellerAgentId: SELLER_AGENT,
          stars: 2,
        }),
      ),
    ).toEqual({
      target: 'agent_task::review_buyer_agent',
      args: [
        obj(TASK_IDS.taskConfigId),
        obj(TASK),
        obj(BUYER_ACCOUNT),
        obj(BUYER_AGENT),
        obj(SELLER_AGENT),
        u8arg(2),
        obj(CLOCK),
      ],
    });
    expect(
      lastMoveCall(
        reviewBuyerPrincipalTx(TASK_IDS, {
          taskId: TASK,
          buyerAccountId: BUYER_ACCOUNT,
          sellerAgentId: SELLER_AGENT,
          stars: 4,
        }),
      ),
    ).toEqual({
      target: 'agent_task::review_buyer_principal',
      args: [
        obj(TASK_IDS.taskConfigId),
        obj(TASK),
        obj(BUYER_ACCOUNT),
        obj(SELLER_AGENT),
        u8arg(4),
        obj(CLOCK),
      ],
    });
  });

  it('a review can ride in the same transaction as the settlement', () => {
    const tx = settleTaskTx(TASK_IDS, {
      taskId: TASK,
      buyerAccountId: BUYER_ACCOUNT,
      sellerAccountId: SELLER_ACCOUNT,
      platformObjectId: PLATFORM,
    });
    reviewSellerTx(
      TASK_IDS,
      {
        taskId: TASK,
        buyerAccountId: BUYER_ACCOUNT,
        sellerAccountId: SELLER_ACCOUNT,
        sellerAgentId: SELLER_AGENT,
        stars: 5,
      },
      tx,
    );
    const data = tx.getData() as unknown as {commands: {$kind: string}[]};
    expect(data.commands.map((c) => c.$kind)).toEqual(['MoveCall', 'MoveCall']);
    expect(lastMoveCall(tx).target).toBe('agent_task::review_seller');
  });
});

const DISPUTE_IDS = {...TASK_IDS, juryConfigId: '0xd1', jurorRosterId: '0xd2'};
const CASE = '0xd3';
const FEE = expect.stringMatching(/^coin:/);

describe('task dispute builders', () => {
  it('open_dispute(config, jury_config, roster, task, memory_config, buyer, seller, seller_agent, fee, clock)', () => {
    const tx = openDisputeTx(DISPUTE_IDS, {
      taskId: TASK,
      buyerAccountId: BUYER_ACCOUNT,
      sellerAccountId: SELLER_ACCOUNT,
      sellerAgentId: SELLER_AGENT,
      feeMist: 100_000_000,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'agent_task::open_dispute',
      args: [
        obj(DISPUTE_IDS.taskConfigId),
        obj(DISPUTE_IDS.juryConfigId),
        obj(DISPUTE_IDS.jurorRosterId),
        obj(TASK),
        obj(IDS.memoryConfigId),
        obj(BUYER_ACCOUNT),
        obj(SELLER_ACCOUNT),
        obj(SELLER_AGENT),
        FEE,
        obj(CLOCK),
      ],
    });
  });

  it('respond_dispute and appeal_dispute take (task, case, memory_config, buyer, seller_agent, fee, clock)', () => {
    const args = {
      taskId: TASK,
      caseId: CASE,
      buyerAccountId: BUYER_ACCOUNT,
      sellerAgentId: SELLER_AGENT,
      feeMist: 60,
    };
    const expected = [
      obj(TASK),
      obj(CASE),
      obj(IDS.memoryConfigId),
      obj(BUYER_ACCOUNT),
      obj(SELLER_AGENT),
      FEE,
      obj(CLOCK),
    ];
    expect(lastMoveCall(respondDisputeTx(DISPUTE_IDS, args))).toEqual({
      target: 'agent_task::respond_dispute',
      args: expected,
    });
    expect(lastMoveCall(appealDisputeTx(DISPUTE_IDS, args))).toEqual({
      target: 'agent_task::appeal_dispute',
      args: expected,
    });
  });

  it('submit_dispute_evidence(jury_config, task, case, memory_config, buyer, seller_agent, digest, uri, clock)', () => {
    const tx = disputeEvidenceTx(DISPUTE_IDS, {
      taskId: TASK,
      caseId: CASE,
      buyerAccountId: BUYER_ACCOUNT,
      sellerAgentId: SELLER_AGENT,
      digest: DIGEST,
      uri: 'https://e.example/1',
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'agent_task::submit_dispute_evidence',
      args: [
        obj(DISPUTE_IDS.juryConfigId),
        obj(TASK),
        obj(CASE),
        obj(IDS.memoryConfigId),
        obj(BUYER_ACCOUNT),
        obj(SELLER_AGENT),
        vecU8(DIGEST),
        vecU8(new TextEncoder().encode('https://e.example/1')),
        obj(CLOCK),
      ],
    });
  });

  it('cancel_dispute_before_draw(task, case, memory_config, buyer, seller_agent, clock)', () => {
    const tx = cancelDisputeTx(DISPUTE_IDS, {
      taskId: TASK,
      caseId: CASE,
      buyerAccountId: BUYER_ACCOUNT,
      sellerAgentId: SELLER_AGENT,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'agent_task::cancel_dispute_before_draw',
      args: [
        obj(TASK),
        obj(CASE),
        obj(IDS.memoryConfigId),
        obj(BUYER_ACCOUNT),
        obj(SELLER_AGENT),
        obj(CLOCK),
      ],
    });
  });

  it('execute_verdict(config, task, case, buyer, seller, platform, clock)', () => {
    const tx = executeVerdictTx(DISPUTE_IDS, {
      taskId: TASK,
      caseId: CASE,
      buyerAccountId: BUYER_ACCOUNT,
      sellerAccountId: SELLER_ACCOUNT,
      platformObjectId: PLATFORM,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'agent_task::execute_verdict',
      args: [
        obj(DISPUTE_IDS.taskConfigId),
        obj(TASK),
        obj(CASE),
        obj(BUYER_ACCOUNT),
        obj(SELLER_ACCOUNT),
        obj(PLATFORM),
        obj(CLOCK),
      ],
    });
  });

  it('start_neutral_resolution(jury_config, task, case, clock) and execute_neutral_resolution(config, task, buyer, seller, platform, clock)', () => {
    expect(lastMoveCall(startNeutralResolutionTx(DISPUTE_IDS, {taskId: TASK, caseId: CASE}))).toEqual({
      target: 'agent_task::start_neutral_resolution',
      args: [obj(DISPUTE_IDS.juryConfigId), obj(TASK), obj(CASE), obj(CLOCK)],
    });
    expect(
      lastMoveCall(
        executeNeutralResolutionTx(DISPUTE_IDS, {
          taskId: TASK,
          buyerAccountId: BUYER_ACCOUNT,
          sellerAccountId: SELLER_ACCOUNT,
          platformObjectId: PLATFORM,
        }),
      ),
    ).toEqual({
      target: 'agent_task::execute_neutral_resolution',
      args: [
        obj(DISPUTE_IDS.taskConfigId),
        obj(TASK),
        obj(BUYER_ACCOUNT),
        obj(SELLER_ACCOUNT),
        obj(PLATFORM),
        obj(CLOCK),
      ],
    });
  });

  it('the settlement agreement calls', () => {
    expect(
      lastMoveCall(
        proposeDisputeSettlementTx(DISPUTE_IDS, {
          taskId: TASK,
          buyerAccountId: BUYER_ACCOUNT,
          sellerAgentId: SELLER_AGENT,
          outcome: 2,
        }),
      ),
    ).toEqual({
      target: 'agent_task::propose_dispute_settlement',
      args: [
        obj(TASK),
        obj(IDS.memoryConfigId),
        obj(BUYER_ACCOUNT),
        obj(SELLER_AGENT),
        u8(2),
        obj(CLOCK),
      ],
    });
    expect(
      lastMoveCall(
        acceptDisputeSettlementTx(DISPUTE_IDS, {
          taskId: TASK,
          buyerAccountId: BUYER_ACCOUNT,
          sellerAccountId: SELLER_ACCOUNT,
          sellerAgentId: SELLER_AGENT,
          platformObjectId: PLATFORM,
        }),
      ),
    ).toEqual({
      target: 'agent_task::accept_dispute_settlement',
      args: [
        obj(DISPUTE_IDS.taskConfigId),
        obj(TASK),
        obj(IDS.memoryConfigId),
        obj(BUYER_ACCOUNT),
        obj(SELLER_ACCOUNT),
        obj(SELLER_AGENT),
        obj(PLATFORM),
        obj(CLOCK),
      ],
    });
    expect(
      lastMoveCall(
        clearDisputeSettlementTx(DISPUTE_IDS, {
          taskId: TASK,
          buyerAccountId: BUYER_ACCOUNT,
          sellerAgentId: SELLER_AGENT,
        }),
      ),
    ).toEqual({
      target: 'agent_task::clear_dispute_settlement',
      args: [obj(TASK), obj(IDS.memoryConfigId), obj(BUYER_ACCOUNT), obj(SELLER_AGENT), obj(CLOCK)],
    });
  });

  it('settle_dispute_fees(task, case, clock), preceded by closing a case that is still open', () => {
    const finished = settleDisputeFeesTx(DISPUTE_IDS, {taskId: TASK, caseId: CASE, closeCaseFirst: false});
    expect(lastMoveCall(finished)).toEqual({
      target: 'agent_task::settle_dispute_fees',
      args: [obj(TASK), obj(CASE), obj(CLOCK)],
    });
    const data = (tx: Transaction) => tx.getData() as unknown as {commands: unknown[]};
    expect(data(finished).commands).toHaveLength(1);

    const open = settleDisputeFeesTx(DISPUTE_IDS, {taskId: TASK, caseId: CASE, closeCaseFirst: true});
    expect(data(open).commands).toHaveLength(2);
    expect(lastMoveCall(open).target).toBe('agent_task::settle_dispute_fees');
  });
});

describe('juror roster builders', () => {
  it('join_roster(jury_config, roster, memory_config, account, agent, payout, model_family, clock)', () => {
    const tx = joinRosterTx(DISPUTE_IDS, {
      accountId: BUYER_ACCOUNT,
      agentId: SELLER_AGENT,
      payoutAddress: '0xf00d',
      modelFamily: 3,
    });
    expect(lastMoveCall(tx)).toEqual({
      target: 'jury::join_roster',
      args: [
        obj(DISPUTE_IDS.juryConfigId),
        obj(DISPUTE_IDS.jurorRosterId),
        obj(IDS.memoryConfigId),
        obj(BUYER_ACCOUNT),
        obj(SELLER_AGENT),
        addr('0xf00d'),
        u8(3),
        obj(CLOCK),
      ],
    });
  });

  it('leave_roster(roster, account, agent_id, clock)', () => {
    const tx = leaveRosterTx(DISPUTE_IDS, {accountId: BUYER_ACCOUNT, agentId: SELLER_AGENT});
    expect(lastMoveCall(tx)).toEqual({
      target: 'jury::leave_roster',
      args: [obj(DISPUTE_IDS.jurorRosterId), obj(BUYER_ACCOUNT), addr(SELLER_AGENT), obj(CLOCK)],
    });
  });
});
