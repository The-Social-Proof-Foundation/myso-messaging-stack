import {test,expect} from '@playwright/test';
import {keyBackupOperation} from '../../../myso-memory/services/server/scripts/key-backup';
import {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';

/**
 * No passkey anywhere: custody is set up and unlocked with the `zklogin-root-v1` tier, whose wrap
 * secret is the deterministic login key. Real envelope crypto and the real owner-signature
 * verifier; chain/storage are fixtures. This also covers the purpose-bound owner challenge, so it
 * depends on the sidecar accepting the `mysocial-key-backup-owner-v2|` message prefix.
 */
test('login-tier custody: setup, encrypted backup, and recovery with no passkey',async({page})=>{
  const account=`0x${'2'.padStart(64,'0')}`;
  const identityAddress=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1)).toMySoAddress();
  let wrap:any=null,draft:any=null,envelope:any=null,challengeMessage='';
  const payloads:string[]=[];
  process.env.MYSO_RPC_URL='http://localhost:1';
  await page.route('**/backup-test/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON()??{};
    payloads.push(request.postData()??'');
    let result:any={};
    try {
      if(path.endsWith('/config')) result={agentKeyBackups:true,agentKeyCustodyTiers:['passkey-prf-v1','zklogin-root-v1','recovery-code-v1']};
      else if(path.endsWith('/owner/auth/challenge')){
        const purpose=body.purpose??'unlock-agent-backups';
        challengeMessage=`mysocial-key-backup-owner-v2|http://localhost:5189|test-chain|${account}|${identityAddress}|${purpose}|${'a'.repeat(64)}|${Math.floor(Date.now()/1000)+300}`;
        result={challenge_id:'fixture',message:challengeMessage,expires_in:300,purpose};
      }
      else if(path.endsWith('/owner/auth/verify')){
        await keyBackupOperation('owner',{message:challengeMessage,signature:body.signature,owner:identityAddress});
        // The server mints a vault token for a custody purpose even before the first wrap exists,
        // so the client can store its first wrap.
        result={owner_token:'fixture',owner:identityAddress,chain:'test-chain',package_id:`0x${'1'.padStart(64,'0')}`,
          vault_token:'fixture-vault',vault_method:challengeMessage.includes('recovery-code')?'recovery-code-v1':'zklogin-root-v1',vault_subject:identityAddress};
      }
      else if(path.endsWith('/recovery-roots')) result=wrap?[{method:wrap.method,subject:wrap.subject,revision:1}]:[];
      else if(path.endsWith('/recovery-root')){
        if(request.method()==='PUT'){wrap=body;result={saved:true};}
        else if(wrap) result=wrap;
        else {await route.fulfill({status:404,contentType:'application/json',body:JSON.stringify({code:'backup_missing'})});return;}
      }
      else if(path.endsWith('/finalize')){envelope=body;draft=null;result={saved:true};}
      else if(path.includes('/agent-key-drafts/')){draft=body;result={saved:true};}
      else if(path.endsWith('/key-envelope')) result=envelope;
      else throw new Error(`Unexpected fixture route ${path}`);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
    }catch(e){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:e instanceof Error?e.message:'fixture_error'})});}
  });
  await page.goto('/tests/custody-login.html');
  await page.getByRole('button',{name:'Set up with my login'}).click();
  await expect(page.locator('#status')).toHaveText('ready');
  expect(wrap.method).toBe('zklogin-root-v1');
  expect(wrap.subject).toBe(identityAddress);
  expect(wrap.prfInput).toBe(Buffer.alloc(32).toString('base64url'));
  expect(wrap.codeKdf).toBe('');
  const created=await page.evaluate(()=> (window as any).createAgent());
  expect(wrap.ciphertext).toBeTruthy();expect(envelope.kind).toBe('agent');expect(draft).toBeNull();
  const joined=payloads.join('');
  expect(joined).not.toContain(created.seed);
  expect(joined).not.toContain(await page.evaluate(()=> (window as any).loginSeedHex));
  expect(joined).not.toContain('"prf"');
  // Reload: no passkey ceremony is possible here, so the tier is detected from the stored wrap.
  await page.reload();
  await page.getByRole('button',{name:'Unlock test vault'}).click();
  await expect(page.locator('#status')).toHaveText('ready');
  expect(await page.evaluate(()=> (window as any).vault.activeMethod)).toBe('zklogin-root-v1');
  expect(await page.evaluate(address=>(window as any).recoverAgent(address),created.address)).toBe(created.seed);
  await page.evaluate(()=> (window as any).vault.lock());
  await expect(page.evaluate(address=>(window as any).recoverAgent(address),created.address)).rejects.toThrow('Unlock');
});
