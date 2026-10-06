import {useEffect, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {ArrowRight, ArrowUpDown, Check} from 'lucide-react';

import {Dialog} from '../Dialog';
import {TxStatusOverlay} from '../TxStatusOverlay';
import {useAgentActions, useAiCreditBalance} from '../../hooks/agents';
import {formatMistAmount, parseMysoToMist} from '../../lib/agents/format';
import {useGraphQLClient} from '../../contexts/MessagingClientContext';
import {useMySocialAuth} from '../../contexts/MySocialAuthContext';
import {resolveAgentChainIds} from '../../lib/agents/chain-ids';
import {depositAiCreditTx, withdrawAiCreditTx} from '../../lib/agents/tx';
import {zkLoginChainAddress} from '../../lib/zklogin-signin';

export type CreditAmountMode = 'deposit' | 'withdraw';

interface CreditAmountDialogProps {
  mode: CreditAmountMode | null;
  onClose: () => void;
  priceUsd: number | null;
  /** Wallet MySo balance in MIST. Deposit MAX uses this. */
  walletMist: bigint | null;
  /** Credit balance in MIST. Withdraw MAX uses this. */
  creditMist: number | null;
}

function stripCommas(value: string): string {
  return value.replace(/,/g, '');
}

function formatWithCommas(value: string): string {
  if (!value) return '';
  const cleaned = stripCommas(value);
  const [integerPart, decimalPart] = cleaned.split('.');
  const formattedInteger = (integerPart ?? '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decimalPart !== undefined ? `${formattedInteger}.${decimalPart}` : formattedInteger;
}

function numericAmount(value: string): number {
  const parsed = Number(stripCommas(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

type AmountUnit = 'token' | 'usd';

function trimAmount(value: string): string {
  if (!value.includes('.')) return value;
  return value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function mysoToUsdString(myso: number, priceUsd: number): string {
  if (!(priceUsd > 0) || !(myso > 0)) return '';
  const usd = myso * priceUsd;
  return trimAmount(usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2));
}

function usdToMysoString(usd: number, priceUsd: number): string {
  if (!(priceUsd > 0) || !(usd > 0)) return '';
  return trimAmount((usd / priceUsd).toFixed(9));
}

type DialogStage = 'amount' | 'review';

type GasEstimate =
  | {state: 'loading'}
  | {state: 'ready'; mist: bigint}
  | {state: 'unavailable'};

function formatMistLabel(mist: bigint): string {
  const whole = mist / 1_000_000_000n;
  const fraction = (mist % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  const body = fraction ? `${whole.toString()}.${fraction}` : whole.toString();
  return formatWithCommas(body);
}

function netGasUsedMist(gasUsed?: {
  computationCost?: string | number | bigint;
  storageCost?: string | number | bigint;
  storageRebate?: string | number | bigint;
} | null): bigint | null {
  if (!gasUsed) return null;
  const computation = BigInt(gasUsed.computationCost ?? 0);
  const storage = BigInt(gasUsed.storageCost ?? 0);
  const rebate = BigInt(gasUsed.storageRebate ?? 0);
  const net = computation + storage - rebate;
  return net > 0n ? net : computation;
}

const actionButtonClass =
  'inline-flex w-full items-center justify-center gap-2 rounded-md bg-[#DFF7AB] px-4 py-3.5 font-chakra text-sm font-normal text-black transition-colors hover:bg-[#BFEF6A] disabled:cursor-not-allowed disabled:bg-secondary-200 disabled:text-secondary-500 disabled:hover:bg-secondary-300 dark:disabled:bg-secondary-700 dark:disabled:text-secondary-400 dark:disabled:hover:bg-secondary-900';

export function CreditAmountDialog({
  mode,
  onClose,
  priceUsd,
  walletMist,
  creditMist,
}: Readonly<CreditAmountDialogProps>) {
  const actions = useAgentActions();
  const credit = useAiCreditBalance();
  const queryClient = useQueryClient();
  const graphql = useGraphQLClient();
  const {keypair} = useMySocialAuth();
  const [amount, setAmount] = useState('');
  const [unit, setUnit] = useState<AmountUnit>('token');
  const [stage, setStage] = useState<DialogStage>('amount');
  const [busy, setBusy] = useState(false);
  const [txPhase, setTxPhase] = useState<'processing' | 'success' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gas, setGas] = useState<GasEstimate>({state: 'unavailable'});

  const open = mode != null;
  const isWithdraw = mode === 'withdraw';
  const title =
    stage === 'review'
      ? isWithdraw
        ? 'Review Withdrawal'
        : 'Review Deposit'
      : isWithdraw
        ? 'Withdraw Credits'
        : 'Deposit Credits';
  const maxMist = mode === 'withdraw' ? creditMist : walletMist;
  const maxMyso = formatMistAmount(maxMist);
  const maxLabel = maxMyso === '—' ? maxMyso : formatWithCommas(trimAmount(maxMyso));
  const entered = numericAmount(amount);
  const mysoEntered =
    unit === 'token' ? entered : priceUsd && priceUsd > 0 ? entered / priceUsd : 0;
  const usdLabel =
    mysoEntered > 0 && priceUsd && priceUsd > 0
      ? `$${(mysoEntered * priceUsd).toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`
      : '$0.00';
  const tokenLabel =
    mysoEntered > 0 ? formatWithCommas(trimAmount(mysoEntered.toFixed(9))) : '0.00';

  function close() {
    if (busy) return;
    setAmount('');
    setUnit('token');
    setStage('amount');
    setGas({state: 'unavailable'});
    setTxPhase(null);
    setError(null);
    onClose();
  }

  function flipUnit() {
    if (!(priceUsd && priceUsd > 0)) return;
    const current = numericAmount(amount);
    if (unit === 'token') {
      setAmount(current > 0 ? formatWithCommas(mysoToUsdString(current, priceUsd)) : '');
      setUnit('usd');
      return;
    }
    setAmount(current > 0 ? formatWithCommas(usdToMysoString(current, priceUsd)) : '');
    setUnit('token');
  }

  function writeMax() {
    if (maxMyso === '—') return;
    const myso = numericAmount(maxMyso);
    if (!(myso > 0)) return;
    if (unit === 'usd' && priceUsd && priceUsd > 0) {
      setAmount(formatWithCommas(mysoToUsdString(myso, priceUsd)));
      return;
    }
    setAmount(formatWithCommas(trimAmount(maxMyso)));
  }

  function onAmountChange(raw: string) {
    const cleaned = stripCommas(raw);
    if (cleaned === '') {
      setAmount('');
      return;
    }
    if (!/^\d*\.?\d*$/.test(cleaned)) return;
    const [whole, fraction] = cleaned.split('.');
    const maxFraction = unit === 'usd' ? 2 : 9;
    const limited =
      fraction != null && fraction.length > maxFraction
        ? `${whole}.${fraction.slice(0, maxFraction)}`
        : cleaned;
    setAmount(formatWithCommas(limited));
  }

  function enteredMist(): bigint | null {
    const mysoText =
      unit === 'token'
        ? stripCommas(amount)
        : priceUsd && priceUsd > 0
          ? usdToMysoString(numericAmount(amount), priceUsd)
          : '';
    const mist = parseMysoToMist(mysoText);
    return mist != null && mist > 0n ? mist : null;
  }

  function review() {
    if (!credit.data?.balance.balance_id) {
      setError('No AI credit balance yet.');
      return;
    }
    if (!enteredMist()) {
      setError('Enter a positive MySo amount.');
      return;
    }
    setError(null);
    setStage('review');
  }

  const reviewMist = stage === 'review' ? enteredMist() : null;
  const balanceId = credit.data?.balance.balance_id ?? null;

  useEffect(() => {
    if (stage !== 'review' || !reviewMist || !balanceId || !keypair) {
      return;
    }
    let cancelled = false;
    setGas({state: 'loading'});
    void (async () => {
      try {
        const ids = await resolveAgentChainIds();
        const tx = isWithdraw
          ? withdrawAiCreditTx(ids, {balanceId, amountMist: reviewMist})
          : depositAiCreditTx(ids, {balanceId, amountMist: reviewMist});
        tx.setSender(zkLoginChainAddress() ?? keypair.toMySoAddress());
        const result = await graphql.simulateTransaction({
          transaction: tx,
          include: {effects: true},
        });
        const effects =
          result.$kind === 'Transaction'
            ? result.Transaction.effects
            : result.FailedTransaction?.effects;
        const mist = netGasUsedMist(effects?.gasUsed);
        if (!cancelled) setGas(mist == null ? {state: 'unavailable'} : {state: 'ready', mist});
      } catch {
        if (!cancelled) setGas({state: 'unavailable'});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [stage, reviewMist, balanceId, keypair, graphql, isWithdraw]);

  async function submit() {
    const id = credit.data?.balance.balance_id;
    const mist = enteredMist();
    if (!id) {
      setError('No AI credit balance yet.');
      return;
    }
    if (!mist) {
      setError('Enter a positive MySo amount.');
      return;
    }
    setBusy(true);
    setTxPhase('processing');
    setError(null);
    try {
      if (isWithdraw) {
        await actions.withdrawCredits({balanceId: id, amountMist: mist});
      } else {
        await actions.depositCredits({balanceId: id, amountMist: mist});
      }
      await queryClient.invalidateQueries({queryKey: ['myso-wallet-balance']});
      setTxPhase('success');
      await new Promise((resolve) => window.setTimeout(resolve, 1600));
      setAmount('');
      setStage('amount');
      setTxPhase(null);
      setBusy(false);
      onClose();
    } catch (err) {
      setTxPhase(null);
      setBusy(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const gasMist = gas.state === 'ready' ? gas.mist : null;
  const totalMist =
    reviewMist == null
      ? null
      : isWithdraw
        ? gasMist
        : gasMist == null
          ? reviewMist
          : reviewMist + gasMist;

  const canFlip = Boolean(priceUsd && priceUsd > 0);

  return (
    <>
    <Dialog
      open={open}
      title={title}
      onClose={close}
      busy={busy}
      titleClassName="font-chakra text-xl font-normal leading-tight tracking-tight text-secondary-900 dark:text-secondary-50"
      panelRadiusClass="rounded-lg"
      leading={
        stage === 'review' ? (
          <button
            type="button"
            onClick={() => {
              if (busy) return;
              setError(null);
              setStage('amount');
            }}
            disabled={busy}
            className="font-chakra text-xs font-bold text-secondary-400 hover:text-secondary-100 disabled:opacity-50"
          >
            ← Back
          </button>
        ) : null
      }
      overlay={
        txPhase ? (
          <TxStatusOverlay
            contained
            phase={txPhase}
            processingText="Processing transaction..."
            successText="Transaction complete"
          />
        ) : null
      }
    >
      {stage === 'amount' ? (
        <>
      <div className="mb-6 pt-2">
        <div className="flex items-center">
          {unit === 'usd' ? (
            <span className="font-chakra text-3xl leading-none text-secondary-400">$</span>
          ) : null}
          <input
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            disabled={busy}
            aria-label="Amount"
            autoFocus
            className="min-w-0 flex-1 bg-transparent font-chakra text-[48px] leading-none text-secondary-900 outline-none placeholder:text-secondary-400 disabled:opacity-50 dark:text-secondary-50"
          />
        </div>
        <button
          type="button"
          onClick={flipUnit}
          disabled={!canFlip || busy}
          className="mt-1 inline-flex items-center gap-2 py-2 text-left font-chakra text-lg text-secondary-400 transition-colors hover:text-secondary-900 disabled:cursor-default dark:hover:text-secondary-50"
        >
          {unit === 'token' ? (
            <span>{usdLabel}</span>
          ) : (
            <span>
              {tokenLabel}
              <span className="ml-1">MySo</span>
            </span>
          )}
          <ArrowUpDown className="h-5 w-5 shrink-0" />
        </button>
      </div>

          <div className="mb-6 space-y-2">
            <p className="px-1 text-xs text-secondary-400">Token</p>
            <div className="flex items-center justify-between rounded-lg border border-secondary-200 bg-secondary-100 p-3 dark:border-secondary-600 dark:bg-secondary-700">
              <div className="flex min-w-0 items-center gap-3">
                <img src="/myso-icon-green.webp" alt="" width={36} height={36} className="h-9 w-9 shrink-0 rounded-full" />
                <div className="min-w-0">
                  <p className="truncate font-chakra text-sm text-secondary-900 dark:text-secondary-50">MySo</p>
                  <p className="truncate text-xs text-secondary-400">
                    {maxLabel === '—' ? '—' : `${maxLabel} MySo`}
                  </p>
                </div>
              </div>
              <button
                type="button"
                disabled={busy || maxLabel === '—'}
                onClick={writeMax}
                className="shrink-0 px-2 py-1 font-chakra text-xs text-secondary-400 hover:text-secondary-900 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-secondary-50"
              >
                MAX
              </button>
            </div>
          </div>

          {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}

          <button
            type="button"
            className={actionButtonClass}
            disabled={busy || mysoEntered <= 0}
            onClick={review}
          >
            {isWithdraw ? 'Review Withdrawal' : 'Review Deposit'}
            <ArrowRight className="h-4 w-4" />
          </button>
        </>
      ) : (
        <>
          <div className="mb-6 overflow-hidden rounded-lg border border-secondary-200 bg-secondary-100 dark:border-secondary-600 dark:bg-secondary-700">
            <div className="divide-y divide-secondary-200 dark:divide-secondary-800">
              <ReviewRow label="Amount" value={reviewMist == null ? '—' : `${formatMistLabel(reviewMist)} MySo`} />
              <ReviewRow
                label="Gas"
                value={
                  gas.state === 'loading'
                    ? 'Estimating…'
                    : gasMist == null
                      ? '—'
                      : `${formatMistLabel(gasMist)} MySo`
                }
              />
              <ReviewRow
                label={isWithdraw ? 'Total cost' : 'Total amount'}
                value={totalMist == null ? '—' : `${formatMistLabel(totalMist)} MySo`}
                emphasize
              />
            </div>
          </div>
          {isWithdraw ? (
            <p className="mb-4 text-xs text-secondary-400">
              The withdrawn MySo returns to your wallet. You only pay the gas.
            </p>
          ) : null}
          {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}
          <button
            type="button"
            className={actionButtonClass}
            disabled={busy || reviewMist == null}
            onClick={() => void submit()}
          >
            <Check className="h-4 w-4" />
            {isWithdraw ? 'Confirm Withdrawal' : 'Confirm Deposit'}
          </button>
        </>
      )}
    </Dialog>
    </>
  );
}

function ReviewRow({
  label,
  value,
  emphasize = false,
}: {
  label: string;
  value: string;
  emphasize?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2">
      <span className="text-xs text-secondary-400">{label}</span>
      <span
        className={`font-chakra text-sm text-secondary-900 dark:text-secondary-50 ${emphasize ? 'font-semibold' : ''}`}
      >
        {value}
      </span>
    </div>
  );
}
