import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const chatAppRoot = path.dirname(fileURLToPath(import.meta.url));
export const memoryRepoRoot = path.resolve(chatAppRoot, '../../myso-memory');
export const memorySdkSourceDir = path.join(memoryRepoRoot, 'packages/sdk/src');

/** Deploy builds have no sibling myso-memory checkout and resolve the published package instead. */
export const hasLocalMemorySdk = existsSync(path.join(memorySdkSourceDir, 'index.ts'));

// Exact matches preserve the separate account/manual/AI entry points. Resolve the
// working SDK source rather than pnpm's copied package or an outdated dist build.
export const memorySdkAliases = hasLocalMemorySdk
  ? [
      {find: /^@socialproof\/memory$/, replacement: path.join(memorySdkSourceDir, 'index.ts')},
      {find: /^@socialproof\/memory\/account$/, replacement: path.join(memorySdkSourceDir, 'account-entry.ts')},
      {find: /^@socialproof\/memory\/manual$/, replacement: path.join(memorySdkSourceDir, 'manual-entry.ts')},
      {find: /^@socialproof\/memory\/ai$/, replacement: path.join(memorySdkSourceDir, 'ai/index.ts')},
    ]
  : [];
export const memorySdkEntries = hasLocalMemorySdk
  ? [
      '@socialproof/memory',
      '@socialproof/memory/account',
      '@socialproof/memory/manual',
      '@socialproof/memory/ai',
    ]
  : [];
export const sharedMySoDependencies = [
  '@socialproof/myso',
  '@socialproof/mydata',
  '@socialproof/bcs',
];
