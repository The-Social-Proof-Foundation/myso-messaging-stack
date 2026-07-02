// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

/**
 * Reaction emoji helpers.
 *
 * Reactions are stored as the canonical Unicode emoji string (NFC), so skin
 * tones (👍🏻), ZWJ sequences (👨‍👩‍👧‍👦), and variation selectors (❤️) are all
 * supported without conversion.
 */

/**
 * Canonicalizes an emoji for storage/comparison (NFC normalization).
 *
 * Always pass reactions through this before sending so visually identical
 * emojis map to the same stored key.
 *
 * @throws {Error} when `emoji` is empty or whitespace-only.
 */
export function emojiToStorage(emoji: string): string {
    const normalized = emoji.normalize("NFC");

    if (normalized.length === 0) {
        throw new Error("Emoji cannot be empty");
    }

    return normalized;
}

/** Converts a stored emoji string back to its display form (identity). */
export function storageToEmoji(emoji: string): string {
	return emoji;
}
