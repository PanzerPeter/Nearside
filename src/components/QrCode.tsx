import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

interface QrCodeProps {
  text: string;
  size?: number;
}

/**
 * A QR as inline SVG, drawn from the module grid rather than from the
 * library's own tag builder — that one returns an HTML string, and the only
 * way to render it would be dangerouslySetInnerHTML.
 *
 * One <path> of unit squares, not one <rect> per module: a connect payload is
 * around forty modules a side, which is sixteen hundred elements React would
 * otherwise have to reconcile every render.
 */
export function QrCode({ text, size = 200 }: QrCodeProps) {
  const { d, count } = useMemo(() => {
    // Type 0 picks the smallest version that fits; 'M' tolerates ~15% damage,
    // which is what makes a code readable off a fingerprinted phone screen.
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const modules = qr.getModuleCount();
    let path = '';
    for (let row = 0; row < modules; row += 1) {
      for (let col = 0; col < modules; col += 1) {
        if (qr.isDark(row, col)) path += `M${col},${row}h1v1h-1z`;
      }
    }
    return { d: path, count: modules };
  }, [text]);

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${count} ${count}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="Connect QR code"
    >
      {/* Explicit black on the caller's white background: the QR must not
          follow the app theme, because a dark-mode inversion is a code no
          scanner reads. */}
      <path d={d} fill="#000000" />
    </svg>
  );
}
