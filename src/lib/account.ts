/**
 * Whether the text typed into the delete-account confirmation matches the
 * account's username exactly, which is the only thing standing between a
 * misclick and an unrecoverable deletion.
 *
 * Case-sensitive on purpose. Usernames are stored lowercase everywhere — the
 * signup trigger lowercases them and SettingsModal normalizes before saving —
 * so a case-insensitive compare would loosen the gate without ever letting a
 * legitimate user through who a strict compare would not. Surrounding
 * whitespace is forgiven because a username can never contain any, so a
 * trailing space from a mobile keyboard is unambiguous rather than a
 * near-miss.
 */
export function confirmsUsername(typed: string, username: string): boolean {
  // An empty username can't be reached today (USERNAME_RE forbids it), but this
  // gate should fail closed rather than depend on a rule enforced elsewhere:
  // '' === '' would otherwise open it to an empty confirmation box.
  return username.length > 0 && typed.trim() === username;
}
