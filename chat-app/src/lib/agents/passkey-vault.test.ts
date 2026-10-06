import {describe,it,expect,vi,afterEach} from 'vitest';
import {PasskeyVault, publicCredential} from './passkey-vault';
afterEach(()=>vi.unstubAllGlobals());
describe('passkey custody boundary',()=>{
  it('serializes only public fields and excludes PRF output',()=>{
    const c={id:'AA',rawId:new Uint8Array([0]).buffer,type:'public-key',response:{clientDataJSON:new Uint8Array([1]).buffer,authenticatorData:new Uint8Array([2]).buffer,signature:new Uint8Array([3]).buffer,userHandle:null},getClientExtensionResults:()=>({prf:{results:{first:'secret-root-material'}}})};
    const dto=JSON.stringify(publicCredential(c as unknown as PublicKeyCredential));
    expect(dto).not.toContain('prf');expect(dto).not.toContain('secret');
  });
  it('locking clears key bytes and invalidates outstanding operation generations',()=>{
    const vault=new PasskeyVault('http://localhost',{owner:'0x1',accountId:'0x2'},async()=>'',async()=>{});
    const root=new Uint8Array(32).fill(1),seed=new Uint8Array(32).fill(2);
    (vault as any).root=root;(vault as any).keys.set('a',{seed});
    const epoch=vault.generation();vault.api.ownerToken='auth';vault.api.vaultToken='auth';vault.lock();
    expect([...root]).toEqual(Array(32).fill(0));expect([...seed]).toEqual(Array(32).fill(0));
    expect(()=>vault.assertCurrent(epoch)).toThrow();expect(vault.api.ownerToken).toBe('');
  });
  it('a late wallet-signing result cannot unlock a logged-out vault',async()=>{
    vi.stubGlobal('isSecureContext',true);vi.stubGlobal('PublicKeyCredential',class{});vi.stubGlobal('navigator',{credentials:{}});
    vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({agentKeyBackups:true}))).mockResolvedValueOnce(new Response(JSON.stringify({challenge_id:'a',message:'owner challenge'}))));
    let resolve!:(value:string)=>void;let started!:(value?:unknown)=>void;
    const signing=new Promise<string>(r=>resolve=r),begun=new Promise(r=>started=r);
    const vault=new PasskeyVault('http://localhost',{owner:'0x1',accountId:'0x2'},async()=>{started();return signing;},async()=>{});
    const pending=vault.unlock();await begun;vault.lock();resolve('late signature');
    await expect(pending).rejects.toThrow('locked');expect(vault.status).toBe('locked');expect(vault.api.ownerToken).toBe('');expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('does not substitute an OAuth key when a passkey provider is absent',async()=>{
    vi.stubGlobal('isSecureContext',false);
    const vault=new PasskeyVault('http://localhost',{owner:'0x1',accountId:'0x2'},async()=>'',async()=>{});
    await expect(vault.unlock()).rejects.toThrow('HTTPS');expect(vault.status).toBe('unsupported');
  });
});
