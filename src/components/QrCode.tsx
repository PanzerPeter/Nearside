import { useMemo } from 'react';
import { qrMatrix } from '../lib/qr';

interface QrCodeProps {
  text: string;
  size?: number;
}

/**
 * A QR as inline SVG, drawn from the module grid rather than from the
 * library's own tag builder — that one returns an HTML string, and the only
 * way to render it would be dangerouslySetInnerHTML.
 *
 * The white background and the quiet zone are inside the SVG, not on the
 * container. A caller that padded the code with a rounded white box was
 * supplying about half the margin a scanner needs, and no amount of squinting
 * at the rendered code shows that — see `lib/qr.ts`.
 */
export function QrCode({ text, size = 232 }: QrCodeProps) {
  const { d, size: side } = useMemo(() => qrMatrix(text), [text]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${side} ${side}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Connect QR code"
    >
      {/* Explicit white under explicit black: the QR must not follow the app
          theme, because a dark-mode inversion is a code no scanner reads. */}
      <rect width={side} height={side} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
