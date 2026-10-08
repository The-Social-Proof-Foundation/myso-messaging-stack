import {useEffect, useState} from 'react';
import {useAgentVault, AGENT_BACKUPS_ENABLED, findRegisteredDraft} from '../../contexts/AgentKeyVaultContext';
import type {AgentKeyEnvelopeV1, AgentKeySetup} from '@socialproof/memory';
import {Button} from '../Button';
import {useAgentActions} from '../../hooks/agents/useAgentActions';
import {CUSTODY_TIER_INFO, PRIMARY_CUSTODY, webauthnAvailable, type CustodyTier} from '../../lib/agents/custody-vault';
import type {PasskeySummary} from '../../lib/agents/passkey-vault';

type WrapSummary = {method: CustodyTier; subject: string; revision: number};

const fieldClass =
  'rounded-md border border-secondary-300 bg-white px-2 py-1 text-sm dark:border-secondary-600 dark:bg-secondary-900 dark:text-secondary-100';

/**
 * Agent key custody. The MySocial login always holds the agent keys and is never removable; a
 * passkey is an optional backup that wraps the same root, so adding one never re-encrypts an agent.
 */
export function AgentSecurityPanel() {
  const vault = useAgentVault();
  const actions = useAgentActions();
  const [setups, setSetups] = useState<AgentKeySetup[]>([]);
  const [records, setRecords] = useState<PasskeySummary[]>([]);
  const [tiers, setTiers] = useState<WrapSummary[]>([]);
  const [enabled, setEnabled] = useState<CustodyTier[]>([]);
  const [selected, setSelected] = useState('');
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
    setEnabled(await vault.enabledTiers());
  };

  useEffect(() => {
    void run(refresh);
    // Vault identity is stable for the signed-in session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vault]);

  if (!AGENT_BACKUPS_ENABLED || !vault) return null;

  const ready = vault.status === 'ready';
  const hasCustody = tiers.length > 0;
  const hasLoginHolder = tiers.some((t) => t.method === PRIMARY_CUSTODY);
  const passkeys = tiers.filter((t) => t.method === 'passkey-prf-v1');
  const passkeyEnabled = enabled.includes('passkey-prf-v1');
  const passkeySupported = passkeyEnabled && webauthnAvailable();
  const login = CUSTODY_TIER_INFO[PRIMARY_CUSTODY];
  const statusLabel = ready
    ? `Unlocked with ${vault.activeMethod ? CUSTODY_TIER_INFO[vault.activeMethod].label : 'agent keys'}`
    : hasCustody
      ? 'Locked'
      : 'Not set up yet';

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
            {statusLabel}. Your MySocial login always holds these agent keys, on any device; a
            passkey is an optional backup.
          </p>
        </div>
        {ready ? (
          <Button variant="secondary" size="sm" onClick={() => vault.lock()}>
            Lock
          </Button>
        ) : null}
      </div>

      <div className="mt-3 rounded-lg border border-secondary-200 px-3 py-2 dark:border-secondary-700">
        <p className="text-xs font-medium text-secondary-800 dark:text-secondary-200">
          {login.label} — always on
        </p>
        <p className="mt-0.5 text-xs text-secondary-500 dark:text-secondary-400">{login.tradeoff}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {ready ? (
            hasLoginHolder ? (
              <span className="text-xs text-secondary-500 dark:text-secondary-400">
                Holding your agent keys.
              </span>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    await vault.adoptTier(PRIMARY_CUSTODY);
                    await refresh();
                  })
                }
              >
                Add my MySocial login
              </Button>
            )
          ) : (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await vault.unlock();
                  await refresh();
                })
              }
            >
              {hasCustody ? 'Unlock agent keys' : 'Set up with my MySocial login'}
            </Button>
          )}
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run(refresh)}>
            Refresh
          </Button>
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
        </div>
        {vault.loginHolderMissing ? (
          <p className="mt-1 text-xs text-secondary-500 dark:text-secondary-400">
            These agent keys were created with a passkey. Add your MySocial login so a lost passkey
            cannot strand them.
          </p>
        ) : null}
      </div>

      {passkeyEnabled || passkeys.length > 0 ? (
      <div className="mt-3 rounded-lg border border-secondary-200 px-3 py-2 dark:border-secondary-700">
        <p className="text-xs font-medium text-secondary-800 dark:text-secondary-200">
          {CUSTODY_TIER_INFO['passkey-prf-v1'].label} — optional
        </p>
        <p className="mt-0.5 text-xs text-secondary-500 dark:text-secondary-400">
          {!passkeyEnabled
            ? 'This Memory server does not offer passkey custody.'
            : passkeySupported
              ? CUSTODY_TIER_INFO['passkey-prf-v1'].tradeoff
              : 'This browser cannot use passkeys. Your MySocial login works everywhere.'}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {ready ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={busy || !passkeySupported}
              onClick={() =>
                void run(async () => {
                  await vault.addPasskey();
                  await refresh();
                })
              }
            >
              Add passkey
            </Button>
          ) : null}
        </div>
        {passkeys.length > 0 ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
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
            {ready ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy || !selected}
                onClick={() =>
                  void run(async () => {
                    await vault.removePasskey(selected);
                    setSelected('');
                    await refresh();
                  })
                }
              >
                Remove selected
              </Button>
            ) : (
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
            )}
          </div>
        ) : null}
      </div>
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
        Every unlock path opens the same agent keys, so adding one never re-encrypts an agent.{' '}
        {hasLoginHolder
          ? 'Your MySocial login is the one you can always recover.'
          : 'Add your MySocial login as the holder you can always recover.'}
      </p>
    </section>
  );
}

/** Compatibility alias; the panel is now custody-tier based. */
export const PasskeyVaultPanel = AgentSecurityPanel;
