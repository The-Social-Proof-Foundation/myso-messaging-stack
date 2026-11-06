/**
 * MLS groups only (E2EE M6): opt-in "share recent history" — members who join later receive the
 * last N days, sent over MLS by an existing member. Shared rows show as unverified to the newcomer.
 */

import { useCallback, useEffect, useState } from 'react';

import { useRequiredMessagingClient } from '../../contexts/MessagingClientContext';
import { IosToggle } from '../IosToggle';

const DEFAULT_DAYS = 7;

interface Props {
  groupId: string;
  groupUuid: string;
  /** MetadataAdmin: may change the setting. Everyone else just sees it. */
  canEdit: boolean;
}

export function HistorySharingSection({ groupId, groupUuid, canEdit }: Readonly<Props>) {
  const { client, signer } = useRequiredMessagingClient();
  const [isMls, setIsMls] = useState(false);
  const [days, setDays] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void client.messaging.view
      .groupsMetadata({ groupIds: [groupId], refresh: true })
      .then((meta) => {
        if (cancelled) return;
        const data = meta[groupId]?.data?.contents ?? [];
        setIsMls(data.find((c) => c.key === 'e2ee')?.value === 'mls1');
        setDays(Number(data.find((c) => c.key === 'e2ee_history_days')?.value ?? 0) || 0);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [client, groupId]);

  const toggle = useCallback(
    async (enabled: boolean) => {
      setSaving(true);
      setError(null);
      try {
        const next = enabled ? DEFAULT_DAYS : 0;
        await client.messaging.setHistorySharing({ signer, groupRef: { uuid: groupUuid }, days: next });
        setDays(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not update history sharing.');
      } finally {
        setSaving(false);
      }
    },
    [client, signer, groupUuid],
  );

  if (!isMls) return null;

  return (
    <section className="border-b border-secondary-100 p-4 dark:border-secondary-700">
      <h4 className="mb-3 text-xs font-semibold uppercase tracking-wide text-secondary-500 dark:text-secondary-400">
        End-to-end encryption
      </h4>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-secondary-900 dark:text-secondary-100">Share recent history</p>
          <p className="text-xs text-secondary-500 dark:text-secondary-400">
            New members see the last {DEFAULT_DAYS} days, marked as shared. Off: they only see messages
            from when they join.
          </p>
        </div>
        <IosToggle
          checked={days > 0}
          disabled={!canEdit || saving}
          onChange={(v: boolean) => void toggle(v)}
          aria-label="Share recent history with new members"
        />
      </div>
      {error ? <p className="mt-2 text-xs text-red-600">{error}</p> : null}
    </section>
  );
}
