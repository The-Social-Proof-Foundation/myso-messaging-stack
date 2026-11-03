// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { Signer } from '@socialproof/myso/cryptography';
import { toBase64 } from '@socialproof/myso/utils';

import type { RelayerTransport } from './transport.js';

/**
 * Maps the signer a call was made with to the signer that authenticates it to the relayer.
 *
 * Only relayer auth uses the mapped signer: request signatures, `sender_address`, and the
 * sender bound into message AAD and transfer idempotency keys. Per-message signatures,
 * MyData session keys and on-chain transactions keep the original signer.
 */
export type RelayerAuthSigner = (signer: Signer) => Signer;

/** A zkLogin account's address and a way to sign personal messages as it. */
export interface ZkLoginRelayerIdentity {
	/** The zkLogin account address the groups list as a member. */
	address: string;
	/**
	 * Serialized zkLogin signature (scheme flag `0x05`) over `bytes` as a personal message:
	 * the ephemeral key signs `bytes`, wrapped in the account's proof.
	 */
	signPersonalMessage(bytes: Uint8Array): Promise<string>;
}

/**
 * Signer that authenticates to the relayer as a zkLogin account. Everything else
 * (`getPublicKey`, `getSecretKey`, transaction signing) still comes from `ephemeral`.
 */
export function zkLoginRelayerSigner(ephemeral: Signer, identity: ZkLoginRelayerIdentity): Signer {
	const address = identity.address.toLowerCase();
	return new Proxy(ephemeral, {
		get(target, prop, receiver) {
			if (prop === 'toMySoAddress') return () => address;
			if (prop === 'signPersonalMessage') {
				return async (bytes: Uint8Array) => ({
					bytes: toBase64(bytes),
					signature: await identity.signPersonalMessage(bytes),
				});
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as Signer;
}

/** `transport` whose every call authenticates with `authSigner(params.signer)`. */
export function withRelayerAuthSigner(
	transport: RelayerTransport,
	authSigner: RelayerAuthSigner,
): RelayerTransport {
	return new Proxy(transport, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== 'function') return value;
			return (...args: unknown[]) => value.apply(target, args.map((arg) => mapSigner(arg, authSigner)));
		},
	});
}

function mapSigner(arg: unknown, authSigner: RelayerAuthSigner): unknown {
	if (!arg || typeof arg !== 'object' || Array.isArray(arg) || !('signer' in arg)) return arg;
	const signer = (arg as { signer?: Signer }).signer;
	if (!signer) return arg;
	return { ...(arg as Record<string, unknown>), signer: authSigner(signer) };
}
