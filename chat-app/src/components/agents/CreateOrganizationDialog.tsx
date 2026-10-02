import {useState} from 'react';

import {useAgentActions, useMemoryAccount, useOrganizationCategories} from '../../hooks/agents';
import {Button} from '../Button';
import {Dialog, dialogFieldClass} from '../Dialog';

interface CreateOrganizationDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (organizationId: string) => void;
}

/** Modal form for creating an organization, matching the New Message dialog's chrome. */
export function CreateOrganizationDialog({
  open,
  onClose,
  onCreated,
}: Readonly<CreateOrganizationDialogProps>) {
  const account = useMemoryAccount();
  const categories = useOrganizationCategories();
  const actions = useAgentActions();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [orgType, setOrgType] = useState(9);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName('');
    setDescription('');
    setOrgType(9);
    setError(null);
  }

  function close() {
    if (busy) return;
    reset();
    onClose();
  }

  async function submit() {
    if (!account.data) {
      setError('A memory account is required. Create a MySocial profile first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const id = await actions.createOrganization({
        accountId: account.data.account_id,
        orgType,
        name: name.trim() || 'Untitled organization',
        description: description.trim(),
      });
      reset();
      onCreated(id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      title="New Organization"
      onClose={close}
      busy={busy}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !account.data}>
            {busy ? 'Creating…' : 'Create'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Name
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Acme Labs"
            disabled={busy}
            autoFocus
            className={`mt-1 ${dialogFieldClass}`}
          />
        </label>

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Description
          <textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What this organization does"
            rows={3}
            disabled={busy}
            className={`mt-1 ${dialogFieldClass}`}
          />
        </label>

        <label className="block text-sm font-medium text-secondary-700 dark:text-secondary-300">
          Category
          <select
            value={orgType}
            onChange={(event) => setOrgType(Number(event.target.value))}
            disabled={busy}
            className={`mt-1 ${dialogFieldClass}`}
          >
            {(categories.data ?? []).map((category) => (
              <option key={category.value} value={category.value}>
                {category.displayName}
              </option>
            ))}
          </select>
        </label>

        {error ? (
          <p className="rounded-lg border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700 dark:border-danger-800 dark:bg-danger-950/40 dark:text-danger-300">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
