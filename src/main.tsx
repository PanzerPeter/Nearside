import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import { FirebaseCrashlytics } from '@capacitor-firebase/crashlytics';
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

// Native crashes are captured by the SDK itself. Unhandled JS rejections are
// not, and the crypto layer added in Plan 2 is exactly the kind of code that
// fails asynchronously and silently.
if (Capacitor.isNativePlatform()) {
  window.addEventListener('unhandledrejection', (event) => {
    void FirebaseCrashlytics.recordException({ message: String(event.reason) });
  });
}

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
