import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';

const STORAGE_KEY = 'chat-app-dev-ed25519-secret-hex';

/** Local-only identity for exercising the UI when MySocial salt derivation is unavailable. */
export function getOrCreateDevMessengerKeypair(): Ed25519Keypair {
	let hex = sessionStorage.getItem(STORAGE_KEY);
	if (!hex || hex.length !== 64) {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
		sessionStorage.setItem(STORAGE_KEY, hex);
	}
	const seed = new Uint8Array(32);
	for (let i = 0; i < 32; i++) {
		seed[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return Ed25519Keypair.fromSecretKey(seed);
}
