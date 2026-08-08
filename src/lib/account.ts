/**
 * Whether the text typed into the delete-account confirmation matches the
 * account's display_name exactly, which is the only thing standing between a
 * misclick and an unrecoverable deletion.
 *
 * Case-sensitive on purpose. Usernames are stored lowercase everywhere: the
 * signup trigger lowercases them and SettingsModal normalizes before saving.
 * A case-insensitive compare would loosen the gate without letting through
 * anyone a strict compare turns away. Surrounding whitespace is forgiven,
 * because a stored display name is already trimmed and a trailing space from a
 * mobile keyboard is unambiguous rather than a near miss.
 */
export function confirmsUsername(typed: string, display_name: string): boolean {
  // An empty display name can't be reached today (signup rejects one), but this
  // gate should fail closed rather than depend on a rule enforced elsewhere:
  // '' === '' would otherwise open it to an empty confirmation box.
  return display_name.length > 0 && typed.trim() === display_name;
}
