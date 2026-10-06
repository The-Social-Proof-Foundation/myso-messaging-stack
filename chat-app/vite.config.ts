import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import {memoryRepoRoot, memorySdkSourceDir, memorySdkAliases, memorySdkEntries, sharedMySoDependencies} from './local-memory-sdk';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const gasPoolRaw =
    env.VITE_MYSO_GAS_POOL_URL || env.MYSO_GAS_POOL_URL || '';
  let gasPoolTarget = gasPoolRaw.trim();
  if (
    gasPoolTarget &&
    !gasPoolTarget.startsWith('http://') &&
    !gasPoolTarget.startsWith('https://')
  ) {
    gasPoolTarget = `https://${gasPoolTarget}`;
  }
  gasPoolTarget = gasPoolTarget.replace(/\/$/, '');
  // Strip trailing /v1 so rewrite can append /v1/reserve_gas|execute_tx
  if (gasPoolTarget.endsWith('/v1')) {
    gasPoolTarget = gasPoolTarget.slice(0, -3);
  }

  const gasPoolProxyHeaders: Record<string, string> = {};
  if (env.GAS_POOL_TOKEN) {
    gasPoolProxyHeaders.Authorization = `Bearer ${env.GAS_POOL_TOKEN}`;
  }

  const vaultCsp: Plugin = {
    name: 'agent-vault-csp', apply: 'build',
    transformIndexHtml() {
      if(env.VITE_AGENT_KEY_BACKUPS_ENABLED !== 'true') return [];
      const origins=new Set<string>();
      for(const [key,value] of Object.entries(env)) {
        if(!key.startsWith('VITE_') || !/(URL|ORIGIN|BASE_URL)$/.test(key)) continue;
        try {const url=new URL(value);if(['https:','http:','wss:','ws:'].includes(url.protocol))origins.add(url.origin);} catch { /* Relative proxies use self. */ }
      }
      for(const origin of (env.VITE_PASSKEY_CONNECT_ORIGINS || '').split(/[ ,]+/).filter(Boolean)) {
        const url=new URL(origin);
        if(origin.includes('*') || !['https:','http:','wss:','ws:'].includes(url.protocol) || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw new Error('VITE_PASSKEY_CONNECT_ORIGINS requires exact origins');
        origins.add(url.origin);
      }
      const connect=[...origins].join(' ');
      return [{tag:'meta',attrs:{'http-equiv':'Content-Security-Policy',content:
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https:; connect-src 'self' ${connect}; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'`},injectTo:'head-prepend'}];
    },
  };

  return {
    plugins: [tailwindcss(), react(), vaultCsp],
    resolve: {
      alias: [...memorySdkAliases, {find: '@', replacement: path.resolve(rootDir, 'src')}],
      dedupe: sharedMySoDependencies,
    },
    optimizeDeps: {
      // Keep local SDK exports live instead of caching a copied compiled package.
      exclude: memorySdkEntries,
    },
    appType: 'spa',
    server: {
      fs: {
        allow: [path.resolve(rootDir, '..'), memorySdkSourceDir, path.join(memoryRepoRoot, 'node_modules')],
      },
      proxy: {
        '/api/relayer': {
          target: env.VITE_RELAYER_BACKEND_URL || 'http://localhost:3000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/relayer/, ''),
        },
        '/api/memory': {
          target: env.VITE_MEMORY_SERVER_URL || 'http://localhost:8000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/memory/, ''),
        },
        '/api/graphql': {
          target: 'https://graphql.testnet.mysocial.network',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/graphql/, '/graphql'),
        },
        '/api/rpc': {
          target:
            env.VITE_MYSO_RPC_URL?.startsWith('http')
              ? env.VITE_MYSO_RPC_URL
              : 'http://127.0.0.1:9001',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/rpc/, ''),
        },
        // Smart gas: browser → /api/gas-pool/* → gas pool /v1/* (CORS-safe in Vite dev)
        '/api/gas-pool/reserve': {
          target: gasPoolTarget || 'https://gas-pool.testnet.mysocial.network',
          changeOrigin: true,
          rewrite: () => '/v1/reserve_gas',
          headers: gasPoolProxyHeaders,
        },
        '/api/gas-pool/execute': {
          target: gasPoolTarget || 'https://gas-pool.testnet.mysocial.network',
          changeOrigin: true,
          rewrite: () => '/v1/execute_tx',
          headers: gasPoolProxyHeaders,
        },
      },
    },
  };
});
