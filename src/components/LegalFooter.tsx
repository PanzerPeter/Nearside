import { useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import {
  CONTACT_EMAIL_IS_PLACEHOLDER,
  LAST_UPDATED,
  type LegalSection,
} from '../lib/legal';
import { isMotionReduced, prefersReducedMotion } from '../lib/motion';
import { privacyLead, privacySections } from './LegalPrivacy';
import { termsLead, termsSections } from './LegalTerms';
import { Modal } from './Modal';

/** Which document to show. Exported because the two documents are reached from
 *  three places now — this footer, the settings page and the sign-up consent
 *  line — and all of them open the same modal below. */
export type LegalDoc = 'terms' | 'privacy';

type Doc = LegalDoc | null;

export function LegalFooter({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState<Doc>(null);

  return (
    <>
      <footer
        className={`flex items-center justify-center gap-3 text-xs text-base-content/60 ${className}`}
      >
        <button type="button" className="link link-hover" onClick={() => setOpen('terms')}>
          Terms
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" className="link link-hover" onClick={() => setOpen('privacy')}>
          Privacy
        </button>
      </footer>

      {open && <LegalDocModal doc={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * Terms of Service and Privacy Policy.
 *
 * The document is rendered from an array of sections rather than written as
 * one run of prose, which is what lets the index above it be generated instead
 * of maintained. A hand-written list of links to headings drifts on the first
 * rename, and does it silently: the link still scrolls somewhere, just to the
 * wrong place.
 *
 * The text itself lives in `LegalTerms.tsx` and `LegalPrivacy.tsx`.
 */
export function LegalDocModal({ doc, onClose }: { doc: LegalDoc; onClose: () => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const terms = doc === 'terms';
  const sections = terms ? termsSections : privacySections;

  // Both documents are long enough that finding one answer means scrolling
  // past everything before it. Scrolling by element rather than by `#hash`:
  // this is a single-page app inside a <dialog>, and a hash would push a
  // history entry whose back button closes the modal instead of going up.
  function jump(id: string) {
    const target = scroller.current?.querySelector(`#${id}`);
    target?.scrollIntoView({
      behavior: isMotionReduced() || prefersReducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
  }

  function toTop() {
    scroller.current?.scrollTo({
      top: 0,
      behavior: isMotionReduced() || prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }

  return (
    <Modal
      title={terms ? 'Terms of Service' : 'Privacy Policy'}
      onClose={onClose}
      className="max-w-lg"
      actions={
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div
        ref={scroller}
        className="max-h-[60vh] overflow-y-auto pr-1 text-sm text-base-content/70 leading-relaxed"
      >
        <p className="text-xs text-base-content/60">Last updated: {LAST_UPDATED}</p>

        {/* Loud on purpose, and it removes itself. A policy that describes
            rights while printing an address nobody reads is worse than one
            that admits the address is not set up yet. */}
        {CONTACT_EMAIL_IS_PLACEHOLDER && (
          <p className="mt-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-base-content/80">
            The contact address in this document has not been set up yet, so it does not receive
            mail. Until it does, use the project&rsquo;s public repository to get in touch.
          </p>
        )}

        <div className="space-y-3 mt-3">{terms ? termsLead : privacyLead}</div>

        <nav aria-label="Sections" className="mt-4 rounded-lg bg-base-200/50 px-3 py-2.5">
          <p className="text-[0.7rem] font-medium uppercase tracking-wide text-base-content/50 mb-1.5">
            In this document
          </p>
          <ul className="space-y-0.5">
            {sections.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  className="link link-hover text-left text-xs text-base-content/75"
                  onClick={() => jump(section.id)}
                >
                  {section.title}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        {sections.map((section) => (
          <Section key={section.id} section={section} />
        ))}

        <button
          type="button"
          className="btn btn-ghost btn-xs gap-1.5 mt-5 text-base-content/60"
          onClick={toTop}
        >
          <ArrowUp className="w-3 h-3" />
          Back to top
        </button>
      </div>
    </Modal>
  );
}

/**
 * One titled section.
 *
 * `scroll-mt` rather than a plain anchor: the heading is scrolled to inside a
 * container with its own padding, and without the margin the title lands
 * flush against the top edge and reads as cut off.
 */
function Section({ section }: { section: LegalSection }) {
  return (
    <section className="mt-5 space-y-3 scroll-mt-2">
      <h4 id={section.id} className="font-semibold text-base-content/90 scroll-mt-2">
        {section.title}
      </h4>
      {section.body}
    </section>
  );
}
