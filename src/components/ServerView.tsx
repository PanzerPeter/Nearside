import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, Eye, EyeOff, Lock, RefreshCw } from 'lucide-react';
import { describeStoredData, exportEverything, type StoredDataReport } from '../lib/server-view';
import { saveTextFile } from '../lib/download';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';

interface ServerViewProps {
  onClose: () => void;
  onOpenLimits: () => void;
}

/**
 * What the server knows — a proof rather than a promise.
 *
 * Every row count below is a live query run as the signed-in user, so RLS
 * scopes it to their own data. Nothing here is a description of what the schema
 * is believed to contain: if a migration adds a table nobody has described, the
 * screen says so instead of going quietly stale.
 *
 * No advertisement, promotion or upsell appears on this screen, ever. It is the
 * one surface where a commercial interruption would falsify the page it sits
 * on.
 */
export function ServerView({ onClose, onOpenLimits }: ServerViewProps) {
  const [report, setReport] = useState<StoredDataReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    setFailed(false);
    setReport(null);
    try {
      setReport(await describeStoredData());
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleExport() {
    setExporting(true);
    try {
      const json = await exportEverything();
      await saveTextFile(json, `nearside-export-${new Date().toISOString().slice(0, 10)}.json`);
      toast.success('Export saved.');
    } catch {
      toast.error('Could not write the export.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <Modal
      title="What the server knows"
      onClose={onClose}
      className="max-w-2xl"
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="text-sm text-base-content/70 leading-relaxed">
        Nearside stores who you talk to and when. It cannot read what you say, what you send, or
        what is in your vault. Your key is on this phone and nowhere else.
      </p>
      <p className="text-sm text-base-content/60 leading-relaxed mt-2">
        Every number below comes from a query run as you, right now, against the live database —
        not from a description of what we think it holds.
      </p>

      <button className="btn btn-outline btn-sm w-full mt-4 gap-2" onClick={onOpenLimits}>
        <AlertTriangle className="w-4 h-4" />
        Where this protection stops
      </button>

      {failed && (
        <div className="alert alert-error mt-4 text-sm">
          <span>Could not read the database. You may be offline.</span>
          <button className="btn btn-sm gap-1.5" onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" />
            Retry
          </button>
        </div>
      )}

      {!report && !failed && (
        <div className="flex justify-center py-12">
          <span className="loading loading-spinner" />
        </div>
      )}

      {report && (
        <>
          {report.unlisted.length > 0 && (
            <div className="alert alert-warning mt-4 text-sm items-start">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">This screen is out of date.</p>
                <p className="text-xs mt-1">
                  The database holds tables nobody has described here:{' '}
                  <span className="font-mono">{report.unlisted.join(', ')}</span>. Treat the summary
                  below as incomplete until it is.
                </p>
              </div>
            </div>
          )}

          {report.missing.length > 0 && (
            <div className="alert alert-warning mt-4 text-sm items-start">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">This screen describes tables that are gone.</p>
                <p className="text-xs mt-1 font-mono">{report.missing.join(', ')}</p>
              </div>
            </div>
          )}

          <div className="space-y-3 mt-4">
            {report.tables.map((t) => (
              <section
                key={t.table}
                className="rounded-xl border border-base-content/10 bg-base-200/40 p-3.5"
              >
                <header className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <h4 className="font-medium text-sm">{t.label}</h4>
                    <p className="font-mono text-[11px] text-base-content/60">{t.table}</p>
                  </div>
                  <span className="text-xs text-base-content/60 shrink-0 tabular-nums">
                    {t.rows === null
                      ? t.infrastructure
                        ? 'not about you'
                        : 'not readable by you'
                      : `${t.rows.toLocaleString()} ${t.rows === 1 ? 'row' : 'rows'}`}
                  </span>
                </header>

                <p className="text-xs text-base-content/70 leading-relaxed mt-2">{t.note}</p>

                <dl className="mt-3 space-y-2">
                  {t.readable.length > 0 && (
                    <div className="flex gap-2">
                      <dt className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-warning shrink-0 w-28">
                        <Eye className="w-3 h-3" />
                        Server reads
                      </dt>
                      <dd className="font-mono text-[11px] text-base-content/60 break-all">
                        {t.readable.join(' · ')}
                      </dd>
                    </div>
                  )}
                  {t.opaque.length > 0 && (
                    <div className="flex gap-2">
                      <dt className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-success shrink-0 w-28">
                        <EyeOff className="w-3 h-3" />
                        Encrypted
                      </dt>
                      <dd className="font-mono text-[11px] text-base-content/60 break-all">
                        {t.opaque.join(' · ')}
                      </dd>
                    </div>
                  )}
                  {t.opaque.length === 0 && (
                    <div className="flex gap-2">
                      <dt className="flex items-center gap-1 text-[11px] font-medium uppercase tracking-wider text-base-content/40 shrink-0 w-28">
                        <Lock className="w-3 h-3" />
                        Encrypted
                      </dt>
                      <dd className="text-[11px] text-base-content/60">nothing in this table</dd>
                    </div>
                  )}
                </dl>
              </section>
            ))}
          </div>

          <div className="rounded-xl border border-base-content/10 bg-base-200/40 p-3.5 mt-3">
            <h4 className="font-medium text-sm">Attachments and storage</h4>
            <p className="text-xs text-base-content/70 leading-relaxed mt-2">
              Photos, videos and voice notes older than the newest 20 (50 for voice notes) are
              removed from the server to keep storage costs down. Anything you pin is saved to this
              phone first and stays forever, free. Every file in storage is sealed before it is
              uploaded and announced as <span className="font-mono">application/octet-stream</span>,
              so the bucket does not even say what kind of file it is.
            </p>
          </div>

          <button
            className="btn btn-outline w-full mt-4 gap-2"
            onClick={() => void handleExport()}
            disabled={exporting}
          >
            {exporting ? (
              <span className="loading loading-spinner loading-xs" />
            ) : (
              <Download className="w-4 h-4" />
            )}
            Export everything
          </button>
          <p className="text-xs text-base-content/55 mt-2 text-center">
            Encrypted columns export as the ciphertext the server holds. Your key is not in the
            file.
          </p>
        </>
      )}
    </Modal>
  );
}
