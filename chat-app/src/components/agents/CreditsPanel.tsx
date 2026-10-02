import {useState} from 'react';

import {buttonClass, cardClass, fieldClass, sectionTitleClass} from './chrome';
import {ListError, LoadMoreRow} from './ListStates';
import {MysoAmount} from './MysoAmount';
import {formatMistAmount, parseMysoToMist} from '../../lib/agents/format';
import {
  useAiCreditBalance,
  useAiCreditConfig,
  useAiCreditUsage,
  useAgentActions,
  useMemoryAccount,
} from '../../hooks/agents';

export function CreditsPanel() {
  const account = useMemoryAccount();
  const credit = useAiCreditBalance();
  const config = useAiCreditConfig();
  const usage = useAiCreditUsage(credit.data?.balance.balance_id);
  const actions = useAgentActions();
  const [amount, setAmount] = useState('1');
  const [daily, setDaily] = useState('');
  const [monthly, setMonthly] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const balance = credit.data?.balance;
  const available = credit.data?.available_mist;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className={`${cardClass} p-4`}>
        <h2 className={sectionTitleClass}>
          Memory account
        </h2>
        {account.isLoading ? (
          <p className="mt-2 text-sm text-secondary-500">Loading…</p>
        ) : account.data ? (
          <dl className="mt-3 grid gap-2 text-sm text-secondary-600 dark:text-secondary-300">
            <div>Status: {account.data.active ? 'Active' : 'Inactive'}</div>
            <div className="truncate">Account {account.data.account_id}</div>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-secondary-500">
            No memory account yet. Create a MySocial profile first — the account is created with it.
          </p>
        )}
      </section>

      <section className={`${cardClass} p-4`}>
        <h2 className={sectionTitleClass}>
          AI credits
        </h2>
        {credit.isLoading ? (
          <p className="mt-2 text-sm text-secondary-500">Loading…</p>
        ) : balance ? (
          <>
            <p className="mt-2 text-2xl font-semibold text-secondary-900 dark:text-secondary-50">
              <MysoAmount amount={formatMistAmount(available ?? balance.balance_mist)} />
            </p>
            <p className="text-xs text-secondary-500">
              Reserved <MysoAmount amount={formatMistAmount(balance.reserved_mist)} /> · Spent{' '}
              <MysoAmount amount={formatMistAmount(balance.spent_total_mist)} />
              {balance.active ? '' : ' · Paused'}
            </p>
            <p className="mt-1 text-xs text-secondary-500">
              Daily cap <MysoAmount amount={formatMistAmount(balance.daily_cap_mist)} /> · Monthly cap{' '}
              <MysoAmount amount={formatMistAmount(balance.monthly_cap_mist)} />
            </p>
            {config.data ? (
              <p className="mt-1 text-xs text-secondary-400">
                Minimum deposit <MysoAmount amount={formatMistAmount(config.data.min_deposit_mist)} />
              </p>
            ) : null}

            <div className="mt-4 flex flex-wrap items-end gap-2">
              <label className="text-xs text-secondary-500">
                Amount (MySo)
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={`${fieldClass} block w-28`}
                />
              </label>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('deposit', async () => {
                    const mist = parseMysoToMist(amount);
                    if (mist == null || mist <= 0n) throw new Error('Enter a positive MySo amount.');
                    await actions.depositCredits({balanceId: balance.balance_id, amountMist: mist});
                  })
                }
                className={buttonClass}
              >
                {busy === 'deposit' ? 'Depositing…' : 'Deposit'}
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('withdraw', async () => {
                    const mist = parseMysoToMist(amount);
                    if (mist == null || mist <= 0n) throw new Error('Enter a positive MySo amount.');
                    await actions.withdrawCredits({balanceId: balance.balance_id, amountMist: mist});
                  })
                }
                className={buttonClass}
              >
                {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw'}
              </button>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('pause', () =>
                    balance.active
                      ? actions.pauseCredits(balance.balance_id)
                      : actions.reactivateCredits(balance.balance_id),
                  )
                }
                className={buttonClass}
              >
                {balance.active
                  ? busy === 'pause'
                    ? 'Pausing…'
                    : 'Pause'
                  : busy === 'pause'
                    ? 'Reactivating…'
                    : 'Reactivate'}
              </button>
            </div>

            <div className="mt-4 flex flex-wrap items-end gap-2">
              <label className="text-xs text-secondary-500">
                Daily cap (MySo)
                <input
                  value={daily}
                  onChange={(e) => setDaily(e.target.value)}
                  placeholder="none"
                  className={`${fieldClass} block w-28`}
                />
              </label>
              <label className="text-xs text-secondary-500">
                Monthly cap (MySo)
                <input
                  value={monthly}
                  onChange={(e) => setMonthly(e.target.value)}
                  placeholder="none"
                  className={`${fieldClass} block w-28`}
                />
              </label>
              <button
                type="button"
                disabled={Boolean(busy)}
                onClick={() =>
                  void run('caps', () =>
                    actions.setAccountCaps({
                      balanceId: balance.balance_id,
                      dailyCapMist: parseMysoToMist(daily),
                      monthlyCapMist: parseMysoToMist(monthly),
                    }),
                  )
                }
                className={buttonClass}
              >
                {busy === 'caps' ? 'Saving…' : 'Save caps'}
              </button>
            </div>
          </>
        ) : (
          <p className="mt-2 text-sm text-secondary-500">
            No AI credit balance indexed yet. It appears after a profile is created on this network.
          </p>
        )}
        {error ? <p className="mt-3 text-sm text-danger-500">{error}</p> : null}
      </section>

      <section className={`${cardClass} p-4`}>
        <h2 className={sectionTitleClass}>Recent usage</h2>
        {usage.isInitialLoading ? (
          <p className="mt-2 text-sm text-secondary-500">Loading…</p>
        ) : usage.isError ? (
          <ListError error={usage.error} onRetry={usage.refetch} className="mt-2 px-0" />
        ) : usage.items.length === 0 ? (
          <p className="mt-2 text-sm text-secondary-500">No usage yet.</p>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-secondary-200 text-sm dark:divide-secondary-700">
              {usage.items.map((row) => (
                <li key={row.id} className="flex justify-between py-2">
                  <span className="truncate text-secondary-600 dark:text-secondary-300">
                    {row.model_id || row.tool_id || `kind ${row.usage_kind}`}
                  </span>
                  <span className="shrink-0 text-secondary-900 dark:text-secondary-50">
                    <MysoAmount amount={formatMistAmount(row.amount_mist)} />
                  </span>
                </li>
              ))}
            </ul>
            <LoadMoreRow list={usage} className="px-0" />
          </>
        )}
      </section>
    </div>
  );
}
