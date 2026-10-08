import {useQueryClient} from '@tanstack/react-query';
import {createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode} from 'react';
import {normalizeKeyAddress, type AgentKeyEnvelopeV1} from '@socialproof/memory';
import {useAuthenticatedAddress, useMySocialAuth} from './MySocialAuthContext';
import {useMemoryAccount} from '../hooks/agents/useMemoryAccount';
import {getMessagingRpcUrl} from '../lib/messaging-client-factory';
import {zkLoginPersonalMessageSignature, sessionLooksLikeZkLogin, fetchZkLoginSalt} from '../lib/zklogin-signin';
import {memoryServerUrl} from '../lib/agents/memory-client';
import {CustodyVault, PRIMARY_CUSTODY, type LoginSeedProvider} from '../lib/agents/custody-vault';
import {getSaltFromSession} from '../lib/get-salt-from-session';
import {resolveOAuthSubForKeypair} from '../lib/auth-utils';

const Context = createContext<CustodyVault | null>(null);
/** Background unlock throttle: at most one attempt per gap, and none for a minute after a 429. */
const AUTO_UNLOCK_MIN_GAP_MS=20_000;
const RATE_LIMIT_BACKOFF_MS=65_000;
const autoUnlockGate={lastAt:0,blockedUntil:0};
export const AGENT_BACKUPS_ENABLED = import.meta.env.VITE_AGENT_KEY_BACKUPS_ENABLED === 'true';
async function objectFields(id: string): Promise<{type: string; fields: Record<string, any>}> {
  const response = await fetch(getMessagingRpcUrl(), {method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0',id:1,method:'myso_getObject',params:[id,{showContent:true}]}),cache:'no-store'});
  if (!response.ok) throw new Error('Chain verification unavailable');
  const content = (await response.json()).result?.data?.content;
  if (!content?.fields || !content.type) throw new Error('Chain object unavailable'); return content;
}
export async function verifyAgentEnvelope(id: string, e: AgentKeyEnvelopeV1) {
  const {type,fields:f} = await objectFields(id);
  const [pkg,mod,name] = type.split('::');
  if (normalizeKeyAddress(pkg)!==e.packageId || mod!=='memory' || name!=='SubAgent' || type.split('::').length!==3) throw new Error('Unexpected agent object');
  for (const [field,value] of [['memory_account_id',e.accountId],['organization_id',e.organizationId],['principal_owner',e.owner],['derived_address',e.derivedAddress]]) {
    if (normalizeKeyAddress(f[field])!==value) throw new Error('Agent ownership mismatch');
  }
  const pk = Array.isArray(f.public_key) ? f.public_key.map((n: number) => Number(n).toString(16).padStart(2,'0')).join('') : '';
  const expiry=optionalValue(f.expires_at);
  if (pk!==e.publicKey || f.active!==true || (expiry!=null && Number(expiry)<Date.now())) throw new Error('Agent key is revoked, expired, or mismatched');
  let parent=optionalValue(f.parent_object_id);
  const visited=new Set<string>();
  while(parent){
    const id=normalizeKeyAddress(parent);
    if(visited.has(id)||visited.size>=8)throw new Error('Invalid agent ancestor chain');
    visited.add(id);
    const ancestor=await objectFields(id);
    const [ancestorPackage,ancestorModule,ancestorType]=ancestor.type.split('::');
    const a=ancestor.fields,expiry=optionalValue(a.expires_at);
    if(normalizeKeyAddress(ancestorPackage)!==e.packageId||ancestorModule!=='memory'||ancestorType!=='SubAgent'||a.active!==true
      ||normalizeKeyAddress(a.memory_account_id)!==e.accountId||normalizeKeyAddress(a.organization_id)!==e.organizationId||normalizeKeyAddress(a.principal_owner)!==e.owner
      ||(expiry!=null&&Number(expiry)<Date.now()))throw new Error('Agent ancestor is revoked, expired, or mismatched');
    parent=optionalValue(a.parent_object_id);
  }
  const account=await objectFields(e.accountId);
  if(account.fields.active!==true || normalizeKeyAddress(account.fields.owner)!==e.owner) throw new Error('Account inactive or ownership changed');
  return {platformScope:optionalValue(f.platform_scope) as string|null};
}
export function AgentKeyVaultProvider({children}: {children: ReactNode}) {
  const owner=useAuthenticatedAddress();
  const queryClient=useQueryClient();
  const {keypair, auth, session}=useMySocialAuth();
  const account=useMemoryAccount();
  // The provider closure is stable; the latest session is read through a ref so a session refresh
  // never rebuilds the vault (which would drop an unlock) and the login seed is derived on demand.
  const sessionRef=useRef({auth, session});
  sessionRef.current={auth, session};
  // The signer is read through a ref too: the session keypair is re-derived often, and rebuilding
  // the vault for it would drop the unlock and fire a fresh unlock (2 of the server's 10 per-minute
  // custody requests) every time.
  const keypairRef=useRef(keypair);
  keypairRef.current=keypair;
  const hasKeypair=Boolean(keypair);
  const vault=useMemo(() => {
    if(!AGENT_BACKUPS_ENABLED || !owner || !hasKeypair || !account.data?.account_id) return null;
    const instance=new CustodyVault(memoryServerUrl(), {accountId:account.data.account_id,owner}, async bytes => {
      if(sessionLooksLikeZkLogin()) {
        const sig=await zkLoginPersonalMessageSignature(bytes);
        if(!sig) throw new Error('Sign in again to verify ownership'); return sig;
      }
      const signer=keypairRef.current;
      if(!signer) throw new Error('Sign in again to verify ownership');
      return (await signer.signPersonalMessage(bytes)).signature;
    }, verifyAgentEnvelope);
    // `zklogin-root-v1` / `recovery-code-v1` custody: SHA256(sub + '_' + salt), the same
    // deterministic login key the app already derives, computed here instead of reusing
    // useMySocialAuth().keypair (which is the ephemeral zkLogin key in a zkLogin session).
    instance.setLoginSeedProvider((async () => {
      const {auth:current, session:currentSession}=sessionRef.current;
      if(!current || !currentSession) throw new Error('Sign in with MySocial so the app can derive your signing key.');
      const sub=resolveOAuthSubForKeypair(currentSession);
      if(!sub) throw new Error('This session is missing the OAuth account id needed to derive your signing key.');
      const saltUrl=import.meta.env.VITE_MYSOCIAL_SALT_URL || 'https://salt.testnet.mysocial.network/salt';
      const accessToken=currentSession.session_access_token ?? currentSession.access_token;
      const salt=sessionLooksLikeZkLogin() && accessToken && accessToken!=='wallet-only'
        ? await fetchZkLoginSalt(accessToken)
        : await getSaltFromSession(current, currentSession, saltUrl);
      const digest=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${sub}_${salt}`));
      return new Uint8Array(digest).slice(0, 32);
    }) satisfies LoginSeedProvider);
    return instance;
  },[owner,hasKeypair,account.data?.account_id]);
  useEffect(()=>{
    // Retire any secret-bearing cache entries from the old deterministic-key hook.
    queryClient.removeQueries({predicate:q=>q.queryKey[0]==='agents'&&q.queryKey[1]==='derived-key'});
  },[queryClient,owner,vault]);
  useEffect(() => {
    if(!vault) return;
    let timer: ReturnType<typeof setTimeout>;
    // The MySocial login holds the keys and needs no ceremony, so a locked vault re-opens itself
    // quietly (on load, and on the next interaction after the idle lock). One attempt per lock:
    // a failure surfaces on the Unlock button instead of retrying in a loop.
    let attempted=false;
    const autoUnlock=()=>{
      if(attempted || vault.status!=='locked') return;
      // Shared across vault instances: dev hot reloads and remounts rebuild the vault, and each
      // unlock costs the server 2 of its 10 per-minute custody requests.
      const now=Date.now();
      if(now<autoUnlockGate.blockedUntil || now-autoUnlockGate.lastAt<AUTO_UNLOCK_MIN_GAP_MS) return;
      attempted=true; autoUnlockGate.lastAt=now;
      vault.unlock({method:PRIMARY_CUSTODY}).catch(e=>{
        if((e as {status?:number})?.status===429) autoUnlockGate.blockedUntil=Date.now()+RATE_LIMIT_BACKOFF_MS;
      });
    };
    const schedule=()=>{
      clearTimeout(timer);
      autoUnlock();
      timer=setTimeout(()=>{vault.lock(); attempted=false;},15*60*1000);
    };
    // Deferred a tick so React StrictMode's mount/cleanup/mount does not start (and abort) an unlock.
    const first=setTimeout(schedule,100);
    const events=['pointerdown','keydown','touchstart'];
    events.forEach(e=>window.addEventListener(e,schedule,{passive:true}));
    return()=>{clearTimeout(first);clearTimeout(timer);events.forEach(e=>window.removeEventListener(e,schedule));vault.lock();};
  },[vault]);
  return <Context.Provider value={vault}>{children}</Context.Provider>;
}
export function useAgentVault() {
  const vault=useContext(Context);
  useSyncExternalStore(vault?.subscribe ?? (()=>()=>{}),vault?.getSnapshot ?? (()=>0));
  return vault;
}

/** Check the canonical registry before retrying an interrupted registration. */
export async function findRegisteredDraft(e: AgentKeyEnvelopeV1): Promise<string | null> {
  const account=await objectFields(e.accountId);
  const table=account.fields.agents?.fields?.id?.id;
  if(!table) throw new Error('Agent registry unavailable; registration was not retried.');
  const response=await fetch(getMessagingRpcUrl(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'mysox_getDynamicFieldObject',params:[table,{type:'address',value:e.derivedAddress}]}),cache:'no-store'});
  if(!response.ok) throw new Error('Agent registry lookup unavailable; retry later.');
  const result=(await response.json()).result;
  if(result?.error?.code==='dynamicFieldNotFound') return null;
  const value=result?.data?.content?.fields?.value;
  const id=value?.fields?.agent_object_id ?? value?.agent_object_id;
  if(id) return normalizeKeyAddress(id);
  throw new Error('Agent registry response unavailable; registration was not retried.');
}

function optionalValue(v:any):any {
  if(v==null) return null;
  if(typeof v==='string'||typeof v==='number') return v;
  const vec=v.vec??v.fields?.vec;
  if(!Array.isArray(vec)||vec.length>1)throw new Error('Canonical policy option unavailable');
  return vec[0]??null;
}
export async function readAgentPolicy(id:string) {
  const {fields:f}=await objectFields(id);
  const c=f.constraints?.fields??f.constraints;
  if(!c || c.approval_required_caps==null || f.capabilities==null || f.delegatable_caps==null || f.register_scope==null)throw new Error('Canonical agent policy unavailable');
  const expiry=optionalValue(f.expires_at),expiresAt=expiry==null?null:Number(expiry);
  if(expiresAt!==null&&!Number.isSafeInteger(expiresAt))throw new Error('Agent expiry outside supported range');
  const spend=optionalValue(c.max_action_spend);
  return {capabilities:Number(f.capabilities),delegatableCaps:Number(f.delegatable_caps),registerScope:Number(f.register_scope),identityClass:Number(f.identity_class),roleTags:String(f.role_tags),
    approvalRequiredCaps:Number(c.approval_required_caps),maxActionSpend:spend==null?null:String(spend),
    platformScope:optionalValue(f.platform_scope) as string|null,expiresAt};
}
