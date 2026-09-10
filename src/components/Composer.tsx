import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Check, Mic, Pause, Play, Send, Paperclip, Pencil, Smile, Square, Trash2, X } from 'lucide-react';
import { EmojiPopover } from './EmojiPopover';
import { VoicePreview } from './VoicePreview';
import { AttachMenu } from './AttachMenu';
import { MAX_MESSAGE_LENGTH } from '../lib/conversation';
import { stagedIsRecording, type StagedMedia } from '../lib/staging';
import { formatDuration, MAX_VOICE_MS, voiceRecordingSupported } from '../lib/audio';
import { permissionSettingsLocation, supportsCameraCapture } from '../lib/device';
import { useVoiceRecorder, type VoiceRecording } from '../hooks/useVoiceRecorder';
import { useT } from '../hooks/useT';

export interface ComposerHandle {
  focus: () => void;
}

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  /** Stage picked/pasted/recorded files for preview; nothing is uploaded until
   *  Send. `durationMs` is set only for voice recordings. */
  onStageFile: (files: File | File[], durationMs?: number) => void;
  /** Everything queued for this send, in send order. */
  staged: StagedMedia[];
  /** Drop one entry from the queue. */
  onUnstage: (id: string) => void;
  onClearStaged: () => void;
  /** How many of the batch are already up, for the count while it sends. */
  sentCount: number;
  sending: boolean;
  uploading: boolean;
  replyingTo: { display_name: string; snippet: string } | null;
  onCancelReply: () => void;
  /** The edit in progress, when the thread has one, and null otherwise.
   *
   *  Committing an edit used to mean hitting a `btn-xs` circle beside the
   *  bubble — under the hand that is already holding the phone, and nowhere
   *  near where a thumb expects "send" to be. The composer takes the controls
   *  instead: the action button becomes the checkmark exactly as it does when
   *  there is something to send, and the input narrows to leave room for the
   *  cancel, because the typing is happening up in the bubble. */
  editing: {
    /** False while the edit is empty — nothing to commit. */
    canSave: boolean;
    /** True while the update is in flight; the button spins. */
    saving: boolean;
    onSave: () => void;
    onCancel: () => void;
  } | null;
  /** Surfaced by the parent as a toast (mic permission, unsupported browser). */
  onError: (message: string) => void;
  /** The sticker drawer, rendered as the picker's second tab. Only the composer
   *  gets one — see `EmojiPopover`. */
  stickers?: ReactNode;
}

// Shared with MessageBubble's edit textarea, which reuses this exact
// grow-to-fit algorithm rather than inventing a second one.
export const MAX_TEXTAREA_PX = 160; // ~6 lines

/** How long the nudge after a too-short recording stays up. */
const HINT_MS = 1800;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    value,
    onChange,
    onSend,
    onStageFile,
    staged,
    onUnstage,
    onClearStaged,
    sentCount,
    sending,
    uploading,
    replyingTo,
    onCancelReply,
    editing,
    onError,
    stickers,
  },
  ref
) {
  const t = useT();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraPhotoRef = useRef<HTMLInputElement>(null);
  const cameraVideoRef = useRef<HTMLInputElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  // Keyed by staged id: the same photo can be picked twice, and the file gives
  // nothing else to tell those two entries apart.
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const [hint, setHint] = useState<string | null>(null);
  // Whether the staged recording is the one the meter heard nothing during.
  const [silentTake, setSilentTake] = useState(false);

  // Probed once: neither answer changes without a reload in practice, and
  // re-running matchMedia on every render would be noise.
  const [cameraCapable] = useState(supportsCameraCapture);
  const [voiceCapable] = useState(voiceRecordingSupported);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  const isAudio = stagedIsRecording(staged);
  const stagedDurationMs = staged[0]?.durationMs ?? null;

  // A local object URL per staged file; revoked when the queue changes. Voice
  // notes get one too — it is what the preview player plays back, and one
  // revoke path is safer than a second one that can outlive it.
  useEffect(() => {
    // The warning belongs to one recording. Anything else taking the composer,
    // including a photo, clears it.
    if (!stagedIsRecording(staged)) setSilentTake(false);
    const urls: Record<string, string> = {};
    for (const item of staged) {
      urls[item.id] = URL.createObjectURL(item.file);
    }
    setPreviewUrls(urls);
    return () => {
      for (const url of Object.values(urls)) URL.revokeObjectURL(url);
    };
  }, [staged]);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  const handleRecorded = useCallback(
    (recording: VoiceRecording | null) => {
      // Null means the recording was too short to be anything but a mis-tap.
      if (!recording) {
        setHint(t('composer.tooShort'));
        return;
      }
      // A microphone that is muted, or held by another app, still yields a
      // perfectly valid file of nothing at all. Stage it anyway and say so on
      // the preview: the meter can be wrong, and a recording someone means to
      // send is not ours to throw away.
      setSilentTake(recording.silent);
      onStageFile(recording.file, recording.durationMs);
    },
    // `t` is the module's own translator and never changes identity; it is
    // listed because the rule cannot know that.
    [onStageFile, t]
  );

  const recorder = useVoiceRecorder(handleRecorded);

  // Whether `start` is still awaiting the microphone, and what the tap that
  // landed during that wait asked for. A phone takes a visible moment to open
  // the mic — long enough for a second tap — and until `start` resolves there
  // is no recorder to stop: without this the tap meant to end a recording
  // started a second one behind it, and neither could be reached again.
  const startingRef = useRef(false);
  const pendingStopRef = useRef<'none' | 'stop' | 'cancel'>('none');

  const busy = sending || uploading;
  const canSend = !busy && (!!value.trim() || staged.length > 0);
  // While recording the button has to stay the mic, whatever else is in the
  // composer. An edit in progress otherwise claims the slot for its checkmark:
  // recording a voice note is not one of the things you can do to a message
  // you are rewriting.
  const showMic = recorder.recording || (!editing && !canSend && voiceCapable && !busy);
  // Recording outranks editing in the row below for the same reason.
  const editBar = editing && !recorder.recording ? editing : null;

  async function beginRecording() {
    startingRef.current = true;
    const failure = await recorder.start();
    startingRef.current = false;
    if (failure) {
      pendingStopRef.current = 'none';
      onError(
        failure === 'denied'
          ? t('composer.micDenied', { location: permissionSettingsLocation() })
          : failure === 'unsupported'
            ? t('composer.voiceUnsupported')
            : t('composer.recordFailed')
      );
      return;
    }

    if (pendingStopRef.current === 'cancel') recorder.cancel();
    else if (pendingStopRef.current === 'stop') recorder.stop();
    pendingStopRef.current = 'none';
  }

  function finishRecording(discard: boolean) {
    if (startingRef.current) {
      // The microphone is still opening. `beginRecording` closes it the moment
      // it arrives, rather than this call landing on a recorder that is not
      // there yet and being lost.
      pendingStopRef.current = discard ? 'cancel' : 'stop';
      return;
    }
    if (discard) recorder.cancel();
    else recorder.stop();
  }

  /**
   * One button, two meanings: start, then stop.
   *
   * Press-and-hold was the touch gesture here, with a slide up to hand the
   * recording over so the finger could leave. It asked somebody to keep a
   * thumb still for the length of what they were saying, and the escape from
   * that was a 60px slide nobody found. A tap that starts and a tap that stops
   * is the same two decisions with nothing to hold and nothing to discover,
   * and it is what leaves the recording staged in the preview above, where it
   * can be played back before it goes anywhere.
   */
  function handleMicClick() {
    if (busy) return;
    if (recorder.recording || startingRef.current) {
      finishRecording(false);
      return;
    }
    pendingStopRef.current = 'none';
    void beginRecording();
  }

  function insertEmoji(emoji: string) {
    const el = textareaRef.current;
    if (!el) {
      if (value.length + emoji.length <= MAX_MESSAGE_LENGTH) onChange(value + emoji);
    } else {
      const start = el.selectionStart ?? value.length;
      const end = el.selectionEnd ?? value.length;
      const next = value.slice(0, start) + emoji + value.slice(end);
      // Refuse rather than truncate: silently clipping would split the emoji's
      // surrogate pair and leave a broken character in the box.
      if (next.length > MAX_MESSAGE_LENGTH) {
        setEmojiOpen(false);
        return;
      }
      onChange(next);
      requestAnimationFrame(() => {
        el.focus();
        const caret = start + emoji.length;
        el.setSelectionRange(caret, caret);
      });
    }
    setEmojiOpen(false);
  }

  // Auto-grow: reset then grow to scrollHeight, capped.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [value]);

  function submit() {
    if (!canSend) return;
    onSend();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    // Cleared before staging, not after: the same photo picked twice in a row
    // fires no change event while the input still holds it.
    e.target.value = '';
    if (files.length) onStageFile(files);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(e.clipboardData.items)
      .filter((i) => i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter((f): f is File => !!f);
    if (!files.length) return;
    e.preventDefault();
    onStageFile(files);
  }

  function openAttach() {
    // Without a camera behind `capture`, the sheet would offer two entries
    // that both land in the filesystem — so on desktop the paperclip stays a
    // one-tap file picker.
    if (cameraCapable) setAttachOpen(true);
    else libraryRef.current?.click();
  }

  // The one staged item, when there is exactly one. A batch renders as a strip
  // instead: names and sizes stop being readable past the first thumbnail.
  const only = staged.length === 1 ? staged[0] : null;
  const stagedKind = only?.file.type.startsWith('video/')
    ? t('composer.video')
    : t('composer.image');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="p-3 sm:p-4 pb-[calc(0.75rem+var(--safe-bottom))] sm:pb-[calc(1rem+var(--safe-bottom))] bg-base-100 border-t border-hairline shrink-0"
    >
      {replyingTo && (
        <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-field bg-base-200/70 border-l-2 border-primary">
          <div className="min-w-0 flex-1">
            <p className="text-meta font-medium text-primary">Replying to {replyingTo.display_name}</p>
            <p className="text-meta text-muted truncate">{replyingTo.snippet}</p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle"
            onClick={onCancelReply}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* A recording gets the whole width and a player: the one thing worth
          checking before it goes is what it sounds like. */}
      {only && isAudio && (
        <div className="flex items-center gap-2 mb-2 p-2 pl-3 rounded-field bg-base-200/70 border border-hairline">
          <div className="min-w-0 flex-1">
            <VoicePreview url={previewUrls[only.id]} durationMs={stagedDurationMs} />
            {silentTake && (
              <p className="mt-1 text-meta text-warning">
                No sound came through. Play it back before you send this.
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle shrink-0"
            onClick={onClearStaged}
            disabled={busy}
            title={t('composer.discardRecording')}
            aria-label={t('composer.discardRecording')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {only && !isAudio && previewUrls[only.id] && (
        <div className="flex items-center gap-3 mb-2 p-2 rounded-field bg-base-200/70 border border-hairline">
          <div className="relative shrink-0">
            {only.file.type.startsWith('video/') ? (
              <video
                src={previewUrls[only.id]}
                className="w-16 h-16 rounded-field object-cover bg-black"
                muted
              />
            ) : (
              <img
                src={previewUrls[only.id]}
                alt={t('composer.attachmentPreview')}
                className="w-16 h-16 rounded-field object-cover"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-meta font-medium truncate">{only.file.name}</p>
            <p className="text-meta text-muted">
              {`${stagedKind} · ${(only.file.size / (1024 * 1024)).toFixed(1)} MB`} ·{' '}
              {t('composer.pressSend')}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle"
            onClick={onClearStaged}
            disabled={busy}
            title={t('composer.removeAttachment')}
            aria-label={t('composer.removeAttachment')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* A batch. Thumbnails only: a column of file names is unreadable at this
          height, and what the sender is checking is which photos are going. */}
      {staged.length > 1 && (
        <div className="mb-2 p-2 rounded-field bg-base-200/70 border border-hairline">
          <div className="flex items-center gap-2 mb-2 px-0.5">
            <p className="text-meta text-muted flex-1 truncate">
              {uploading
                ? t('composer.sendingProgress', {
                    index: Math.min(sentCount + 1, staged.length),
                    total: staged.length,
                  })
                : t('composer.batchHint', {
                    files: t('storage.files', { count: staged.length }),
                  })}
            </p>
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={onClearStaged}
              disabled={busy}
            >
              {t('common.clear')}
            </button>
          </div>
          <div className="flex gap-2 overflow-x-auto scrollbar-none [&::-webkit-scrollbar]:hidden">
            {staged.map((item, index) => (
              <div key={item.id} className="relative shrink-0">
                {item.file.type.startsWith('video/') ? (
                  <video
                    src={previewUrls[item.id]}
                    className="w-16 h-16 rounded-field object-cover bg-black"
                    muted
                  />
                ) : (
                  <img
                    src={previewUrls[item.id]}
                    alt={t('composer.attachmentN', { index: index + 1 })}
                    className="w-16 h-16 rounded-field object-cover"
                  />
                )}
                {/* The order matters — the first one carries the caption — so
                    the strip numbers itself rather than leaving it to be
                    inferred from left-to-right. */}
                <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-micro text-white">
                  {index + 1}
                </span>
                <button
                  type="button"
                  className="absolute -top-1 -right-1 btn btn-xs btn-circle btn-neutral"
                  onClick={() => onUnstage(item.id)}
                  disabled={busy}
                  title={t('composer.removeThisFile')}
                  aria-label={t('composer.removeAttachmentN', { index: index + 1 })}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* `multiple` on the library picker only. The two below open the camera,
          which takes one shot at a time whatever the input says. */}
      <input
        ref={libraryRef}
        type="file"
        accept="image/*,video/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />
      {cameraCapable && (
        <>
          <input
            ref={cameraPhotoRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
          <input
            ref={cameraVideoRef}
            type="file"
            accept="video/*"
            capture="environment"
            className="hidden"
            onChange={handleFileChange}
          />
        </>
      )}

      <AttachMenu
        open={attachOpen}
        onClose={() => setAttachOpen(false)}
        onTakePhoto={() => cameraPhotoRef.current?.click()}
        onRecordVideo={() => cameraVideoRef.current?.click()}
        onChooseLibrary={() => libraryRef.current?.click()}
      />

      {/* One row, two faces. The action button on the right is deliberately a
          single element across both of them: a press-and-hold captures the
          pointer on it, and unmounting the button mid-gesture would swallow
          the release that ends the recording. Keeping both left-hand variants
          inside one conditional expression holds the button at the same
          reconciliation slot, so its DOM node — and its pointer capture —
          survive the switch. */}
      <div className="flex items-end gap-2">
        {recorder.recording ? (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-square"
              onClick={() => finishRecording(true)}
              title={t('composer.discardRecording')}
              aria-label={t('composer.discardRecording')}
            >
              <Trash2 className="w-5 h-5" />
            </button>

            {/* Unconditional now. Pause used to be gated on the recording having
                been locked, because a finger holding the mic button had nothing
                left to press it with; nothing is being held any more. */}
            <button
              type="button"
              className="btn btn-ghost btn-square"
              onClick={() => (recorder.paused ? recorder.resume() : recorder.pause())}
              title={recorder.paused ? t('composer.resume') : t('composer.pause')}
              aria-label={recorder.paused ? t('composer.resume') : t('composer.pause')}
            >
              {recorder.paused ? (
                <Play className="w-5 h-5 fill-current" />
              ) : (
                <Pause className="w-5 h-5 fill-current" />
              )}
            </button>

            <div className="flex-1 flex items-center gap-2 min-w-0 h-12" aria-live="polite">
              {/* motion-recording swaps the flat opacity pulse for emitted
                  rings under the expressive set — see index.css. A paused
                  recording holds a steady dot: a light that goes on blinking
                  says the microphone is still taking something in. */}
              <span
                className={`motion-recording w-2.5 h-2.5 rounded-full shrink-0 ${
                  recorder.paused ? 'bg-base-content/40' : 'bg-error animate-pulse'
                }`}
              />
              <span className="font-mono text-body tabular-nums">
                {formatDuration(recorder.elapsedMs)}
              </span>
              {/* The one thing on screen that proves the microphone is picking
                  anything up. Recording silence looks identical to recording a
                  voice right up until the moment it is played back. */}
              <span
                className="h-4 flex-1 min-w-8 max-w-24 overflow-hidden rounded-full bg-base-content/10"
                role="meter"
                aria-label={t('composer.micLevel')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(recorder.level * 100)}
              >
                <span
                  className="block h-full rounded-full bg-error transition-[width] duration-100 ease-out"
                  style={{ width: `${Math.max(2, recorder.level * 100)}%` }}
                />
              </span>
              <span className="text-meta text-muted truncate">
                {recorder.paused
                  ? t('composer.paused')
                  : t('composer.recording', { max: formatDuration(MAX_VOICE_MS) })}
              </span>
            </div>
          </>
        ) : editBar ? (
          <>
            {/* The narrowed "typing box". It is a label, not an input: the text
                is being typed in the bubble, and a second box to type in here
                would be two carets asking for the same message. */}
            <div className="flex-1 min-w-0 flex items-center gap-2 h-12 px-4 rounded-box bg-base-300 border border-hairline">
              <Pencil className="w-4 h-4 shrink-0 text-primary" aria-hidden />
              <span className="text-body truncate text-strong">{t('composer.editing')}</span>
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-circle"
              onClick={editBar.onCancel}
              disabled={editBar.saving}
              title={t('composer.cancelEdit')}
              aria-label={t('composer.cancelEdit')}
            >
              <X className="w-5 h-5" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn-ghost btn-square"
              onClick={openAttach}
              disabled={busy}
              title={t('composer.attach')}
              aria-label={t('composer.attach')}
            >
              <Paperclip className="w-5 h-5" />
            </button>

            <button
              ref={emojiBtnRef}
              type="button"
              className="btn btn-ghost btn-square"
              onClick={() => setEmojiOpen((o) => !o)}
              title={t('composer.emoji')}
              aria-label={t('composer.insertEmoji')}
              aria-expanded={emojiOpen}
            >
              <Smile className="w-5 h-5" />
            </button>
            <EmojiPopover
              open={emojiOpen}
              anchorRef={emojiBtnRef}
              onSelect={insertEmoji}
              onClose={() => setEmojiOpen(false)}
              stickers={stickers}
            />

            <textarea
              ref={textareaRef}
              rows={1}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder={
                staged.length > 1
                  ? t('composer.captionFirst')
                  : staged.length
                    ? t('composer.caption')
                    : t('composer.placeholder')
              }
              // The scrollbar is hidden, not the scrolling: auto-grow stops at
              // MAX_TEXTAREA_PX, so a long draft still has to scroll. The bar
              // itself is a grey stripe down a rounded pill and the WebView
              // paints it even on the one empty line.
              className="textarea flex-1 resize-none min-h-0 leading-6 py-2.5 px-4 rounded-box bg-base-300 border border-hairline focus:border-primary/60 focus:bg-base-300 focus:outline-hidden transition-colors scrollbar-none [&::-webkit-scrollbar]:hidden"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
            />
          </>
        )}

        {/* The mic takes the send slot while there is nothing to send, the way
            a voice-first messenger behaves: one button, whose meaning follows
            what the composer holds. */}
        {showMic ? (
          <button
            type="button"
            className={`btn btn-circle select-none ${
              recorder.recording ? 'btn-error' : 'btn-primary'
            }`}
            onClick={handleMicClick}
            // A long press on a button in a WebView otherwise raises the text
            // selection menu over the one control the recording is ended with.
            onContextMenu={(e) => e.preventDefault()}
            title={
              recorder.recording ? t('composer.finishRecording') : t('composer.recordVoice')
            }
            aria-label={
              recorder.recording ? t('composer.finishRecording') : t('composer.recordVoice')
            }
          >
            {/* A stop square, not a paper plane. This tap ends the recording
                and stages it for playback; the send is the separate press
                afterwards, and an arrow here promised otherwise. */}
            {recorder.recording ? (
              <Square className="w-[15px] h-[15px] fill-current" />
            ) : (
              <Mic className="w-[18px] h-[18px]" />
            )}
          </button>
        ) : (
          <button
            type={editBar ? 'button' : 'submit'}
            className="btn btn-primary btn-circle"
            disabled={editBar ? !editBar.canSave || editBar.saving : !canSend}
            onClick={editBar ? editBar.onSave : undefined}
            title={editBar ? t('composer.saveChanges') : t('common.send')}
            aria-label={editBar ? t('composer.saveChanges') : t('composer.sendMessage')}
          >
            {busy || editBar?.saving ? (
              <span className="loading loading-spinner loading-sm" />
            ) : editBar ? (
              <Check className="w-[18px] h-[18px]" />
            ) : (
              <Send className="w-[18px] h-[18px]" />
            )}
          </button>
        )}
      </div>

      {hint && <p className="mt-1.5 text-center text-meta text-muted">{hint}</p>}
    </form>
  );
});
