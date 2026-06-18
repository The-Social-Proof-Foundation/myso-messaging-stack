import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessagingClientProvider } from './contexts/MessagingClientContext';
import { MySocialAuthProvider } from './contexts/MySocialAuthContext';
import { MySocialAuthBroadcastListener } from './components/MySocialAuthBroadcastListener';
import { ErrorBoundary } from './components/ErrorBoundary';
import AuthCallback from './pages/AuthCallback';
import App from './App';
import './index.css';

const queryClient = new QueryClient();
const isAuthCallback =
  typeof window !== 'undefined' &&
  window.location.pathname.replace(/\/$/, '') === '/auth/callback';

const root = createRoot(document.getElementById('root')!);

if (isAuthCallback) {
  root.render(
    <StrictMode>
      <AuthCallback />
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <MySocialAuthProvider>
          <MySocialAuthBroadcastListener />
          <MessagingClientProvider>
            <ErrorBoundary>
              <App />
            </ErrorBoundary>
          </MessagingClientProvider>
        </MySocialAuthProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
