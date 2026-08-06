import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import { UpdatePrompt } from './components/UpdatePrompt';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './hooks/useToast';
import { Toast } from './components/Toast';
import { ConnectionBanner } from './components/ConnectionBanner';
import { startConnectionMonitor } from './lib/connection';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './index.css';

// Outside React: the wake watchdog and the socket-health poll are one
// per-document concern, not per-mount, and they have to survive StrictMode's
// double-mount without doubling their timers.
startConnectionMonitor();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost: a crash inside ToastProvider itself must still be caught. */}
    <ErrorBoundary>
      <ToastProvider>
        <App />
        <Toast />
        <ConnectionBanner />
        <UpdatePrompt />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>
);
