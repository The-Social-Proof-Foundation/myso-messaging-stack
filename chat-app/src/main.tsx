import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MySoClientProvider, WalletProvider } from '@socialproof/dapp-kit';
import { networkConfig } from './lib/network-config';
import { MessagingClientProvider } from './contexts/MessagingClientContext';
import { ErrorBoundary } from './components/ErrorBoundary';
import App from './App';
import '@socialproof/dapp-kit/dist/index.css';
import './index.css';

const queryClient = new QueryClient();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MySoClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider autoConnect>
          <MessagingClientProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </MessagingClientProvider>
        </WalletProvider>
      </MySoClientProvider>
    </QueryClientProvider>
  </StrictMode>,
);
