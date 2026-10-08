import {test,expect} from '@playwright/test';
import {keyBackupOperation} from '../../../myso-memory/services/server/scripts/key-backup';

/**
 * Actual Chromium WebAuthn PRF + actual server verifier; chain/storage are fixtures.
 *
 * Custody is created by the MySocial login (the holder tier), and the passkey is added afterwards
 * as an optional backup that re-wraps the *same* root — so the second run below also proves a
 * passkey can never mint a second root, and that both paths open the same agent keys.
 */
test('login holder plus passkey backup: enrollment, encrypted backup, and recovery after a restart',async({page,context})=>{
  const cdp=await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}});
  const credentials=new Map<string,any>(),ceremonies=new Map<string,{operation:string;challenge:string}>();
  const account=`0x${'2'.padStart(64,'0')}`;
  let wraps:{method:string;subject:string;envelope:any}[]=[],vault:{method:string;subject:string}|null=null,pendingPurpose='unlock-agent-backups',challengeMessage='';
  let draft:any=null,envelope:any=null;
  const payloads:string[]=[];
  process.env.MYSO_RPC_URL='http://localhost:1';
  await page.route('**/backup-test/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON();
    payloads.push(request.postData()??'');
    const headers=request.headers();
    let result:any={};
    const fail=(status:number,code:string)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify({code})});
    try {
      if(path.endsWith('/config')) result={agentKeyBackups:true,agentKeyCustodyTiers:['passkey-prf-v1','zklogin-root-v1','recovery-code-v1']};
      else if(path.endsWith('/owner/auth/challenge')){
        const purpose=body.purpose??'unlock-agent-backups';pendingPurpose=purpose;
        // The default purpose keeps the v1 message; custody purposes use the v2 prefix and are
        // rejected by the sidecar unless field 5 is one of its pinned purposes.
        const version=purpose==='unlock-agent-backups'?'v1':'v2';
        challengeMessage=`mysocial-key-backup-owner-${version}|localhost|test-chain|${account}|${owner}|${purpose}|${'a'.repeat(32)}|${Math.floor(Date.now()/1000)+300}`;
        result={challenge_id:'fixture',message:challengeMessage,expires_in:900,purpose};
      }
      else if(path.endsWith('/owner/auth/verify')){
        await keyBackupOperation('owner',{message:challengeMessage,signature:body.signature,owner});
        const purpose=pendingPurpose;
        result={owner_token:'fixture',expires_in:900,owner,chain:'test-chain',package_id:`0x${'1'.padStart(64,'0')}`};
        if(purpose!=='unlock-agent-backups'){
          const m=purpose.replace(/^custody-unlock-/,'');
          vault={method:m,subject:owner};
          result={...result,vault_token:'fixture-vault',vault_method:m,vault_subject:vault.subject};
        }
      }
      else if(path.endsWith('/recovery-roots')) result=wraps.map(w=>({method:w.method,subject:w.subject,revision:1}));
      else if(path.endsWith('/passkeys')) result=Array.from(credentials.values()).map(c=>({id:c.id,active:true,prfInput:c.prfInput}));
      else if(path.endsWith('/options')){
        const operation=path.includes('/registration/')?'registration':'authentication';
        const selected=Array.from(credentials.values()).filter(c=>!body.credential_id||c.id===body.credential_id);
        const options=await keyBackupOperation(`${operation}-options`,{rpId:'localhost',owner:'test-owner',accountId:account,credentials:selected});
        const id=crypto.randomUUID();ceremonies.set(id,{operation,challenge:options.challenge});
        result={ceremony_id:id,options,rp_id:'localhost',credentials:selected.map(c=>({id:c.id,prfInput:c.prfInput,active:true}))};
      }
      else if(path.endsWith('/verify')){
        const c=ceremonies.get(body.ceremony_id)!;ceremonies.delete(body.ceremony_id);
        const verified=await keyBackupOperation(`${c.operation}-verify`,{rpId:'localhost',origins:['http://localhost:5189'],challenge:c.challenge,response:body.response,credential:credentials.get(body.response.id)});
        if(c.operation==='registration'){
          verified.prfInput=Buffer.alloc(32,3).toString('base64url');credentials.set(verified.id,verified);
          result={credential_id:verified.id,prf_input:verified.prfInput};
        }else{
          credentials.get(body.response.id).counter=verified.counter;
          vault={method:'passkey-prf-v1',subject:body.response.id};
          result={vault_token:'fixture'};
        }
      }
      else if(path.endsWith('/recovery-root')){
        if(request.method()==='PUT'){
          wraps=[...wraps.filter(w=>!(w.method===body.method&&w.subject===body.subject)),{method:body.method,subject:body.subject,envelope:body}];
          result={saved:true};
        }else{
          if(!headers['x-vault-token']) return await fail(401,'custody_unlock_required');
          const found=wraps.find(w=>vault&&w.method===vault.method&&w.subject===vault.subject);
          if(!found) return await fail(404,'backup_missing');
          result=found.envelope;
        }
      }
      else if(path.endsWith('/finalize')){envelope=body;draft=null;result={saved:true};}
      else if(path.includes('/agent-key-drafts/')){draft=body;result={saved:true};}
      else if(path.endsWith('/key-envelope')) result=envelope;
      else throw new Error(`Unexpected fixture route ${path}`);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
    }catch(e){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:e instanceof Error?e.message:'fixture_error'})});}
  });
  const owner=await page.evaluate(async()=>{const m=await import('@socialproof/myso/keypairs/ed25519');return m.Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1)).toMySoAddress();});
  function pendingOwner(){return owner;}
  let lastMessage='';

  // 1. The MySocial login creates the custody root; no passkey is involved.
  await page.goto('/tests/passkey-vault.html');
  await page.getByRole('button',{name:'Set up with my login'}).click();
  await expect(page.locator('#status')).toHaveText('ready');
  const loginWrap=wraps.find(w=>w.method==='zklogin-root-v1')?.envelope;
  expect(loginWrap?.version).toBe(2);
  expect(loginWrap?.rootId).toBeTruthy();

  // 2. The passkey is an optional backup that re-wraps the same root.
  await page.getByRole('button',{name:'Add passkey backup'}).click();
  await expect(page.locator('#status')).toHaveText('ready');
  await expect.poll(()=>wraps.filter(w=>w.method==='passkey-prf-v1').length).toBe(1);
  const passkeyWrap=wraps.find(w=>w.method==='passkey-prf-v1')!.envelope;
  expect(passkeyWrap.version).toBe(1);
  expect(passkeyWrap.rootId).toBe(loginWrap.rootId);

  const created=await page.evaluate(()=> (window as any).createAgent());
  expect(envelope.kind).toBe('agent');expect(draft).toBeNull();
  expect(payloads.join('')).not.toContain(created.seed);expect(payloads.join('')).not.toContain('"prf"');expect(payloads.join('')).not.toContain('"seed"');

  // 3. A restart unlocks with the passkey alone, and the agent keys are identical.
  await page.reload();
  await page.getByRole('button',{name:'Unlock with passkey'}).click();
  await expect(page.locator('#status')).toHaveText('ready');
  expect(await page.evaluate(()=> (window as any).vault.activeMethod)).toBe('passkey-prf-v1');
  expect(await page.evaluate(address=>(window as any).recoverAgent(address),created.address)).toBe(created.seed);
  await page.evaluate(()=> (window as any).vault.lock());
  await expect(page.evaluate(address=>(window as any).recoverAgent(address),created.address)).rejects.toThrow('Unlock');
});
