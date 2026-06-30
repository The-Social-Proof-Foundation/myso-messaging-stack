import { useCallback, useEffect, useState } from 'react';
import type { WalletMessagingPolicy } from '@socialproof/myso-messaging-stack';
import {
  createPaidMessagingClient,
} from '@socialproof/myso-messaging-stack';

import {
  useMessagingClient,
  useMessagingClientLoading,
} from '../contexts/MessagingClientContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';

export function PaidMessagingSettings() {
  const client = useMessagingClient();
  const clientLoading = useMessagingClientLoading();
  const { keypair: signer } = useMySocialAuth();
  const [policy, setPolicy] = useState<WalletMessagingPolicy | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [minCost, setMinCost] = useState('1000');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const socialServerUrl = import.meta.env.VITE_SOCIAL_SERVER_URL || '';

  const loadPolicy = useCallback(async () => {
    if (!client || !signer || clientLoading) return;
    setLoading(true);
    setError(null);
    try {
      const paid = createPaidMessagingClient({ messaging: client.messaging });
      const onChain = await paid.getOnChainPolicy(signer.toMySoAddress());
      setPolicy({
        wallet: signer.toMySoAddress(),
        enabled: onChain.enabled,
        minCost: onChain.minCost,
      });
      setEnabled(onChain.enabled);
      if (onChain.minCost !== null) {
        setMinCost(onChain.minCost.toString());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load paid policy');
    } finally {
      setLoading(false);
    }
  }, [client, signer, clientLoading]);

  useEffect(() => {
    void loadPolicy();
  }, [loadPolicy]);

  const handleSave = async () => {
    if (!client || !signer) return;
    setLoading(true);
    setError(null);
    setSaved(false);
    try {
      const paid = createPaidMessagingClient({ messaging: client.messaging });
      await paid.setPolicy({
        signer,
        enabled,
        minCost: enabled ? BigInt(minCost || '0') : null,
      });
      setSaved(true);
      await loadPolicy();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save paid policy');
    } finally {
      setLoading(false);
    }
  };

  if (!client || clientLoading) {
    return (
      <section className="border-b border-secondary-200 px-4 py-3 dark:border-secondary-700">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
          Paid messaging
        </h3>
        <p className="mt-1 text-xs text-secondary-500 dark:text-secondary-400">
          Loading…
        </p>
      </section>
    );
  }

  return (
    <section className="border-b border-secondary-200 px-4 py-3 dark:border-secondary-700">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
        Paid messaging
      </h3>
      {!socialServerUrl && (
        <p className="mt-1 text-xs text-secondary-500 dark:text-secondary-400">
          Set <code className="rounded bg-secondary-100 px-1 dark:bg-secondary-700">VITE_SOCIAL_SERVER_URL</code>{' '}
          to enable off-chain gating checks before opening paid DMs.
        </p>
      )}
      {policy && (
        <p className="mt-1 text-xs text-secondary-500 dark:text-secondary-400">
          On-chain: {policy.enabled ? `enabled (min ${policy.minCost?.toString() ?? '0'} MYSO)` : 'disabled'}
        </p>
      )}
      <label className="mt-2 flex items-center gap-2 text-sm text-secondary-700 dark:text-secondary-200">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        Accept paid stranger DMs
      </label>
      {enabled && (
        <label className="mt-2 block text-xs text-secondary-600 dark:text-secondary-300">
          Minimum escrow (MYSO)
          <input
            type="text"
            value={minCost}
            onChange={(e) => setMinCost(e.target.value)}
            className="mt-1 w-full rounded border border-secondary-300 px-2 py-1 text-sm dark:border-secondary-600 dark:bg-secondary-900"
          />
        </label>
      )}
      {error && <p className="mt-2 text-xs text-danger-500">{error}</p>}
      {saved && <p className="mt-2 text-xs text-success-600">Policy saved on-chain.</p>}
      <button
        type="button"
        disabled={loading}
        onClick={() => void handleSave()}
        className="mt-2 rounded bg-primary-500 px-3 py-1 text-xs font-medium text-white hover:bg-primary-600 disabled:opacity-50"
      >
        {loading ? 'Saving…' : 'Save policy'}
      </button>
    </section>
  );
}
