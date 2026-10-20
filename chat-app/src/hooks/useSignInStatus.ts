import { useEffect, useState, useSyncExternalStore } from 'react';
import {
  subscribeZkLoginProofRecovered,
  zkLoginProofRecovered,
} from '../lib/zklogin-signin';

const STEP_MS = 1800;
const RECOVER_HOLD_MS = 1200;
const SIGN_IN_STEPS = [
  'Signing in...',
  'Generating zero-knowledge proof...',
  'Verifying proof...',
  'Securing your session...',
] as const;
const RECOVER_TEXT = 'Recovering zk-proof...';

/**
 * Sign-in overlay copy, matching the MySocial web app.
 * A fresh proof steps through the prover stages. A reused on-device proof shows
 * "Recovering zk-proof..." and holds it briefly so it does not flash before success.
 */
export function useSignInStatus(ready: boolean): {
  phase: 'processing' | 'success';
  processingText: string;
} {
  const recovered = useSyncExternalStore(
    subscribeZkLoginProofRecovered,
    zkLoginProofRecovered,
    () => false,
  );
  const [recoverHeld, setRecoverHeld] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!recovered) {
      setRecoverHeld(false);
      return;
    }
    const timer = window.setTimeout(() => setRecoverHeld(true), RECOVER_HOLD_MS);
    return () => window.clearTimeout(timer);
  }, [recovered]);

  const done = ready && (!recovered || recoverHeld);
  const cycling = !done && !recovered;

  useEffect(() => {
    if (!cycling) {
      setStep(0);
      return;
    }
    const timer = window.setInterval(() => {
      setStep((current) => Math.min(current + 1, SIGN_IN_STEPS.length - 1));
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [cycling]);

  return {
    phase: done ? 'success' : 'processing',
    processingText: recovered ? RECOVER_TEXT : SIGN_IN_STEPS[step],
  };
}
