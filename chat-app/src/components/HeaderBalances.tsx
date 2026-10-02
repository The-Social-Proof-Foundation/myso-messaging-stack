import {useState} from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {ArrowDownLeft, ArrowUpRight} from 'lucide-react';

import {CreditAmountDialog, type CreditAmountMode} from './agents/CreditAmountDialog';
import {formatMistAmount} from '../lib/agents/format';
import {graphqlNumber} from '../lib/agents/profile-graphql';
import {formatApproxMysoUsd, useMysoUsdPrice} from '../hooks/useMysoUsdPrice';
import {useProfileOverview} from '../hooks/agents/useProfileOverview';
import {useMysoWalletBalance} from '../hooks/useMysoWalletBalance';

const menuItemClass =
  'font-chakra flex flex-1 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-4 py-2 text-xs font-medium tracking-wide text-secondary-800 outline-none hover:bg-secondary-50 focus:bg-secondary-50 dark:text-secondary-100 dark:hover:bg-secondary-800 dark:focus:bg-secondary-800';

function mysoNumber(amount: string): number | null {
  if (amount === '—' || amount === '') return null;
  const value = Number(amount);
  return Number.isFinite(value) ? value : null;
}

function formatCreditUsd(mysoAmount: number | null, priceUsd: number | null): string {
  return formatApproxMysoUsd(mysoAmount, priceUsd).replace(/^~/, '');
}

/** AI credit balance, shown beside Create New. */
export function HeaderBalances() {
  const wallet = useMysoWalletBalance();
  const {priceUsd} = useMysoUsdPrice();
  const overview = useProfileOverview();
  const [creditMode, setCreditMode] = useState<CreditAmountMode | null>(null);
  const credit = overview.data?.aiCreditBalance;

  const creditAmount = formatMistAmount(graphqlNumber(credit?.balanceMist));
  const creditUsd = formatCreditUsd(mysoNumber(creditAmount), priceUsd);

  return (
    <div className="hidden items-center sm:flex">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className="font-chakra flex items-baseline gap-1.5 text-sm font-medium tracking-wide text-secondary-800 dark:text-secondary-100"
            aria-label="AI credit balance"
          >
            <span>{overview.isPending ? '…' : creditUsd}</span>
            <span className="font-sans text-xs font-normal text-secondary-400">AI Credits</span>
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={8}
            className="z-50 min-w-64 overflow-hidden rounded-lg border border-secondary-200 bg-white p-1 shadow-lg dark:border-secondary-700 dark:bg-secondary-900"
          >
            <div className="flex w-full items-stretch">
              <DropdownMenu.Item className={menuItemClass} onSelect={() => setCreditMode('withdraw')}>
                <ArrowUpRight className="size-3.5" strokeWidth={2} aria-hidden />
                Withdraw
              </DropdownMenu.Item>
              <div className="my-1.5 w-px self-stretch bg-secondary-200 dark:bg-secondary-700" aria-hidden />
              <DropdownMenu.Item className={menuItemClass} onSelect={() => setCreditMode('deposit')}>
                <ArrowDownLeft className="size-3.5" strokeWidth={2} aria-hidden />
                Deposit
              </DropdownMenu.Item>
            </div>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <CreditAmountDialog
        mode={creditMode}
        onClose={() => setCreditMode(null)}
        priceUsd={priceUsd}
        walletMist={wallet.data ?? null}
        creditMist={graphqlNumber(credit?.balanceMist)}
      />
    </div>
  );
}
