export function formatPaidPolicyError(err: unknown): string {
  if (!(err instanceof Error)) {
    return 'Failed to update paid messaging policy.';
  }

  const message = err.message;
  const isLocalnet = import.meta.env.VITE_MYSO_NETWORK === 'localnet';
  const socialServerUrl =
    import.meta.env.VITE_SOCIAL_SERVER_URL || 'http://127.0.0.1:9126';
  const rpcUrl =
    import.meta.env.VITE_MYSO_RPC_URL || 'http://127.0.0.1:9001';

  if (
    message.includes('messaging policy for') &&
    message.includes('Failed to fetch')
  ) {
    return (
      `Could not load indexed policy from the social server (${socialServerUrl}). ` +
      'Confirm `myso start` includes `--with-social-indexer` and `VITE_SOCIAL_SERVER_URL` ' +
      'matches the social server port (default 9126).'
    );
  }

  if (
    message.includes('Illegal invocation') ||
    message.includes("Failed to execute 'fetch' on 'Window'")
  ) {
    return (
      'Browser fetch was called without a proper binding. Restart the dev server after ' +
      'reinstalling dependencies (`pnpm install` in chat-app). If this persists, ensure SDK ' +
      'fetch defaults use a bound wrapper, not a bare `fetch` reference.'
    );
  }

  if (
    message.includes('Unauthorized') ||
    message.includes('401') ||
    (isLocalnet && message.includes('Unauthorized'))
  ) {
    return (
      'MySo JSON-RPC rejected the request (401 Unauthorized). ' +
      `Confirm VITE_MYSO_RPC_URL (${rpcUrl}) is the local fullnode JSON-RPC URL from myso start. ` +
      'In dev, the app proxies it via /api/rpc to avoid CORS. ' +
      'Verify the backend responds to a myso_getLatestCheckpointSequenceNumber JSON-RPC POST ' +
      '(see chat-app README).'
    );
  }

  if (
    isLocalnet &&
    (message === 'Failed to fetch' ||
      message.includes('ERR_CONNECTION_REFUSED') ||
      message.includes('NetworkError'))
  ) {
    return (
      'Could not reach MySo JSON-RPC from the browser. On localnet, set `VITE_MYSO_RPC_URL` to your ' +
      `fullnode URL (e.g. ${rpcUrl}) and restart pnpm dev — the Vite dev server proxies it at /api/rpc. ` +
      'Confirm that URL responds to curl (see chat-app README). ' +
      'Policy reads use the social server when VITE_SOCIAL_SERVER_URL is set; Save still requires RPC.'
    );
  }

  if (message.includes('requires a MessagingGatingClient')) {
    return (
      'Set `VITE_SOCIAL_SERVER_URL` to load paid policy from the social indexer, ' +
      'or configure a browser-accessible `VITE_MYSO_RPC_URL` for on-chain dev-inspect.'
    );
  }

  if (message.includes('requiresPaymentFromRecipient')) {
    return `${message} Check that genesis messaging packages are published on the configured network.`;
  }

  if (message.includes('No RPC-verified gas coins') || message.includes('No valid gas coins')) {
    return (
      `${message} Fund your signer on localnet: ` +
      '`myso client faucet <your-address>` (see "[chat-app] signer gas" in the console).'
    );
  }

  return message;
}
