import {describe,it,expect,vi,afterEach} from 'vitest';
import {
  ZERO_32_BASE64URL, base64url, deriveRecoveryCodeSecret, deriveZkLoginRootSecret, formatRecoveryCodeParams,
  normalizeCustodyBinding, normalizeKeyAddress, wrapRecoveryRoot, wrapRecoveryRootV2,
  type AnyRecoveryRootWrap,
} from '@socialproof/memory';
import {CustodyVault} from './custody-vault';

afterEach(()=>vi.unstubAllGlobals());

const owner=normalizeKeyAddress('0x2'),accountId=normalizeKeyAddress('0x3'),packageId=normalizeKeyAddress('0x1'),organizationId=normalizeKeyAddress('0x4');
const chain='test-chain',rootId='00000000-0000-4000-8000-000000000001';
const loginSeed=new Uint8Array(32).fill(5);
const root=new Uint8Array(32).fill(6);
const prf=new Uint8Array(32).fill(9);
type Wrap={method:string;subject:string;envelope:AnyRecoveryRootWrap};

/**
 * Fixture server: only the endpoints the vault calls, with real wrap crypto and the server's
 * method-availability rule (`custody_method_unavailable` when an account has wraps but none for
 * the requested method), which is what tells a passkey-only account from a first run.
 */
function server(initial:Wrap[]) {
  const calls:string[]=[];let wraps=[...initial];let vault:{method:string;subject:string}|null=null;let pending:string|null=null;
  vi.stubGlobal('fetch',vi.fn(async (url:string,init?:RequestInit)=>{
    const path=new URL(url).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;
    const headers=(init?.headers??{}) as Record<string,string>;
    calls.push(`${method} ${path}`);
    const ok=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
    const fail=(status:number,code:string)=>new Response(JSON.stringify({code}),{status,headers:{'Content-Type':'application/json'}});
    if(path.endsWith('/config')) return ok({agentKeyBackups:true,agentKeyCustodyTiers:['passkey-prf-v1','zklogin-root-v1','recovery-code-v1']});
    if(path.endsWith('/owner/auth/challenge')){
      const purpose=body?.purpose??'unlock-agent-backups';
      // The real server keeps the purpose with the challenge; the vault token is bound to it.
      pending=purpose;
      return ok({challenge_id:`challenge-${calls.length}`,message:`mysocial-key-backup-owner-v2|origin|test-chain|acct|owner|${purpose}|nonce|expires`,expires_in:900,purpose});
    }
    if(path.endsWith('/owner/auth/verify')){
      const purpose=pending??'unlock-agent-backups';
      if(purpose==='unlock-agent-backups') return ok({owner_token:'owner-token',expires_in:900,owner,chain:'test-chain',package_id:packageId});
      const m=purpose.replace(/^custody-unlock-/,'');
      const has=wraps.some(w=>w.method===m);
      if(!has && wraps.length) return fail(403,'custody_method_unavailable');
      vault={method:m,subject:m==='passkey-prf-v1'?'credential-a':owner};
      return ok({owner_token:'owner-token',expires_in:900,owner,chain:'test-chain',package_id:packageId,vault_token:'vault-token',vault_method:m,vault_subject:vault.subject});
    }
    if(path.endsWith('/recovery-roots')) return ok(wraps.map(w=>({method:w.method,subject:w.subject,revision:1})));
    if(path.endsWith('/recovery-root')){
      if(method==='PUT'){
        wraps=[...wraps.filter(w=>!(w.method===body.method&&w.subject===body.subject)),{method:body.method,subject:body.subject,envelope:body}];
        return ok({saved:true});
      }
      if(!headers['x-vault-token']) return fail(401,'custody_unlock_required');
      const found=wraps.find(w=>vault&&w.method===vault.method&&w.subject===vault.subject);
      return found ? ok(found.envelope) : fail(404,'backup_missing');
    }
    if(path.endsWith('/passkeys')) return ok([{id:'credential-a',active:true,prfInput:base64url(prf)}]);
    if(path.endsWith('/passkeys/authentication/options')) return ok({ceremony_id:'ceremony',rp_id:'localhost',options:{challenge:base64url(new Uint8Array(32).fill(1)),rpId:'localhost',allowCredentials:[]},credentials:[{id:'credential-a',prfInput:base64url(prf),active:true}]});
    if(path.endsWith('/passkeys/authentication/verify')){vault={method:'passkey-prf-v1',subject:'credential-a'};return ok({vault_token:'vault-token'});}
    if(path.endsWith('/agent-key-drafts')) return ok([]);
    if(path.includes('/agent-key-drafts/')) return ok({saved:true});
    throw new Error(`Unexpected fixture call ${method} ${path}`);
  }));
  return {calls,wrap:()=>wraps};
}
/** A device with a working WebAuthn PRF authenticator returning `prf`. */
function stubWebauthn() {
  const credential={
    id:'credential-a',rawId:new Uint8Array([1]).buffer,type:'public-key',
    response:{clientDataJSON:new Uint8Array([1]).buffer,authenticatorData:new Uint8Array([2]).buffer,signature:new Uint8Array([3]).buffer,userHandle:null},
    getClientExtensionResults:()=>({prf:{results:{first:prf.slice().buffer}}}),
  };
  vi.stubGlobal('isSecureContext',true);
  vi.stubGlobal('PublicKeyCredential',class{});
  vi.stubGlobal('navigator',{credentials:{get:vi.fn(async()=>credential),create:vi.fn()}});
}
function vault() {
  const instance=new CustodyVault('http://localhost',{owner,accountId},async()=>'signature',async()=>{});
  instance.setLoginSeedProvider(()=>loginSeed);
  return instance;
}
const binding=(method:'zklogin-root-v1'|'recovery-code-v1'|'passkey-prf-v1') => normalizeCustodyBinding(method,{
  chain,packageId,owner,accountId,rootId,subject:method==='passkey-prf-v1'?'credential-a':owner,revision:1,credentialId:'',rpId:'',prfInput:ZERO_32_BASE64URL,
  codeKdf:method==='recovery-code-v1'?formatRecoveryCodeParams('pbkdf2-sha256',100000):'',codeSalt:method==='recovery-code-v1'?base64url(new Uint8Array(32).fill(4)):ZERO_32_BASE64URL,
});
const loginWrap=async()=>wrapRecoveryRootV2(await deriveZkLoginRootSecret(loginSeed),root,'zklogin-root-v1',binding('zklogin-root-v1'));

describe('custody tiers',()=>{
  it('unlocks with the MySocial login by default, on a device with no WebAuthn',async()=>{
    server([{method:'zklogin-root-v1',subject:owner,envelope:await loginWrap()}]);
    const v=vault();
    await v.unlock();
    expect(v.status).toBe('ready');
    expect(v.activeMethod).toBe('zklogin-root-v1');
    const draft=await v.prepare(organizationId);
    expect(draft.envelope.rootId).toBe(rootId);
    expect([...draft.key.seed]).not.toEqual([...root]);
  });

  it('creates the login holder on a first run, with no tier choice',async()=>{
    const fixture=server([]);
    const v=vault();
    await v.unlock();
    expect(v.activeMethod).toBe('zklogin-root-v1');
    const saved=fixture.wrap();
    expect(saved).toHaveLength(1);
    expect(saved[0].method).toBe('zklogin-root-v1');
    expect(saved[0].envelope.version).toBe(2);
  });

  it('opens a passkey-only account with the passkey and then adds the login holder',async()=>{
    stubWebauthn();
    const record=await wrapRecoveryRoot(prf,root,{chain,packageId,owner,accountId,rootId,credentialId:'credential-a',rpId:'localhost',prfInput:base64url(prf),revision:1});
    const fixture=server([{method:'passkey-prf-v1',subject:'credential-a',envelope:record}]);
    const v=vault();
    await v.unlock();
    expect(v.status).toBe('ready');
    expect(v.activeMethod).toBe('passkey-prf-v1');
    // The same root, so no agent is re-encrypted, and the login is now a holder too.
    expect((await v.availableTiers()).map(t=>t.method).sort()).toEqual(['passkey-prf-v1','zklogin-root-v1']);
    expect(fixture.wrap().find(w=>w.method==='zklogin-root-v1')?.envelope.rootId).toBe(rootId);
    expect(v.loginHolderMissing).toBe(false);
  });

  it('never mints a root from a passkey: a passkey wraps the root that exists',async()=>{
    const fixture=server([]);
    const v=vault();
    // No login holder and no passkey: adding a passkey cannot create custody out of thin air.
    await expect(v.addPasskey()).rejects.toThrow('Unlock agent keys first');
    expect(fixture.wrap()).toHaveLength(0);
    await expect(v.prepare(organizationId)).rejects.toThrow('Unlock agent keys first');
  });

  it('requires the user code for the recovery-code path and accepts it when present',async()=>{
    const salt=new Uint8Array(32).fill(4);
    const secret=await deriveRecoveryCodeSecret(loginSeed,'correct horse',salt,formatRecoveryCodeParams('pbkdf2-sha256',100000));
    const wrap=await wrapRecoveryRootV2(secret,root,'recovery-code-v1',binding('recovery-code-v1'));
    const login=await loginWrap();
    server([{method:'zklogin-root-v1',subject:owner,envelope:login},{method:'recovery-code-v1',subject:owner,envelope:wrap}]);
    const v=vault();
    await expect(v.unlock({method:'recovery-code-v1'})).rejects.toThrow('recovery code');
    await expect(v.unlock({method:'recovery-code-v1',code:'wrong horse'})).rejects.toThrow();
    expect(v.status).toBe('error');
    await v.unlock({method:'recovery-code-v1',code:'correct horse'});
    expect(v.status).toBe('ready');
    expect(v.activeMethod).toBe('recovery-code-v1');
  });

  it('adopting a second path keeps the live root, so agents still decrypt',async()=>{
    server([{method:'zklogin-root-v1',subject:owner,envelope:await loginWrap()}]);
    const v=vault();
    await v.unlock();
    const draft=await v.prepare(organizationId);
    await v.adoptTier('recovery-code-v1',{code:'correct horse'});
    expect(v.status).toBe('ready');
    expect([...(await v.recoverDraft(draft.envelope)).seed]).toEqual([...draft.key.seed]);
  });

  it('refuses to remove the login holder, or the last remaining path',async()=>{
    server([{method:'zklogin-root-v1',subject:owner,envelope:await loginWrap()}]);
    const v=vault();
    await v.unlock();
    await expect(v.removeCustodyMethod('zklogin-root-v1')).rejects.toThrow('always holds');
    await expect(v.removeCustodyMethod('passkey-prf-v1')).rejects.toThrow('last one');
  });

  it('reads legacy v1 passkey wraps through the same unlock path',async()=>{
    // The passkey tier still encrypts with v1 records, so the reader must accept both shapes.
    const record=await wrapRecoveryRoot(prf,root,{chain,packageId,owner,accountId,rootId,credentialId:'credential-a',rpId:'localhost',prfInput:base64url(prf),revision:1});
    server([{method:'passkey-prf-v1',subject:'credential-a',envelope:record}]);
    const v=vault();
    const tiers=await v.availableTiers();
    expect(tiers).toEqual([{method:'passkey-prf-v1',subject:'credential-a',revision:1}]);
  });

  it('mints one owner session for repeat reads instead of one per call',async()=>{
    const fixture=server([{method:'zklogin-root-v1',subject:owner,envelope:await loginWrap()}]);
    const v=vault();
    await v.availableTiers();
    await v.listPasskeys();
    const challenges=fixture.calls.filter(c=>c.endsWith('/owner/auth/challenge')).length;
    expect(challenges).toBe(1);
  });
});
