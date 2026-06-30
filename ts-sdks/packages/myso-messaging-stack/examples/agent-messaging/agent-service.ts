/**
 * Example agent service — create an agent group and send a message with attribution.
 *
 * Set env vars documented in README.md, then:
 *   pnpm exec tsx examples/agent-messaging/agent-service.ts
 */
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { MySoJsonRpcClient } from '@socialproof/myso/jsonRpc';
import {
  createAgentMessagingClient,
  createMySoMessagingStackClientAsync,
} from '@socialproof/myso-messaging-stack';

async function main() {
  const rpcUrl = process.env.MYSO_RPC_URL ?? 'http://127.0.0.1:9000';
  const agentSecret = process.env.AGENT_SECRET_KEY;
  const humanAddress = process.env.HUMAN_ADDRESS;
  const subAgentId = process.env.SUB_AGENT_ID;
  const memoryAccountId = process.env.MEMORY_ACCOUNT_ID;
  const platformId = process.env.PLATFORM_ID;

  if (!agentSecret || !humanAddress || !subAgentId || !memoryAccountId || !platformId) {
    throw new Error('Missing required env vars — see README.md');
  }

  const agentSigner = Ed25519Keypair.fromSecretKey(agentSecret);
  const baseClient = new MySoJsonRpcClient({ url: rpcUrl, network: 'localnet' });
  const client = await createMySoMessagingStackClientAsync(baseClient, {
    encryption: { sessionKey: { signer: agentSigner } },
    relayer: {
      relayerUrl: process.env.RELAYER_URL ?? 'http://127.0.0.1:3000',
    },
  });

  const agent = createAgentMessagingClient({
    messaging: client.messaging,
    agent: {
      agentSigner,
      subAgentId,
      principalOwner: humanAddress,
      identityClass: 0,
      memoryAccountId,
      platformId,
    },
  });

  const { groupId } = await agent.createAgentGroupAndWait({
    name: 'Example agent DM',
    initialMembers: [humanAddress],
  });

  await agent.sendMessage({
    groupRef: { groupId },
    text: 'Hello from example agent-service',
  });

  console.log('Sent agent message in group', groupId);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
