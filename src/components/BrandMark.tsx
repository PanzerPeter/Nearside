import { useId } from 'react';

// Inlined from public/logo-source.svg rather than loaded through <img>, so the
// mark can be sized and dropped anywhere without a network request. This is
// the one component exempt from the "no hardcoded colour literals" rule: logo
// artwork renders identically everywhere instead of adapting to the theme.
//
// The drawing is "the near gap": one disc cut on the diagonal and slid apart,
// so the mark is really the sliver between the two halves. See the header of
// logo-source.svg for the rest of it, and keep the two in step — they are the
// same artwork and every icon in the repo is rendered from that file.
//
// Gradient ids are prefixed `nearside-` and suffixed with `useId()`. The prefix
// stops collisions with unrelated SVGs on the page; the per-instance suffix is
// needed because the mark renders more than once at a time, and a repeated id
// lets `url(#nearside-near)` resolve to whichever element the browser picked
// rather than this instance's own.
export function BrandMark({ size = 24, className = '' }: { size?: number; className?: string }) {
  const uid = useId();
  const bgId = `nearside-bg-${uid}`;
  const nearId = `nearside-near-${uid}`;
  const farId = `nearside-far-${uid}`;
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
        {/* The near half: lit, and the brand blue at full strength. */}
        <linearGradient id={nearId} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#93c5ff" />
          <stop offset="1" stopColor="#4a8ff7" />
        </linearGradient>
        {/* The far half: the same blue with the light taken off it. */}
        <linearGradient id={farId} x1="0.15" y1="0" x2="0.85" y2="1">
          <stop offset="0" stopColor="#2f66c4" />
          <stop offset="1" stopColor="#1d4187" />
        </linearGradient>
        <filter id={softId} x="-25%" y="-25%" width="150%" height="150%">
          <feDropShadow dx="0" dy="9" stdDeviation="13" floodColor="#000000" floodOpacity="0.32" />
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

      {/* The stroke is the same paint as the fill: it grows r=126 to r=136 and
          rounds the four right angles where each arc meets its chord, so none
          of them has to be described by hand. */}
      <g filter={`url(#${softId})`}>
        {/* Far half: below the cut, slid down-left. */}
        <path
          fill={`url(#${farId})`}
          stroke={`url(#${farId})`}
          strokeWidth="20"
          strokeLinejoin="round"
          transform="translate(-10.32 14.74)"
          d="M 359.21 328.27 A 126 126 0 0 1 152.79 183.73 Z"
        />
        {/* Near half: above the cut, slid up-right. */}
        <path
          fill={`url(#${nearId})`}
          stroke={`url(#${nearId})`}
          strokeWidth="20"
          strokeLinejoin="round"
          transform="translate(10.32 -14.74)"
          d="M 152.79 183.73 A 126 126 0 0 1 359.21 328.27 Z"
        />
      </g>
    </svg>
  );
}
