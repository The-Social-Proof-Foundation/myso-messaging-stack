import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, useLocation } from 'react-router-dom';
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

function Root() {
  const location = useLocation();
  const isAuthCallback =
    location.pathname.replace(/\/$/, '') === '/auth/callback';

  if (isAuthCallback) {
    return <AuthCallback />;
  }

  return (
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
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <Root />
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
