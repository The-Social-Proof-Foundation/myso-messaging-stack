import {useState} from 'react';

import {Dialog} from '../Dialog';
import {AgentCreateForm} from './AgentCreateForm';

interface CreateAgentDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pre-selects an organization (e.g. the one being viewed). */
  defaultOrganizationId?: string | null;
  onCreated?: (agentObjectId: string) => void;
}

/**
 * Modal form for registering a root or child agent. The fields themselves live in
 * `AgentCreateForm`, which the organization chart also renders inline when an organization has
 * no agents yet.
 */
export function CreateAgentDialog({
  open,
  onClose,
  defaultOrganizationId = null,
  onCreated,
}: Readonly<CreateAgentDialogProps>) {
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      open={open}
      title="New Agent"
      onClose={onClose}
      busy={busy}
      maxWidthClass="max-w-lg"
    >
      <AgentCreateForm
        enabled={open}
        defaultOrganizationId={defaultOrganizationId}
        onCreated={onCreated}
        onClose={onClose}
        onBusyChange={setBusy}
      />
    </Dialog>
  );
}
