// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { emojiToStorage, storageToEmoji } from '../../src/emoji.js';

describe('emoji helpers', () => {
	it('round-trips simple and complex emojis', () => {
		for (const emoji of ['👍', '❤️', '👍🏻', '👨‍👩‍👧‍👦', '🏳️‍🌈', '🫶']) {
			expect(storageToEmoji(emojiToStorage(emoji))).toBe(emoji);
		}
	});

	it('normalizes to NFC so equivalent sequences share one key', () => {
		// U+00E9 (é precomposed) vs U+0065 U+0301 (e + combining acute)
		expect(emojiToStorage('\u00e9')).toBe(emojiToStorage('e\u0301'));
	});

	it('rejects empty strings', () => {
		expect(() => emojiToStorage('')).toThrow('empty');
	});
});
