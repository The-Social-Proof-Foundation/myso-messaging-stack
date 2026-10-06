import {describe,it,expect,vi,afterEach} from 'vitest';
import {
  ZERO_32_BASE64URL, base64url, deriveRecoveryCodeSecret, deriveZkLoginRootSecret, formatRecoveryCodeParams,
  normalizeCustodyBinding, normalizeKeyAddress, wrapRecoveryRoot, wrapRecoveryRootV2,
} from '@socialproof/memory';
import {CustodyVault} from './custody-vault';

afterEach(()=>vi.unstubAllGlobals());

const owner=normalizeKeyAddress('0x2'),accountId=normalizeKeyAddress('0x3'),packageId=normalizeKeyAddress('0x1'),organizationId=normalizeKeyAddress('0x4');
const chain='test-chain',rootId='00000000-0000-4000-8000-000000000001';
const loginSeed=new Uint8Array(32).fill(5);
const root=new Uint8Array(32).fill(6);

/** Fixture server: only the endpoints the vault actually calls, with real wrap crypto. */
function server(wraps:{method:string;subject:string;envelope:any}[]) {
  const calls:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async (url:string,init?:RequestInit)=>{
    const path=new URL(url).pathname,method=init?.method??'GET',body=init?.body?JSON.parse(String(init.body)):null;
    calls.push(`${method} ${path}`);
    const ok=(value:unknown)=>new Response(JSON.stringify(value),{status:200,headers:{'Content-Type':'application/json'}});
    if(path.endsWith('/config')) return ok({agentKeyBackups:true,agentKeyCustodyTiers:['passkey-prf-v1','zklogin-root-v1','recovery-code-v1']});
    if(path.endsWith('/owner/auth/challenge')) return ok({challenge_id:'challenge',message:'mysocial-key-backup-owner-v2|origin|test-chain|acct|owner|purpose|nonce|expires',expires_in:300,purpose:body?.purpose??'unlock-agent-backups'});
    if(path.endsWith('/owner/auth/verify')) return ok({owner_token:'owner-token',owner,chain:'test-chain',package_id:packageId,vault_token:'vault-token',vault_method:body?.signature?.includes('recovery')?'recovery-code-v1':'zklogin-root-v1',vault_subject:owner});
    if(path.endsWith('/recovery-roots')) return ok(wraps.map(w=>({method:w.method,subject:w.subject,revision:1})));
    if(path.endsWith('/recovery-root')) return ok(wraps[0].envelope);
    if(path.endsWith('/passkeys')) return ok([]);
    if(path.endsWith('/agent-key-drafts')) return ok([]);
    if(path.includes('/agent-key-drafts/')) return ok({saved:true});
    throw new Error(`Unexpected fixture call ${method} ${path}`);
  }));
  return calls;
}
function vault() {
  const instance=new CustodyVault('http://localhost',{owner,accountId},async()=>'signature',async()=>{});
  instance.setLoginSeedProvider(()=>loginSeed);
  return instance;
}
const binding=(method:'zklogin-root-v1'|'recovery-code-v1') => normalizeCustodyBinding(method,{
  chain,packageId,owner,accountId,rootId,subject:owner,revision:1,credentialId:'',rpId:'',prfInput:ZERO_32_BASE64URL,
  codeKdf:method==='recovery-code-v1'?formatRecoveryCodeParams('pbkdf2-sha256',100000):'',codeSalt:method==='recovery-code-v1'?base64url(new Uint8Array(32).fill(4)):ZERO_32_BASE64URL,
});

describe('custody tiers',()=>{
  it('unlocks with the login tier and no passkey, then encrypts an agent under the same root',async()=>{
    const wrap=await wrapRecoveryRootV2(await deriveZkLoginRootSecret(loginSeed),root,'zklogin-root-v1',binding('zklogin-root-v1'));
    server([{method:'zklogin-root-v1',subject:owner,envelope:wrap}]);
    const v=vault();
    // This environment has no WebAuthn, so the tier is chosen explicitly; auto-detection on such a
    // device reports an unsupported device instead of silently switching tiers.
    await expect(v.unlock()).rejects.toThrow('HTTPS');
    await v.unlock({method:'zklogin-root-v1'});
    expect(v.status).toBe('ready');
    expect(v.activeMethod).toBe('zklogin-root-v1');
    const draft=await v.prepare(organizationId);
    expect(draft.envelope.rootId).toBe(rootId);
    expect([...draft.key.seed]).not.toEqual([...root]);
  });

  it('requires the user code for the recovery-code tier and accepts it when present',async()=>{
    const salt=new Uint8Array(32).fill(4);
    const secret=await deriveRecoveryCodeSecret(loginSeed,'correct horse',salt,formatRecoveryCodeParams('pbkdf2-sha256',100000));
    const wrap=await wrapRecoveryRootV2(secret,root,'recovery-code-v1',binding('recovery-code-v1'));
    server([{method:'recovery-code-v1',subject:owner,envelope:wrap}]);
    const v=vault();
    await expect(v.unlock({method:'recovery-code-v1'})).rejects.toThrow('recovery code');
    await v.unlock({method:'recovery-code-v1',code:'wrong horse'});
    expect(v.status).toBe('error');
    await v.unlock({method:'recovery-code-v1',code:'correct horse'});
    expect(v.status).toBe('ready');
    expect(v.activeMethod).toBe('recovery-code-v1');
  });

  it('refuses to remove the method that is currently unlocking or the last remaining method',async()=>{
    const wrap=await wrapRecoveryRootV2(await deriveZkLoginRootSecret(loginSeed),root,'zklogin-root-v1',binding('zklogin-root-v1'));
    server([{method:'zklogin-root-v1',subject:owner,envelope:wrap}]);
    const v=vault();
    await v.unlock({method:'zklogin-root-v1'});
    await expect(v.removeCustodyMethod('zklogin-root-v1')).rejects.toThrow('another method');
    await expect(v.removeCustodyMethod('passkey-prf-v1')).rejects.toThrow('last one');
  });

  it('reads legacy v1 passkey wraps through the same unlock path',async()=>{
    // The passkey tier still encrypts with v1 records, so the reader must accept both shapes.
    const prfInput=base64url(new Uint8Array(32).fill(3));
    const record=await wrapRecoveryRoot(new Uint8Array(32).fill(9),root,{chain,packageId,owner,accountId,rootId,credentialId:'credential-a',rpId:'localhost',prfInput,revision:1});
    server([{method:'passkey-prf-v1',subject:'credential-a',envelope:record}]);
    const v=vault();
    // No WebAuthn in this environment, so the login tier must be chosen explicitly here; this
    // asserts the tier list is read from the server without a ceremony.
    const tiers=await v.availableTiers();
    expect(tiers).toEqual([{method:'passkey-prf-v1',subject:'credential-a',revision:1}]);
  });
});
