// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

import type { MemberReceipt, MessageTickStatus } from './types.js';

export type TickStatusOptions = {
	/**
	 * When set (e.g. DM peer wallets), only these addresses count toward ticks.
	 * Avoids orphan receipt rows with `0` watermarks poisoning `min`.
	 */
	peerAddresses?: readonly string[];
};

/**
 * Own-message tick from peer watermarks: min over every member except `self`.
 * - `read` when all others have `readUpto >= order`
 * - `delivered` when all others have `deliveredUpto >= order`
 * - `none` otherwise (or no peers)
 */
export function tickStatus(
	order: number,
	members: MemberReceipt[],
	selfAddress: string,
	options?: TickStatusOptions,
): MessageTickStatus {
	if (!Number.isFinite(order) || order <= 0) return 'none';
	const self = selfAddress.toLowerCase();
	const peerFilter = options?.peerAddresses?.length
		? new Set(options.peerAddresses.map((a) => a.toLowerCase()))
		: null;
	const others = members.filter((m) => {
		const key = m.member.toLowerCase();
		if (key === self) return false;
		if (peerFilter && !peerFilter.has(key)) return false;
		return true;
	});
	if (others.length === 0) return 'none';

	const minDelivered = Math.min(...others.map((m) => m.deliveredUpto));
	const minRead = Math.min(...others.map((m) => m.readUpto));
	if (minRead >= order) return 'read';
	if (minDelivered >= order) return 'delivered';
	return 'none';
}

/** Merge a live `receipt.updated` into a member list (max-wins per wallet). */
export function upsertMemberReceipt(
	members: MemberReceipt[],
	next: MemberReceipt,
): MemberReceipt[] {
	const key = next.member.toLowerCase();
	let found = false;
	const out = members.map((m) => {
		if (m.member.toLowerCase() !== key) return m;
		found = true;
		return {
			member: m.member,
			deliveredUpto: Math.max(m.deliveredUpto, next.deliveredUpto),
			readUpto: Math.max(m.readUpto, next.readUpto),
		};
	});
	if (!found) out.push(next);
	return out;
}
