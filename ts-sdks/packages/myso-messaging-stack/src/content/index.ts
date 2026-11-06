// Copyright (c) The Social Proof Foundation, LLC.
// SPDX-License-Identifier: Apache-2.0

export {
	CONTENT_ENVELOPE_VERSION,
	CONTENT_ENVELOPE_MIN_LENGTH,
	decodeContentEnvelope,
	encodeContentEnvelope,
	padme,
	paddedEnvelopeLength,
	relayerKindForEnvelope,
} from './envelope.js';
export type {
	ContentEnvelope,
	EnvelopeAttachment,
	EnvelopeMessageType,
	MessageEvent,
} from './envelope.js';
export { TimelineFold } from './timeline-fold.js';
export type { FoldInput, FoldedEdit, ReactionTally } from './timeline-fold.js';
export {
	GROUP_NAME_PADDED_BYTES,
	GROUP_NAME_PREFIX,
	isEncryptedGroupName,
	parseEncryptedGroupName,
} from './group-name.js';
