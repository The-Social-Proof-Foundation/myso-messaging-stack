/**
 * Addresses that are all "you", for display.
 *
 * Older zkLogin sessions used a fresh ephemeral key, so messages from those
 * sign-ins sit under addresses that would otherwise look like someone else.
 * New sign-ins reuse the encrypted chat key. An alias still holds no key and
 * grants no access.
 */

export interface AliasStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = 'chat-app-self-aliases';
export const SELF_ALIASES_EVENT = 'chat-app-self-aliases-changed';
const MAX_ALIASES_PER_ACCOUNT = 50;

/** Lowercase, `0x`-prefixed, zero padding ignored, so one address always has one spelling. */
export function normalizeAddress(address: string): string {
  const hex = address.trim().toLowerCase().replace(/^0x/, '').replace(/^0+/, '');
  return `0x${hex}`;
}

const isAddress = (value: string) => /^0x[0-9a-fA-F]{1,64}$/.test(value.trim());

function browserStorage(): AliasStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

type AliasBook = Record<string, string[]>;

function read(storage: AliasStorage | null): AliasBook {
  if (!storage) return {};
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const book: AliasBook = {};
    for (const [account, list] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(list)) book[account] = list.filter((a): a is string => typeof a === 'string' && isAddress(a));
    }
    return book;
  } catch {
    return {};
  }
}

function write(storage: AliasStorage | null, book: AliasBook): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(book));
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SELF_ALIASES_EVENT));
  } catch {
    /* storage is full or blocked; the alias just does not persist */
  }
}

/** Every address recorded as this account's own, normalized. */
export function getSelfAliases(
  account: string | null | undefined,
  storage: AliasStorage | null = browserStorage(),
): string[] {
  if (!account) return [];
  return (read(storage)[normalizeAddress(account)] ?? []).map(normalizeAddress);
}

/** Add an address to an account's list. Returns false when nothing changed. */
export function addSelfAlias(
  account: string | null | undefined,
  address: string | null | undefined,
  storage: AliasStorage | null = browserStorage(),
): boolean {
  if (!account || !address || !isAddress(address) || !isAddress(account)) return false;
  const key = normalizeAddress(account);
  const next = normalizeAddress(address);
  const book = read(storage);
  const list = (book[key] ?? []).map(normalizeAddress);
  if (list.includes(next)) return false;
  book[key] = [...list, next].slice(-MAX_ALIASES_PER_ACCOUNT);
  write(storage, book);
  return true;
}

export function removeSelfAlias(
  account: string | null | undefined,
  address: string | null | undefined,
  storage: AliasStorage | null = browserStorage(),
): boolean {
  if (!account || !address) return false;
  const key = normalizeAddress(account);
  const target = normalizeAddress(address);
  const book = read(storage);
  const list = (book[key] ?? []).map(normalizeAddress);
  if (!list.includes(target)) return false;
  book[key] = list.filter((a) => a !== target);
  write(storage, book);
  return true;
}

/** True when `address` is the current signer or any recorded alias. */
export function isSelfAddress(
  address: string | null | undefined,
  currentSigner: string | null | undefined,
  aliases: readonly string[],
): boolean {
  if (!address) return false;
  const a = normalizeAddress(address);
  return (currentSigner ? normalizeAddress(currentSigner) === a : false) || aliases.includes(a);
}
