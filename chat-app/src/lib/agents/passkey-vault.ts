import {
  AgentKeyBackupClient, KeyBackupError, base64url, fromBase64url, normalizeKeyAddress,
  randomKey, generateAgentKey, agentKeyFromSeed, encryptAgentKey, decryptAgentKey, keyHex,
  wrapRecoveryRoot, unwrapRecoveryRoot, agentRegistrationIntentHash,
  type AgentKeyEnvelopeV1, type RecoveryRootWrapV1, type AgentRegistrationIntent,
} from '@socialproof/memory';
import {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';
import type {SubAgentRow} from './social-api';

export type VaultStatus = 'locked' | 'ready' | 'busy' | 'unsupported' | 'error';
export type AgentSigningKey = {signal?:AbortSignal; platformId?:string; seed: Uint8Array; publicKey: Uint8Array; address: string; keypair: Ed25519Keypair};
type Ceremony = {ceremony_id: string; options: any; rp_id: string; credentials: {id: string; prfInput: string; active: boolean}[]};
export type PasskeySummary = {id: string; active: boolean; prfInput: string};
export type VaultIdentity = {accountId: string; owner: string};
const ZERO = `0x${'0'.repeat(64)}`;

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

/** No root or signing key is stored in query caches, localStorage, or sessionStorage. */
export class PasskeyVault {
  readonly api: AgentKeyBackupClient;
  status: VaultStatus = 'locked';
  error: string | null = null;
  private root: Uint8Array | null = null;
  private rootWrap: RecoveryRootWrapV1 | null = null;
  private keys = new Map<string, AgentSigningKey>();
  private epoch = 0;
  private controller = new AbortController();
  private listeners = new Set<() => void>();
  private snapshot = 0;
  private chain = '';
  private packageId = '';
  constructor(server: string, readonly identity: VaultIdentity, private signOwner: (message: Uint8Array) => Promise<string>, private verifyAgent: (agentId: string, envelope: AgentKeyEnvelopeV1) => Promise<{platformScope:string|null}|void>) {
    this.api = new AgentKeyBackupClient(server, normalizeKeyAddress(identity.accountId));
    this.api.signal=this.controller.signal;
    this.api.onUnauthorized=()=>this.lock();
  }
  subscribe = (fn: () => void) => {this.listeners.add(fn); return () => {this.listeners.delete(fn);};};
  getSnapshot = () => this.snapshot;
  private emit() {this.snapshot++; this.listeners.forEach(fn => fn());}
  lock() {
    this.epoch++; this.controller.abort(); this.controller = new AbortController();this.api.signal=this.controller.signal;
    this.root?.fill(0); this.root = null; this.rootWrap = null;
    this.keys.forEach(k => k.seed.fill(0)); this.keys.clear(); this.api.clear();
    this.status = 'locked'; this.error = null; this.emit();
  }
  assertCurrent(epoch: number) {if (epoch !== this.epoch) throw new Error('Agent vault was locked. Unlock it again.');}
  generation() {return this.epoch;}
  private async owner() {
    const epoch = this.epoch;
    const features = await this.api.request<{agentKeyBackups?: boolean}>('GET', '/config');
    this.assertCurrent(epoch);
    if(features.agentKeyBackups !== true) throw new Error('This Memory server has not enabled passkey-backed agent backups.');
    const c = await this.api.request<{challenge_id: string; message: string}>('POST', '/api/owner/auth/challenge', {account_id: this.api.accountId});
    this.assertCurrent(epoch);
    const signature = await this.signOwner(new TextEncoder().encode(c.message));
    this.assertCurrent(epoch);
    const verified = await this.api.request<{owner_token: string; owner: string; chain: string; package_id: string}>('POST', '/api/owner/auth/verify', {challenge_id: c.challenge_id, signature});
    this.assertCurrent(epoch);
    if (normalizeKeyAddress(verified.owner) !== normalizeKeyAddress(this.identity.owner)) throw new Error('Wallet owner mismatch');
    this.chain = verified.chain; this.packageId = verified.package_id; this.api.ownerToken = verified.owner_token;
  }
  async listPasskeys(): Promise<PasskeySummary[]> {await this.owner(); return this.api.request('GET', this.api.path('passkeys'));}
  private supported() {
    if (!globalThis.isSecureContext || !globalThis.PublicKeyCredential || !navigator.credentials) {
      this.status = 'unsupported'; throw new Error('Passkey recovery needs a supported browser on HTTPS.');
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
  private async work(fn: () => Promise<void>) {
    if(this.status==='busy') throw new Error('A passkey operation is already in progress');
    try {this.supported();} catch(e) {this.error=e instanceof Error?e.message:'Unsupported device';this.emit();throw e;}
    this.status = 'busy'; this.error = null; this.emit();
    const epoch = this.epoch;
    try {await fn(); this.assertCurrent(epoch); this.status = 'ready';}
    catch (e) {if (epoch !== this.epoch) throw e; const unsupported=(this.status as VaultStatus)==='unsupported'; this.lock(); this.error = e instanceof Error ? e.message : 'Passkey recovery failed'; this.status=unsupported?'unsupported':'error'; throw e;}
    finally {this.emit();}
  }
  async unlock(credentialId?: string) {
    return this.work(async () => {
      const epoch = this.epoch;
      await this.owner();
      const records = await this.api.request<PasskeySummary[]>('GET', this.api.path('passkeys'));
      const id = credentialId ?? records.find(c => c.active)?.id;
      if (!id) {await this.enroll(false); return;}
      const {prf, prfInput, rpId} = await this.assertion(id);
      try {
        let wrap: RecoveryRootWrapV1;
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
        if (wrap.rpId !== rpId || wrap.prfInput !== prfInput || wrap.chain !== this.chain || wrap.packageId !== this.packageId || wrap.owner !== normalizeKeyAddress(this.identity.owner) || wrap.accountId !== this.api.accountId || wrap.credentialId !== id) throw new Error('Recovery root identity mismatch');
        const root = await unwrapRecoveryRoot(prf, wrap);
        try {this.assertCurrent(epoch);} catch(e){root.fill(0); throw e;}
        this.root?.fill(0); this.root = root; this.rootWrap = wrap;
      } finally {prf.fill(0);}
    });
  }
  async addPasskey() {
    if (!this.root) throw new Error('Unlock an existing passkey first');
    return this.work(async () => {await this.owner(); await this.enroll(true);});
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
      this.root = root; this.rootWrap = wrap;
    } catch (e) {if (!additional) root.fill(0); throw e;}
    finally {prf.fill(0);}
  }
  async removePasskey(id: string) {
    if (!this.root) throw new Error('Unlock another passkey before removal');
    await this.owner(); await this.api.request('DELETE', this.api.path(`passkeys/${encodeURIComponent(id)}`));
  }
  private ready() {if (!this.root || !this.rootWrap || this.status !== 'ready') throw new Error('Unlock agent backups with your passkey first'); return this.root;}
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
    const result = {...key, signal:this.controller.signal, platformId:policy ? policy.platformScope ?? undefined : undefined, keypair: Ed25519Keypair.fromSecretKey(key.seed)};
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
