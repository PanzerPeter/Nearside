import { useCallback, useEffect, useState } from 'react';
import {
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  ShieldCheck,
  SwitchCamera,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useCall } from '../hooks/useCall';
import { Avatar } from './Avatar';
import { callDuration, endLabel, formatDuration } from '../lib/call/state';
import { useT } from '../hooks/useT';

/**
 * Attach a stream to a `<video>`, on every element that asks for it.
 *
 * A callback ref rather than an effect over `useRef`. An effect keyed on the
 * stream never re-runs when React swaps one `<video>` for another while the
 * stream stays the same — which is exactly what turning the camera off and back
 * on does — and the fresh element is left with no `srcObject` at all, rendering
 * the WebView's broken-media placeholder where the self-view should be. React
 * calls this on every mount, so a new element is always fed.
 *
 * The `!==` guard is what keeps it cheap: assigning the same stream twice
 * restarts playback, which on a video call reads as a flicker.
 */
function useStream(stream: MediaStream | null) {
  return useCallback(
    (element: HTMLVideoElement | null) => {
      if (element && element.srcObject !== stream) element.srcObject = stream;
    },
    [stream]
  );
}

/** One control in the bottom row. */
function CallButton({
  label,
  onClick,
  active,
  danger,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const tone = danger
    ? 'bg-error text-error-content hover:bg-error/90'
    : active
      ? 'bg-base-content text-base-100'
      : 'bg-base-content/15 text-base-content hover:bg-base-content/25';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors ${tone}`}
    >
      {children}
    </button>
  );
}

/**
 * The call, over everything.
 *
 * Mounted app-wide rather than inside a conversation: a call outlives the chat
 * that started it, and one answered from a notification has no chat open at
 * all. Renders nothing at all while idle, so the ordinary app pays nothing for
 * this being here.
 */
export function CallScreen() {
  const t = useT();
  const {
    state,
    localStream,
    remoteStream,
    accept,
    decline,
    hangup,
    toggleMute,
    toggleCamera,
    flipCamera,
    toggleSpeaker,
    dismiss,
  } = useCall();

  const localRef = useStream(localStream);
  const remoteRef = useStream(remoteStream);

  // Only to re-render the duration readout. A second is the resolution shown,
  // so a second is what it costs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.phase !== 'active') return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [state.phase]);

  if (state.phase === 'idle') return null;

  const video = state.kind === 'video';
  const ringing = state.phase === 'ringing';
  const ended = state.phase === 'ended';
  const seconds = callDuration(state, now);

  /**
   * Whether there is a picture to show.
   *
   * `remoteVideo` alone is not the question. The call releases its streams the
   * moment it ends — the camera must not stay lit while someone reads "call
   * ended" — which left a `<video>` with no source on screen for the four
   * seconds the ended card lingers, and a WebView draws that as its own broken
   * media placeholder: a grey play button over the whole call.
   */
  const showRemote = video && state.remoteVideo && remoteStream !== null && !ended;

  const status = ended
    ? endLabel(state)
    : state.phase === 'dialing'
      ? t('call.calling')
      : ringing
        ? video
          ? t('call.incomingVideo')
          : t('call.incomingVoice')
        : state.phase === 'connecting'
          ? t('chat.connecting')
          : seconds !== null
            ? formatDuration(seconds)
            : t('call.connected');

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-base-300 text-base-content"
      style={{
        paddingTop: 'var(--safe-top)',
        paddingBottom: 'var(--safe-bottom)',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={
        video
          ? t('call.withVideo', { name: state.peerName })
          : t('call.withVoice', { name: state.peerName })
      }
    >
      {/* One element, shown or hidden — never unmounted. It carries the remote
          audio as well as the picture, so swapping it out the moment a video
          track arrives would cut the sound to raise the image. `remoteVideo`
          rather than `kind` decides whether it is shown: a video call whose peer
          denied the camera has to render something, and a black rectangle is
          not it. */}
      <video
        ref={remoteRef}
        autoPlay
        playsInline
        className={showRemote ? 'absolute inset-0 w-full h-full object-cover bg-black' : 'hidden'}
      />

      <div className="relative flex-1 flex flex-col items-center justify-center gap-4 px-6 text-center">
        {!showRemote && (
          <>
            <div className="motion-float">
              <Avatar display_name={state.peerName.replace(/^@/, '')} size={112} />
            </div>
            <div>
              <p className="text-2xl font-semibold">{state.peerName}</p>
              <p className="mt-1 text-base-content/60">{status}</p>
            </div>
            {/* The claim this app is built on, said at the moment it matters
                most — and true here without qualification: the keys come out
                of a handshake between the two phones and no server holds one. */}
            {!ended && (
              <p className="inline-flex items-center gap-1.5 text-xs text-base-content/50">
                <ShieldCheck className="w-3.5 h-3.5" />
                {t('call.e2ee')}
              </p>
            )}
          </>
        )}

        {showRemote && (
          <div className="absolute top-4 left-0 right-0 flex flex-col items-center gap-1">
            <p className="rounded-full bg-base-300/70 px-3 py-1 text-sm font-medium backdrop-blur">
              {state.peerName}
            </p>
            <p className="rounded-full bg-base-300/60 px-2.5 py-0.5 text-xs text-base-content/80 backdrop-blur">
              {status}
            </p>
          </div>
        )}
      </div>

      {/* Own camera, small, and mirrored the way a mirror is — an unmirrored
          self-view has people reaching the wrong way to adjust the frame. The
          back camera is not mirrored, because it is not a mirror: it shows the
          room in front of you, and flipping that left for right is simply
          wrong. Hidden rather than unmounted while the camera is off: the track
          is only disabled, and tearing the element down means rebuilding it
          with no stream attached. */}
      {video && localStream && (
        <video
          ref={localRef}
          autoPlay
          playsInline
          muted
          className={`absolute right-4 w-28 aspect-[3/4] rounded-xl object-cover bg-black shadow-overlay${
            state.facing === 'user' ? ' -scale-x-100' : ''
          }${state.cameraOff ? ' hidden' : ''}`}
          style={{ top: 'calc(1rem + var(--safe-top))' }}
        />
      )}

      {/* Wraps, because a video call carries five controls and five of these
          side by side do not fit across a narrow phone. */}
      <div className="relative flex flex-wrap items-center justify-center gap-3 px-4 pb-8 pt-4">
        {ringing ? (
          <>
            <CallButton label={t('requests.decline')} onClick={decline} danger>
              <PhoneOff className="w-6 h-6" />
            </CallButton>
            <CallButton label={t('call.answer')} onClick={accept} active>
              <Phone className="w-6 h-6" />
            </CallButton>
          </>
        ) : ended ? (
          <button type="button" className="btn btn-ghost" onClick={dismiss}>
            {t('common.close')}
          </button>
        ) : (
          <>
            <CallButton
              label={state.muted ? t('call.unmute') : t('call.mute')}
              onClick={toggleMute}
              active={state.muted}
            >
              {state.muted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </CallButton>
            <CallButton
              label={state.speaker ? t('call.speakerOff') : t('call.speakerOn')}
              onClick={toggleSpeaker}
              active={state.speaker}
            >
              {state.speaker ? <Volume2 className="w-6 h-6" /> : <VolumeX className="w-6 h-6" />}
            </CallButton>
            {video && (
              <CallButton
                label={state.cameraOff ? t('call.cameraOn') : t('call.cameraOff')}
                onClick={toggleCamera}
                active={state.cameraOff}
              >
                {state.cameraOff ? <VideoOff className="w-6 h-6" /> : <Video className="w-6 h-6" />}
              </CallButton>
            )}
            {/* Only while the camera is on: there is nothing to turn around
                when the picture is off, and a control that visibly does
                nothing is worse than one that is not there. */}
            {video && !state.cameraOff && (
              <CallButton
                label={state.facing === 'user' ? t('call.backCamera') : t('call.frontCamera')}
                onClick={flipCamera}
              >
                <SwitchCamera className="w-6 h-6" />
              </CallButton>
            )}
            <CallButton label={t('call.end')} onClick={hangup} danger>
              <PhoneOff className="w-6 h-6" />
            </CallButton>
          </>
        )}
      </div>
    </div>
  );
}
