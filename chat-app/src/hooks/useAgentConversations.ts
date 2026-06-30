import { useCallback, useEffect, useState } from 'react';
import {
  createPrincipalMessagingClient,
  type AgentConversation,
} from '@socialproof/myso-messaging-stack';

import {
  useMessagingClient,
  useMessagingClientLoading,
} from '../contexts/MessagingClientContext';
import { useMySocialAuth } from '../contexts/MySocialAuthContext';

export interface UseAgentConversationsResult {
  conversations: AgentConversation[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useAgentConversations(): UseAgentConversationsResult {
  const client = useMessagingClient();
  const clientLoading = useMessagingClientLoading();
  const { keypair: signer } = useMySocialAuth();
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    if (!client || !signer || clientLoading) {
      setConversations([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const principal = createPrincipalMessagingClient({
      messaging: client.messaging,
      humanSigner: signer,
    });

    void principal
      .listAgentConversations()
      .then((rows) => {
        if (!cancelled) setConversations(rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load agent conversations');
          setConversations([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [client, signer, clientLoading]);

  useEffect(() => {
    const cleanup = refresh();
    return cleanup;
  }, [refresh]);

  return { conversations, loading, error, refresh };
}
