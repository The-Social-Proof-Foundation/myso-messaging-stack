import {defineConfig} from 'vitest/config';
import {memorySdkAliases, sharedMySoDependencies} from './local-memory-sdk';

export default defineConfig({
  resolve: {alias: memorySdkAliases, dedupe: sharedMySoDependencies},
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
