import { useState } from 'react';
import { Images, Pin, RefreshCw, Search } from 'lucide-react';
import { clearCachedMessages } from '../../lib/localdb';
import { clearAutoKeptMedia, clearPinnedMedia } from '../../lib/pins';
import { keepPolicy, setKeepPolicy, type KeepPolicy } from '../../lib/media-retention';
import type { MessageKey } from '../../lib/i18n';
import { forgetAllMedia } from '../../lib/media-cache';
import { formatBytes } from '../../lib/storage-usage';
import { isMobileNative } from '../../lib/platform';
import { useStorageUsage } from '../../hooks/useStorageUsage';
import { useToast } from '../../hooks/useToast';
import { ActionRow, Card, InfoRow, Note } from './SettingsUi';
import { useT } from '../../hooks/useT';

/** Which clear is waiting for a second tap. Each destroys the only copy of
 *  something, so none of them is a single tap. */
type Pending = 'mirror' | 'pins' | 'autoKept' | null;

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
  // Read once and held: the setting is written from this screen and nowhere
  // else, so a re-read per render would only ever return what is on screen.
  const [keep, setKeep] = useState<KeepPolicy>(keepPolicy);
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
      } else if (what === 'autoKept') {
        await clearAutoKeptMedia();
        toast.success(t('storage.autoKeptCleared'));
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
      <div className="alert alert-error text-body">
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

      {/*
        The server's copy of an attachment is bounded — a conversation is trimmed
        back to its keep limits — and this phone's is not. That is what this
        card is: the opt-out, per device, because how much room a phone has is
        not a fact about the account.
      */}
      <Card title={t('storage.keepTitle')}>
        <div className="px-3 py-2.5">
          <p className="text-meta text-muted">{t('storage.keepHint')}</p>
          <div className="mt-2 flex flex-col gap-1.5">
            {(['off', 'light', 'all'] as KeepPolicy[]).map((option) => (
              <label key={option} className="flex items-start gap-2.5 cursor-pointer">
                <input
                  type="radio"
                  name="keep-policy"
                  className="radio radio-sm radio-primary mt-0.5 shrink-0"
                  checked={keep === option}
                  onChange={() => {
                    setKeep(option);
                    setKeepPolicy(option);
                  }}
                />
                <span className="min-w-0">
                  <span className="block text-body text-strong">
                    {t(`storage.keep.${option}` as MessageKey)}
                  </span>
                  <span className="block text-meta text-muted">
                    {t(`storage.keep.${option}Hint` as MessageKey)}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <Note>{t('storage.keepDisappearing')}</Note>
        {pending === 'autoKept' ? (
          <Confirm
            working={working}
            onCancel={() => setPending(null)}
            onConfirm={() => void run('autoKept')}
            label={t('storage.clearAutoKept')}
          >
            {t('storage.clearAutoKeptBody')}
          </Confirm>
        ) : (
          <ActionRow
            label={t('storage.clearAutoKept')}
            hint={t('storage.clearAutoKeptHint')}
            action={t('common.remove')}
            onAction={() => setPending('autoKept')}
          />
        )}
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
      <p className="text-body font-medium">{label}?</p>
      <p className="text-meta text-strong leading-relaxed">{children}</p>
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
