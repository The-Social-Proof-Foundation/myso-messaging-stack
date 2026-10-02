import {useCallback, useEffect, useRef, useState} from 'react';
import type {ClientWithCoreApi} from '@socialproof/myso/client';
import type {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';
import {useQueryClient} from '@tanstack/react-query';

import {isAgentChatMetadata, type AgentChatRef} from '../../lib/agents/agent-chats';
import {findAgentKeypair} from '../../lib/agents/agent-keys';
import {CAP, hasCapability} from '../../lib/agents/capabilities';
import {executeAsAgent} from '../../lib/agents/execute';
import {ensureAgentChatSendPermission} from '../../lib/agents/agent-chat-permissions';
import {
  classifyAgentChatError,
  type AgentChatErrorInfo,
} from '../../lib/agents/format-agent-chat-error';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {writeSelectedAgent} from '../../lib/agents/selected-agent-store';
import {addStoredGroup} from '../../lib/group-store';
import {waitForAgentChatReady} from '../../lib/wait-for-relayer-membership';
import {useAuthenticatedAddress, useMySocialAuth} from '../../contexts/MySocialAuthContext';
import {useMessagingClient} from '../../contexts/MessagingClientContext';
import {useAgentActions} from './useAgentActions';
import {useMemoryAccount} from './useMemoryAccount';
import {useSubAgents} from './useSubAgents';
import {useAgentChatPlatform, type AgentChatPlatformState} from './useAgentChatPlatform';

export interface HydratedAgentChat {
  groupId: string;
  uuid: string;
  name: string;
}

export type AgentChatStage = 'platform' | 'preparing' | 'signing' | 'syncing' | 'permissions';

export const AGENT_CHAT_STAGE_LABEL: Record<AgentChatStage, string> = {
  platform: 'Preparing your account…',
  preparing: 'Preparing the agent key…',
  signing: 'Waiting for the agent signature…',
  syncing: 'Syncing group membership…',
  permissions: 'Granting you message permissions…',
};

/** Guards against a double-click producing two on-chain groups for one agent. */
const inFlight = new Map<string, Promise<HydratedAgentChat>>();

/**
 * Hydrates an agent group into the local group store and returns the ids needed to open it.
 *
 * Reads the on-chain metadata for the authoritative name and adds the group to the store
 * first — selecting a group absent from the store is a no-op. It also repairs the caller's
 * send permission once per session, because `create_agent_and_share_group` grants the human
 * principal `MessagingReader` only, which would otherwise leave the chat read-only.
 */
/**
 * When an agent chat is open but the owner still lacks send permission, grant it and
 * refresh the composer. One attempt per group, so a failed grant does not loop.
 */
export function useRepairAgentChatSend(options: {
  groupId: string;
  canSend: boolean;
  permissionsLoading: boolean;
  refreshPermissions: () => void;
}) {
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const address = useAuthenticatedAddress();
  const attempted = useRef<string | null>(null);
  const {groupId, canSend, permissionsLoading, refreshPermissions} = options;

  useEffect(() => {
    if (permissionsLoading || canSend) return;
    if (!client || !keypair) return;
    if (attempted.current === groupId) return;
    attempted.current = groupId;

    const member = address ?? keypair.toMySoAddress();
    let cancelled = false;
    let finished = false;

    void (async () => {
      try {
        const rows = await client.messaging.view.groupsMetadata({
          groupIds: [groupId],
          refresh: true,
        });
        if (cancelled) return;
        const parsed = rows[groupId] as {
          data?: {contents?: {key?: string; value?: string}[]};
        } | undefined;
        const data: Record<string, string> = {};
        for (const entry of parsed?.data?.contents ?? []) {
          if (entry?.key) data[entry.key] = entry.value ?? '';
        }
        if (!isAgentChatMetadata(data)) {
          finished = true;
          return;
        }

        await ensureAgentChatSendPermission({
          client: client as never,
          signer: keypair,
          groupId,
          member,
        });
        finished = true;
        if (cancelled) return;
        refreshPermissions();
        window.setTimeout(() => {
          if (!cancelled) refreshPermissions();
        }, 800);
      } catch (error) {
        finished = true;
        console.warn('[chat-app] could not grant send permission on agent chat:', error);
      }
    })();

    return () => {
      cancelled = true;
      if (!finished) attempted.current = null;
    };
  }, [groupId, canSend, permissionsLoading, refreshPermissions, client, keypair, address]);
}

export function useOpenAgentChat() {
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const address = useAuthenticatedAddress();

  return useCallback(
    async (ref: AgentChatRef): Promise<HydratedAgentChat> => {
      if (!client) throw new Error('Messaging client is not ready yet.');
      const groupId = ref.groupId || client.messaging.derive.groupId({uuid: ref.uuid});
      let name = ref.name ?? 'Agent chat';

      try {
        const metadata = await client.messaging.view.groupsMetadata({
          groupIds: [groupId],
          refresh: true,
        });
        const row = metadata[groupId] as {name?: string} | undefined;
        if (row?.name) name = row.name;
      } catch {
        // Metadata is best-effort; the ref already carries a usable name.
      }

      addStoredGroup({uuid: ref.uuid, name, groupId, createdAt: Date.now()});

      const member = address ?? keypair?.toMySoAddress();
      if (member && keypair && client) {
        try {
          await ensureAgentChatSendPermission({
            client: client as never,
            signer: keypair,
            groupId,
            member,
          });
        } catch (error) {
          console.warn('[chat-app] could not grant send permission on agent chat:', error);
        }
      }

      return {groupId, uuid: ref.uuid, name};
    },
    [client, keypair, address],
  );
}

export interface CreateAgentChatState {
  /** Creates (or reuses) the agent's messaging group and returns it hydrated and opened. */
  createChat: (agent: SubAgentRow) => Promise<HydratedAgentChat>;
  stage: AgentChatStage | null;
  error: AgentChatErrorInfo | null;
  clearError: () => void;
  /** Adds `MESSAGE_SEND`/`MESSAGE_READ` to an agent that lacks them. */
  enableMessaging: (agent: SubAgentRow) => Promise<void>;
  isEnabling: boolean;
  enableError: AgentChatErrorInfo | null;
  canChat: (agent: SubAgentRow) => boolean;
  /** Platform resolution state, exposed only so callers can surface load failures. */
  platform: AgentChatPlatformState;
}

/**
 * Creates an agent's messaging group.
 *
 * Everything the chain requires is handled inside one user-visible action:
 *  1. the agent must be active and hold `CAP_MESSAGE_SEND`;
 *  2. the owner must be a platform member — joined automatically, never a separate step;
 *  3. the **agent** key signs (`actor_address == ctx.sender()`), with the human paying gas
 *     because derived agent addresses hold no MYSO;
 *  4. the human principal is then granted `MessagingSender` so the chat is actually writable.
 */
export function useCreateAgentChat(): CreateAgentChatState {
  const client = useMessagingClient();
  const {keypair} = useMySocialAuth();
  const address = useAuthenticatedAddress();
  const account = useMemoryAccount();
  const agents = useSubAgents(false);
  const actions = useAgentActions();
  const platform = useAgentChatPlatform();
  const openChat = useOpenAgentChat();
  const queryClient = useQueryClient();

  const [stage, setStage] = useState<AgentChatStage | null>(null);
  const [error, setError] = useState<AgentChatErrorInfo | null>(null);
  const [isEnabling, setIsEnabling] = useState(false);
  const [enableError, setEnableError] = useState<AgentChatErrorInfo | null>(null);
  const accountRef = useRef(account.data);
  accountRef.current = account.data;

  const canChat = useCallback(
    (agent: SubAgentRow) =>
      agent.active && !agent.revoked_at_ms && hasCapability(agent.capabilities, 'MESSAGE_SEND'),
    [],
  );

  const enableMessaging = useCallback(
    async (agent: SubAgentRow) => {
      const memoryAccount = accountRef.current;
      if (!memoryAccount) throw new Error('A memory account is required.');
      setIsEnabling(true);
      setEnableError(null);
      try {
        await actions.updateAgent({
          accountId: memoryAccount.account_id,
          agentObjectId: agent.agent_object_id,
          organizationId: agent.organization_id,
          capabilities: agent.capabilities | CAP.MESSAGE_SEND | CAP.MESSAGE_READ,
          label: agent.label,
        });
      } catch (err) {
        const info = classifyAgentChatError(err);
        setEnableError(info);
        throw err;
      } finally {
        setIsEnabling(false);
      }
    },
    [actions],
  );

  const runCreate = useCallback(
    async (agent: SubAgentRow): Promise<HydratedAgentChat> => {
      if (!client || !keypair) {
        throw new Error('Sign in and wait for the messaging client before starting an agent chat.');
      }
      const memoryAccount = accountRef.current;
      if (!memoryAccount) {
        throw new Error('A memory account is required. Create a MySocial profile first.');
      }
      if (agent.revoked_at_ms) {
        throw new Error('This agent was revoked and can no longer start new chats.');
      }
      if (!agent.active) {
        throw new Error('This agent is deactivated and can no longer start new chats.');
      }
      if (!canChat(agent)) {
        throw new Error('This agent is missing the messaging capability (cap_message_send).');
      }

      // Platform membership is an on-chain precondition, not a user-facing step.
      setStage('platform');
      const targetPlatform = await platform.ensureMembership();

      setStage('preparing');
      // The derivation bound must come from the all-rows count: deactivating siblings lowers
      // the active-only count and would otherwise make an agent at a high index un-derivable.
      const bound = Math.max(agents.totalCount ?? 0, 32);
      const derived = await findAgentKeypair(
        keypair as Ed25519Keypair,
        agent.derived_address,
        agent.organization_id,
        bound,
      );
      if (!derived) {
        throw new Error('Could not re-derive this agent key from the current login.');
      }

      const uuid = crypto.randomUUID();
      const name = `${agent.label.trim() || 'Agent'} chat`;
      const tx = client.messaging.tx.createAgentAndShareGroup({
        uuid,
        name,
        platformId: targetPlatform.platformId,
        creatorMemoryAccountId: memoryAccount.account_id,
        crossPrincipalPeerMemoryAccountId: memoryAccount.account_id,
        initialMembers: [],
      });

      const groupId = client.messaging.derive.groupId({uuid});

      setStage('signing');
      await executeAsAgent(
        client as ClientWithCoreApi,
        derived.keypair,
        keypair as Ed25519Keypair,
        tx,
      );

      setStage('syncing');
      const principal = address ?? keypair.toMySoAddress();
      await waitForAgentChatReady({
        client,
        signer: keypair,
        groupId,
        uuid,
        principalAddress: principal,
      });

      // Without this the owner can read the chat but not reply.
      setStage('permissions');
      try {
        await ensureAgentChatSendPermission({
          client: client as never,
          signer: keypair,
          groupId,
          member: principal,
        });
      } catch (grantError) {
        console.warn('[chat-app] agent chat created but send permission grant failed:', grantError);
      }

      const hydrated = await openChat({
        groupId,
        uuid,
        name,
        agentObjectId: agent.agent_object_id,
        creatorActor: derived.address,
        creatorPrincipal: principal,
        organizationId: agent.organization_id,
        createdAt: Date.now(),
        source: 'chain',
      });

      writeSelectedAgent({
        agentObjectId: agent.agent_object_id,
        derivedAddress: agent.derived_address,
        memoryAccountId: memoryAccount.account_id,
        label: agent.label,
        organizationId: agent.organization_id,
      });

      await queryClient.invalidateQueries({queryKey: ['agents']});
      return hydrated;
    },
    [client, keypair, address, canChat, agents.totalCount, platform, openChat, queryClient],
  );

  const createChat = useCallback(
    async (agent: SubAgentRow): Promise<HydratedAgentChat> => {
      const existing = inFlight.get(agent.agent_object_id);
      if (existing) return existing;

      setError(null);
      const task = (async () => {
        try {
          return await runCreate(agent);
        } catch (err) {
          setError(classifyAgentChatError(err));
          throw err;
        } finally {
          setStage(null);
          inFlight.delete(agent.agent_object_id);
        }
      })();

      inFlight.set(agent.agent_object_id, task);
      return task;
    },
    [runCreate],
  );

  const clearError = useCallback(() => {
    setError(null);
    setEnableError(null);
  }, []);

  return {
    createChat,
    stage,
    error,
    clearError,
    enableMessaging,
    isEnabling,
    enableError,
    canChat,
    platform,
  };
}
