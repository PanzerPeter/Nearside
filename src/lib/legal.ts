// Facts the Terms and the Privacy Policy both state, held in one place so the
// two documents cannot disagree with each other.
import type { ReactNode } from 'react';

/**
 * A titled part of a legal document.
 *
 * The heading and the jump index are rendered from the same array, so a
 * section cannot exist without an index entry or an index entry point at a
 * heading that was renamed. The alternative is a hand-written list of links,
 * which drifts on the first edit and does it silently.
 */
export interface LegalSection {
  /** Unique within its document, and used as the DOM id the index scrolls to. */
  id: string;
  title: string;
  body: ReactNode;
}

export const LAST_UPDATED = 'August 13, 2026';

/**
 * The address a data request actually reaches.
 *
 * Google Play requires a contact on the listing, and a privacy policy
 * describing rights it offers no route to exercise is worse than one that
 * promises less. Should this ever go back to the placeholder, both documents
 * say so in the app rather than printing an address that bounces. See
 * `CONTACT_EMAIL_IS_PLACEHOLDER`.
 */
export const PLACEHOLDER_EMAIL = 'you@example.com';

// Annotated `string`, not left to inference: against the literal type of a real
// address, the comparison below narrows to `never` and tsc rejects the file.
export const CONTACT_EMAIL: string = 'Hi.Nearside@protonmail.com';

export const CONTACT_EMAIL_IS_PLACEHOLDER = CONTACT_EMAIL === PLACEHOLDER_EMAIL;

/** Where the Supabase project runs. Named because "the EU" is a claim someone
 *  may rely on, and eu-west-3 is Paris. */
export const HOSTING_REGION = 'Paris, France (Supabase region eu-west-3)';
