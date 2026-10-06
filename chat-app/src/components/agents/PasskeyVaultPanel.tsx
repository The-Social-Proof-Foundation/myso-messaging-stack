import {useEffect, useState} from 'react';
import {useAgentVault, AGENT_BACKUPS_ENABLED, findRegisteredDraft} from '../../contexts/AgentKeyVaultContext';
import type {AgentKeyEnvelopeV1, AgentKeySetup} from '@socialproof/memory';
import {Button} from '../Button';
import {useAgentActions} from '../../hooks/agents/useAgentActions';
import {CUSTODY_TIER_INFO, CUSTODY_TIERS, type CustodyTier} from '../../lib/agents/custody-vault';
import type {PasskeySummary} from '../../lib/agents/passkey-vault';

type WrapSummary = {method: CustodyTier; subject: string; revision: number};

const fieldClass =
  'rounded-md border border-secondary-300 bg-white px-2 py-1 text-sm dark:border-secondary-600 dark:bg-secondary-900 dark:text-secondary-100';

/** Agent key custody: one root, unlockable through any configured tier. Passkeys are optional. */
export function AgentSecurityPanel() {
  const vault = useAgentVault();
  const actions = useAgentActions();
  const [setups, setSetups] = useState<AgentKeySetup[]>([]);
  const [records, setRecords] = useState<PasskeySummary[]>([]);
  const [tiers, setTiers] = useState<WrapSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [code, setCode] = useState('');
  const [drafts, setDrafts] = useState<AgentKeyEnvelopeV1[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Agent custody unavailable');
    } finally {
      setBusy(false);
    }
  }

  const refresh = async () => {
    if (!vault) return;
    setTiers(await vault.availableTiers());
    setRecords(await vault.listPasskeys());
  };

  useEffect(() => {
    void run(refresh);
    // Vault identity is stable for the signed-in session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  if (!AGENT_BACKUPS_ENABLED || !vault) return null;

  const configured = (method: CustodyTier) => tiers.some((t) => t.method === method);
  const locked = vault.status !== 'ready';
  const activeInfo = vault.activeMethod ? CUSTODY_TIER_INFO[vault.activeMethod] : null;
  const statusLabel =
    vault.status === 'ready'
      ? `Unlocked with ${activeInfo?.label ?? 'custody'}`
      : vault.status === 'unsupported'
        ? 'This device cannot use passkeys'
        : 'Locked';

  return (
    <section
      aria-label="Agent keys"
      className="overflow-hidden rounded-xl border border-secondary-200 bg-white px-4 py-3 dark:border-secondary-700 dark:bg-secondary-900"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-secondary-800 dark:text-secondary-200">
            Agent keys
          </p>
          <p className="mt-0.5 text-xs text-secondary-500 dark:text-secondary-400">
            {statusLabel}. Choose how to unlock them. Your MySocial login works on any
            device; a passkey never leaves this device.
          </p>
        </div>
        {vault.status === 'ready' ? (
          <Button variant="secondary" size="sm" onClick={() => vault.lock()}>
            Lock
          </Button>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {vault.status === 'ready' ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await vault.upgradeToPasskey();
                  await refresh();
                })
              }
            >
              Add passkey
            </Button>
            {configured('recovery-code-v1') ? null : (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy || !code}
                onClick={() =>
                  void run(async () => {
                    await vault.adoptTier('recovery-code-v1', {code});
                    await refresh();
                  })
                }
              >
                Add recovery code
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setDrafts(await vault.pending());
                  setSetups(await vault.api.setups());
                })
              }
            >
              Incomplete setups
            </Button>
          </>
        ) : (
          <>
            {tiers.length ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await vault.unlock({code: code || undefined});
                    await refresh();
                  })
                }
              >
                Unlock agent keys
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await vault.unlock({method: 'zklogin-root-v1'});
                  await refresh();
                })
              }
            >
              {tiers.length ? 'Unlock with login' : 'Use my MySocial login'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !code}
              onClick={() =>
                void run(async () => {
                  await vault.unlock({method: 'recovery-code-v1', code});
                  await refresh();
                })
              }
            >
              {tiers.length ? 'Unlock with code' : 'Use a recovery code'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await vault.adoptTier('passkey-prf-v1');
                  await refresh();
                })
              }
            >
              {tiers.length ? 'Add passkey' : 'Use a passkey'}
            </Button>
          </>
        )}
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(refresh)}>
          Refresh
        </Button>
      </div>

      <label className="mt-3 block text-xs text-secondary-600 dark:text-secondary-300">
        Recovery code
        <input
          aria-label="Recovery code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="Only if you use one"
          className={`${fieldClass} mt-1 block w-full max-w-xs`}
          autoComplete="off"
        />
      </label>

      {tiers.length > 0 ? (
        <ul className="mt-3 space-y-2 text-xs text-secondary-500 dark:text-secondary-400">
          {tiers.map((t) => (
            <li key={t.method} className="flex items-start justify-between gap-2">
              <span>
                <span className="font-medium text-secondary-800 dark:text-secondary-200">
                  {CUSTODY_TIER_INFO[t.method].label}
                </span>
                {' — '}
                {CUSTODY_TIER_INFO[t.method].secret}.
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || locked || tiers.length <= 1}
                onClick={() =>
                  void run(async () => {
                    await vault.removeCustodyMethod(t.method);
                    await refresh();
                  })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}

      {records.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <select
            aria-label="Passkey"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className={fieldClass}
          >
            <option value="">Choose passkey</option>
            {records.map((r, i) => (
              <option key={r.id} value={r.id}>
                Passkey {i + 1}
                {r.active ? '' : ' (setup incomplete)'}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy || !selected}
            onClick={() =>
              void run(async () => {
                await vault.unlock({method: 'passkey-prf-v1', credentialId: selected});
                await refresh();
              })
            }
          >
            Unlock with selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !selected || locked}
            onClick={() =>
              void run(async () => {
                await vault.removePasskey(selected);
                await refresh();
              })
            }
          >
            Remove selected
          </Button>
        </div>
      ) : null}

      {vault.status === 'unsupported' ? (
        <p className="mt-2 text-xs text-secondary-500 dark:text-secondary-400">
          Unlock with your MySocial login or a recovery code instead. There is no
          server recovery fallback for the passkey tier.
        </p>
      ) : null}
      {activeInfo ? (
        <p className="mt-2 text-xs text-secondary-500 dark:text-secondary-400">
          {activeInfo.tradeoff} {activeInfo.caution}
        </p>
      ) : null}
      {error || vault.error ? (
        <p role="alert" className="mt-2 text-xs text-danger-500 dark:text-danger-400">
          {error || vault.error}
        </p>
      ) : null}

      {drafts.map((d) => (
        <div key={d.keyId} className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-secondary-600 dark:text-secondary-300">
            Incomplete agent {d.derivedAddress.slice(0, 10)}…
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const id = await findRegisteredDraft(d);
                if (!id) {
                  throw new Error(
                    'Not registered yet. Open New Agent and select this saved setup to resume.',
                  );
                }
                const key = await vault.recoverDraft(d);
                try {
                  await vault.finalize(d, key.seed, id);
                } finally {
                  key.seed.fill(0);
                }
                setDrafts(await vault.pending());
                setSetups(await vault.api.setups());
              })
            }
          >
            Recover backup
          </Button>
        </div>
      ))}
      {setups.map((s) => (
        <div key={s.agentId} className="mt-3 flex items-center gap-2 text-xs">
          <span className="text-secondary-600 dark:text-secondary-300">
            Finish {s.intent?.label ?? 'registered agent'}: vault {s.state.vault}, budget{' '}
            {s.state.budget}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await actions.finishAgentSetup(s.agentId);
                setSetups(await vault.api.setups());
              })
            }
          >
            Finish setup
          </Button>
        </div>
      ))}

      <p className="mt-3 text-xs text-secondary-500 dark:text-secondary-400">
        Every unlock path opens the same agent keys, so adding one never re-encrypts an
        agent.{' '}
        {CUSTODY_TIERS.length > 2
          ? 'Keep at least two paths if you can.'
          : 'Keep at least one path you can recover.'}
      </p>
    </section>
  );
}

/** Compatibility alias; the panel is now custody-tier based. */
export const PasskeyVaultPanel = AgentSecurityPanel;
