import { Ed25519Keypair } from '@socialproof/myso/keypairs/ed25519';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearZkLoginProof,
  clearZkLoginSigner,
  createMemoryZkLoginBackend,
  forgetDecryptedZkLoginSigner,
  loadZkLoginSigner,
  saveZkLoginSigner,
  setZkLoginBackendForTests,
  zkLoginSignerAad,
  type ZkLoginRestoreRecord,
} from './persist';

const proof = {
  address: '0x3195b0dea77347027ae462a1450b2af0be1e7979dd89556ff9e71a15980ee53c',
  addressSeed: '123456789',
  maxEpoch: 40,
  proofPoints: { a: ['1', '2', '1'], b: [['1', '0'], ['3', '4'], ['1', '0']], c: ['5', '6', '1'] },
  issBase64Details: { value: 'abc', indexMod4: 1 },
  headerBase64: 'header',
  proofVersion: 3,
  sub: 'subject-a',
} satisfies ZkLoginRestoreRecord;

afterEach(() => {
  setZkLoginBackendForTests(null);
});

describe('zkLogin signer store', () => {
  it('seals the secret so the saved record does not contain it', async () => {
    const backend = createMemoryZkLoginBackend();
    setZkLoginBackendForTests(backend);
    const keypair = new Ed25519Keypair();
    const secret = keypair.getSecretKey();

    await saveZkLoginSigner(secret, proof, 'subject-a');

    const envelope = backend.snapshot().get('signer');
    expect(JSON.stringify(envelope)).not.toContain(secret);
    expect(JSON.stringify(envelope)).not.toContain(proof.addressSeed);
    expect(JSON.stringify(envelope)).not.toContain('subject-a');
  });

  it('rejects a ciphertext whose associated data was swapped', async () => {
    const backend = createMemoryZkLoginBackend();
    setZkLoginBackendForTests(backend);
    await saveZkLoginSigner('messaging-secret-value', proof, 'subject-a');
    const key = backend.snapshot().get('device-key') as CryptoKey;
    const envelope = backend.snapshot().get('signer') as { iv: number[]; cipher: number[] };

    await expect(
      crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(envelope.iv),
          additionalData: new TextEncoder().encode('wrong-record'),
        },
        key,
        new Uint8Array(envelope.cipher),
      ),
    ).rejects.toThrow();

    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(envelope.iv),
        additionalData: zkLoginSignerAad(),
      },
      key,
      new Uint8Array(envelope.cipher),
    );
    expect(new TextDecoder().decode(opened)).toContain('messaging-secret-value');
  });

  it('keeps the same messaging address after the proof is cleared and the cache is dropped', async () => {
    const backend = createMemoryZkLoginBackend();
    setZkLoginBackendForTests(backend);
    const keypair = new Ed25519Keypair();
    const secret = keypair.getSecretKey();
    await saveZkLoginSigner(secret, proof, 'subject-a');

    await clearZkLoginProof();
    forgetDecryptedZkLoginSigner();
    const loaded = await loadZkLoginSigner();

    expect(loaded?.record).toBeNull();
    expect(loaded?.sub).toBe('subject-a');
    expect(Ed25519Keypair.fromSecretKey(loaded!.secret).toMySoAddress()).toBe(keypair.toMySoAddress());
  });

  it('deletes the previous account ciphertext on account switch', async () => {
    const backend = createMemoryZkLoginBackend();
    setZkLoginBackendForTests(backend);
    const first = new Ed25519Keypair().getSecretKey();
    await saveZkLoginSigner(first, proof, 'subject-a');
    await clearZkLoginSigner();
    expect(await loadZkLoginSigner()).toBeNull();
    expect(backend.snapshot().get('signer')).toBeUndefined();

    const second = new Ed25519Keypair().getSecretKey();
    await saveZkLoginSigner(second, { ...proof, sub: 'subject-b' }, 'subject-b');
    const loaded = await loadZkLoginSigner();
    expect(loaded?.secret).toBe(second);
    expect(loaded?.sub).toBe('subject-b');
    expect(JSON.stringify(backend.snapshot().get('signer'))).not.toContain(first);
  });
});
