import {describe, expect, it} from 'vitest';
import {Transaction} from '@socialproof/myso/transactions';
import {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';
import type {ClientWithCoreApi} from '@socialproof/myso/client';

import {deriveAgentKeypair} from '../lib/agents/legacy-agent-keys';
import {resolveAgentChainIds} from '../lib/agents/chain-ids';
import {executeAsHuman, requireCreatedObjectId} from '../lib/agents/execute';
import {CAPABILITY_PRESETS} from '../lib/agents/capabilities';
import {
  createAgenticOrganizationTx,
  ensureAgentMemoryVaultTx,
  registerSubAgentTx,
} from '../lib/agents/tx';
import {createBaseMySoRpcClient} from '../lib/messaging-client-factory';
import {collectAllPages} from '../lib/pagination';
import {
  fetchOrganizations,
  fetchSubAgents,
  type AgenticOrganizationRow,
  type SubAgentRow,
} from '../lib/agents/social-api';

/**
 * Localnet seeder for the pagination acceptance criteria (150+ organizations and agents).
 *
 * **Inert by default.** It submits real transactions, so it only runs with `SEED_E2E=1`;
 * `pnpm test` reports the suite as skipped.
 *
 *   SEED_E2E=1 SEED_HUMAN_SECRET_KEY=<64 hex> SEED_ORGS=150 SEED_AGENTS=150 \
 *     pnpm vitest run src/dev/seed-agentic-stack.e2e.test.ts
 *
 * The wallet must already own a MemoryAccount (a social profile) and hold MYSO for gas.
 * Reads go through the same `collectAllPages` path the app uses, so a green run also proves
 * the endpoints page past the 100-row clamp.
 */

/** Reads the runner's environment without depending on Node type definitions. */
const ENV: Record<string, string | undefined> =
  (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env ?? {};

const ENABLED = ENV.SEED_E2E === '1';
const ORG_TARGET = Number(ENV.SEED_ORGS ?? '150');
const AGENT_TARGET = Number(ENV.SEED_AGENTS ?? '150');
const SOCIAL_URL = (ENV.VITE_SOCIAL_SERVER_URL ?? 'http://127.0.0.1:9126').replace(/\/+$/, '');

/** Messenger preset, because agent messaging groups need `CAP_MESSAGE_SEND`. */
const SEED_PRESET = CAPABILITY_PRESETS.find((preset) => preset.id === 'messenger')!;

function humanKeypair(): Ed25519Keypair {
  const hex = ENV.SEED_HUMAN_SECRET_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('SEED_HUMAN_SECRET_KEY must be the 32-byte hex secret of a funded wallet.');
  }
  const seed = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    seed[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return Ed25519Keypair.fromSecretKey(seed);
}

async function memoryAccountId(address: string): Promise<string> {
  const res = await fetch(`${SOCIAL_URL}/profiles/${address}/memory-account`);
  if (!res.ok) {
    throw new Error(`No indexed MemoryAccount for ${address} (HTTP ${res.status}).`);
  }
  const row = (await res.json()) as {account_id: string};
  return row.account_id;
}

function readAllOrganizations(address: string) {
  return collectAllPages<AgenticOrganizationRow>(
    (request, signal) => fetchOrganizations(address, {activeOnly: false, ...request, signal}),
    {keyOf: (row) => row.organization_id},
  );
}

function readAllSubAgents(address: string) {
  return collectAllPages<SubAgentRow>(
    (request, signal) => fetchSubAgents(address, {activeOnly: false, ...request, signal}),
    {keyOf: (row) => row.agent_object_id},
  );
}

describe.skipIf(!ENABLED)('seed agentic stack (localnet)', () => {
  it(
    'creates enough organizations and agents to exercise pagination',
    async () => {
      const human = humanKeypair();
      const address = human.toMySoAddress();
      const client = await createBaseMySoRpcClient();
      const rpc = client as unknown as ClientWithCoreApi;
      const ids = await resolveAgentChainIds();
      const accountId = await memoryAccountId(address);

      const existingOrgs = await readAllOrganizations(address);
      expect(existingOrgs.items.length).toBeGreaterThan(0);
      // One organization hosts every seeded agent; index space is per (owner, org).
      const hostOrg = existingOrgs.items[0]!;

      console.log(
        `seed: ${existingOrgs.items.length} organizations present, target ${ORG_TARGET}`,
      );
      for (let index = existingOrgs.items.length; index < ORG_TARGET; index += 1) {
        const digest = await executeAsHuman(
          rpc,
          human,
          createAgenticOrganizationTx(ids, {
            accountId,
            orgType: 9,
            name: `Seed organization ${index}`,
            description: 'Seed data for pagination verification',
          }),
        );
        const organizationId = await requireCreatedObjectId(rpc, digest, 'AgenticOrganization');
        console.log(`seed: organization ${index} -> ${organizationId}`);
      }

      const existingAgents = await readAllSubAgents(address);
      console.log(`seed: ${existingAgents.items.length} agents present, target ${AGENT_TARGET}`);
      for (let index = existingAgents.items.length; index < AGENT_TARGET; index += 1) {
        const derived = await deriveAgentKeypair(human, {
          organizationId: hostOrg.organization_id,
          index,
        });
        const digest = await executeAsHuman(
          rpc,
          human,
          registerSubAgentTx(ids, {
            accountId,
            organizationId: hostOrg.organization_id,
            publicKey: derived.publicKey,
            derivedAddress: derived.address,
            label: `Seed agent ${index}`,
            capabilities: SEED_PRESET.mask,
            delegatableCaps: SEED_PRESET.mask,
            expiresAtMs: null,
          }),
        );
        const agentObjectId = await requireCreatedObjectId(rpc, digest, 'SubAgent');
        const followUp = new Transaction();
        ensureAgentMemoryVaultTx(ids, {accountId, agentObjectId}, followUp);
        await executeAsHuman(rpc, human, followUp);
        console.log(`seed: agent ${index} -> ${agentObjectId}`);
      }

      const orgs = await readAllOrganizations(address);
      const agents = await readAllSubAgents(address);
      console.log(
        `seed: read back ${orgs.items.length} organizations (complete=${orgs.complete}, reason=${orgs.reason}) ` +
          `and ${agents.items.length} agents (complete=${agents.complete}, reason=${agents.reason})`,
      );

      expect(orgs.items.length).toBeGreaterThan(100);
      expect(new Set(orgs.items.map((o) => o.organization_id)).size).toBe(orgs.items.length);
      expect(orgs.complete).toBe(true);

      expect(agents.items.length).toBeGreaterThan(100);
      expect(new Set(agents.items.map((a) => a.agent_object_id)).size).toBe(agents.items.length);
      expect(agents.complete).toBe(true);
    },
    60 * 60 * 1000,
  );
});
