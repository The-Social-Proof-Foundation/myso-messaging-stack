// Regenerates test/vectors/content-envelope-v2.json (shared with iOS). Run: npx tsx scripts/gen-content-envelope-vectors.ts
import { writeFileSync } from 'node:fs';

import { encodeContentEnvelope, padme, type ContentEnvelope } from '../src/content/envelope.js';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const cases: { name: string; envelope: ContentEnvelope }[] = [
	{ name: 'text', envelope: { t: 'text', text: 'hi' } },
	{ name: 'text-unicode', envelope: { t: 'text', text: 'café 👍🏽 — ok' } },
	{ name: 'text-long', envelope: { t: 'text', text: 'x'.repeat(700) } },
	{
		name: 'text-attachment',
		envelope: {
			t: 'text',
			text: '',
			att: [
				{
					id: 'r2:abc',
					k: '11'.repeat(32),
					n: '22'.repeat(12),
					name: 'photo-1.jpg',
					mime: 'image/jpeg',
					size: 1234,
				},
			],
		},
	},
	{ name: 'reaction', envelope: { t: 'event', e: { type: 'reaction', target: 'm-1', emoji: '❤️', add: true } } },
	{ name: 'edit', envelope: { t: 'event', e: { type: 'edit', target: 'm-1', text: 'fixed' } } },
	{ name: 'delete', envelope: { t: 'event', e: { type: 'delete', target: 'm-1' } } },
];

const out = {
	description: 'Content envelope v2 vectors. plaintextHex = encodeContentEnvelope(envelope).',
	padme: [1, 2, 7, 255, 256, 300, 1000, 5000, 100000].map((l) => ({ input: l, output: padme(l) })),
	cases: cases.map((c) => ({ ...c, plaintextHex: hex(encodeContentEnvelope(c.envelope)) })),
};
writeFileSync(new URL('../test/vectors/content-envelope-v2.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log('wrote', out.cases.length, 'cases');
