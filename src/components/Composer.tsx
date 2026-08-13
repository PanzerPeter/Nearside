import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { Check, Mic, Send, Paperclip, Pencil, Smile, Trash2, X } from 'lucide-react';
import { EmojiPopover } from './EmojiPopover';
import { AttachMenu } from './AttachMenu';
import { MAX_MESSAGE_LENGTH } from '../lib/conversation';
import { formatDuration, MAX_VOICE_MS, voiceRecordingSupported } from '../lib/audio';
import { isCoarsePointer, permissionSettingsLocation, supportsCameraCapture } from '../lib/device';
import { useVoiceRecorder, type VoiceRecording } from '../hooks/useVoiceRecorder';

export interface ComposerHandle {
  focus: () => void;
}

interface ComposerProps {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  /** Stage a picked/pasted/recorded file for preview; it isn't uploaded until
   *  Send. `durationMs` is set only for voice recordings. */
  onStageFile: (file: File, durationMs?: number) => void;
  /** The file currently staged for sending, if any. */
  stagedFile: File | null;
  /** Length of the staged recording, when the staged file is a voice note. */
  stagedDurationMs: number | null;
  onClearStaged: () => void;
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
}

// Shared with MessageBubble's edit textarea, which reuses this exact
// grow-to-fit algorithm rather than inventing a second one.
export const MAX_TEXTAREA_PX = 160; // ~6 lines

/** How far the finger must travel from the mic button, while holding, to arm
 *  the cancel. Roughly a thumb's width — far enough not to trigger on the
 *  drift of holding still. */
const CANCEL_SLIDE_PX = 60;

/** How long the "hold to record" nudge stays up after a too-short tap. */
const HINT_MS = 1800;

export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    value,
    onChange,
    onSend,
    onStageFile,
    stagedFile,
    stagedDurationMs,
    onClearStaged,
    sending,
    uploading,
    replyingTo,
    onCancelReply,
    editing,
    onError,
  },
  ref
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);
  const cameraPhotoRef = useRef<HTMLInputElement>(null);
  const cameraVideoRef = useRef<HTMLInputElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [attachOpen, setAttachOpen] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  // Whether the staged recording is the one the meter heard nothing during.
  const [silentTake, setSilentTake] = useState(false);

  // Probed once: neither answer changes without a reload in practice, and
  // re-running matchMedia on every render would be noise.
  const [cameraCapable] = useState(supportsCameraCapture);
  const [voiceCapable] = useState(voiceRecordingSupported);
  const [holdToRecord] = useState(isCoarsePointer);

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
  }));

  const isAudio = !!stagedFile?.type.startsWith('audio/');

  // A local object URL to preview the staged image/video; revoked on change.
  // Voice notes get their duration rendered instead, so they need no URL.
  useEffect(() => {
    // The warning belongs to one recording. Anything else taking the staged
    // slot, including a photo, clears it.
    if (!stagedFile) setSilentTake(false);
    if (!stagedFile || stagedFile.type.startsWith('audio/')) {
      setPreviewUrl(null);
      return;
    }
    setSilentTake(false);
    const url = URL.createObjectURL(stagedFile);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [stagedFile]);

  useEffect(() => {
    if (!hint) return;
    const timer = setTimeout(() => setHint(null), HINT_MS);
    return () => clearTimeout(timer);
  }, [hint]);

  const handleRecorded = useCallback(
    (recording: VoiceRecording | null) => {
      // Null means the recording was too short to be anything but a mis-tap.
      if (!recording) {
        setHint('Hold to record');
        return;
      }
      // A microphone that is muted, or held by another app, still yields a
      // perfectly valid file of nothing at all. Stage it anyway and say so on
      // the preview: the meter can be wrong, and a recording someone means to
      // send is not ours to throw away.
      setSilentTake(recording.silent);
      onStageFile(recording.file, recording.durationMs);
    },
    [onStageFile]
  );

  const recorder = useVoiceRecorder(handleRecorded);

  // Where a press-and-hold started, and whether the finger has slid far enough
  // to mean "throw this away". The ref is what the release handler reads —
  // the state exists only to render the warning.
  const holdOriginRef = useRef<{ x: number; y: number } | null>(null);
  const cancelArmedRef = useRef(false);
  const [cancelArmed, setCancelArmed] = useState(false);
  // A release that lands before `start` has resolved. Without this, a quick
  // tap would leave the recorder running with nothing left to stop it.
  const pendingReleaseRef = useRef<'none' | 'stop' | 'cancel'>('none');

  const busy = sending || uploading;
  const canSend = !busy && (!!value.trim() || !!stagedFile);
  // While recording the button has to stay the mic, whatever else is in the
  // composer — it is the element the finger is still holding. An edit in
  // progress otherwise claims the slot for its checkmark: recording a voice
  // note is not one of the things you can do to a message you are rewriting.
  const showMic = recorder.recording || (!editing && !canSend && voiceCapable && !busy);
  // Recording outranks editing in the row below for the same reason: the mic
  // may already be live and holding a pointer capture.
  const editBar = editing && !recorder.recording ? editing : null;

  /** Reset the gesture bookkeeping, then start. Callers own the reset because
   *  the release that `beginRecording` reads back may land while `start` is
   *  still awaiting permission. */
  function armRecording() {
    pendingReleaseRef.current = 'none';
    cancelArmedRef.current = false;
    setCancelArmed(false);
    void beginRecording();
  }

  async function beginRecording() {
    const failure = await recorder.start();
    if (failure) {
      holdOriginRef.current = null;
      pendingReleaseRef.current = 'none';
      onError(
        failure === 'denied'
          ? `Microphone access is off. Turn it on in ${permissionSettingsLocation()}.`
          : failure === 'unsupported'
            ? 'Voice messages are not supported on this device.'
            : 'Could not start recording.'
      );
      return;
    }

    if (pendingReleaseRef.current === 'cancel') recorder.cancel();
    else if (pendingReleaseRef.current === 'stop') recorder.stop();
    pendingReleaseRef.current = 'none';
  }

  function finishRecording(discard: boolean) {
    pendingReleaseRef.current = discard ? 'cancel' : 'stop';
    if (discard) recorder.cancel();
    else recorder.stop();
    holdOriginRef.current = null;
    cancelArmedRef.current = false;
    setCancelArmed(false);
  }

  function handleMicPointerDown(e: React.PointerEvent<HTMLButtonElement>) {
    if (!holdToRecord || busy) return;
    // Capture so the slide-to-cancel still reports moves once the finger has
    // left the button, and so the release always comes back here.
    e.currentTarget.setPointerCapture(e.pointerId);
    holdOriginRef.current = { x: e.clientX, y: e.clientY };
    armRecording();
  }

  function handleMicPointerMove(e: React.PointerEvent<HTMLButtonElement>) {
    const origin = holdOriginRef.current;
    if (!origin) return;
    const armed = origin.x - e.clientX > CANCEL_SLIDE_PX || origin.y - e.clientY > CANCEL_SLIDE_PX;
    if (armed !== cancelArmedRef.current) {
      cancelArmedRef.current = armed;
      setCancelArmed(armed);
    }
  }

  function handleMicPointerUp() {
    if (!holdOriginRef.current) return;
    finishRecording(cancelArmedRef.current);
  }

  /** The gesture was taken away (a system scroll, a call arriving). Nothing
   *  about that says "send", so the recording is dropped. */
  function handleMicPointerCancel() {
    if (!holdOriginRef.current) return;
    finishRecording(true);
  }

  function handleMicClick() {
    // On touch the press/release pair already drove the recording; this click
    // is the tail of that same gesture.
    if (holdToRecord) return;
    if (recorder.recording) finishRecording(false);
    else armRecording();
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
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) onStageFile(file);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    onStageFile(file);
  }

  function openAttach() {
    // Without a camera behind `capture`, the sheet would offer two entries
    // that both land in the filesystem — so on desktop the paperclip stays a
    // one-tap file picker.
    if (cameraCapable) setAttachOpen(true);
    else libraryRef.current?.click();
  }

  const stagedKind = isAudio ? 'Voice message' : stagedFile?.type.startsWith('video/') ? 'Video' : 'Image';

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="p-3 sm:p-4 pb-[calc(0.75rem+var(--safe-bottom))] sm:pb-[calc(1rem+var(--safe-bottom))] bg-base-100 border-t border-base-content/5 shrink-0"
    >
      {replyingTo && (
        <div className="flex items-center gap-2 mb-2 px-3 py-2 rounded-lg bg-base-200/70 border-l-2 border-primary">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-primary">Replying to {replyingTo.display_name}</p>
            <p className="text-xs text-base-content/60 truncate">{replyingTo.snippet}</p>
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

      {stagedFile && (isAudio || previewUrl) && (
        <div className="flex items-center gap-3 mb-2 p-2 rounded-lg bg-base-200/70 border border-base-content/10">
          <div className="relative shrink-0">
            {isAudio ? (
              <div className="w-16 h-16 rounded-md bg-primary/15 text-primary flex items-center justify-center">
                <Mic className="w-6 h-6" />
              </div>
            ) : stagedFile.type.startsWith('video/') ? (
              <video
                src={previewUrl ?? undefined}
                className="w-16 h-16 rounded-md object-cover bg-black"
                muted
              />
            ) : (
              <img
                src={previewUrl ?? undefined}
                alt="Attachment preview"
                className="w-16 h-16 rounded-md object-cover"
              />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate">
              {isAudio ? 'Voice message' : stagedFile.name}
            </p>
            {/* The name above already says which kind this is for a voice note,
                so repeating it here left the preview reading "Voice message /
                Voice message · 0:03". */}
            <p className="text-xs text-base-content/60">
              {isAudio
                ? stagedDurationMs !== null
                  ? formatDuration(stagedDurationMs)
                  : 'Recorded'
                : `${stagedKind} · ${(stagedFile.size / (1024 * 1024)).toFixed(1)} MB`}{' '}
              · press Send
            </p>
            {silentTake && (
              <p className="mt-0.5 text-xs text-warning">
                No sound came through. Check the microphone before you send this.
              </p>
            )}
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-circle"
            onClick={onClearStaged}
            disabled={busy}
            title="Remove attachment"
            aria-label="Remove attachment"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <input
        ref={libraryRef}
        type="file"
        accept="image/*,video/*"
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
              className={`btn btn-ghost btn-square ${cancelArmed ? 'text-error' : ''}`}
              onClick={() => finishRecording(true)}
              title="Discard recording"
              aria-label="Discard recording"
            >
              <Trash2 className="w-5 h-5" />
            </button>

            <div className="flex-1 flex items-center gap-2 min-w-0 h-12" aria-live="polite">
              {/* motion-recording swaps the flat opacity pulse for emitted
                  rings under the expressive set — see index.css. */}
              <span className="motion-recording w-2.5 h-2.5 rounded-full bg-error animate-pulse shrink-0" />
              <span className="font-mono text-sm tabular-nums">
                {formatDuration(recorder.elapsedMs)}
              </span>
              {/* The one thing on screen that proves the microphone is picking
                  anything up. Recording silence looks identical to recording a
                  voice right up until the moment it is played back. */}
              <span
                className="h-4 flex-1 min-w-8 max-w-24 overflow-hidden rounded-full bg-base-content/10"
                role="meter"
                aria-label="Microphone level"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(recorder.level * 100)}
              >
                <span
                  className="block h-full rounded-full bg-error transition-[width] duration-100 ease-out"
                  style={{ width: `${Math.max(2, recorder.level * 100)}%` }}
                />
              </span>
              <span className="text-xs text-base-content/60 truncate">
                {cancelArmed
                  ? 'Release to cancel'
                  : holdToRecord
                    ? 'Slide away to cancel'
                    : `Recording · ${formatDuration(MAX_VOICE_MS)} max`}
              </span>
            </div>
          </>
        ) : editBar ? (
          <>
            {/* The narrowed "typing box". It is a label, not an input: the text
                is being typed in the bubble, and a second box to type in here
                would be two carets asking for the same message. */}
            <div className="flex-1 min-w-0 flex items-center gap-2 h-12 px-4 rounded-2xl bg-base-300 border border-base-content/10">
              <Pencil className="w-4 h-4 shrink-0 text-primary" aria-hidden />
              <span className="text-sm truncate text-base-content/70">Editing message</span>
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-circle"
              onClick={editBar.onCancel}
              disabled={editBar.saving}
              title="Cancel edit"
              aria-label="Cancel edit"
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
              title="Attach a photo or video"
              aria-label="Attach a photo or video"
            >
              <Paperclip className="w-5 h-5" />
            </button>

            <button
              ref={emojiBtnRef}
              type="button"
              className="btn btn-ghost btn-square"
              onClick={() => setEmojiOpen((o) => !o)}
              title="Emoji"
              aria-label="Insert emoji"
              aria-expanded={emojiOpen}
            >
              <Smile className="w-5 h-5" />
            </button>
            <EmojiPopover
              open={emojiOpen}
              anchorRef={emojiBtnRef}
              onSelect={insertEmoji}
              onClose={() => setEmojiOpen(false)}
            />

            <textarea
              ref={textareaRef}
              rows={1}
              maxLength={MAX_MESSAGE_LENGTH}
              placeholder={stagedFile ? 'Add a caption...' : 'Type a message...'}
              className="textarea flex-1 resize-none min-h-0 leading-6 py-2.5 px-4 rounded-2xl bg-base-300 border border-base-content/10 focus:border-primary/60 focus:bg-base-300 focus:outline-none transition-colors"
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
            className={`btn btn-circle touch-none select-none ${
              recorder.recording ? 'btn-error' : 'btn-primary'
            }`}
            onPointerDown={handleMicPointerDown}
            onPointerMove={handleMicPointerMove}
            onPointerUp={handleMicPointerUp}
            onPointerCancel={handleMicPointerCancel}
            onClick={handleMicClick}
            onContextMenu={(e) => e.preventDefault()}
            title={
              recorder.recording
                ? holdToRecord
                  ? 'Release to send'
                  : 'Finish recording'
                : holdToRecord
                  ? 'Hold to record a voice message'
                  : 'Record a voice message'
            }
            aria-label={recorder.recording ? 'Finish recording' : 'Record a voice message'}
          >
            {recorder.recording ? (
              <Send className="w-[18px] h-[18px]" />
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
            title={editBar ? 'Save changes' : 'Send'}
            aria-label={editBar ? 'Save changes' : 'Send message'}
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

      {hint && <p className="mt-1.5 text-center text-xs text-base-content/60">{hint}</p>}
    </form>
  );
});
