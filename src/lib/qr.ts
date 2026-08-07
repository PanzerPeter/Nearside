// Turning a string into the module grid of a QR code.
//
// Split out of `components/QrCode.tsx` so the geometry can be tested without a
// DOM. The thing worth testing is not that a path comes back — it is the quiet
// zone, which is invisible, which is why it was missing.
import qrcode from 'qrcode-generator';

/**
 * Modules of light margin around the code, per ISO/IEC 18004.
 *
 * Four is not decoration. A scanner locates the three finder patterns by their
 * 1:1:3:1:1 run of light and dark, and a code butted against dark UI has no
 * light run to find on the outer edge — it renders perfectly and scans never.
 * The white padding on the container is not a substitute: it was 12 CSS pixels
 * against a ~5px module, which is under half the required margin.
 */
export const QUIET_ZONE = 4;

export interface QrMatrix {
  /** One SVG path of unit squares, offset by the quiet zone. */
  d: string;
  /** Side length in modules, quiet zone included — the SVG viewBox. */
  size: number;
  /** Side length of the code itself, without the margin. */
  modules: number;
}

/**
 * The grid for `text`, as a single path.
 *
 * One `<path>` rather than one `<rect>` per module: a connect payload is around
 * forty modules a side, which is sixteen hundred elements React would otherwise
 * reconcile on every render.
 */
export function qrMatrix(text: string, quietZone: number = QUIET_ZONE): QrMatrix {
  // Type 0 picks the smallest version that fits. 'M' tolerates ~15% damage,
  // which is what makes a code readable off a fingerprinted phone screen.
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const modules = qr.getModuleCount();
  let d = '';
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (qr.isDark(row, col)) {
        d += `M${col + quietZone},${row + quietZone}h1v1h-1z`;
      }
    }
  }

  return { d, size: modules + quietZone * 2, modules };
}
