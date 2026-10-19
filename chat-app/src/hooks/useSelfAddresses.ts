import {useCallback, useEffect, useMemo, useSyncExternalStore} from 'react';

import {useMessagingMemberAddress} from '../contexts/MessagingClientContext';
import {useAuthenticatedAddress} from '../contexts/MySocialAuthContext';
import {
  SELF_ALIASES_EVENT,
  addSelfAlias,
  getSelfAliases,
  isSelfAddress,
  normalizeAddress,
  removeSelfAlias,
} from '../lib/self-aliases';

function subscribe(onChange: () => void): () => void {
  window.addEventListener(SELF_ALIASES_EVENT, onChange);
  window.addEventListener('storage', onChange);
  return () => {
    window.removeEventListener(SELF_ALIASES_EVENT, onChange);
    window.removeEventListener('storage', onChange);
  };
}

/** The snapshot is a string so React can tell, by value, whether the list changed. */
const snapshot = (account: string | null | undefined) => () => getSelfAliases(account).join(',');

export interface SelfAddresses {
  /** The account these addresses belong to: the login identity, stable across sign-ins. */
  account: string | undefined;
  /** The address the messaging signer uses right now. */
  signer: string | undefined;
  /** Earlier addresses of this account, not counting the current signer. */
  aliases: readonly string[];
  /** The current signer or any alias: "this is me". */
  isMine: (address: string | null | undefined) => boolean;
  /** One of my earlier addresses, as opposed to the current one. */
  isAlias: (address: string | null | undefined) => boolean;
  addAlias: (address: string) => void;
  removeAlias: (address: string) => void;
}

/**
 * Every address that is the signed-in person. Older sign-ins may have used a
 * different messaging key; those stay here so history still reads as ours.
 * Must be used inside the messaging provider.
 */
export function useSelfAddresses(): SelfAddresses {
  const account = useAuthenticatedAddress();
  const signer = useMessagingMemberAddress();
  const key = useSyncExternalStore(subscribe, snapshot(account), () => '');
  const stored = useMemo(() => (key ? key.split(',') : []), [key]);
  const signerKey = signer ? normalizeAddress(signer) : null;
  const aliases = useMemo(() => stored.filter((a) => a !== signerKey), [stored, signerKey]);

  const isMine = useCallback(
    (address: string | null | undefined) => isSelfAddress(address, signer, aliases),
    [signer, aliases],
  );
  const isAlias = useCallback(
    (address: string | null | undefined) =>
      Boolean(address) && aliases.includes(normalizeAddress(address!)),
    [aliases],
  );
  const addAlias = useCallback((address: string) => void addSelfAlias(account, address), [account]);
  const removeAlias = useCallback((address: string) => void removeSelfAlias(account, address), [account]);

  return {account, signer, aliases, isMine, isAlias, addAlias, removeAlias};
}

/** Remembers each sign-in's messaging address under the account, so later sign-ins recognize it. */
export function useRecordSignerAddress(): void {
  const account = useAuthenticatedAddress();
  const signer = useMessagingMemberAddress();
  useEffect(() => {
    if (account && signer) addSelfAlias(account, signer);
  }, [account, signer]);
}
