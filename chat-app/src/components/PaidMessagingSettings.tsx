import { useCallback, useEffect, useMemo, useState } from 'react';
import type { WalletMessagingPolicy } from '@socialproof/myso-messaging-stack';
import {
  createPaidMessagingClient,
  createPaidMessagingClientWithGating,
} from '@socialproof/myso-messaging-stack';

import {
  useMessagingClient,
  useMessagingClientLoading,
} from '../contexts/MessagingClientContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';
import {
  formatApproxMysoUsd,
  useMysoUsdPrice,
} from '../hooks/useMysoUsdPrice';
import { IosToggle } from './IosToggle';
import { formatPaidPolicyError } from '../lib/format-paid-policy-error';
import { mistToMyso, mysoToMist } from '../lib/mys-coin';

function parseMysoAmount(raw: string): number | null {
  try {
    const mist = mysoToMist(raw.trim() || '0');
    return Number(mist) / 1_000_000_000;
  } catch {
    return null;
  }
}

function applyPolicyToForm(
  loaded: WalletMessagingPolicy,
  setPolicy: (p: WalletMessagingPolicy) => void,
  setEnabled: (v: boolean) => void,
  setMinCost: (v: string) => void,
): void {
  setPolicy(loaded);
  setEnabled(loaded.enabled);
  if (loaded.minCost !== null) {
    setMinCost(mistToMyso(loaded.minCost));
  }
}

/** True when the form differs from the last loaded on-chain/indexed policy. */
function policyFormIsDirty(
  policy: WalletMessagingPolicy | null,
  enabled: boolean,
  minCost: string,
): boolean {
  if (!policy) return false;

  if (enabled !== policy.enabled) return true;

  // Min cost only matters while enabled (disabled saves null).
  if (!enabled) return false;

  let nextMist: bigint;
  try {
    nextMist = mysoToMist(minCost.trim() || '0');
  } catch {
    // Invalid amount is not a "legit" change we can save.
    return false;
  }

  const baseline = policy.minCost ?? 0n;
  return nextMist !== baseline;
}

export function PaidMessagingSettings() {
  const client = useMessagingClient();
  const clientLoading = useMessagingClientLoading();
  const { keypair: signer } = useMySocialAuth();
  const [policy, setPolicy] = useState<WalletMessagingPolicy | null>(null);
  const [enabled, setEnabled] = useState(false);
  /** Human-entered MySo amount; converted to MIST on save. */
  const [minCost, setMinCost] = useState('10');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const socialServerUrl = import.meta.env.VITE_SOCIAL_SERVER_URL || '';
  const { priceUsd } = useMysoUsdPrice();

  const escrowUsdLabel = useMemo(
    () => formatApproxMysoUsd(parseMysoAmount(minCost), priceUsd),
    [minCost, priceUsd],
  );

  const loadPolicy = useCallback(async () => {
    if (!client || !signer || clientLoading) return;
    setLoading(true);
    setError(null);
    try {
      const wallet = signer.toMySoAddress();
      const paid = socialServerUrl
        ? createPaidMessagingClientWithGating({
            messaging: client.messaging,
            socialServerUrl,
          })
        : createPaidMessagingClient({ messaging: client.messaging });

      if (socialServerUrl) {
        const indexed = await paid.getPolicy(wallet);
        const loaded: WalletMessagingPolicy = indexed ?? {
          wallet,
          enabled: false,
          minCost: null,
        };
        applyPolicyToForm(loaded, setPolicy, setEnabled, setMinCost);
      } else {
        const onChain = await paid.getOnChainPolicy(wallet);
        applyPolicyToForm(
          {
            wallet,
            enabled: onChain.enabled,
            minCost: onChain.minCost,
          },
          setPolicy,
          setEnabled,
          setMinCost,
        );
      }
    } catch (err) {
      setError(formatPaidPolicyError(err));
    } finally {
      setLoading(false);
    }
  }, [client, signer, clientLoading, socialServerUrl]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const isDirty = useMemo(
    () => policyFormIsDirty(policy, enabled, minCost),
    [policy, enabled, minCost],
  );

  const canSave = isDirty && !loading;

  const handleSave = async () => {
    if (!client || !signer || !isDirty) return;
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const paid = createPaidMessagingClient({ messaging: client.messaging });
      await paid.setPolicy({
        signer,
        enabled,
        minCost: enabled ? mysoToMist(minCost.trim() || '0') : null,
      });
      setSaved(true);
      await loadPolicy();
    } catch (err) {
      setError(formatPaidPolicyError(err));
    } finally {
      setLoading(false);
    }
  };

  if (!client || clientLoading) {
    return (
      <section className="px-4 py-3">
        <p className="text-sm font-medium text-secondary-800 dark:text-secondary-200">
          Paid Messaging
        </p>
        <p className="mt-0.5 text-xs text-secondary-500 dark:text-secondary-400">
          Loading…
        </p>
      </section>
    );
  }

  return (
    <section className="px-4 py-3">
      {!socialServerUrl && (
        <p className="mb-2 text-xs text-secondary-500 dark:text-secondary-400">
          Set <code className="rounded bg-secondary-100 px-1 dark:bg-secondary-700">VITE_SOCIAL_SERVER_URL</code>{' '}
          to load policy from the social indexer (recommended). Without it, policy is read via
          on-chain dev-inspect and requires browser-accessible JSON-RPC.
        </p>
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-secondary-800 dark:text-secondary-200">
            Paid Messaging
          </p>
          <p className="mt-0.5 text-xs text-secondary-500 dark:text-secondary-400">
            Require escrow before unknown users can message you
            {policy?.enabled && policy.minCost !== null
              ? ` · min ${mistToMyso(policy.minCost)} MySo`
              : ''}
          </p>
        </div>
        <IosToggle
          checked={enabled}
          onChange={(next) => {
            setEnabled(next);
            setSaved(false);
          }}
          disabled={loading}
          aria-label="Accept paid stranger DMs"
        />
      </div>
      <div className="mt-2 flex items-end gap-2">
        <div
          className={`grid min-w-0 flex-1 transition-[grid-template-rows,opacity] duration-150 ease-out ${
            enabled
              ? 'grid-rows-[1fr] opacity-100'
              : 'grid-rows-[0fr] opacity-0'
          }`}
        >
          <div className="min-h-0 overflow-hidden">
            <label className="block text-xs text-secondary-600 dark:text-secondary-300">
              <span>
                Minimum escrow{' '}
                <span className="tabular-nums text-secondary-500 dark:text-secondary-400">
                  {escrowUsdLabel}
                </span>
              </span>
              <span className="mt-1 flex items-center gap-2">
                <input
                  type="text"
                  value={minCost}
                  onChange={(e) => {
                    setMinCost(e.target.value);
                    setSaved(false);
                  }}
                  tabIndex={enabled ? 0 : -1}
                  inputMode="decimal"
                  className="w-24 rounded border border-secondary-300 px-2 py-1 text-sm dark:border-secondary-600 dark:bg-secondary-900 dark:text-secondary-100"
                />
                <span className="text-xs font-medium text-secondary-500 dark:text-secondary-400">
                  MySo
                </span>
              </span>
            </label>
          </div>
        </div>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => void handleSave()}
          className="shrink-0 rounded bg-primary-500 px-3 py-1 text-xs font-medium text-white hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loading ? 'Saving…' : 'Save policy'}
        </button>
      </div>
      {error && (
        <p className="mt-2 text-right text-xs text-danger-500 dark:text-danger-400">
          {error}
        </p>
      )}
      {saved && !isDirty && (
        <p className="mt-2 text-right text-xs text-accent-600 dark:text-accent-400">
          Policy saved on-chain.
        </p>
      )}
    </section>
  );
}
