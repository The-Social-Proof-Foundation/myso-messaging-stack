import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

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

  return {
    plugins: [tailwindcss(), react()],
    appType: 'spa',
    server: {
      fs: {
        allow: ['..'],
      },
      proxy: {
        '/api/relayer': {
          target: env.VITE_RELAYER_BACKEND_URL || 'http://localhost:3000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/relayer/, ''),
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
