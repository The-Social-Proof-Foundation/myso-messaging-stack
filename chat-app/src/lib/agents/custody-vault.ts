import {
  AgentKeyBackupClient, KeyBackupError, base64url, fromBase64url, normalizeKeyAddress,
  randomKey, generateAgentKey, agentKeyFromSeed, encryptAgentKey, decryptAgentKey, keyHex,
  wrapRecoveryRoot, unwrapRecoveryRoot, wrapRecoveryRootV2, unwrapRecoveryRootV2, isRecoveryRootWrapV2,
  normalizeCustodyBinding, deriveZkLoginRootSecret, deriveRecoveryCodeSecret, formatRecoveryCodeParams,
  agentRegistrationIntentHash, ZERO_32_BASE64URL,
  type AgentKeyEnvelopeV1, type RecoveryRootWrapV1, type AnyRecoveryRootWrap,
  type CustodyPurpose, type AgentRegistrationIntent,
} from '@socialproof/memory';
import {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';
import type {SubAgentRow} from './social-api';

const ZERO = `0x${'0'.repeat(64)}`;

export type VaultStatus = 'locked' | 'ready' | 'busy' | 'unsupported' | 'error';
export type AgentSigningKey = {signal?:AbortSignal; platformId?:string; seed: Uint8Array; publicKey: Uint8Array; address: string; keypair: Ed25519Keypair};
type Ceremony = {ceremony_id: string; options: any; rp_id: string; credentials: {id: string; prfInput: string; active: boolean}[]};
export type PasskeySummary = {id: string; active: boolean; prfInput: string};
export type VaultIdentity = {accountId: string; owner: string};

/** Custody tiers this client can unlock. `device-key-v1` is deliberately not surfaced. */
export type CustodyTier = 'passkey-prf-v1' | 'zklogin-root-v1' | 'recovery-code-v1';
export const CUSTODY_TIERS: CustodyTier[] = ['passkey-prf-v1', 'zklogin-root-v1', 'recovery-code-v1'];

export type CustodyTierInfo = {
  method: CustodyTier;
  label: string;
  /** What unlocks the root. */
  secret: string;
  needsWebauthn: boolean;
  crossDevice: boolean;
  /** Stated plainly, including what gets weaker. */
  tradeoff: string;
  /** Shown as a caution when this tier is chosen or removed. */
  caution: string;
};

/** Copy is the product contract: it must state the weaker tier honestly (plan section 3.4). */
export const CUSTODY_TIER_INFO: Record<CustodyTier, CustodyTierInfo> = {
  'passkey-prf-v1': {
    method: 'passkey-prf-v1', label: 'Passkey', secret: 'a passkey held by your device',
    needsWebauthn: true, crossDevice: true,
    tradeoff: 'Strongest option: the key that decrypts your agents never leaves your passkey, so neither MySocial nor the Memory server can reconstruct it.',
    caution: 'Losing every passkey loses these agent keys. Save a backup passkey before you lose your current one.',
  },
  'zklogin-root-v1': {
    method: 'zklogin-root-v1', label: 'Your MySocial login', secret: 'the signing key derived from your MySocial login',
    needsWebauthn: false, crossDevice: true,
    tradeoff: 'Works on any device with no passkey: your agent keys are exactly as recoverable as your wallet. MySocial\u2019s salt service stores the inputs that derive this key, so it can reconstruct it.',
    caution: 'Anyone who can sign in as you \u2014 or reach the salt service with your session \u2014 can unlock these agent keys. Add a passkey if you want custody that survives a login compromise.',
  },
  'recovery-code-v1': {
    method: 'recovery-code-v1', label: 'Login + recovery code', secret: 'your MySocial login together with a recovery code you save',
    needsWebauthn: false, crossDevice: true,
    tradeoff: 'No passkey and no salt-service-only recovery: unlocking needs both your login and your saved code.',
    caution: 'If you lose the code, the backups become unreadable. Store it somewhere separate from this device.',
  },
};

export type CustodyUnlockOptions = {method?: CustodyTier; credentialId?: string; code?: string};
export type LoginSeedProvider = () => Promise<Uint8Array> | Uint8Array;

export function webauthnAvailable(): boolean {
  return Boolean(globalThis.isSecureContext && globalThis.PublicKeyCredential && navigator.credentials);
}

/** Build a public response explicitly: PRF extension output must never leave this browser. */
export function publicCredential(c: PublicKeyCredential) {
  const common = {id: c.id, rawId: base64url(new Uint8Array(c.rawId)), type: c.type, clientExtensionResults: {}};
  if ('attestationObject' in c.response) {
    const r = c.response as AuthenticatorAttestationResponse;
    return {...common, response: {clientDataJSON: base64url(new Uint8Array(r.clientDataJSON)), attestationObject: base64url(new Uint8Array(r.attestationObject)), transports: r.getTransports()}};
  }
  const r = c.response as AuthenticatorAssertionResponse;
  return {...common, response: {clientDataJSON: base64url(new Uint8Array(r.clientDataJSON)), authenticatorData: base64url(new Uint8Array(r.authenticatorData)), signature: base64url(new Uint8Array(r.signature)), userHandle: r.userHandle ? base64url(new Uint8Array(r.userHandle)) : null}};
}
function options(o: any, registration: boolean): any {
  const value = {...o, challenge: fromBase64url(o.challenge)};
  if (registration) {
    value.user = {...o.user, id: fromBase64url(o.user.id)};
    value.excludeCredentials = (o.excludeCredentials ?? []).map((c: any) => ({...c, id: fromBase64url(c.id)}));
    value.extensions = {prf: {}};
  } else { value.allowCredentials = (o.allowCredentials ?? []).map((c: any) => ({...c, id: fromBase64url(c.id)})); }
  return value;
}

/**
 * One random per-account recovery root, stored only as independently encrypted wraps, one per
 * custody method. Any wrap unlocks the same agents, so a passkey is an optional upgrade rather
 * than a prerequisite. No root or signing key is stored in query caches, localStorage, or
 * sessionStorage; the derived login seed is supplied lazily by the app and never retained here.
 */
export class CustodyVault {
  readonly api: AgentKeyBackupClient;
  status: VaultStatus = 'locked';
  error: string | null = null;
  /** Tier the current unlock used; null while locked. */
  activeMethod: CustodyTier | null = null;
  private root: Uint8Array | null = null;
  private rootWrap: AnyRecoveryRootWrap | null = null;
  private keys = new Map<string, AgentSigningKey>();
  private epoch = 0;
  private controller = new AbortController();
  private listeners = new Set<() => void>();
  private snapshot = 0;
  private chain = '';
  private packageId = '';
  private loginSeedProvider: LoginSeedProvider | null = null;
  constructor(server: string, readonly identity: VaultIdentity, private signOwner: (message: Uint8Array) => Promise<string>, private verifyAgent: (agentId: string, envelope: AgentKeyEnvelopeV1) => Promise<{platformScope:string|null}|void>) {
    this.api = new AgentKeyBackupClient(server, normalizeKeyAddress(identity.accountId));
    this.api.signal=this.controller.signal;
    this.api.onUnauthorized=()=>this.lock();
  }
  subscribe = (fn: () => void) => {this.listeners.add(fn); return () => {this.listeners.delete(fn);};};
  getSnapshot = () => this.snapshot;
  private emit() {this.snapshot++; this.listeners.forEach(fn => fn());}
  /** The app supplies this lazily; the login seed itself is never kept on the vault. */
  setLoginSeedProvider(provider: LoginSeedProvider | null) {this.loginSeedProvider = provider;}
  lock() {
    this.epoch++; this.controller.abort(); this.controller = new AbortController();this.api.signal=this.controller.signal;
    this.root?.fill(0); this.root = null; this.rootWrap = null; this.activeMethod = null;
    this.keys.forEach(k => k.seed.fill(0)); this.keys.clear(); this.api.clear();
    this.status = 'locked'; this.error = null; this.emit();
  }
  assertCurrent(epoch: number) {if (epoch !== this.epoch) throw new Error('Agent vault was locked. Unlock it again.');}
  generation() {return this.epoch;}
  private async features() {
    const features = await this.api.request<{agentKeyBackups?: boolean; agentKeyCustodyTiers?: string[]}>('GET', '/config');
    if(features.agentKeyBackups !== true) throw new Error('This Memory server has not enabled agent key backups.');
    return features;
  }
  /** Enabled tiers advertised by the server, intersected with what this client can run. */
  async enabledTiers(): Promise<CustodyTier[]> {
    const features = await this.features();
    const advertised = features.agentKeyCustodyTiers ?? ['passkey-prf-v1'];
    return CUSTODY_TIERS.filter(method => advertised.includes(method));
  }
  /**
   * Purpose-bound owner session. The passkey purpose (the default) only proves ownership; the
   * custody purposes additionally mint a vault token bound to that method, so a login-root or
   * recovery-code unlock needs no passkey at all.
   */
  private async ownerSession(purpose: CustodyPurpose = 'unlock-agent-backups') {
    const epoch = this.epoch;
    await this.features();
    this.assertCurrent(epoch);
    const c = purpose === 'unlock-agent-backups'
      ? await this.api.request<{challenge_id: string; message: string}>('POST', '/api/owner/auth/challenge', {account_id: this.api.accountId})
      : await this.api.ownerChallenge(purpose);
    this.assertCurrent(epoch);
    const signature = await this.signOwner(new TextEncoder().encode(c.message));
    this.assertCurrent(epoch);
    const verified = await this.api.ownerVerify(c.challenge_id, signature);
    this.assertCurrent(epoch);
    if (normalizeKeyAddress(verified.owner) !== normalizeKeyAddress(this.identity.owner)) throw new Error('Wallet owner mismatch');
    this.chain = verified.chain; this.packageId = verified.package_id; this.api.ownerToken = verified.owner_token;
    if (verified.vault_token) {
      this.api.vaultToken = verified.vault_token;
      this.activeMethod = (verified.vault_method as CustodyTier | undefined) ?? this.activeMethod;
    }
    return verified;
  }
  async listPasskeys(): Promise<PasskeySummary[]> {await this.ownerSession(); return this.api.request('GET', this.api.path('passkeys'));}
  /** Public summaries of every wrap of this account's root, for the tier chooser. */
  async availableTiers(): Promise<{method: CustodyTier; subject: string; revision: number}[]> {
    await this.ownerSession();
    const wraps = await this.api.listRoots();
    return wraps.filter(w => (CUSTODY_TIERS as string[]).includes(w.method)).map(w => ({method: w.method as CustodyTier, subject: w.subject, revision: w.revision}));
  }
  private supported() {
    if (!webauthnAvailable()) {
      this.status = 'unsupported'; throw new Error('Passkeys need a supported browser on HTTPS. Choose your MySocial login or a recovery code instead.');
    }
  }
  private async assertion(id: string) {
    const epoch = this.epoch;
    const c = await this.api.request<Ceremony>('POST', this.api.path('passkeys/authentication/options'), {credential_id: id});
    this.assertCurrent(epoch);
    const record = c.credentials.find(v => v.id === id);
    if (!record) throw new Error('Passkey unavailable');
    const request = options(c.options, false);
    request.extensions = {prf: {eval: {first: fromBase64url(record.prfInput, 32)}}};
    const credential = await navigator.credentials.get({publicKey: request, signal: this.controller.signal}) as PublicKeyCredential | null;
    this.assertCurrent(epoch);
    if (!credential || credential.id !== id) throw new Error('Passkey unlock canceled');
    const extension = credential.getClientExtensionResults() as {prf?: {results?: {first?: ArrayBuffer}}};
    if (!extension.prf?.results?.first || extension.prf.results.first.byteLength !== 32) {
      this.status = 'unsupported'; throw new Error('This passkey or browser cannot unlock encrypted backups. Use a passkey with PRF support.');
    }
    const prf = new Uint8Array(extension.prf.results.first);
    try {
      const verified = await this.api.request<{vault_token: string}>('POST', this.api.path('passkeys/authentication/verify'), {ceremony_id: c.ceremony_id, response: publicCredential(credential)});
      this.assertCurrent(epoch); this.api.vaultToken = verified.vault_token;
      return {prf, rpId: c.rp_id, prfInput: record.prfInput};
    } catch (err) {prf.fill(0); throw err;}
  }
  private async work(fn: () => Promise<void>, requiresWebauthn = true) {
    if(this.status==='busy') throw new Error('A custody operation is already in progress');
    if (requiresWebauthn) { try {this.supported();} catch(e) {this.error=e instanceof Error?e.message:'Unsupported device';this.emit();throw e;} }
    this.status = 'busy'; this.error = null; this.emit();
    const epoch = this.epoch;
    try {await fn(); this.assertCurrent(epoch); this.status = 'ready';}
    catch (e) {if (epoch !== this.epoch) throw e; const unsupported=(this.status as VaultStatus)==='unsupported'; this.lock(); this.error = e instanceof Error ? e.message : 'Custody unlock failed'; this.status=unsupported?'unsupported':'error'; throw e;}
    finally {this.emit();}
  }
  /**
   * Unlock with whichever tier the account has, preferring the strongest available. `opts.method`
   * pins one; a recovery-code unlock needs `opts.code`.
   *
   * A locked vault on a device with no passkey support is reported as an unsupported device rather
   * than silently switching to a login-derived key: the login tiers are always reachable, but only
   * through an explicit choice (`unlock({method})`, `adoptTier`, or the custody panel).
   */
  async unlock(opts: CustodyUnlockOptions = {}) {
    if (!opts.method) {
      if (!webauthnAvailable()) this.supported();
      const detected = await this.detectTier(opts);
      return detected === 'passkey-prf-v1' ? this.unlockWithPasskey(opts.credentialId) : this.unlockWithLoginTier(detected, opts);
    }
    return opts.method === 'passkey-prf-v1' ? this.unlockWithPasskey(opts.credentialId) : this.unlockWithLoginTier(opts.method, opts);
  }
  private async detectTier(opts: CustodyUnlockOptions): Promise<CustodyTier> {
    const wraps = await this.availableTiers().catch(() => []);
    if (!wraps.length) throw new Error('Set up agent key custody before unlocking.');
    const has = (method: CustodyTier) => wraps.some(w => w.method === method);
    if (has('passkey-prf-v1') && webauthnAvailable()) return 'passkey-prf-v1';
    if (has('zklogin-root-v1')) return 'zklogin-root-v1';
    if (has('recovery-code-v1')) return 'recovery-code-v1';
    if (has('passkey-prf-v1')) return 'passkey-prf-v1';
    throw new Error(opts.code ? 'This account has no recovery code configured.' : 'No supported custody method is configured for this account.');
  }
  /** Reads both wrap formats: v1 (legacy passkey records) and v2 (method-tagged). */
  private assertPasskeyWrap(wrap: AnyRecoveryRootWrap, expected: {id: string; rpId: string; prfInput: string}) {
    const identityMismatch = wrap.chain !== this.chain || wrap.packageId !== this.packageId || wrap.owner !== normalizeKeyAddress(this.identity.owner)
      || wrap.accountId !== this.api.accountId || wrap.rpId !== expected.rpId || wrap.prfInput !== expected.prfInput;
    if (identityMismatch) throw new Error('Recovery root identity mismatch');
    if (isRecoveryRootWrapV2(wrap)) {
      if (wrap.method !== 'passkey-prf-v1' || wrap.subject !== expected.id || wrap.credentialId !== expected.id) throw new Error('Recovery root identity mismatch');
    } else if (wrap.credentialId !== expected.id) throw new Error('Recovery root identity mismatch');
  }
  private async unlockWithPasskey(credentialId?: string) {
    return this.work(async () => {
      const epoch = this.epoch;
      await this.ownerSession();
      const records = await this.api.request<PasskeySummary[]>('GET', this.api.path('passkeys'));
      const id = credentialId ?? records.find(c => c.active)?.id;
      if (!id) {await this.enroll(false); return;}
      const {prf, prfInput, rpId} = await this.assertion(id);
      try {
        let wrap: AnyRecoveryRootWrap;
        try {wrap = await this.api.getRoot();} catch(e) {
          if (!(e instanceof KeyBackupError) || e.status !== 404 || records.find(c=>c.id===id)?.active) throw e;
          const root=randomKey();
          try {
            wrap=await wrapRecoveryRoot(prf,root,{chain:this.chain,packageId:this.packageId,owner:normalizeKeyAddress(this.identity.owner),accountId:this.api.accountId,
              rootId:crypto.randomUUID(),credentialId:id,rpId,prfInput,revision:1});
            this.assertCurrent(epoch);await this.api.putRoot(wrap);
          } finally {root.fill(0);}
        }
        this.assertCurrent(epoch);
        this.assertPasskeyWrap(wrap, {id, rpId, prfInput});
        const root = isRecoveryRootWrapV2(wrap) ? await unwrapRecoveryRootV2(prf, wrap) : await unwrapRecoveryRoot(prf, wrap as RecoveryRootWrapV1);
        try {this.assertCurrent(epoch);} catch(e){root.fill(0); throw e;}
        this.root?.fill(0); this.root = root; this.rootWrap = wrap; this.activeMethod = 'passkey-prf-v1';
      } finally {prf.fill(0);}
    });
  }
  private async loginSeed(): Promise<Uint8Array> {
    if (!this.loginSeedProvider) throw new Error('Sign in with MySocial so the app can derive your signing key.');
    const seed = await this.loginSeedProvider();
    if (seed.length !== 32) throw new Error('The derived login key is unavailable for this session.');
    return seed;
  }
  /** The wrap secret for a non-passkey tier; the caller zero-fills it. */
  private async tierSecret(method: CustodyTier, wrap: AnyRecoveryRootWrap, opts: CustodyUnlockOptions): Promise<Uint8Array> {
    const seed = await this.loginSeed();
    if (method === 'zklogin-root-v1') return deriveZkLoginRootSecret(seed);
    if (method === 'recovery-code-v1') {
      if (!opts.code) throw new Error('Enter your recovery code to unlock agent keys.');
      if (!isRecoveryRootWrapV2(wrap)) throw new Error('This recovery code cannot unlock a legacy passkey record.');
      return deriveRecoveryCodeSecret(seed, opts.code, fromBase64url(wrap.codeSalt, 32), wrap.codeKdf);
    }
    throw new Error('Unsupported custody method');
  }
  private purposeFor(method: CustodyTier): CustodyPurpose {
    if (method === 'recovery-code-v1') return 'custody-unlock-recovery-code-v1';
    if (method === 'zklogin-root-v1') return 'custody-unlock-zklogin-root-v1';
    return 'unlock-agent-backups';
  }
  /**
   * Build and store the wrap for a non-passkey tier. A fresh root is minted only when no root is
   * loaded and none exists; otherwise the in-memory root is reused, so `rootId` never changes and
   * no agent envelope is ever re-encrypted.
   */
  private async createTierWrap(method: CustodyTier, opts: CustodyUnlockOptions, mintRoot: boolean): Promise<AnyRecoveryRootWrap> {
    const epoch = this.epoch;
    const root = mintRoot ? randomKey() : this.root!;
    const codeSalt = method === 'recovery-code-v1' ? randomKey() : null;
    try {
      const codeKdf = method === 'recovery-code-v1' ? formatRecoveryCodeParams() : '';
      const binding = normalizeCustodyBinding(method, {
        chain: this.chain, packageId: this.packageId, owner: normalizeKeyAddress(this.identity.owner), accountId: this.api.accountId,
        rootId: this.rootWrap?.rootId ?? crypto.randomUUID(), subject: normalizeKeyAddress(this.identity.owner), revision: 1,
        credentialId: '', rpId: '', prfInput: ZERO_32_BASE64URL,
        codeKdf, codeSalt: codeSalt ? base64url(codeSalt) : ZERO_32_BASE64URL,
      });
      const seed = await this.loginSeed();
      const secret = codeSalt ? await deriveRecoveryCodeSecret(seed, opts.code ?? '', codeSalt, codeKdf) : await deriveZkLoginRootSecret(seed);
      try {
        const wrap = await wrapRecoveryRootV2(secret, root, method, binding);
        const check = await unwrapRecoveryRootV2(secret, wrap);
        if (!check.every((b,i) => b===root[i])) throw new Error('Recovery verification failed'); check.fill(0);
        this.assertCurrent(epoch); await this.api.putRoot(wrap, 0); this.assertCurrent(epoch);
        this.root?.fill(0); this.root = root; this.rootWrap = wrap; this.activeMethod = method;
        return wrap;
      } finally {secret.fill(0);}
    } catch (e) {if (mintRoot) root.fill(0); throw e;}
    finally {codeSalt?.fill(0);}
  }
  /** Unlock a login-derived tier, setting it up when the account has no wrap for it yet. */
  private async unlockWithLoginTier(method: CustodyTier, opts: CustodyUnlockOptions) {
    return this.work(async () => {
      const epoch = this.epoch;
      await this.ownerSession(this.purposeFor(method));
      const existing = await this.api.getRoot().catch(e => {
        if (e instanceof KeyBackupError && e.status === 404) return null;
        throw e;
      });
      if (!existing) {
        const wraps = await this.api.listRoots();
        if (wraps.length) throw new Error('Unlock with an unlock method you already have, then add this one.');
        await this.createTierWrap(method, opts, true);
        return;
      }
      this.assertCurrent(epoch);
      if (!isRecoveryRootWrapV2(existing) || existing.method !== method || existing.subject !== normalizeKeyAddress(this.identity.owner)) throw new Error('Recovery root identity mismatch');
      const secret = await this.tierSecret(method, existing, opts);
      try {
        const root = await unwrapRecoveryRootV2(secret, existing);
        try {this.assertCurrent(epoch);} catch(e){root.fill(0); throw e;}
        this.root?.fill(0); this.root = root; this.rootWrap = existing; this.activeMethod = method;
      } finally {secret.fill(0);}
    }, false);
  }
  /**
   * Add a tier to the account's root. An already-unlocked vault authorizes the new wrap with its
   * existing vault token (the server only accepts a wrap written by an already-active method);
   * a first-time setup mints the root through a purpose-bound unlock instead.
   */
  async adoptTier(method: CustodyTier, opts: {code?: string} = {}) {
    if (method === 'passkey-prf-v1') return this.addPasskey();
    return this.work(async () => {
      if (this.root && this.api.vaultToken) {
        await this.createTierWrap(method, opts, false);
        return;
      }
      await this.ownerSession(this.purposeFor(method));
      const wraps = await this.api.listRoots().catch(() => []);
      if (wraps.length) throw new Error('Unlock agent keys first, then add this unlock method.');
      await this.createTierWrap(method, opts, true);
    }, false);
  }
  /** Passkeys are an upgrade: adding one re-wraps the same root, so no agent is re-encrypted. */
  async upgradeToPasskey() {
    if (!this.root) throw new Error('Unlock agent keys before adding a passkey');
    return this.addPasskey();
  }
  async addPasskey() {
    if (!this.root) throw new Error('Unlock agent keys before adding a passkey');
    return this.work(async () => {await this.ownerSession(); await this.enroll(true);});
  }
  private async enroll(additional: boolean) {
    const epoch = this.epoch;
    const c = await this.api.request<Ceremony>('POST', this.api.path('passkeys/registration/options'), {});
    this.assertCurrent(epoch);
    const credential = await navigator.credentials.create({publicKey: options(c.options, true), signal: this.controller.signal}) as PublicKeyCredential | null;
    this.assertCurrent(epoch);
    if (!credential) throw new Error('Passkey setup canceled');
    const saved = await this.api.request<{credential_id: string}>('POST', this.api.path('passkeys/registration/verify'), {ceremony_id: c.ceremony_id, response: publicCredential(credential)});
    this.assertCurrent(epoch);
    const {prf, prfInput, rpId} = await this.assertion(saved.credential_id);
    const root = additional ? this.root! : randomKey();
    try {
      const wrap = await wrapRecoveryRoot(prf, root, {chain: this.chain, packageId: this.packageId, owner: normalizeKeyAddress(this.identity.owner), accountId: this.api.accountId,
        rootId: additional ? this.rootWrap!.rootId : crypto.randomUUID(), credentialId: saved.credential_id, rpId, prfInput, revision: 1});
      const check = await unwrapRecoveryRoot(prf, wrap);
      if (!check.every((b,i) => b===root[i])) throw new Error('Recovery verification failed'); check.fill(0);
      this.assertCurrent(epoch); await this.api.putRoot(wrap); this.assertCurrent(epoch);
      this.root = root; this.rootWrap = wrap; this.activeMethod = 'passkey-prf-v1';
    } catch (e) {if (!additional) root.fill(0); throw e;}
    finally {prf.fill(0);}
  }
  async removePasskey(id: string) {
    if (!this.root) throw new Error('Unlock agent keys with another method before removal');
    await this.ownerSession(); await this.api.request('DELETE', this.api.path(`passkeys/${encodeURIComponent(id)}`));
  }
  /**
   * Remove an unlock path. The last remaining method is never removable, and a non-passkey tier is
   * disabled through the account custody policy because the server has no wrap-delete for it.
   */
  async removeCustodyMethod(method: CustodyTier) {
    if (!this.root || !this.rootWrap) throw new Error('Unlock agent keys before removing a method');
    if (this.activeMethod === method) throw new Error('Unlock with another method before removing this one');
    const wraps = await this.availableTiers();
    if (wraps.length <= 1) throw new Error('Add another unlock method before removing your last one');
    if (method === 'passkey-prf-v1') {
      const subject = wraps.find(w => w.method === 'passkey-prf-v1')?.subject;
      if (!subject) throw new Error('No passkey is configured for this account');
      return this.removePasskey(subject);
    }
    const policy = await this.api.getCustodyPolicy();
    const allowed = policy.allowed_methods.filter(m => m !== method);
    if (!allowed.length) throw new Error('At least one custody method must stay enabled');
    return this.api.putCustodyPolicy({allowed_methods: allowed, active_method: policy.active_method === method ? null : policy.active_method});
  }
  private ready() {if (!this.root || !this.rootWrap || this.status !== 'ready') throw new Error('Unlock agent keys first'); return this.root;}
  async prepare(organizationId: string, intent?: AgentRegistrationIntent) {
    const root = this.ready(), epoch = this.epoch;
    const key = await generateAgentKey();
    const keyId = crypto.randomUUID();
    try {
      const envelope = await encryptAgentKey(root, key.seed, {chain: this.chain, packageId: this.packageId, owner: normalizeKeyAddress(this.identity.owner), accountId: this.api.accountId,
        rootId: this.rootWrap!.rootId, keyId, organizationId: normalizeKeyAddress(organizationId), agentId: ZERO, publicKey: keyHex(key.publicKey), derivedAddress: key.address, revision: 1, intentHash: intent ? agentRegistrationIntentHash(intent) : '0'.repeat(64), registrationIntent:intent??null}, 'draft');
      this.assertCurrent(epoch); await this.api.putDraft(envelope); this.assertCurrent(epoch);
      if(intent) {await this.api.setIntent(envelope.keyId,intent);this.assertCurrent(epoch);}
      const signing={...key,signal:this.controller.signal,keypair:Ed25519Keypair.fromSecretKey(key.seed)};
      this.keys.set(keyId,signing);
      return {envelope, key: signing};
    } catch (e) {key.seed.fill(0); throw e;}
  }
  async finalize(draft: AgentKeyEnvelopeV1, seed: Uint8Array, agentId: string) {
    const epoch = this.epoch;
    const envelope = await encryptAgentKey(this.ready(), seed, {...draft, agentId: normalizeKeyAddress(agentId), revision: 1}, 'agent');
    this.assertCurrent(epoch); await this.verifyAgent(agentId, envelope); this.assertCurrent(epoch);
    await this.api.finalize(envelope); this.assertCurrent(epoch); return envelope;
  }
  async getAgent(agent: SubAgentRow): Promise<AgentSigningKey> {
    const root = this.ready(), epoch = this.epoch;
    const envelope = await this.api.get(agent.agent_object_id);
    this.assertCurrent(epoch);
    if (envelope.chain !== this.chain || envelope.packageId !== this.packageId || envelope.owner !== normalizeKeyAddress(this.identity.owner) || envelope.accountId !== this.api.accountId || envelope.rootId !== this.rootWrap!.rootId
      || envelope.agentId !== normalizeKeyAddress(agent.agent_object_id) || envelope.derivedAddress !== normalizeKeyAddress(agent.derived_address) || envelope.organizationId !== normalizeKeyAddress(agent.organization_id!)) throw new Error('Agent backup identity mismatch');
    const policy = await this.verifyAgent(agent.agent_object_id, envelope); this.assertCurrent(epoch);
    const key = await decryptAgentKey(root, envelope);
    try {this.assertCurrent(epoch);} catch(e){key.seed.fill(0); throw e;}
    const result = {...key, signal:this.controller.signal, platformId:policy ? policy.platformScope ?? undefined : undefined, keypair:Ed25519Keypair.fromSecretKey(key.seed)};
    this.keys.get(agent.agent_object_id)?.seed.fill(0); this.keys.set(agent.agent_object_id, result); return result;
  }
  async verifiedIntent(draft:AgentKeyEnvelopeV1):Promise<AgentRegistrationIntent|null> {
    const epoch=this.epoch;
    const key=await this.recoverDraft(draft);key.seed.fill(0);
    const intent=await this.api.getIntent(draft.keyId);this.assertCurrent(epoch);
    if(intent && agentRegistrationIntentHash(intent)!==draft.intentHash)throw new Error('Saved registration choices were altered. No transaction was signed.');
    if(!intent && draft.intentHash!=='0'.repeat(64))throw new Error('Saved registration choices are unavailable.');
    return intent;
  }
  async verifiedSetup(agentId:string) {
    const epoch=this.epoch,root=this.ready();
    const setup=await this.api.getSetup(agentId),e=await this.api.get(agentId);
    this.assertCurrent(epoch);
    if(e.accountId!==this.api.accountId||e.owner!==normalizeKeyAddress(this.identity.owner)||e.chain!==this.chain||e.packageId!==this.packageId||e.rootId!==this.rootWrap!.rootId||e.agentId!==normalizeKeyAddress(agentId))throw new Error('Setup identity mismatch');
    await this.verifyAgent(agentId,e);this.assertCurrent(epoch);
    const key=await decryptAgentKey(root,e);key.seed.fill(0);this.assertCurrent(epoch);
    if(setup.intent && agentRegistrationIntentHash(setup.intent)!==e.intentHash)throw new Error('Saved setup choices were altered. No transaction was signed.');
    if(!setup.intent && e.intentHash!=='0'.repeat(64))throw new Error('Saved setup choices are unavailable.');
    return setup;
  }
  async pending() {this.ready(); return this.api.drafts();}
  async recoverDraft(draft: AgentKeyEnvelopeV1) {
    const epoch = this.epoch;
    if (draft.rootId !== this.rootWrap?.rootId || draft.accountId !== this.api.accountId || draft.owner !== normalizeKeyAddress(this.identity.owner) || draft.chain !== this.chain || draft.packageId !== this.packageId || draft.kind !== 'draft') throw new Error('Draft identity mismatch');
    const key = await decryptAgentKey(this.ready(), draft);
    try {this.assertCurrent(epoch);} catch(e){key.seed.fill(0); throw e;}
    const signing={...key,signal:this.controller.signal,keypair:Ed25519Keypair.fromSecretKey(key.seed)};
    this.keys.set(draft.keyId,signing);return signing;
  }
  async importLegacy(agent: SubAgentRow, seed: Uint8Array) {
    const root=this.ready(),epoch=this.epoch;
    const envelope=await encryptAgentKey(root,seed,{chain:this.chain,packageId:this.packageId,owner:normalizeKeyAddress(this.identity.owner),accountId:this.api.accountId,
      rootId:this.rootWrap!.rootId,keyId:crypto.randomUUID(),organizationId:normalizeKeyAddress(agent.organization_id!),agentId:normalizeKeyAddress(agent.agent_object_id),publicKey:keyHex((await agentKeyFromSeed(seed)).publicKey),derivedAddress:normalizeKeyAddress(agent.derived_address),revision:1});
    this.assertCurrent(epoch);await this.verifyAgent(agent.agent_object_id,envelope);this.assertCurrent(epoch);await this.api.put(envelope);this.assertCurrent(epoch);
    await this.api.setSetup(agent.agent_object_id,{vault:'complete',budget:'skipped'});
  }
}
