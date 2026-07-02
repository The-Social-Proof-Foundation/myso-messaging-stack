/**
 * MYSO/MIST conversion helpers (re-exported from the SDK).
 *
 * On-chain amounts — escrows, paid-messaging min_cost, relayer dm-gate values —
 * are denominated in MIST (1 MYSO = 10^9 MIST). UI inputs and labels use MYSO.
 */
export { MIST_PER_MYSO, mistToMyso, mysoToMist } from '@socialproof/myso-messaging-stack';
