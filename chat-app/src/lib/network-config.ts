import { createNetworkConfig } from '@socialproof/dapp-kit';
import { getJsonRpcFullnodeUrl } from '@socialproof/myso/jsonRpc';

const rpcUrl = import.meta.env.VITE_MYSO_RPC_URL;

const { networkConfig, useNetworkVariable } = createNetworkConfig({
  testnet: {
    url: rpcUrl || getJsonRpcFullnodeUrl('testnet'),
    network: 'testnet',
  },
});

export { networkConfig, useNetworkVariable };
