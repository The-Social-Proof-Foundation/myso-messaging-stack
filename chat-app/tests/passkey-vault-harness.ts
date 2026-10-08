import {CustodyVault} from '../src/lib/agents/custody-vault';
import {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';
import {keyHex} from '@socialproof/memory';

/**
 * The MySocial login is the holder tier and a passkey is an optional backup that re-wraps the same
 * root, so this harness sets up custody with the login, adds a real WebAuthn PRF passkey, and can
 * then unlock with either. Fixture chain/storage; real envelope and custody crypto.
 */
const human=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1));
const loginSeed=new Uint8Array(32).fill(7);
const account=`0x${'2'.padStart(64,'0')}`,organization=`0x${'3'.padStart(64,'0')}`,agentId=`0x${'4'.padStart(64,'0')}`;
const vault=new CustodyVault('/backup-test',{owner:human.toMySoAddress(),accountId:account},async b=>(await human.signPersonalMessage(b)).signature,async()=>{});
vault.setLoginSeedProvider(()=>loginSeed);
Object.assign(window,{
  vault,
  loginSeedHex:keyHex(loginSeed),
  async adoptLogin(){await vault.adoptTier('zklogin-root-v1');return vault.activeMethod;},
  async addPasskeyBackup(){await vault.addPasskey();return vault.activeMethod;},
  async unlock(){await vault.unlock();return vault.activeMethod;},
  async unlockWithPasskey(){await vault.unlock({method:'passkey-prf-v1'});return vault.activeMethod;},
  async createAgent(){const draft=await vault.prepare(organization);await vault.finalize(draft.envelope,draft.key.seed,agentId);return {seed:keyHex(draft.key.seed),address:draft.key.address};},
  async recoverAgent(address:string){const key=await vault.getAgent({agent_object_id:agentId,derived_address:address,organization_id:organization} as any);return keyHex(key.seed);},
});
function wire(id:string,action:()=>Promise<unknown>){
  document.getElementById(id)!.addEventListener('click',()=>{
    void action().then(()=>{document.getElementById('status')!.textContent='ready';}).catch((e:any)=>{document.getElementById('status')!.textContent=e.message;});
  });
}
wire('adopt',()=>(window as any).adoptLogin());
wire('addpasskey',()=>(window as any).addPasskeyBackup());
wire('unlock',()=>(window as any).unlock());
wire('unlockpasskey',()=>(window as any).unlockWithPasskey());
