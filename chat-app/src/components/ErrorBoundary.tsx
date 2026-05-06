/**
 * Global error boundary that catches React rendering errors
 * and displays a friendly fallback UI instead of a blank screen.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-secondary-50 p-8 dark:bg-secondary-900">
          <div className="w-full max-w-md rounded-xl bg-white p-8 shadow-lg dark:bg-secondary-800">
            <h2 className="mb-2 text-lg font-semibold text-danger-500">
              Something went wrong
            </h2>
            <p className="mb-4 text-sm text-secondary-600 dark:text-secondary-400">
              An unexpected error occurred. Please try refreshing the page.
            </p>
            {this.state.error && (
              <pre className="mb-4 max-h-32 overflow-auto rounded-lg bg-secondary-100 p-3 text-xs text-secondary-700 dark:bg-secondary-700 dark:text-secondary-300">
                {this.state.error.message}
              </pre>
            )}
            <button
              onClick={() => globalThis.location.reload()}
              className="rounded-lg bg-primary-500 px-4 py-2 text-sm font-medium text-white hover:bg-primary-600"
            >
              Reload Page
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
