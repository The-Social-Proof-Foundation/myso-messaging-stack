import {useEffect, useState} from 'react';
import type {SubAgentRow} from '../../lib/agents/social-api';
import type {AgentSigningKey} from '../../lib/agents/passkey-vault';
import {useAgentVault} from '../../contexts/AgentKeyVaultContext';
/** Compatibility hook name; secrets are component state, never React Query data. */
export function useDerivedAgentKey(agent: SubAgentRow | null, _maxIndex?: number) {
  const vault=useAgentVault();
  const [state,setState]=useState<{data:AgentSigningKey|null;isPending:boolean;isLoading:boolean;error:Error|null}>({data:null,isPending:false,isLoading:false,error:null});
  const revision=vault?.getSnapshot();
  useEffect(()=>{
    let canceled=false;
    setState({data:null,isPending:!!agent&&vault?.status==='ready',isLoading:!!agent&&vault?.status==='ready',error:null});
    if(agent&&vault?.status==='ready') void vault.getAgent(agent).then(data=>{if(!canceled)setState({data,isPending:false,isLoading:false,error:null});}).catch(error=>{if(!canceled)setState({data:null,isPending:false,isLoading:false,error});});
    return()=>{canceled=true;};
  },[vault,revision,agent?.agent_object_id,agent?.derived_address]);
  return vault?.status==='ready'?state:{data:null,isPending:false,isLoading:false,error:state.error};
}
