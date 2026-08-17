import { useState } from 'react';
import { Images, Pin, RefreshCw, Search } from 'lucide-react';
import { clearCachedMessages } from '../../lib/localdb';
import { clearPinnedMedia } from '../../lib/pins';
import { forgetAllMedia } from '../../lib/media-cache';
import { formatBytes } from '../../lib/storage-usage';
import { isMobileNative } from '../../lib/platform';
import { useStorageUsage } from '../../hooks/useStorageUsage';
import { useToast } from '../../hooks/useToast';
import { ActionRow, Card, InfoRow, Note } from './SettingsUi';
import { useT } from '../../hooks/useT';

/** Which clear is waiting for a second tap. Both of them destroy the only copy
 *  of something, so neither is a single tap. */
type Pending = 'mirror' | 'pins' | null;

/**
 * What this device is holding, and how to get it back.
 *
 * All three numbers are local. The server cannot answer any of them: it has no
 * plaintext to count, the pinned files exist precisely because it pruned its own
 * copies, and the media cache never leaves memory. So this page measures rather
 * than queries, and says so — a storage screen that reported a server-side
 * figure would be describing a different app.
 */
export function StoragePage() {
  const { usage, failed, reload } = useStorageUsage();
  const [pending, setPending] = useState<Pending>(null);
  const [working, setWorking] = useState(false);
  const toast = useToast();
  const native = isMobileNative();
  const t = useT();

  async function run(what: Exclude<Pending, null>) {
    setWorking(true);
    try {
      if (what === 'mirror') {
        await clearCachedMessages();
        toast.success(t('storage.mirrorCleared'));
      } else {
        await clearPinnedMedia();
        toast.success(t('storage.pinsCleared'));
      }
      await reload();
    } catch {
      toast.error(t('storage.clearFailed'));
    } finally {
      setWorking(false);
      setPending(null);
    }
  }

  if (failed) {
    return (
      <div className="alert alert-error text-sm">
        <span>{t('storage.measureFailed')}</span>
        <button className="btn btn-sm gap-1.5" onClick={() => void reload()}>
          <RefreshCw className="w-3.5 h-3.5" />
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!usage) {
    return (
      <div className="flex justify-center py-12">
        <span className="loading loading-spinner" />
      </div>
    );
  }

  const { mirror, pins, cacheBytes } = usage;

  return (
    <>
      <Card title={t('storage.offlineCopy')}>
        <InfoRow
          icon={Search}
          label={t('storage.decrypted')}
          hint={
            mirror.messages === 0
              ? t('storage.decryptedEmpty')
              : t('storage.decryptedHint', {
                  conversations: t('storage.conversations', { count: mirror.conversations }),
                })
          }
          status={t('storage.messages', { count: mirror.messages })}
        />
        {mirror.messages > 0 &&
          (pending === 'mirror' ? (
            <Confirm
              working={working}
              onCancel={() => setPending(null)}
              onConfirm={() => void run('mirror')}
              label={t('storage.clearMirror')}
            >
              {t('storage.clearMirrorBody')}
            </Confirm>
          ) : (
            <ActionRow
              label={t('storage.clearMirror')}
              action={t('common.clear')}
              onAction={() => setPending('mirror')}
            />
          ))}
      </Card>

      <Card title={t('storage.pinnedFiles')}>
        <InfoRow
          icon={Pin}
          label={t('storage.pinnedLabel')}
          hint={native ? t('storage.pinnedHint') : t('storage.pinnedBrowser')}
          status={
            pins.files + pins.unmeasured === 0
              ? t('common.none')
              : `${t('storage.files', { count: pins.files })} · ${formatBytes(pins.bytes)}`
          }
        />
        {pins.unmeasured > 0 && (
          <InfoRow
            label={t('storage.unmeasured', {
              files: t('storage.files', { count: pins.unmeasured }),
            })}
            hint={t('storage.unmeasuredHint')}
            tone="warning"
          />
        )}
        {pins.files > 0 &&
          (pending === 'pins' ? (
            <Confirm
              working={working}
              onCancel={() => setPending(null)}
              onConfirm={() => void run('pins')}
              label={t('storage.removePins')}
            >
              {t('storage.removePinsBody')}
            </Confirm>
          ) : (
            <ActionRow
              label={t('storage.removePins')}
              hint={t('storage.removePinsHint')}
              action={t('common.remove')}
              onAction={() => setPending('pins')}
            />
          ))}
      </Card>

      <Card title={t('storage.mediaCache')}>
        <ActionRow
          icon={Images}
          label={t('storage.mediaCacheLabel')}
          hint={t('storage.mediaCacheHint')}
          action={t('common.clear')}
          onAction={() => {
            forgetAllMedia();
            void reload();
          }}
        />
        <InfoRow label={t('storage.currentlyHeld')} status={formatBytes(cacheBytes)} />
      </Card>

      <Note>{t('storage.note')}</Note>
    </>
  );
}

function Confirm({
  label,
  children,
  onCancel,
  onConfirm,
  working,
}: {
  label: string;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  working: boolean;
}) {
  const t = useT();
  return (
    <div className="p-3 bg-base-200/60 space-y-2.5">
      <p className="text-sm font-medium">{label}?</p>
      <p className="text-xs text-base-content/70 leading-relaxed">{children}</p>
      <div className="flex items-center gap-2">
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={working}>
          {t('common.cancel')}
        </button>
        <button className="btn btn-warning btn-sm" onClick={onConfirm} disabled={working}>
          {working ? <span className="loading loading-spinner loading-sm" /> : t('common.clear')}
        </button>
      </div>
    </div>
  );
}
