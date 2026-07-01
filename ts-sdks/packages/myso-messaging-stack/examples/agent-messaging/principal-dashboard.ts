/**
 * Example principal dashboard — list agent-associated groups from the relayer.
 *
 *   pnpm exec tsx examples/agent-messaging/principal-dashboard.ts
 */
import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { MySoJsonRpcClient } from '@socialproof/myso/jsonRpc';
import {
	createMySoMessagingStackClientAsync,
	createPrincipalMessagingClient,
} from '@socialproof/myso-messaging-stack';

async function main() {
	const rpcUrl = process.env.MYSO_RPC_URL ?? 'http://127.0.0.1:9000';
	const humanSecret = process.env.HUMAN_SECRET_KEY;
	if (!humanSecret) {
		throw new Error('Set HUMAN_SECRET_KEY');
	}

	const humanSigner = Ed25519Keypair.fromSecretKey(humanSecret);
	const baseClient = new MySoJsonRpcClient({ url: rpcUrl, network: 'localnet' });
	const client = await createMySoMessagingStackClientAsync(baseClient, {
		mydata: { serverConfigs: [], verifyKeyServers: false },
		encryption: { sessionKey: { signer: humanSigner } },
		relayer: {
			relayerUrl: process.env.RELAYER_URL ?? 'http://127.0.0.1:3000',
		},
	});

	const principal = createPrincipalMessagingClient({
		messaging: client.messaging,
		humanSigner,
	});

	const conversations = await principal.listAgentConversations();
	console.log(JSON.stringify(conversations, null, 2));
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
