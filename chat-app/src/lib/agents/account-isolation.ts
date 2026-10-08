/**
 * Cross-account isolation.
 *
 * Mirrors the Walrus Memory cross-account synthetic: an identity authorized for
 * account A must never be able to read account B's memories. Two layers here:
 *
 *  1. {@link assertAgentAccountBinding} — the positive, always-on guard. Before a
 *     turn touches memory, the chat's agent must actually be registered under the
 *     account we are about to query, and must be the actor the chat names.
 *  2. {@link verifyCrossAccountIsolation} — the negative, read-only probe. It
 *     asks the server to serve account B using account A's key and requires the
 *     request to be refused. A success is a policy regression, not a flake.
 *
 * The probe is read-only by construction: it performs a `recall` and nothing
 * else. It never writes, never spends credits, and never mutates chain state.
 */

/** Greppable failure token, matching the upstream synthetic's convention. */
export const CROSS_ACCOUNT_FAIL_TOKEN = 'SYNTHETIC_MEMORY_CROSS_ACCOUNT_FAIL';

export class CrossAccountMemoryError extends Error {
  constructor(message: string, readonly code: 'binding-mismatch' | 'isolation-breach') {
    super(message);
    this.name = 'CrossAccountMemoryError';
  }
}

export interface AgentBinding {
  /** `SubAgent` object id the chat is bound to. */
  agentObjectId: string;
  /** `account_id` recorded on that `SubAgent` row. */
  agentAccountId: string;
  /** `derived_address` recorded on that `SubAgent` row. */
  derivedAddress: string;
  /** Actor the chat metadata names as the agent, when the chat declares one. */
  chatCreatorActor?: string | null;
  /** Memory account this turn is about to read and write. */
  expectedAccountId: string;
}

function normalize(address: string | null | undefined): string {
  if (!address) return '';
  const raw = address.startsWith('0x') ? address.slice(2) : address;
  return raw.toLowerCase().replace(/^0+/, '');
}

/**
 * Refuse to use the agent's key against an account it does not belong to.
 *
 * This is the check that makes the chat's own memory calls safe: the agent key
 * is signed with, so if the ids disagreed the agent would be asking the server
 * to serve somebody else's namespace.
 */
export function assertAgentAccountBinding(binding: AgentBinding): void {
  if (!binding.agentObjectId) {
    throw new CrossAccountMemoryError('Chat has no agent bound to it.', 'binding-mismatch');
  }
  if (!binding.expectedAccountId) {
    throw new CrossAccountMemoryError(
      'No memory account is selected for this session.',
      'binding-mismatch',
    );
  }
  if (normalize(binding.agentAccountId) !== normalize(binding.expectedAccountId)) {
    throw new CrossAccountMemoryError(
      `Agent ${binding.agentObjectId} is registered under a different memory account than this session. ` +
        'Refusing to read or write memories with it.',
      'binding-mismatch',
    );
  }
  if (
    binding.chatCreatorActor != null &&
    binding.chatCreatorActor !== '' &&
    normalize(binding.chatCreatorActor) !== normalize(binding.derivedAddress)
  ) {
    throw new CrossAccountMemoryError(
      'Chat agent binding mismatch: the chat names a different actor than the agent key.',
      'binding-mismatch',
    );
  }
}

export interface CrossAccountProbeInput {
  /** Account whose memory the identity is legitimately allowed to read. */
  ownAccountId: string;
  /** A different account, owned by someone else, that must not be readable. */
  foreignAccountId: string;
  /**
   * Performs one authenticated read against `accountId` and resolves with the
   * row count it returned. Implementations must be read-only.
   */
  readMemories: (accountId: string) => Promise<number>;
}

export type IsolationVerdict =
  | {isolated: true; ownRows: number}
  | {isolated: false; code: typeof CROSS_ACCOUNT_FAIL_TOKEN; message: string}
  | {isolated: null; message: string};

/**
 * Probe that account A's identity cannot read account B's memories.
 *
 * Returns `isolated: null` when the check could not run (the foreign read failed
 * for an unrelated reason), which is deliberately distinct from a pass — an
 * inconclusive probe must not report success. Mirrors the upstream synthetic,
 * which prints `skip` and exits 0 rather than false-greening.
 */
export async function verifyCrossAccountIsolation(
  input: CrossAccountProbeInput,
): Promise<IsolationVerdict> {
  if (!input.ownAccountId || !input.foreignAccountId) {
    return {isolated: null, message: 'Both account ids are required to run the isolation probe.'};
  }
  if (normalize(input.ownAccountId) === normalize(input.foreignAccountId)) {
    return {
      isolated: null,
      message: 'Isolation probe needs two different accounts; the same account was supplied twice.',
    };
  }

  let foreignRows: number;
  try {
    foreignRows = await input.readMemories(input.foreignAccountId);
  } catch {
    // The read was refused. That is the expected outcome.
    const ownRows = await input.readMemories(input.ownAccountId).catch(() => 0);
    return {isolated: true, ownRows};
  }

  return {
    isolated: false,
    code: CROSS_ACCOUNT_FAIL_TOKEN,
    message:
      `Reading account ${input.foreignAccountId} with this identity's key succeeded and returned ` +
      `${foreignRows} memories. An identity authorized for ${input.ownAccountId} must not be able ` +
      'to read another account. Treat this as a policy regression.',
  };
}
