import { Component, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Last resort for a render throw. React unmounts the whole tree below the
 * nearest boundary on an uncaught render error, so without this a single bad
 * render (a null dereference in a list item, a malformed realtime payload)
 * white-screened the entire app instead of failing one screen.
 *
 * Must be a class component — `getDerivedStateFromError`/`componentDidCatch`
 * have no hook equivalent.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: { componentStack: string }) {
    console.error('Uncaught render error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-dvh flex flex-col items-center justify-center gap-4 bg-base-300 px-6 text-center py-safe">
          <p className="text-base-content font-semibold">Something went wrong.</p>
          <p className="text-base-content/55 text-sm max-w-xs">
            Nearside hit an unexpected error. Reloading usually fixes it.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
