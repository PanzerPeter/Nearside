import { useEffect, useState } from 'react';
import { Bug, Send } from 'lucide-react';
import { clearCrashReport, crashMailto, pendingCrashReport } from '../lib/crash-report';
import { useT } from '../hooks/useT';

/**
 * Asked once, on the launch after a crash: send the report, or don't.
 *
 * Either answer clears it — a prompt that came back every launch until
 * somebody gave in would be pressure, and the report is theirs to withhold.
 * Laid out like `UpdatePrompt`, for the same reason: full-height buttons, away
 * from the corner where the send button lives.
 */
export function CrashPrompt() {
  const t = useT();
  const [report, setReport] = useState<string | null>(null);

  useEffect(() => {
    void pendingCrashReport().then(setReport);
  }, []);

  if (!report) return null;

  function done() {
    setReport(null);
    void clearCrashReport();
  }

  return (
    <div
      className="fixed inset-x-0 bottom-0 z-110 flex justify-center px-3 pb-[calc(0.75rem+var(--safe-bottom))] pointer-events-none"
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-auto w-full max-w-md rounded-box bg-base-100/95 backdrop-blur-sm border border-hairline shadow-modal p-4 animate-message-in">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-primary/10 grid place-items-center shrink-0">
            <Bug className="w-5 h-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-body font-semibold leading-snug">{t('crash.title')}</p>
            <p className="text-meta opacity-70 leading-snug mt-0.5">{t('crash.body')}</p>
          </div>
        </div>
        <div className="mt-3 flex gap-2">
          {/* A link, not window.open: the same path a link in a message takes,
              which every shell already hands to the system. */}
          <a
            href={crashMailto(report)}
            target="_blank"
            rel="noreferrer"
            className="btn btn-primary flex-1 h-11 min-h-11"
            // Deferred so the link is still in the page when it is followed.
            onClick={() => setTimeout(done)}
          >
            <Send className="w-4 h-4" />
            {t('crash.send')}
          </a>
          <button type="button" className="btn btn-ghost h-11 min-h-11 px-4" onClick={done}>
            {t('crash.dismiss')}
          </button>
        </div>
      </div>
    </div>
  );
}
