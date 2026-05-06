import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [tailwindcss(), react()],
    server: {
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
      },
    },
  };
});
