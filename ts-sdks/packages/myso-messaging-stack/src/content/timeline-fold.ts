// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { EnvelopeAttachment, MessageEvent } from './envelope.js';

/** One timeline row as the fold sees it. `event` is set for `kind === 'event'` rows. */
export interface FoldInput {
	messageId: string;
	order: number;
	senderAddress: string;
	/** Only rows whose sender signature verified may affect state. */
	senderVerified: boolean;
	event?: MessageEvent;
}

export interface ReactionTally {
	emoji: string;
	/** Lowercased member addresses, in first-reacted order. */
	members: string[];
}

export interface FoldedEdit {
	text: string;
	att?: EnvelopeAttachment[];
	order: number;
}

interface Target {
	order: number;
	sender: string;
}

interface PendingEvent {
	order: number;
	sender: string;
	event: MessageEvent;
}

/**
 * Folds v2 `event` rows into reaction / edit / delete / pin / poll-vote state, following the rules in
 * E2EE-Protocol-v2.md. Ingest rows in any order and as often as you like: state depends only on the
 * set of rows seen. Events whose target hasn't been ingested yet are held until it is.
 */
export class TimelineFold {
	readonly #targets = new Map<string, Target>();
	readonly #seenEvents = new Set<string>();
	readonly #pending = new Map<string, PendingEvent[]>();
	/** target → emoji → sender → latest {add, order} */
	readonly #reactions = new Map<string, Map<string, Map<string, { add: boolean; order: number }>>>();
	readonly #edits = new Map<string, FoldedEdit>();
	readonly #deletes = new Map<string, number>();
	readonly #pins = new Map<string, { pinned: boolean; order: number }>();
	readonly #votes = new Map<string, Map<string, { options: number[]; order: number }>>();

	/** Returns the set of target message ids whose folded state changed. */
	ingest(input: FoldInput): Set<string> {
		const changed = new Set<string>();
		const sender = input.senderAddress.toLowerCase();
		if (!input.event) {
			if (!this.#targets.has(input.messageId)) {
				this.#targets.set(input.messageId, { order: input.order, sender });
				for (const pending of this.#pending.get(input.messageId) ?? []) {
					if (this.#apply(input.messageId, pending)) changed.add(input.messageId);
				}
				this.#pending.delete(input.messageId);
			}
			return changed;
		}
		if (!input.senderVerified || this.#seenEvents.has(input.messageId)) return changed;
		this.#seenEvents.add(input.messageId);
		const pending: PendingEvent = { order: input.order, sender, event: input.event };
		const target = input.event.target;
		if (!this.#targets.has(target)) {
			const list = this.#pending.get(target) ?? [];
			list.push(pending);
			this.#pending.set(target, list);
			return changed;
		}
		if (this.#apply(target, pending)) changed.add(target);
		return changed;
	}

	#apply(targetId: string, p: PendingEvent): boolean {
		const target = this.#targets.get(targetId);
		if (!target || p.order <= target.order) return false;
		const e = p.event;
		switch (e.type) {
			case 'reaction': {
				const byEmoji = this.#reactions.get(targetId) ?? new Map();
				const bySender = byEmoji.get(e.emoji) ?? new Map();
				const prev = bySender.get(p.sender);
				if (prev && prev.order >= p.order) return false;
				bySender.set(p.sender, { add: e.add, order: p.order });
				byEmoji.set(e.emoji, bySender);
				this.#reactions.set(targetId, byEmoji);
				return !prev || prev.add !== e.add;
			}
			case 'edit': {
				if (p.sender !== target.sender) return false;
				const prev = this.#edits.get(targetId);
				if (prev && prev.order >= p.order) return false;
				this.#edits.set(targetId, { text: e.text, ...(e.att ? { att: e.att } : {}), order: p.order });
				return true;
			}
			case 'delete': {
				if (p.sender !== target.sender || this.#deletes.has(targetId)) return false;
				this.#deletes.set(targetId, p.order);
				return true;
			}
			case 'pin': {
				const prev = this.#pins.get(targetId);
				if (prev && prev.order >= p.order) return false;
				this.#pins.set(targetId, { pinned: e.pinned, order: p.order });
				return !prev || prev.pinned !== e.pinned;
			}
			case 'poll_vote': {
				const bySender = this.#votes.get(targetId) ?? new Map();
				const prev = bySender.get(p.sender);
				if (prev && prev.order >= p.order) return false;
				bySender.set(p.sender, { options: e.options, order: p.order });
				this.#votes.set(targetId, bySender);
				return true;
			}
		}
	}

	/** Current reactions on `targetId`, emoji groups ordered by first reaction. */
	reactionsFor(targetId: string): ReactionTally[] {
		const byEmoji = this.#reactions.get(targetId);
		if (!byEmoji) return [];
		const out: { emoji: string; members: string[]; first: number }[] = [];
		for (const [emoji, bySender] of byEmoji) {
			const members = [...bySender.entries()]
				.filter(([, v]) => v.add)
				.sort((a, b) => a[1].order - b[1].order);
			if (members.length === 0) continue;
			out.push({ emoji, members: members.map(([m]) => m), first: members[0]![1].order });
		}
		return out.sort((a, b) => a.first - b.first).map(({ emoji, members }) => ({ emoji, members }));
	}

	/** Whether `member` currently has `emoji` on `targetId`. */
	hasReacted(targetId: string, emoji: string, member: string): boolean {
		return this.#reactions.get(targetId)?.get(emoji.normalize('NFC'))?.get(member.toLowerCase())?.add === true;
	}

	editFor(targetId: string): FoldedEdit | undefined {
		return this.#edits.get(targetId);
	}

	isDeleted(targetId: string): boolean {
		return this.#deletes.has(targetId);
	}

	pinnedTargets(): string[] {
		return [...this.#pins.entries()]
			.filter(([, v]) => v.pinned)
			.sort((a, b) => a[1].order - b[1].order)
			.map(([id]) => id);
	}

	/** Latest vote per member on a poll message. */
	votesFor(targetId: string): Map<string, number[]> {
		const out = new Map<string, number[]>();
		for (const [member, v] of this.#votes.get(targetId) ?? []) out.set(member, v.options);
		return out;
	}
}
