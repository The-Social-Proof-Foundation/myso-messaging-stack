import {useEffect, useMemo} from 'react';
import {useQuery} from '@tanstack/react-query';

import {
  createAgentMemoryClient,
  getAgentLlmModel,
  listLlmModels,
} from '../../lib/agents/memory-client';
import {useDerivedAgentKey} from './useDerivedAgentKey';
import {useMemoryAccount} from './useMemoryAccount';
import {useAllSubAgents} from './useSubAgents';

const sameId = (a: string, b: string) =>
  a.replace(/^0x/i, '').toLowerCase() === b.replace(/^0x/i, '').toLowerCase();

export interface AgentModelInfo {
  modelId: string;
  label: string;
  /**
   * `default` means no model was ever saved for this agent and the server default is
   * answering. Surfaced so an unsaved agent is not mistaken for a chosen one — the
   * picker used to render the default with a checkmark beside it.
   */
  source: 'saved' | 'default';
}

/**
 * The model an agent answers with. Reading it is a request signed by the agent's own key, so it
 * resolves only while agent keys are unlocked (`null` until then). The query keys match the
 * details drawer's model picker, so the card and the drawer share one fetch.
 */
export function useAgentModel(agentId: string | null): AgentModelInfo | null {
  const agents = useAllSubAgents();
  const account = useMemoryAccount();
  const accountId = account.data?.account_id ?? null;
  const row = useMemo(
    () => (agentId ? agents.items.find((item) => sameId(item.agent_object_id, agentId)) ?? null : null),
    [agents.items, agentId],
  );
  const derived = useDerivedAgentKey(row, 32);
  const memory = useMemo(
    () => (derived.data && accountId ? createAgentMemoryClient(derived.data, accountId) : null),
    [accountId, derived.data],
  );
  useEffect(() => () => memory?.destroy(), [memory]);

  const current = useQuery({
    queryKey: ['agents', 'llm-model', row?.agent_object_id],
    enabled: Boolean(memory && row),
    queryFn: () => getAgentLlmModel(memory!),
  });
  const models = useQuery({
    queryKey: ['agents', 'llm-models', row?.agent_object_id],
    enabled: Boolean(memory && row),
    queryFn: () => listLlmModels(memory!),
  });

  const modelId = current.data?.model_id;
  if (!modelId) return null;
  const label = models.data?.models.find((option) => option.id === modelId)?.display_name || modelId;
  return {modelId, label, source: current.data?.source === 'saved' ? 'saved' : 'default'};
}
