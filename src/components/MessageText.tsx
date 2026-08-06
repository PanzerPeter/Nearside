import { linkify } from '../lib/linkify';

interface MessageTextProps {
  text: string;
}

/** Renders a message body with any `http(s)://` or `www.` URL turned into a
 *  clickable link; everything else stays plain text (see `linkify`'s own
 *  comment for why that whitelist is the security boundary here). */
export function MessageText({ text }: MessageTextProps) {
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
        ) : (
          <span key={i}>{segment.value}</span>
        )
      )}
    </div>
  );
}
