// What this device is holding, in numbers a person can act on.
//
// Everything the storage screen shows is local: the decrypted mirror search
// reads from, the pinned attachments that outlive the server's prune, and the
// in-memory media cache. None of it exists on the server, so none of it can be
// answered by a query — it has to be measured here.
//
// The arithmetic lives apart from the measuring because the measuring is
// `Filesystem.stat` and a SQLite count, neither of which a node test can reach.

/** Bytes for one pinned file, or null when the file could not be measured —
 *  the row is in the mirror but the sandbox has no file at that path. */
export type PinSize = number | null;

export interface PinTotals {
  /** Pins whose bytes are counted below. */
  files: number;
  bytes: number;
  /** Pins whose file could not be read. Reported rather than folded into
   *  `files` as a zero: a total that quietly under-counts is worse than one
   *  that admits it is short. */
  unmeasured: number;
}

export function totalPinBytes(sizes: readonly PinSize[]): PinTotals {
  let files = 0;
  let bytes = 0;
  let unmeasured = 0;
  for (const size of sizes) {
    if (size === null || !Number.isFinite(size) || size < 0) {
      unmeasured += 1;
      continue;
    }
    files += 1;
    bytes += size;
  }
  return { files, bytes, unmeasured };
}

const UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/**
 * A size to read at a glance, not to audit.
 *
 * Binary units under decimal names, which is what every phone's own storage
 * screen shows — matching the file manager the user will check this against
 * matters more here than matching the SI.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Whole bytes never gain a decimal point; anything larger keeps one digit
  // until it is big enough that the digit is noise.
  const digits = unit === 0 ? 0 : value >= 100 ? 0 : 1;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** "3 messages" / "1 message" — the readout is full of counted nouns and a
 *  stray "1 messages" undercuts a screen whose whole job is being precise. */
export function plural(count: number, noun: string, plural = `${noun}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : plural}`;
}
