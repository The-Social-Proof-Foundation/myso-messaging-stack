/**
 * Compatibility entry point: the vault is custody-tier based (`CustodyVault`). The MySocial login
 * (`PRIMARY_CUSTODY`) always holds an account's agent keys; a passkey is an optional backup that
 * wraps the same root. `PasskeyVault` remains as an alias so existing imports, tests and the
 * browser harness keep working.
 */
export {
  CustodyVault,
  CustodyVault as PasskeyVault,
  PRIMARY_CUSTODY,
  OPTIONAL_CUSTODY,
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
