/**
 * Adapter that wraps dapp-kit's signPersonalMessage into a Signer-compatible object
 * for use with the messaging SDK's relayer transport.
 *
 * Supports all MySo wallet types (Ed25519, Secp256k1, Secp256r1, zkLogin, multisig)
 * by lazily extracting the public key from the first signature when the wallet
 * doesn't expose publicKey upfront.
 */
import { Signer, parseSerializedSignature } from '@socialproof/myso/cryptography';
import type { PublicKey, SignatureScheme } from '@socialproof/myso/cryptography';
import { publicKeyFromRawBytes, publicKeyFromMySoBytes } from '@socialproof/myso/verify';
import { toBase64 } from '@socialproof/myso/utils';

export type SignPersonalMessageFn = (args: {
  message: Uint8Array;
}) => Promise<{ signature: string }>;

export class DappKitSigner extends Signer {
  readonly #address: string;
  #publicKey: PublicKey | null;
  readonly #signPersonalMessage: SignPersonalMessageFn;

  constructor(opts: {
    address: string;
    publicKeyBytes?: Uint8Array;
    signPersonalMessage: SignPersonalMessageFn;
  }) {
    super();
    this.#address = opts.address;
    this.#publicKey =
      opts.publicKeyBytes?.length
        ? publicKeyFromMySoBytes(opts.publicKeyBytes)
        : null;
    this.#signPersonalMessage = opts.signPersonalMessage;
  }

  async sign(_bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    throw new Error(
      'DappKitSigner.sign() is not supported. Use signPersonalMessage() instead.',
    );
  }

  override async signPersonalMessage(
    bytes: Uint8Array,
  ): Promise<{ bytes: string; signature: string }> {
    const { signature } = await this.#signPersonalMessage({
      message: bytes,
    });

    // Extract public key from the signature if not already known
    if (!this.#publicKey) {
      const parsed = parseSerializedSignature(signature);
      if ('publicKey' in parsed && parsed.publicKey) {
        this.#publicKey = publicKeyFromRawBytes(
          parsed.signatureScheme,
          parsed.publicKey,
        );
      }
    }

    return { bytes: toBase64(bytes), signature };
  }

  getKeyScheme(): SignatureScheme {
    if (!this.#publicKey) {
      return 'ED25519'; // default until first signature resolves it
    }
    const flag = this.#publicKey.flag();
    if (flag === 0x00) return 'ED25519';
    if (flag === 0x01) return 'Secp256k1';
    return 'Secp256r1';
  }

  getPublicKey(): PublicKey {
    if (!this.#publicKey) {
      throw new Error(
        'Public key not yet available. It will be resolved after the first signPersonalMessage call.',
      );
    }
    return this.#publicKey;
  }

  override toMySoAddress(): string {
    return this.#address;
  }
}
