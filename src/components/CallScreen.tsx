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
import { supabase } from '../lib/supabase';
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

/**
 * The peer's picture, fetched here rather than carried on the call.
 *
 * Deliberately not threaded through `CallState`: the call is placed from four
 * different screens and answered from a notification that carries nothing but
 * an id, so the state would have to hold a field three of those paths could not
 * fill. A face is decoration — it may arrive a moment after the ring, and on
 * the wake path nothing may wait for it. Cleared on every peer change, or the
 * last caller's face sits on the next call for as long as the query takes.
 */
function usePeerAvatar(peerId: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!peerId) return;
    let live = true;
    void supabase
      .from('profiles')
      .select('avatar_url')
      .eq('id', peerId)
      .maybeSingle()
      .then(({ data }) => {
        if (live) setUrl(data?.avatar_url ?? null);
      });
    return () => {
      live = false;
    };
  }, [peerId]);
  return url;
}

/**
 * One control in the bottom row.
 *
 * `overlay` is not a style preference: over a remote picture the app's theme
 * colours are the wrong contrast reference — a light pack's controls vanish
 * against a bright frame and a dark pack's against a dim one. Anything drawn
 * on top of video is white-on-glass, which holds against both.
 */
function CallButton({
  label,
  onClick,
  active,
  danger,
  overlay,
  size = 'md',
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  overlay?: boolean;
  size?: 'md' | 'lg';
  children: React.ReactNode;
}) {
  const tone = danger
    ? 'bg-error text-error-content hover:brightness-110 shadow-overlay'
    : active
      ? overlay
        ? 'bg-white text-neutral-900'
        : 'bg-base-content text-base-100'
      : overlay
        ? 'bg-white/15 text-white hover:bg-white/25 backdrop-blur-sm'
        : 'bg-base-content/10 text-base-content hover:bg-base-content/20';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={label}
      className={`${size === 'lg' ? 'w-16 h-16' : 'w-14 h-14'} rounded-full flex items-center justify-center transition-[background-color,transform,filter] active:scale-95 ${tone}`}
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
  const peerAvatar = usePeerAvatar(state.peerId);

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
  // The two phases where nothing is connected yet and the screen is waiting on
  // a person rather than on the network.
  const pending = ringing || state.phase === 'dialing';

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
      className="fixed inset-0 z-50 overflow-hidden bg-base-300 text-base-content"
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

      {/* Full-bleed, and therefore outside the safe-area padding below: a scrim
          that stops at the status bar leaves the name sitting on bare picture
          for the one strip where the picture is brightest. Black on both
          counts — over video the theme is the wrong contrast reference. */}
      {showRemote ? (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/70 to-transparent" />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/75 to-transparent" />
        </>
      ) : (
        /* A flat slab with a circle in the middle of it reads as a placeholder.
           One soft pool of light behind the avatar gives the screen a centre,
           and it is drawn from the theme's own ink so it lands on every pack. */
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(80% 46% at 50% 30%, color-mix(in oklab, var(--color-base-content) 9%, transparent), transparent 72%)',
          }}
        />
      )}

      <div
        className="relative flex h-full flex-col"
        style={{
          paddingTop: 'var(--safe-top)',
          paddingBottom: 'var(--safe-bottom)',
        }}
      >
        {showRemote ? (
          /* Over the picture the caller's name is chrome, not the subject: one
             quiet line at the top rather than the centre of the screen. */
          <div className="px-6 pt-4 text-center text-white drop-shadow-md">
            <p className="text-title font-semibold">{state.peerName}</p>
            <p className="mt-0.5 text-meta text-white/75 tabular-nums">{status}</p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
            {/* The halo is only ever on while the call is waiting for a person
                to act. Once it is connected the screen has a running clock,
                and a pulse beside it is decoration claiming to be status. */}
            <div className={`relative flex rounded-full${pending ? ' motion-call-halo' : ''}`}>
              <Avatar
                display_name={state.peerName.replace(/^@/, '')}
                url={peerAvatar}
                size={128}
                className="ring-1 ring-hairline-strong shadow-overlay"
              />
            </div>
            <div>
              <p className="text-display font-semibold">{state.peerName}</p>
              <p className="mt-1.5 text-muted tabular-nums">{status}</p>
            </div>
            {/* The claim this app is built on, said at the moment it matters
                most — and true here without qualification: the keys come out
                of a handshake between the two phones and no server holds one. */}
            {!ended && (
              <p className="inline-flex items-center gap-1.5 rounded-full bg-base-content/8 px-3 py-1 text-meta text-muted">
                <ShieldCheck className="w-3.5 h-3.5" />
                {t('call.e2ee')}
              </p>
            )}
          </div>
        )}

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
            className={`absolute right-4 top-4 w-28 aspect-3/4 rounded-2xl object-cover bg-black shadow-overlay ring-1 ring-white/20${
              state.facing === 'user' ? ' -scale-x-100' : ''
            }${state.cameraOff ? ' hidden' : ''}`}
          />
        )}

        <div className="px-4 pb-6 pt-4">
          {ringing ? (
            /* Answer and decline at opposite ends of the screen, not side by
               side: this row is reached for in a hurry, often one-handed, and
               the two outcomes are not ones to confuse under a thumb. */
            <div className="mx-auto flex w-full max-w-xs items-start justify-between">
              <div className="flex flex-col items-center gap-2">
                <CallButton label={t('requests.decline')} onClick={decline} danger size="lg">
                  <PhoneOff className="w-7 h-7" />
                </CallButton>
                <span className="text-meta text-muted">{t('requests.decline')}</span>
              </div>
              <div className="flex flex-col items-center gap-2">
                <button
                  type="button"
                  onClick={accept}
                  aria-label={t('call.answer')}
                  title={t('call.answer')}
                  className="motion-call-halo relative w-16 h-16 rounded-full flex items-center justify-center bg-success text-success-content shadow-overlay transition-[filter,transform] hover:brightness-110 active:scale-95"
                >
                  <Phone className="w-7 h-7" />
                </button>
                <span className="text-meta text-muted">{t('call.answer')}</span>
              </div>
            </div>
          ) : ended ? (
            <div className="flex justify-center">
              <button type="button" className="btn rounded-full px-8" onClick={dismiss}>
                {t('common.close')}
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-4">
              {/* One tray, so the toggles read as a set of switches and the
                  thing that ends the call does not read as a sixth switch. */}
              <div
                className={`flex flex-wrap items-center justify-center gap-2 rounded-full p-2 ${
                  showRemote ? 'bg-black/30 backdrop-blur-md' : 'bg-base-content/6'
                }`}
              >
                <CallButton
                  label={state.muted ? t('call.unmute') : t('call.mute')}
                  onClick={toggleMute}
                  active={state.muted}
                  overlay={showRemote}
                >
                  {state.muted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
                </CallButton>
                <CallButton
                  label={state.speaker ? t('call.speakerOff') : t('call.speakerOn')}
                  onClick={toggleSpeaker}
                  active={state.speaker}
                  overlay={showRemote}
                >
                  {state.speaker ? (
                    <Volume2 className="w-6 h-6" />
                  ) : (
                    <VolumeX className="w-6 h-6" />
                  )}
                </CallButton>
                {video && (
                  <CallButton
                    label={state.cameraOff ? t('call.cameraOn') : t('call.cameraOff')}
                    onClick={toggleCamera}
                    active={state.cameraOff}
                    overlay={showRemote}
                  >
                    {state.cameraOff ? (
                      <VideoOff className="w-6 h-6" />
                    ) : (
                      <Video className="w-6 h-6" />
                    )}
                  </CallButton>
                )}
                {/* Only while the camera is on: there is nothing to turn around
                    when the picture is off, and a control that visibly does
                    nothing is worse than one that is not there. */}
                {video && !state.cameraOff && (
                  <CallButton
                    label={state.facing === 'user' ? t('call.backCamera') : t('call.frontCamera')}
                    onClick={flipCamera}
                    overlay={showRemote}
                  >
                    <SwitchCamera className="w-6 h-6" />
                  </CallButton>
                )}
              </div>
              <CallButton label={t('call.end')} onClick={hangup} danger size="lg">
                <PhoneOff className="w-7 h-7" />
              </CallButton>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
