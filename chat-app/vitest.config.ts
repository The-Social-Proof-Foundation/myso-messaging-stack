import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vitest/config';
import typegpu from 'unplugin-typegpu/vite';
import {memorySdkAliases, sharedMySoDependencies} from './local-memory-sdk';

export default defineConfig({
  plugins: [typegpu({})],
  resolve: {
    alias: {...memorySdkAliases, '@': fileURLToPath(new URL('./src', import.meta.url))},
    dedupe: sharedMySoDependencies},
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
