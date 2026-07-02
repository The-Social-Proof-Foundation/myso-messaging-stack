import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MessagingClientProvider } from './contexts/MessagingClientContext';
import {
  MySocialAuthProvider,
  useMySocialAuth,
} from './contexts/MySocialAuthContext';
import { MySocialAuthBroadcastListener } from './components/MySocialAuthBroadcastListener';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ThemeProvider } from './contexts/ThemeContext';
import AuthCallback from './pages/AuthCallback';
import App from './App';
import './index.css';

function AppErrorBoundary({ children }: Readonly<{ children: ReactNode }>) {
  const { connectedAddress } = useMySocialAuth();
  return (
    <ErrorBoundary resetKey={connectedAddress ?? 'logged-out'}>
      {children}
    </ErrorBoundary>
  );
}

const queryClient = new QueryClient();
const isAuthCallback =
  typeof window !== 'undefined' &&
  window.location.pathname.replace(/\/$/, '') === '/auth/callback';

const root = createRoot(document.getElementById('root')!);

if (isAuthCallback) {
  root.render(
    <StrictMode>
      <ThemeProvider>
        <AuthCallback />
      </ThemeProvider>
    </StrictMode>,
  );
} else {
  root.render(
    <StrictMode>
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <MySocialAuthProvider>
            <MySocialAuthBroadcastListener />
            <MessagingClientProvider>
              <AppErrorBoundary>
                <App />
              </AppErrorBoundary>
            </MessagingClientProvider>
          </MySocialAuthProvider>
        </QueryClientProvider>
      </ThemeProvider>
    </StrictMode>,
  );
}
