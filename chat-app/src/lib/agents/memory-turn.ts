/**
 * When a chat turn touches memory.
 *
 * The upstream chatbot example recalls before *every* generation and saves after
 * every turn. That is the wrong default for a chat app: most turns are social,
 * and an unconditional recall costs a query embedding, a vector search and a set
 * of MYDATA decrypts — plus a larger prompt — for facts the turn never used.
 *
 * So memory is opt-in per turn:
 *  - recall only when the turn actually refers to stored facts, and
 *  - write only when the turn states a durable fact worth keeping.
 *
 * Everything here is a pure function of the message text so it can be unit
 * tested and reasoned about without a server.
 */

/** Phrases that mean "use something you already know about me or this chat". */
const RECALL_CUES = [
  /\bremem(?:ber|bered|mber)\b/i,
  /\brecall\b/i,
  /\bearlier\b/i,
  /\bpreviously\b/i,
  /\blast time\b/i,
  /\bbefore\b/i,
  /\bwe (?:discussed|talked|said|agreed)\b/i,
  /\byou (?:said|told|mentioned)\b/i,
  /\b(?:my|our|mine)\b/i,
  /\bprefer(?:ence|ences)?\b/i,
  /\bfavou?rite\b/i,
  /\ballerg/i,
  /\bname\b/i,
  /\bbirthday\b/i,
  /\baddress\b/i,
  /\bbudget\b/i,
  /\babout me\b/i,
  /\bwhat do you know\b/i,
];

/** Turns that are pure pleasantries carry no fact and need no lookup. */
const SMALL_TALK = /^(?:hi|hey|hello|yo|thanks|thank you|ty|ok|okay|cool|nice|great|lol|haha|gm|good (?:morning|night|evening))[\s!.,?]*$/i;

/** Openers that make a statement, not a question about prior context. */
const QUESTION_START = /^(?:what|who|when|where|why|how|which|is|are|was|were|do|does|did|can|could|should|would|will|may)\b/i;

export interface RecallDecision {
  /** Pass as `recall` on `/api/ask`. `false` skips embedding, search and decrypts. */
  recall: boolean;
  reason: 'asked-to-remember' | 'refers-to-prior-context' | 'small-talk' | 'self-contained';
}

/**
 * Decide whether this turn should pull stored memories into the prompt.
 *
 * `historyLength` is the number of earlier turns in the thread. A bare pronoun
 * or a short follow-up only needs memory when there is something to follow up on.
 */
export function decideRecall(text: string, historyLength = 0): RecallDecision {
  const trimmed = text.trim();
  if (!trimmed) return {recall: false, reason: 'self-contained'};
  if (SMALL_TALK.test(trimmed)) return {recall: false, reason: 'small-talk'};

  for (const cue of RECALL_CUES) {
    if (cue.test(trimmed)) return {recall: true, reason: 'refers-to-prior-context'};
  }

  // A short question with prior turns behind it is almost always a follow-up.
  if (historyLength > 0 && trimmed.length <= 80 && trimmed.includes('?')) {
    return {recall: true, reason: 'refers-to-prior-context'};
  }

  return {recall: false, reason: 'self-contained'};
}

/** Statements that carry a durable fact worth storing, instead of every turn. */
const DURABLE_FACT = [
  /\bmy name is\b/i,
  /\bi (?:am|'m) (?:a|an|the)\b/i,
  /\bi (?:live|work|study) (?:in|at|for)\b/i,
  /\bi prefer\b/i,
  /\bi (?:like|love|hate|dislike|avoid)\b/i,
  /\bi (?:always|never|usually|often)\b/i,
  /\bremember (?:that|this)\b/i,
  /\bmy favou?rite\b/i,
  /\bi (?:am )?allergic\b/i,
  /\bmy (?:birthday|address|email|phone|budget)\b/i,
  /\bcall me\b/i,
];

/**
 * "remember that I like pie", "can you please remember the fact that I like pie?". Checked before
 * the question filter because a polite request to remember is phrased as a question.
 */
const EXPLICIT_REMEMBER =
  /^(?:(?:hey|hi|ok|okay)\b[^,.!?]{0,30}[,.!]?\s+)?(?:(?:can|could|would|will) you\s+)?(?:please\s+)?(?:remember|save|note|store|keep in mind)\b(?:\s+the fact)?(?:\s+(?:that|this))?[:\s]+(.+?)[\s?.!]*$/is;

export interface RememberDecision {
  /** Facts to persist this turn. Usually empty: most turns are not durable. */
  facts: string[];
  reason: 'stated-a-fact' | 'explicit-remember' | 'nothing-durable';
}

/**
 * Extract the facts worth persisting from one user turn.
 *
 * Returns at most one fact: a chat turn is one statement, and storing a whole
 * message verbatim is what makes recall noisy. Returns nothing for questions,
 * greetings, and anything that does not assert something durable.
 */
export function decideRemember(text: string): RememberDecision {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500) return {facts: [], reason: 'nothing-durable'};
  if (SMALL_TALK.test(trimmed)) return {facts: [], reason: 'nothing-durable'};

  if (/^\s*\/remember\b/i.test(trimmed)) {
    const explicit = trimmed.replace(/^\s*\/remember\b[:\s]*/i, '').trim();
    return explicit
      ? {facts: [explicit], reason: 'explicit-remember'}
      : {facts: [], reason: 'nothing-durable'}
  }

  const explicitRequest = EXPLICIT_REMEMBER.exec(trimmed)?.[1]?.trim();
  if (explicitRequest) return {facts: [explicitRequest], reason: 'explicit-remember'};

  if (QUESTION_START.test(trimmed)) return {facts: [], reason: 'nothing-durable'};
  if (DURABLE_FACT.some((pattern) => pattern.test(trimmed))) {
    return {facts: [trimmed], reason: 'stated-a-fact'};
  }
  return {facts: [], reason: 'nothing-durable'};
}

/**
 * Stable idempotency key for one logical turn.
 *
 * A retry of the same question in the same chat reuses this key, so the AI-credit
 * gateway reconciles the existing reservation instead of reserving and billing a
 * second inference. Derived from the chat id plus the exact question text.
 */
export async function turnIdempotencyKey(
  scopeId: string,
  text: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${scopeId}\u0000${text}`),
  );
  const hex = Array.from(new Uint8Array(digest).subarray(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `chat-turn-${hex}`;
}
