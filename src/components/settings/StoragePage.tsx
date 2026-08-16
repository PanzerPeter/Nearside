import { useState } from 'react';
import { Images, Pin, RefreshCw, Search } from 'lucide-react';
import { clearCachedMessages } from '../../lib/localdb';
import { clearPinnedMedia } from '../../lib/pins';
import { forgetAllMedia } from '../../lib/media-cache';
import { formatBytes, plural } from '../../lib/storage-usage';
import { isMobileNative } from '../../lib/platform';
import { useStorageUsage } from '../../hooks/useStorageUsage';
import { useToast } from '../../hooks/useToast';
import { ActionRow, Card, InfoRow, Note } from './SettingsUi';

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

  async function run(what: Exclude<Pending, null>) {
    setWorking(true);
    try {
      if (what === 'mirror') {
        await clearCachedMessages();
        toast.success('Offline copy cleared. It rebuilds as you open conversations.');
      } else {
        await clearPinnedMedia();
        toast.success('Pinned files removed from this device.');
      }
      await reload();
    } catch {
      toast.error('Could not clear that.');
    } finally {
      setWorking(false);
      setPending(null);
    }
  }

  if (failed) {
    return (
      <div className="alert alert-error text-sm">
        <span>Could not measure this device&apos;s storage.</span>
        <button className="btn btn-sm gap-1.5" onClick={() => void reload()}>
          <RefreshCw className="w-3.5 h-3.5" />
          Retry
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
      <Card title="Offline copy">
        <InfoRow
          icon={Search}
          label="Decrypted messages"
          hint={
            mirror.messages === 0
              ? 'Nothing yet. It fills as you open conversations.'
              : `Across ${plural(mirror.conversations, 'conversation')}. Search reads this copy, so a conversation this device never opened cannot be searched.`
          }
          status={plural(mirror.messages, 'message')}
        />
        {mirror.messages > 0 &&
          (pending === 'mirror' ? (
            <Confirm
              working={working}
              onCancel={() => setPending(null)}
              onConfirm={() => void run('mirror')}
              label="Clear the offline copy"
            >
              Search goes quiet until you open each conversation again, and anything the server has
              already deleted is gone for good. Your contacts stay verified.
            </Confirm>
          ) : (
            <ActionRow
              label="Clear the offline copy"
              action="Clear"
              onAction={() => setPending('mirror')}
            />
          ))}
      </Card>

      <Card title="Pinned files">
        <InfoRow
          icon={Pin}
          label="Kept forever, on this phone"
          hint={
            native
              ? 'The server prunes older photos, videos and voice notes. A pin keeps a copy here, so it survives that.'
              : 'Pinning needs the app. A browser has no private storage to keep the file in.'
          }
          status={
            pins.files + pins.unmeasured === 0
              ? 'none'
              : `${plural(pins.files, 'file')} · ${formatBytes(pins.bytes)}`
          }
        />
        {pins.unmeasured > 0 && (
          <InfoRow
            label={`${plural(pins.unmeasured, 'file')} could not be measured`}
            hint="The pin is recorded but the file is gone from this phone."
            tone="warning"
          />
        )}
        {pins.files > 0 &&
          (pending === 'pins' ? (
            <Confirm
              working={working}
              onCancel={() => setPending(null)}
              onConfirm={() => void run('pins')}
              label="Remove every pinned file"
            >
              These are the last copies. Anything the server has pruned cannot be downloaded again,
              and nothing here is in your gallery unless you put it there.
            </Confirm>
          ) : (
            <ActionRow
              label="Remove every pinned file"
              hint="Deletes the files, not the messages"
              action="Remove"
              onAction={() => setPending('pins')}
            />
          ))}
      </Card>

      <Card title="Media cache">
        <ActionRow
          icon={Images}
          label="Attachments held in memory"
          hint="Photos and videos you opened this session, so scrolling back does not decrypt them again. It empties when the app closes."
          action="Clear"
          onAction={() => {
            forgetAllMedia();
            void reload();
          }}
        />
        <InfoRow label="Currently held" status={formatBytes(cacheBytes)} />
      </Card>

      <Note>
        None of this is on the server. Clearing it frees space here and changes nothing anywhere
        else.
      </Note>
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
  return (
    <div className="p-3 bg-base-200/60 space-y-2.5">
      <p className="text-sm font-medium">{label}?</p>
      <p className="text-xs text-base-content/70 leading-relaxed">{children}</p>
      <div className="flex items-center gap-2">
        <button className="btn btn-ghost btn-sm" onClick={onCancel} disabled={working}>
          Cancel
        </button>
        <button className="btn btn-warning btn-sm" onClick={onConfirm} disabled={working}>
          {working ? <span className="loading loading-spinner loading-sm" /> : 'Clear'}
        </button>
      </div>
    </div>
  );
}
