import { useState } from 'react';
import { createAgentMessagingClient } from '@socialproof/myso-messaging-stack';
import type { Signer } from '@socialproof/myso/cryptography';

import { useMessagingClient } from '../contexts/MessagingClientContext';

const AGENT_DEV_ENABLED = import.meta.env.VITE_ENABLE_AGENT_DEV === 'true';

interface AgentDevSendPanelProps {
  humanSigner: Signer;
  groupUuid: string;
}

/**
 * Dev-only panel for sending a test message with agent attribution fields.
 * Requires VITE_ENABLE_AGENT_DEV=true and manual env for agent credentials.
 */
export function AgentDevSendPanel({
  humanSigner,
  groupUuid,
}: Readonly<AgentDevSendPanelProps>) {
  const client = useMessagingClient();
  const [text, setText] = useState('Hello from dev agent');
  const [status, setStatus] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (!AGENT_DEV_ENABLED) {
    return null;
  }

  const subAgentId = import.meta.env.VITE_AGENT_SUB_AGENT_ID;
  const agentSecret = import.meta.env.VITE_AGENT_SECRET_KEY;
  const platformId = import.meta.env.VITE_AGENT_PLATFORM_ID;
  const memoryAccountId = import.meta.env.VITE_AGENT_MEMORY_ACCOUNT_ID;

  if (!subAgentId || !agentSecret || !platformId || !memoryAccountId) {
    return (
      <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100">
        Agent dev panel enabled — set VITE_AGENT_SUB_AGENT_ID, VITE_AGENT_SECRET_KEY,
        VITE_AGENT_PLATFORM_ID, and VITE_AGENT_MEMORY_ACCOUNT_ID.
      </div>
    );
  }

  const handleSend = async () => {
    if (!client) return;
    setSending(true);
    setStatus(null);
    try {
      const { Ed25519Keypair } = await import('@socialproof/myso/keypairs/ed25519');
      const agentSigner = Ed25519Keypair.fromSecretKey(agentSecret);
      const agentClient = createAgentMessagingClient({
        messaging: client.messaging,
        agent: {
          agentSigner,
          subAgentId,
          principalOwner: humanSigner.toMySoAddress(),
          identityClass: 0,
          memoryAccountId,
          platformId,
        },
      });
      const result = await agentClient.sendMessage({
        groupRef: { uuid: groupUuid },
        text,
      });
      setStatus(`Sent message ${result.messageId}`);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : 'Agent send failed');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 dark:border-amber-800 dark:bg-amber-950/40">
      <p className="text-xs font-semibold text-amber-900 dark:text-amber-100">
        Agent dev send
      </p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        className="mt-2 w-full rounded border border-amber-300 bg-white px-2 py-1 text-sm dark:border-amber-700 dark:bg-secondary-900"
      />
      <button
        type="button"
        disabled={sending || !groupUuid}
        onClick={() => void handleSend()}
        className="mt-2 rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
      >
        {sending ? 'Sending…' : 'Send as agent'}
      </button>
      {status && <p className="mt-2 text-xs text-amber-900 dark:text-amber-100">{status}</p>}
    </div>
  );
}
