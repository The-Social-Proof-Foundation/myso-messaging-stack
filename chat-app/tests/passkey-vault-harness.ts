import {PasskeyVault} from '../src/lib/agents/passkey-vault';
import {Ed25519Keypair} from '@socialproof/myso/keypairs/ed25519';
import {keyHex} from '@socialproof/memory';
const human=Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(1));
const account=`0x${'2'.padStart(64,'0')}`,organization=`0x${'3'.padStart(64,'0')}`,agentId=`0x${'4'.padStart(64,'0')}`;
const vault=new PasskeyVault('/backup-test',{owner:human.toMySoAddress(),accountId:account},async b=>(await human.signPersonalMessage(b)).signature,async()=>{});
Object.assign(window,{vault,async createAgent(){const draft=await vault.prepare(organization);await vault.finalize(draft.envelope,draft.key.seed,agentId);return {seed:keyHex(draft.key.seed),address:draft.key.address};},async recoverAgent(address:string){const key=await vault.getAgent({agent_object_id:agentId,derived_address:address,organization_id:organization} as any);return keyHex(key.seed);}});
document.getElementById('unlock')!.addEventListener('click',()=>{void vault.unlock().then(()=>{document.getElementById('status')!.textContent='ready';}).catch(e=>{document.getElementById('status')!.textContent=e.message;});});
