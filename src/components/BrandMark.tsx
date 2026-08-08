import { useId } from 'react';

// Inlined from public/logo-source.svg rather than loaded through <img>, so the
// mark can be sized and dropped anywhere without a network request. This is
// the one component exempt from the "no hardcoded colour literals" rule: logo
// artwork renders identically everywhere instead of adapting to the theme.
//
// Gradient and filter ids are prefixed `nearside-` and suffixed with
// `useId()`. The prefix stops collisions with unrelated SVGs on the page; the
// per-instance suffix is needed because the mark renders more than once at a
// time, and a repeated id lets `url(#nearside-bg)` resolve to whichever
// element the browser picked rather than this instance's own.
export function BrandMark({ size = 24, className = '' }: { size?: number; className?: string }) {
  const uid = useId();
  const bgId = `nearside-bg-${uid}`;
  const bubbleId = `nearside-bubble-${uid}`;
  const softId = `nearside-soft-${uid}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 512 512"
      width={size}
      height={size}
      role="img"
      aria-label="Nearside"
      className={className}
    >
      <defs>
        {/* Cool-grey canvas, matching base-200/base-300. */}
        <linearGradient id={bgId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#202225" />
          <stop offset="1" stopColor="#1a1b1e" />
        </linearGradient>
        {/* Blue brand accent (#3b82f6) with a lighter top edge. */}
        <linearGradient id={bubbleId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#60a5fa" />
          <stop offset="0.55" stopColor="#3b82f6" />
          <stop offset="1" stopColor="#2563eb" />
        </linearGradient>
        <filter id={softId} x="-20%" y="-20%" width="140%" height="140%">
          <feDropShadow dx="0" dy="10" stdDeviation="14" floodColor="#000000" floodOpacity="0.35" />
        </filter>
      </defs>

      {/* Rounded-square app tile. */}
      <rect width="512" height="512" rx="116" fill={`url(#${bgId})`} />
      <rect
        x="4"
        y="4"
        width="504"
        height="504"
        rx="112"
        fill="none"
        stroke="#ffffff"
        strokeOpacity="0.05"
        strokeWidth="2"
      />

      {/* Speech bubble, kept inside the maskable safe zone (center ~62%). */}
      <g filter={`url(#${softId})`}>
        <path
          fill={`url(#${bubbleId})`}
          d="
            M172 132
            h168
            a56 56 0 0 1 56 56
            v104
            a56 56 0 0 1 -56 56
            h-96
            l-58 46
            a10 10 0 0 1 -16 -8
            v-38
            h-2
            a56 56 0 0 1 -52 -56
            v-104
            a56 56 0 0 1 56 -56
            z"
        />
      </g>

      {/* Three conversation dots. */}
      <g fill="#1a1b1e">
        <circle cx="212" cy="240" r="17" />
        <circle cx="270" cy="240" r="17" />
        <circle cx="328" cy="240" r="17" />
      </g>
    </svg>
  );
}
