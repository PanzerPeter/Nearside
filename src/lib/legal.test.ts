import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { privacySections } from '../components/LegalPrivacy';
import { termsSections } from '../components/LegalTerms';
import { CONTACT_EMAIL, CONTACT_EMAIL_IS_PLACEHOLDER, PLACEHOLDER_EMAIL } from './legal';

const DOCUMENTS: [string, typeof termsSections][] = [
  ['terms', termsSections],
  ['privacy', privacySections],
];

describe.each(DOCUMENTS)('%s sections', (_name, sections) => {
  it('gives every section a distinct id', () => {
    // The id is the DOM id the jump index scrolls to. Two sections sharing one
    // means half the index silently lands on the wrong heading.
    expect(new Set(sections.map((s) => s.id)).size).toBe(sections.length);
  });

  it('uses ids that are valid as a query selector', () => {
    // `jump` looks the heading up with `querySelector('#' + id)`, which throws
    // on an id starting with a digit or holding a space, and takes the whole
    // modal down with it.
    for (const section of sections) expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  it('titles every section', () => {
    // The title is both the heading and the index entry, so an empty one is an
    // invisible row in a list of links.
    for (const section of sections) expect(section.title.trim()).not.toBe('');
  });

  it('has a body for every section', () => {
    for (const section of sections) expect(section.body).toBeTruthy();
  });
});

describe('processors', () => {
  // Every company that receives anything has to be named in the policy. This
  // reads the source rather than the rendered text because the suite runs in
  // node with no DOM. It is a drift guard, so that removing a disclosure takes
  // a deliberate edit to this list rather than a quiet deletion.
  const source = readFileSync('src/components/LegalPrivacy.tsx', 'utf8');

  for (const company of [
    'Supabase',
    'OneSignal',
    'Firebase Cloud Messaging',
    'Crashlytics',
    'Cloudflare',
    'RevenueCat',
    'ML Kit',
  ]) {
    it(`names ${company}`, () => {
      expect(source).toContain(company);
    });
  }

  it('says a call exposes an IP address to the other person', () => {
    // The single most surprising consequence of peer-to-peer media, and the
    // one a reader is most entitled to be told about.
    expect(source).toContain('IP address');
  });
});

describe('contact address', () => {
  it('agrees with itself about whether it is still the placeholder', () => {
    // The documents render a warning banner off this flag. A real address left
    // flagged as a placeholder tells every reader the working address does not
    // work.
    expect(CONTACT_EMAIL_IS_PLACEHOLDER).toBe(CONTACT_EMAIL === PLACEHOLDER_EMAIL);
  });

  it('is an address and not the placeholder', () => {
    // The documents promise a route to exercise GDPR rights; this is it.
    expect(CONTACT_EMAIL).not.toBe(PLACEHOLDER_EMAIL);
    expect(CONTACT_EMAIL).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i);
  });
});
