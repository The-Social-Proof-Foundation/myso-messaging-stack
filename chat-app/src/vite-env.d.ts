/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MEMORY_SERVER_URL?: string;
  readonly VITE_SOCIAL_SERVER_URL?: string;
  readonly VITE_MYSO_GRAPHQL_URL?: string;
  readonly VITE_MYSO_RPC_URL?: string;
  readonly VITE_MYSO_NETWORK?: string;
  readonly VITE_ZKLOGIN_PROVER_URL?: string;
  readonly VITE_ENABLE_AGENT_DEV?: string;
  readonly VITE_AGENT_SUB_AGENT_ID?: string;
  readonly VITE_AGENT_SECRET_KEY?: string;
  readonly VITE_AGENT_PLATFORM_ID?: string;
  readonly VITE_AGENT_MEMORY_ACCOUNT_ID?: string;
  readonly VITE_PLATFORM_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
