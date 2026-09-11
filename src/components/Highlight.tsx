/**
 * The searched-for words, marked inside the line they were found in.
 *
 * Shared by the conversation search and the search across all of them, so the
 * two cannot drift on what counts as a match — a result list that highlights
 * differently from the one beside it reads as one of them being wrong.
 */

/** Regex metacharacters that would otherwise break `new RegExp` below —
 *  distinct from the SQL LIKE metacharacters the query escapes. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  // Splitting on a capturing group keeps the matched substrings themselves in
  // the output array (at the odd indices), so no separate matching pass over
  // the string is needed to know which piece to wrap.
  const parts = text.split(new RegExp(`(${escapeRegExp(needle)})`, 'gi'));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-warning/30 text-base-content rounded px-0.5">
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  );
}
