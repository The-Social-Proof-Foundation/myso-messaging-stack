/**
 * Compatibility entry point: the vault is now custody-tier based (`CustodyVault`, which unlocks the
 * same recovery root with a passkey, the MySocial login key, or a login key plus a recovery code).
 * `PasskeyVault` remains as an alias so existing imports, tests and the browser harness keep working.
 */
export {
  CustodyVault,
  CustodyVault as PasskeyVault,
  CUSTODY_TIERS,
  CUSTODY_TIER_INFO,
  publicCredential,
  webauthnAvailable,
  type AgentSigningKey,
  type CustodyTier,
  type CustodyTierInfo,
  type CustodyUnlockOptions,
  type LoginSeedProvider,
  type PasskeySummary,
  type VaultIdentity,
  type VaultStatus,
} from './custody-vault';
