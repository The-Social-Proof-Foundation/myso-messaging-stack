import {useState} from 'react';
import {useAgentVault, AGENT_BACKUPS_ENABLED, findRegisteredDraft} from '../../contexts/AgentKeyVaultContext';
import type {AgentKeyEnvelopeV1, AgentKeySetup} from '@socialproof/memory';
import {Button} from '../Button';
import {useAgentActions} from '../../hooks/agents/useAgentActions';
import type {PasskeySummary} from '../../lib/agents/passkey-vault';

export function PasskeyVaultPanel() {
  const vault=useAgentVault();
  const actions=useAgentActions();
  const [setups,setSetups]=useState<AgentKeySetup[]>([]);
  const [records,setRecords]=useState<PasskeySummary[]>([]);
  const [selected,setSelected]=useState('');
  const [drafts,setDrafts]=useState<AgentKeyEnvelopeV1[]>([]);
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  if(!AGENT_BACKUPS_ENABLED || !vault) return null;
  async function run(action:()=>Promise<unknown>) {
    setBusy(true);setError(null);
    try{await action();}catch(e){setError(e instanceof Error?e.message:'Agent backups unavailable');}finally{setBusy(false);}
  }
  return <section aria-label="Agent key backups" className="border-b border-border px-4 py-2 text-sm">
    <div className="flex flex-wrap items-center gap-2">
      <span>Agent backups: {vault.status==='ready'?'unlocked':vault.status==='unsupported'?'unsupported device':'locked'}</span>
      {vault.status==='ready'?<>
        <Button variant="secondary" size="sm" onClick={()=>vault.lock()}>Lock</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={()=>void run(()=>vault.addPasskey())}>Add backup passkey</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={()=>void run(async()=>{setDrafts(await vault.pending());setSetups(await vault.api.setups());})}>Incomplete setups</Button>
      </>:<Button variant="secondary" size="sm" disabled={busy} onClick={()=>void run(async()=>{
        const list=await vault.listPasskeys();setRecords(list);
        if(list.some(c=>c.active)) {const id=selected||list.find(c=>c.active)!.id;setSelected(id);await vault.unlock(id);} else await vault.unlock();
      })}>{busy?'Waiting for passkey…':'Set up / unlock passkey'}</Button>}
      <Button variant="ghost" size="sm" disabled={busy} onClick={()=>void run(async()=>setRecords(await vault.listPasskeys()))}>Manage passkeys</Button>
      {records.length>0?<>
        <select aria-label="Recovery passkey" value={selected} onChange={e=>setSelected(e.target.value)} className="rounded border border-border bg-background p-1">
          <option value="">Choose passkey</option>{records.map((r,i)=><option key={r.id} value={r.id}>Passkey {i+1}{r.active?'':' (setup incomplete)'}</option>)}
        </select>
        <Button variant="ghost" size="sm" disabled={busy||!selected} onClick={()=>void run(()=>vault.unlock(selected))}>Use selected</Button>
        <Button variant="ghost" size="sm" disabled={busy||!selected||vault.status!=='ready'} onClick={()=>void run(async()=>{await vault.removePasskey(selected);setRecords(await vault.listPasskeys());})}>Remove selected</Button>
      </>:null}
    </div>
    {vault.status==='unsupported'?<p className="mt-1 text-xs">Use a browser and passkey that support encrypted recovery. There is no server recovery fallback.</p>:null}
    {error||vault.error?<p role="alert" className="mt-1 text-xs text-destructive">{error||vault.error}</p>:null}
    {drafts.map(d=><div key={d.keyId} className="mt-2 flex items-center gap-2 text-xs">
      <span>Incomplete agent {d.derivedAddress.slice(0,10)}…</span>
      <Button variant="secondary" size="sm" disabled={busy} onClick={()=>void run(async()=>{
        const id=await findRegisteredDraft(d);
        if(!id) throw new Error('Not registered yet. Open New Agent and select this saved setup to resume.');
        const key=await vault.recoverDraft(d);
        try{await vault.finalize(d,key.seed,id);}finally{key.seed.fill(0);}
        setDrafts(await vault.pending());setSetups(await vault.api.setups());
      })}>Recover backup</Button>
    </div>)}
    {setups.map(s=><div key={s.agentId} className="mt-2 flex items-center gap-2 text-xs"><span>Finish {s.intent?.label??'registered agent'}: vault {s.state.vault}, budget {s.state.budget}</span>
      <Button variant="secondary" size="sm" disabled={busy} onClick={()=>void run(async()=>{await actions.finishAgentSetup(s.agentId);setSetups(await vault.api.setups());})}>Finish setup</Button></div>)}
    <p className="mt-1 text-xs text-muted-foreground">Save a backup passkey before losing your current one. Losing all usable passkeys means losing these backups.</p>
  </section>;
}
