import type { ReactNode } from 'react';
import { linkify } from '../lib/linkify';
import { findMentions } from '../lib/mentions';

interface MessageTextProps {
  text: string;
  /** Display names present in this conversation. Only a name somebody here
   *  actually holds is a mention; `@anything` else is text they typed. Rooms
   *  pass their member list, 1:1 threads pass nothing. */
  handles?: string[];
  /** My own display name, so a mention of me can be marked more strongly than
   *  a mention of somebody else. */
  myHandle?: string;
}

/** Splits a plain segment on the mentions inside it. Links are left alone —
 *  `linkify` decides what a link is, and running a second matcher inside one
 *  is how the two would start disagreeing. */
function withMentions(value: string, handles: string[], myHandle: string, key: string): ReactNode[] {
  const mentions = findMentions(value, handles);
  if (mentions.length === 0) return [<span key={key}>{value}</span>];

  const out: ReactNode[] = [];
  let cursor = 0;
  for (const [i, mention] of mentions.entries()) {
    if (mention.start > cursor) {
      out.push(<span key={`${key}-t${i}`}>{value.slice(cursor, mention.start)}</span>);
    }
    const isMe = !!myHandle && mention.handle.toLowerCase() === myHandle.toLowerCase();
    out.push(
      <span
        key={`${key}-m${i}`}
        className={
          isMe
            ? 'rounded px-0.5 font-semibold bg-primary/25 text-primary'
            : 'font-semibold opacity-90'
        }
      >
        {value.slice(mention.start, mention.end)}
      </span>
    );
    cursor = mention.end;
  }
  if (cursor < value.length) out.push(<span key={`${key}-tail`}>{value.slice(cursor)}</span>);
  return out;
}

/** Renders a message body with any `http(s)://` or `www.` URL turned into a
 *  clickable link; everything else stays plain text (see `linkify`'s own
 *  comment for why that whitelist is the security boundary here). */
export function MessageText({ text, handles, myHandle }: MessageTextProps) {
  const segments = linkify(text);

  return (
    <div>
      {segments.map((segment, i) =>
        segment.type === 'link' ? (
          <a
            key={i}
            href={segment.href}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 break-all hover:opacity-80"
            // A link tap shouldn't also toggle the bubble's action toolbar
            // underneath it.
            onClick={(e) => e.stopPropagation()}
          >
            {segment.value}
          </a>
        ) : handles && handles.length > 0 ? (
          withMentions(segment.value, handles, myHandle ?? '', String(i))
        ) : (
          <span key={i}>{segment.value}</span>
        )
      )}
    </div>
  );
}
