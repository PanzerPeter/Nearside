import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FirebaseCrashlytics } from '@capacitor-firebase/crashlytics';
import App from './App.tsx';
import { UpdatePrompt } from './components/UpdatePrompt';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider } from './hooks/useToast';
import { Toast } from './components/Toast';
import { startConnectionMonitor } from './lib/connection';
import { initLocale } from './lib/i18n';
import { initMotionPreference } from './lib/motion';
import { registerAuthLinkHandler } from './lib/nativeAuthLinks';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './index.css';
import { isMobileNative } from './lib/platform';

// Outside React: the wake watchdog and the socket-health poll are one
// per-document concern, not per-mount, and they have to survive StrictMode's
// double-mount without doubling their timers.
startConnectionMonitor();

// Also before the first render: a frame painted before the stored language
// lands would open the app in English and visibly correct itself, and every
// string on that frame is one somebody has to read twice.
initLocale();

// Before the first render, not inside a component: `data-motion` decides which
// of the two animation sets every stylesheet rule resolves to, and a frame
// painted before it lands would open the app in the restrained one and then
// visibly switch.
initMotionPreference();

// Native crashes are captured by the SDK itself. Unhandled JS rejections are
// not, and the crypto layer added in Plan 2 is exactly the kind of code that
// fails asynchronously and silently.
if (isMobileNative()) {
  window.addEventListener('unhandledrejection', (event) => {
    void FirebaseCrashlytics.recordException({ message: String(event.reason) });
  });

  // Also outside React, and before the first render: a link tapped while the
  // app was killed is already waiting in the launch intent, and the listener
  // has to exist before Android delivers it.
  registerAuthLinkHandler();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Outermost: a crash inside ToastProvider itself must still be caught. */}
    <ErrorBoundary>
      <ToastProvider>
        <App />
        <Toast />
        <UpdatePrompt />
      </ToastProvider>
    </ErrorBoundary>
  </StrictMode>
);
