import { useEffect } from 'react';
import { storeBroadcastAuthSession } from '../lib/auth-session-build';

const BROADCAST_CHANNEL_NAME = 'mysocial-auth';

export function MySocialAuthBroadcastListener({
  onSessionStored,
}: {
  onSessionStored?: () => void;
}) {
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return;

    const channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);

    const handler = (event: MessageEvent) => {
      const data = event.data;
      if (!data || typeof data !== 'object' || data.type !== 'MYSOCIAL_AUTH_RESULT') {
        return;
      }

      const stored = storeBroadcastAuthSession(data);
      if (stored) {
        onSessionStored?.();
      }
    };

    channel.addEventListener('message', handler);
    return () => {
      channel.removeEventListener('message', handler);
      channel.close();
    };
  }, [onSessionStored]);

  return null;
}
