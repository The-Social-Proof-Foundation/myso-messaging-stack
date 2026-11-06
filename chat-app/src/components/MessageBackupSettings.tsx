/**
 * Settings → Message backup (E2EE M8). Off by default. When on, this device's readable message
 * history is backed up encrypted under the account passkey, so a new device can get it back with
 * one passkey prompt. Turning it on also restores anything already backed up.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  disableMlsBackup,
  enableMlsBackup,
  mlsBackupStatus,
  onMlsTabState,
  type MlsBackupStatus,
} from '../lib/mls/mls-runtime';
import { IosToggle } from './IosToggle';

export function MessageBackupSettings() {
  const [status, setStatus] = useState<MlsBackupStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void mlsBackupStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refresh();
    return onMlsTabState(refresh);
  }, [refresh]);

  const turnOn = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { restored, backedUp } = await enableMlsBackup();
      setNote(
        restored > 0
          ? `Restored ${restored} message${restored === 1 ? '' : 's'} from your backup. Backup is on.`
          : `Backup is on. ${backedUp} message${backedUp === 1 ? '' : 's'} backed up.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t turn on message backup.');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const turnOff = async (deleteRemote: boolean) => {
    if (deleteRemote && !window.confirm('Delete your message backup? Messages on your devices stay.')) return;
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      await disableMlsBackup(deleteRemote);
      setNote(deleteRemote ? 'Backup deleted.' : 'Backup is off on this device.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Couldn’t change message backup.');
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const enabled = status?.enabled ?? false;
  const available = status?.available ?? false;

  return (
    <section className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-secondary-800 dark:text-secondary-200">Message backup</p>
          <p className="mt-0.5 text-sm text-secondary-500 dark:text-secondary-400">
            Keep your encrypted chats recoverable on a new device, protected by your MySocial passkey.
            Without it, a lost device’s history can’t be recovered.
          </p>
        </div>
        <IosToggle
          checked={enabled}
          disabled={busy || (!enabled && !available)}
          onChange={(v: boolean) => void (v ? turnOn() : turnOff(false))}
          aria-label="Message backup"
        />
      </div>
      {!available && !enabled && status ? (
        <p className="mt-2 text-xs text-secondary-500 dark:text-secondary-400">
          Needs a passkey-capable browser on mysocial.network.
        </p>
      ) : null}
      {enabled ? (
        <button
          type="button"
          className="mt-2 text-xs font-medium text-danger-600 hover:underline disabled:opacity-50 dark:text-danger-400"
          disabled={busy}
          onClick={() => void turnOff(true)}
        >
          Delete backup
        </button>
      ) : null}
      {note ? <p className="mt-2 text-xs text-secondary-600 dark:text-secondary-300">{note}</p> : null}
      {error ? <p className="mt-2 text-xs text-danger-600 dark:text-danger-400">{error}</p> : null}
    </section>
  );
}
