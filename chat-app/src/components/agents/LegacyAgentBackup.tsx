import {useEffect,useState} from 'react';
import {useAgentVault} from '../../contexts/AgentKeyVaultContext';
import type {SubAgentRow} from '../../lib/agents/social-api';
import {Button} from '../Button';

/** Explicit import only: no signer-derived recovery and no transmission of this seed. */
export function LegacyAgentBackup({agent}:{agent:SubAgentRow}) {
  const vault=useAgentVault();
  const [seed,setSeed]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
  useEffect(()=>{if(vault?.status!=='ready')setSeed('');},[vault?.status]);
  async function save(){
    if(!vault||!confirmed||! /^[0-9a-f]{64}$/i.test(seed.trim()))return;
    const bytes=Uint8Array.from(seed.trim().match(/../g)!,v=>parseInt(v,16));setSeed('');setBusy(true);setMessage(null);
    try{await vault.importLegacy(agent,bytes);setMessage('Encrypted backup saved. Lock and unlock to load it.');}
    catch(e){setMessage(e instanceof Error?e.message:'Backup unavailable');}finally{bytes.fill(0);setBusy(false);}
  }
  return <details className="mt-3 text-xs"><summary>Existing agent recovery</summary>
    <p className="mt-2">Import a key generated on your device that was never sent to MySocial. Service-derived or server-exposed keys need replacement.</p>
    <label className="mt-2 block">Existing signing key<input type="password" maxLength={64} autoComplete="off" value={seed} onChange={e=>setSeed(e.target.value)} className="mt-1 w-full rounded border border-border bg-background p-2"/></label>
    <label className="mt-2 flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>This key was generated locally and has never been shared with MySocial.</label>
    <Button variant="secondary" size="sm" disabled={busy||!confirmed||vault?.status!=='ready'||! /^[0-9a-f]{64}$/i.test(seed.trim())} onClick={()=>void save()}>Save encrypted backup</Button>
    <Button variant="ghost" size="sm" onClick={()=>window.dispatchEvent(new Event('agent:create-replacement'))}>Create replacement</Button>
    <p className="mt-2">Choose another organization for a replacement root agent. Verify the new agent, then revoke the old one. Existing history stays with the old agent.</p>
    {message?<p role="status" className="mt-1">{message}</p>:null}
  </details>;
}
