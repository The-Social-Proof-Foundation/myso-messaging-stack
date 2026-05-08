import { type SyntheticEvent, useState } from 'react';
import { useRequiredMessagingClient } from '../contexts/MessagingClientContext';
import { signAndExecuteTransactionAndWait } from '../lib/sign-and-wait';
import { addStoredGroup } from '../lib/group-store';

interface CreateGroupModalProps {
  open: boolean;
  onClose: () => void;
  onGroupCreated: (uuid: string) => void;
}

export function CreateGroupModal({
  open,
  onClose,
  onGroupCreated,
}: Readonly<CreateGroupModalProps>) {
  const { client, signer } = useRequiredMessagingClient();

  const [name, setName] = useState('');
  const [members, setMembers] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  async function handleSubmit(e: SyntheticEvent) {
    e.preventDefault();
    setError(null);

    const trimmedName = name.trim();
    if (!trimmedName) {
      setError('Group name is required.');
      return;
    }

    setLoading(true);

    try {
      const uuid = crypto.randomUUID();

      // Parse optional initial member addresses
      const initialMembers = members
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      // Build the transaction via the SDK's tx layer
      const tx = client.messaging.tx.createAndShareGroup({
        uuid,
        name: trimmedName,
        ...(initialMembers.length > 0 && { initialMembers }),
      });

      await signAndExecuteTransactionAndWait(client, signer, tx);

      // Derive the on-chain groupId from the UUID
      const groupId = client.messaging.derive.groupId({ uuid });

      // Persist to localStorage
      addStoredGroup({
        uuid,
        name: trimmedName,
        groupId,
        createdAt: Date.now(),
      });

      // Reset form
      setName('');
      setMembers('');
      onGroupCreated(uuid);
      onClose();
    } catch (err) {
      console.error('Failed to create group:', err);
      setError(err instanceof Error ? err.message : 'Failed to create group.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-secondary-800">
        <h2 className="mb-4 text-lg font-semibold text-secondary-900 dark:text-secondary-100">
          Create Group
        </h2>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Group name */}
          <div>
            <label
              htmlFor="group-name"
              className="mb-1 block text-sm font-medium text-secondary-700 dark:text-secondary-300"
            >
              Group Name <span className="text-danger-500">*</span>
            </label>
            <input
              id="group-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Project Alpha"
              disabled={loading}
              className="w-full rounded-lg border border-secondary-300 bg-white px-3 py-2 text-sm text-secondary-900 placeholder:text-secondary-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100 dark:placeholder:text-secondary-500"
            />
          </div>

          {/* Initial members */}
          <div>
            <label
              htmlFor="initial-members"
              className="mb-1 block text-sm font-medium text-secondary-700 dark:text-secondary-300"
            >
              Initial Members{' '}
              <span className="text-secondary-400 dark:text-secondary-500">
                (optional)
              </span>
            </label>
            <textarea
              id="initial-members"
              value={members}
              onChange={(e) => setMembers(e.target.value)}
              placeholder="Comma-separated MySo addresses&#10;0xabc..., 0xdef..."
              rows={3}
              disabled={loading}
              className="w-full rounded-lg border border-secondary-300 bg-white px-3 py-2 text-sm text-secondary-900 placeholder:text-secondary-400 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 disabled:opacity-50 dark:border-secondary-600 dark:bg-secondary-700 dark:text-secondary-100 dark:placeholder:text-secondary-500"
            />
          </div>

          {/* Error */}
          {error && (
            <p className="text-sm text-danger-500">{error}</p>
          )}

          {/* Buttons */}
          <div className="flex justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              disabled={loading}
              className="rounded-lg px-4 py-2 text-sm font-medium text-secondary-600 hover:bg-secondary-100 disabled:opacity-50 dark:text-secondary-400 dark:hover:bg-secondary-700"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600 disabled:opacity-50"
            >
              {loading ? 'Creating...' : 'Create Group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
