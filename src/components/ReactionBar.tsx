import { useEffect, useRef, useState } from 'react';
import { SmilePlus } from 'lucide-react';
import { EmojiPopover } from './EmojiPopover';

const QUICK = ['❤️', '😂', '👍', '😮', '😢', '🙏'];

interface ReactionBarProps {
  onReact: (emoji: string) => void;
  /** Reports the full emoji picker opening and closing. The picker renders in
   *  its own portal, so whatever surface hosts this row needs to know not to
   *  treat clicks in it as clicks outside itself. */
  onPickerOpenChange?: (open: boolean) => void;
}

/** The quick-reaction row at the top of a message's menu: six one-tap emoji
 *  plus a button for the full picker. */
export function ReactionBar({ onReact, onPickerOpenChange }: ReactionBarProps) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    onPickerOpenChange?.(pickerOpen);
  }, [pickerOpen, onPickerOpenChange]);

  return (
    <div className="flex items-center gap-0.5 px-1.5 py-1">
      {QUICK.map((e) => (
        <button
          key={e}
          onClick={() => onReact(e)}
          aria-label={`React with ${e}`}
          // 40px square on touch, 34px from lg up. The old size was a 20px
          // box around a `text-sm` glyph — under half the 44px minimum, six
          // of them in a row, so picking the intended emoji was a coin flip
          // on a phone and fiddly with a mouse. The hit area grows; the
          // emoji itself grows with it so the bar doesn't read as mostly
          // empty padding.
          className="flex items-center justify-center w-10 h-10 lg:w-[2.125rem] lg:h-[2.125rem] rounded-full text-xl lg:text-lg leading-none hover:bg-base-content/10 hover:scale-110 active:scale-95 transition-transform"
        >
          {e}
        </button>
      ))}
      <button
        ref={moreRef}
        onClick={() => setPickerOpen((o) => !o)}
        className="flex items-center justify-center w-10 h-10 lg:w-[2.125rem] lg:h-[2.125rem] rounded-full hover:bg-base-content/10 transition-colors"
        title="More"
        aria-label="More reactions"
      >
        <SmilePlus className="w-5 h-5 lg:w-[1.125rem] lg:h-[1.125rem]" />
      </button>
      <EmojiPopover
        open={pickerOpen}
        anchorRef={moreRef}
        onSelect={(emoji) => {
          setPickerOpen(false);
          onReact(emoji);
        }}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
