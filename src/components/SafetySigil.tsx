import type { SafetyArt } from '../lib/crypto/safety-art';

const GRID = 5;

/**
 * The safety number as a picture. Two phones showing different sigils are not
 * talking to each other — but the sigil is derived from the digits below it,
 * so it is a faster way to read the same check, not a second one.
 */
export function SafetySigil({ art, size = 120 }: { art: SafetyArt; size?: number }) {
  const cell = size / GRID;
  const fill = `oklch(0.62 0.19 ${art.hue})`;
  const accent = `oklch(0.72 0.16 ${art.accentHue})`;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`Safety sigil: ${art.words.join(', ')}`}
      className="rounded-xl bg-base-200/60"
    >
      {art.cells.map((on, i) => {
        if (!on) return null;
        const row = Math.floor(i / GRID);
        const col = i % GRID;
        return (
          <rect
            key={i}
            x={col * cell}
            y={row * cell}
            width={cell}
            height={cell}
            rx={cell * 0.28}
            // The centre column takes the accent so the mirror line is visible;
            // a fully single-colour grid reads as a texture rather than a shape.
            fill={col === 2 ? accent : fill}
          />
        );
      })}
    </svg>
  );
}
