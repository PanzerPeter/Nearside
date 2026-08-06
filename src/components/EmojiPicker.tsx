import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  /**
   * Called when emoji-mart detects a click outside its own root. Receives the
   * native event so the caller can ignore clicks on the trigger button (which
   * otherwise close the picker on the very click that opened it).
   */
  onClickOutside: (e: MouseEvent) => void;
}

export default function EmojiPicker({ onSelect, onClickOutside }: EmojiPickerProps) {
  return (
    <Picker
      data={data}
      theme="dark"
      previewPosition="none"
      skinTonePosition="none"
      dynamicWidth
      onEmojiSelect={(e: { native: string }) => onSelect(e.native)}
      onClickOutside={onClickOutside}
    />
  );
}
