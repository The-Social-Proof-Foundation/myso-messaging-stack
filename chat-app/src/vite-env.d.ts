/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** `true`: new groups write content envelope v2 (see docs/myso-messaging-stack/E2EE-Protocol-v2.md). */
  readonly VITE_E2EE_V2_NEW_GROUPS?: string;
  /** MLS (forward secrecy) is on by default; `false` turns it off in this build. New groups use it. */
  readonly VITE_MLS_ENABLED?: string;
  /** `true`: renew MLS device certificates via the on-chain `MlsDeviceRegistry` (must exist on-chain). */
  readonly VITE_MLS_DEVICE_REGISTRY?: string;
  /** Passkey relying party for the message backup (default `mysocial.network`). */
  readonly VITE_PASSKEY_RP_ID?: string;
  readonly VITE_MEMORY_SERVER_URL?: string;
  readonly VITE_SOCIAL_SERVER_URL?: string;
  readonly VITE_MYSO_GRAPHQL_URL?: string;
  readonly VITE_MYSO_RPC_URL?: string;
  readonly VITE_MYSO_NETWORK?: string;
  readonly VITE_ZKLOGIN_PROVER_URL?: string;
  readonly VITE_ZKLOGIN_PROVER_NETWORK?: string;
  readonly VITE_ENABLE_AGENT_DEV?: string;
  readonly VITE_AGENT_SUB_AGENT_ID?: string;
  readonly VITE_AGENT_SECRET_KEY?: string;
  readonly VITE_AGENT_PLATFORM_ID?: string;
  readonly VITE_AGENT_MEMORY_ACCOUNT_ID?: string;
  readonly VITE_AGENT_KEY_BACKUPS_ENABLED?: string;
  readonly VITE_PASSKEY_CONNECT_ORIGINS?: string;
  readonly VITE_PLATFORM_ID?: string;
  /** Public X25519 key (`<id>:<base64url>`) delegate seeds are encrypted to. Not a secret. */
  readonly VITE_AUTOMATION_MYDATA_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
