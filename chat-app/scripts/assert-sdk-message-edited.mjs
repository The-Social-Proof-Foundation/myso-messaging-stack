/**
 * Fail loudly if the installed local SDK build still drops `message.edited`
 * WebSocket frames (stale file: copy after SDK source changes).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkgRoot = join(root, 'node_modules/@socialproof/myso-messaging-stack/dist');
const required = ['message.edited'];
const files = [
  join(pkgRoot, 'relayer/ws-transport.mjs'),
  join(pkgRoot, 'client.mjs'),
];

for (const file of files) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`[sync:sdk] missing installed SDK file: ${file}`);
    console.error(err);
    process.exit(1);
  }
  for (const needle of required) {
    if (!src.includes(needle)) {
      console.error(
        `[sync:sdk] stale SDK: ${file} does not contain "${needle}". ` +
          'Rebuild @socialproof/myso-messaging-stack and reinstall.',
      );
      process.exit(1);
    }
  }
}

console.log('[sync:sdk] OK — installed SDK includes message.edited support');
