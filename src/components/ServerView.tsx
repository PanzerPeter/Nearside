import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, Eye, EyeOff, Lock, RefreshCw } from 'lucide-react';
import {
  describeStoredData,
  exportEverything,
  groupTables,
  type StoredDataReport,
} from '../lib/server-view';
import { saveTextFile } from '../lib/download';
import { useToast } from '../hooks/useToast';
import { SettingsPage } from './settings/SettingsUi';
import { useT } from '../hooks/useT';

interface ServerViewProps {
  onBack: () => void;
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
export function ServerView({ onBack, onOpenLimits }: ServerViewProps) {
  const t = useT();
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
      toast.success(t('serverView.exportSaved'));
    } catch {
      toast.error(t('serverView.exportFailed'));
    } finally {
      setExporting(false);
    }
  }

  return (
    <SettingsPage title={t('privacy.serverKnows')} onBack={onBack}>
      <p className="text-body text-strong leading-relaxed">{t('serverView.intro')}</p>
      <p className="text-body text-muted leading-relaxed mt-2">{t('serverView.live')}</p>

      <button className="btn btn-outline btn-sm w-full mt-4 gap-2" onClick={onOpenLimits}>
        <AlertTriangle className="w-4 h-4" />
        {t('privacy.limits')}
      </button>

      {failed && (
        <div className="alert alert-error mt-4 text-body">
          <span>{t('serverView.readFailed')}</span>
          <button className="btn btn-sm gap-1.5" onClick={() => void load()}>
            <RefreshCw className="w-3.5 h-3.5" />
            {t('common.retry')}
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
            <div className="alert alert-warning mt-4 text-body items-start">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">{t('serverView.staleTitle')}</p>
                <p className="text-meta mt-1">
                  {t('serverView.stalePrefix')}{' '}
                  <span className="font-mono">{report.unlisted.join(', ')}</span>
                  {t('serverView.staleSuffix')}
                </p>
              </div>
            </div>
          )}

          {report.missing.length > 0 && (
            <div className="alert alert-warning mt-4 text-body items-start">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-medium">{t('serverView.missingTitle')}</p>
                <p className="text-meta mt-1 font-mono">{report.missing.join(', ')}</p>
              </div>
            </div>
          )}

          {/* Column-level drift, which is the quiet half of going stale: a
              migration adds a column to a table that is already described
              here, and the card goes on listing what it listed last year.
              Every "server reads: …" below is a hand-written claim, and this
              is what holds it against the live database. */}
          {report.drift.length > 0 && (
            <div className="alert alert-warning mt-4 text-body items-start">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="font-medium">{t('serverView.driftTitle')}</p>
                <ul className="text-meta mt-1 space-y-1">
                  {report.drift.map((entry) => (
                    <li key={entry.table} className="wrap-break-word">
                      <span className="font-mono">{entry.table}</span>
                      {entry.unlisted.length > 0 && (
                        <>
                          {' — '}
                          {t('serverView.driftUnlisted')}{' '}
                          <span className="font-mono">{entry.unlisted.join(', ')}</span>
                        </>
                      )}
                      {entry.missing.length > 0 && (
                        <>
                          {' — '}
                          {t('serverView.driftMissing')}{' '}
                          <span className="font-mono">{entry.missing.join(', ')}</span>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
                <p className="text-meta mt-1">{t('serverView.driftSuffix')}</p>
              </div>
            </div>
          )}

          {/* Grouped rather than one run of eighteen cards. Flat, the list read
              as a pile of things the server holds; under headings, the shape of
              the answer is visible before any single row is: sealed content,
              routing metadata the server genuinely reads, and plumbing. */}
          {groupTables(report.tables).map((group) => (
            <section key={group.group} className="mt-5">
              <h4 className="text-micro font-medium uppercase tracking-wider text-muted">
                {t(group.title)}
              </h4>
              <p className="text-meta text-muted leading-relaxed mt-1">{t(group.blurb)}</p>

              <div className="space-y-3 mt-3">
                {group.tables.map((spec) => (
                  <section
                    key={spec.table}
                    className="rounded-box border border-hairline bg-base-200/40 p-3.5"
                  >
                    <header className="flex items-baseline justify-between gap-3">
                      <div className="min-w-0">
                        <h5 className="font-medium text-body">{t(spec.label)}</h5>
                        <p className="font-mono text-micro text-muted">{spec.table}</p>
                      </div>
                      <span className="text-meta text-muted shrink-0 tabular-nums">
                        {spec.rows === null
                          ? spec.infrastructure
                            ? t('serverView.notAboutYou')
                            : t('serverView.notReadable')
                          : t('serverView.rows', { count: spec.rows })}
                      </span>
                    </header>

                    <p className="text-meta text-strong leading-relaxed mt-2">
                      {t(spec.note)}
                    </p>

                    <dl className="mt-3 space-y-2">
                      {spec.readable.length > 0 && (
                        <div className="flex gap-2">
                          <dt className="flex items-center gap-1 text-micro font-medium uppercase tracking-wider text-warning shrink-0 w-28">
                            <Eye className="w-3 h-3" />
                            {t('serverView.serverReads')}
                          </dt>
                          <dd className="font-mono text-micro text-muted break-all">
                            {spec.readable.join(' · ')}
                          </dd>
                        </div>
                      )}
                      {spec.opaque.length > 0 && (
                        <div className="flex gap-2">
                          <dt className="flex items-center gap-1 text-micro font-medium uppercase tracking-wider text-success shrink-0 w-28">
                            <EyeOff className="w-3 h-3" />
                            {t('serverView.encrypted')}
                          </dt>
                          <dd className="font-mono text-micro text-muted break-all">
                            {spec.opaque.join(' · ')}
                          </dd>
                        </div>
                      )}
                      {spec.opaque.length === 0 && (
                        <div className="flex gap-2">
                          <dt className="flex items-center gap-1 text-micro font-medium uppercase tracking-wider text-faint shrink-0 w-28">
                            <Lock className="w-3 h-3" />
                            {t('serverView.encrypted')}
                          </dt>
                          <dd className="text-micro text-muted">
                            {t('serverView.nothingEncrypted')}
                          </dd>
                        </div>
                      )}
                    </dl>
                  </section>
                ))}
              </div>
            </section>
          ))}

          {/* Its own heading, under the tables rather than among them: both
              cards below describe things with no row anywhere above, and
              trailing them off the last group made them read as more plumbing. */}
          <h4 className="text-micro font-medium uppercase tracking-wider text-muted mt-5">
            {t('serverView.outsideTables')}
          </h4>

          <div className="rounded-box border border-hairline bg-base-200/40 p-3.5 mt-3">
            <h5 className="font-medium text-body">{t('serverView.attachmentsTitle')}</h5>
            <p className="text-meta text-strong leading-relaxed mt-2">
              {t('serverView.attachmentsBodyStart')}{' '}
              <span className="font-mono">application/octet-stream</span>
              {t('serverView.attachmentsBodyEnd')}
            </p>
          </div>

          {/* No table above it, because there is no table. Said here rather
              than left as an absence: a screen that lists what the server holds
              is the screen where "and calls leave nothing behind" is a claim
              worth making explicitly, and the only one on it whose evidence is
              that no row exists. */}
          <div className="rounded-box border border-hairline bg-base-200/40 p-3.5 mt-3">
            <h5 className="font-medium text-body">{t('serverView.callsTitle')}</h5>
            <p className="text-meta text-strong leading-relaxed mt-2">
              {t('serverView.callsBody')}
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
            {t('serverView.export')}
          </button>
          <p className="text-meta text-muted mt-2 text-center">
            {t('serverView.exportNote')}
          </p>
        </>
      )}
    </SettingsPage>
  );
}
