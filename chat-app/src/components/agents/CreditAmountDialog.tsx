import {useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';

import {Button} from '../Button';
import {Dialog} from '../Dialog';
import {formatApproxMysoUsd} from '../../hooks/useMysoUsdPrice';
import {useAgentActions, useAiCreditBalance} from '../../hooks/agents';
import {formatMistAmount, parseMysoToMist} from '../../lib/agents/format';

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
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = mode != null;
  const title = mode === 'withdraw' ? 'Withdraw credits' : 'Deposit credits';
  const maxMist = mode === 'withdraw' ? creditMist : walletMist;
  const maxLabel = formatMistAmount(maxMist);
  const preview = formatApproxMysoUsd(numericAmount(amount) > 0 ? numericAmount(amount) : null, priceUsd);

  function close() {
    if (busy) return;
    setAmount('');
    setError(null);
    onClose();
  }

  function onAmountChange(raw: string) {
    const cleaned = stripCommas(raw);
    if (cleaned === '') {
      setAmount('');
      return;
    }
    if (!/^\d*\.?\d*$/.test(cleaned)) return;
    const [whole, fraction] = cleaned.split('.');
    const limited = fraction != null && fraction.length > 9 ? `${whole}.${fraction.slice(0, 9)}` : cleaned;
    setAmount(formatWithCommas(limited));
  }

  async function submit() {
    const balanceId = credit.data?.balance.balance_id;
    const mist = parseMysoToMist(stripCommas(amount));
    if (!balanceId) {
      setError('No AI credit balance yet.');
      return;
    }
    if (mist == null || mist <= 0n) {
      setError('Enter a positive MySo amount.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (mode === 'withdraw') {
        await actions.withdrawCredits({balanceId, amountMist: mist});
      } else {
        await actions.depositCredits({balanceId, amountMist: mist});
      }
      await queryClient.invalidateQueries({queryKey: ['myso-wallet-balance']});
      setAmount('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} title={title} onClose={close} busy={busy}>
      <div className="flex items-center gap-2">
        <input
          value={amount}
          onChange={(event) => onAmountChange(event.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          disabled={busy}
          aria-label="Amount"
          className="min-w-0 flex-1 bg-transparent font-chakra text-4xl text-secondary-900 outline-none placeholder:text-secondary-400 disabled:opacity-50 dark:text-secondary-50"
        />
        <button
          type="button"
          disabled={busy || maxLabel === '—'}
          onClick={() => setAmount(formatWithCommas(maxLabel))}
          className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-secondary-500 hover:text-secondary-800 disabled:opacity-50 dark:hover:text-secondary-100"
        >
          MAX
        </button>
      </div>
      <p className="mt-1 text-sm text-secondary-400">{preview}</p>

      <div className="mt-5">
        <p className="px-1 text-xs text-secondary-500">Token</p>
        <div className="mt-1 flex items-center gap-3 rounded-lg border border-secondary-200 px-3 py-2.5 dark:border-secondary-600">
          <img src="/myso-icon-green.webp" alt="" width={32} height={32} className="h-8 w-8 rounded-full" />
          <div className="min-w-0">
            <p className="text-sm text-secondary-900 dark:text-secondary-50">MySo</p>
            <p className="text-xs text-secondary-500">{maxLabel === '—' ? '—' : `${maxLabel} available`}</p>
          </div>
        </div>
      </div>

      {error ? <p className="mt-3 text-sm text-danger-500">{error}</p> : null}

      <Button className="mt-5 w-full" disabled={busy || numericAmount(amount) <= 0} onClick={() => void submit()}>
        {busy ? (mode === 'withdraw' ? 'Withdrawing…' : 'Depositing…') : 'Confirm'}
      </Button>
    </Dialog>
  );
}
