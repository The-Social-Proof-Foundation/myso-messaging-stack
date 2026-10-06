import {test,expect} from '@playwright/test';
import {keyBackupOperation} from '../../../myso-memory/services/server/scripts/key-backup';

/** Actual Chromium WebAuthn PRF + actual server verifier; chain/storage are fixtures. */
test('passkey enrollment, encrypted backup, and recovery after a page restart',async({page,context})=>{
  const cdp=await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',ctap2Version:'ctap2_1',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true,hasPrf:true}});
  const credentials=new Map<string,any>(),ceremonies=new Map<string,{operation:string;challenge:string}>();
  let wrap:any=null,draft:any=null,envelope:any=null;
  const payloads:string[]=[];
  process.env.MYSO_RPC_URL='http://localhost:1';
  await page.route('**/backup-test/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON();
    payloads.push(request.postData()??'');
    let result:any={};
    try {
      if(path.endsWith('/config')) result={agentKeyBackups:true};
      else if(path.endsWith('/owner/auth/challenge')) result={challenge_id:'fixture',message:`mysocial-key-backup-owner-v1|localhost|test-chain|${body.account_id}|unlock`};
      else if(path.endsWith('/owner/auth/verify')){
        const human=await import('@socialproof/myso/keypairs/ed25519');
        const owner=human.Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1)).toMySoAddress();
        await keyBackupOperation('owner',{message:`mysocial-key-backup-owner-v1|localhost|test-chain|0x${'2'.padStart(64,'0')}|unlock`,signature:body.signature,owner});
        result={owner_token:'fixture',owner,chain:'test-chain',package_id:`0x${'1'.padStart(64,'0')}`};
      }
      else if(path.endsWith('/passkeys')) result=Array.from(credentials.values()).map(c=>({id:c.id,active:!!wrap,prfInput:c.prfInput}));
      else if(path.endsWith('/options')){
        const operation=path.includes('/registration/')?'registration':'authentication';
        const selected=Array.from(credentials.values()).filter(c=>!body.credential_id||c.id===body.credential_id);
        const options=await keyBackupOperation(`${operation}-options`,{rpId:'localhost',owner:'test-owner',accountId:`0x${'2'.padStart(64,'0')}`,credentials:selected});
        const id=crypto.randomUUID();ceremonies.set(id,{operation,challenge:options.challenge});
        result={ceremony_id:id,options,rp_id:'localhost',credentials:selected.map(c=>({id:c.id,prfInput:c.prfInput,active:!!wrap}))};
      }
      else if(path.endsWith('/verify')){
        const c=ceremonies.get(body.ceremony_id)!;ceremonies.delete(body.ceremony_id);
        const verified=await keyBackupOperation(`${c.operation}-verify`,{rpId:'localhost',origins:['http://localhost:5189'],challenge:c.challenge,response:body.response,credential:credentials.get(body.response.id)});
        if(c.operation==='registration'){
          verified.prfInput=Buffer.alloc(32,3).toString('base64url');credentials.set(verified.id,verified);result={credential_id:verified.id,prf_input:verified.prfInput};
        }else{credentials.get(body.response.id).counter=verified.counter;result={vault_token:'fixture'};}
      }
      else if(path.endsWith('/recovery-root')){
        if(request.method()==='PUT'){wrap=body;result={saved:true};}else result=wrap;
      }
      else if(path.endsWith('/finalize')){envelope=body;draft=null;result={saved:true};}
      else if(path.includes('/agent-key-drafts/')){draft=body;result={saved:true};}
      else if(path.endsWith('/key-envelope')) result=envelope;
      else throw new Error(`Unexpected fixture route ${path}`);
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(result)});
    }catch(e){await route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({code:e instanceof Error?e.message:'fixture_error'})});}
  });
  await page.goto('/tests/passkey-vault.html');await page.getByRole('button',{name:'Unlock test vault'}).click();
  await expect(page.locator('#status')).toHaveText('ready');
  const created=await page.evaluate(()=> (window as any).createAgent());
  expect(wrap.ciphertext).toBeTruthy();expect(envelope.kind).toBe('agent');expect(draft).toBeNull();
  expect(payloads.join('')).not.toContain(created.seed);expect(payloads.join('')).not.toContain('"prf"');expect(payloads.join('')).not.toContain('"seed"');
  await page.reload();await page.getByRole('button',{name:'Unlock test vault'}).click();await expect(page.locator('#status')).toHaveText('ready');
  expect(await page.evaluate(address=>(window as any).recoverAgent(address),created.address)).toBe(created.seed);
  await page.evaluate(()=> (window as any).vault.lock());
  await expect(page.evaluate(address=>(window as any).recoverAgent(address),created.address)).rejects.toThrow('Unlock');
});
