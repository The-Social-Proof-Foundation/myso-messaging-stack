import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
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
      },
    },
  };
});
