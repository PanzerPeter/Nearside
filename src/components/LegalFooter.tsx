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
import { SettingsPage } from './settings/SettingsUi';
import { useT } from '../hooks/useT';

/** Which document to show. Exported because the two documents are reached from
 *  three places now — this footer, the settings page and the sign-up consent
 *  line — and all of them render the same body below. */
export type LegalDoc = 'terms' | 'privacy';

type Doc = LegalDoc | null;

export function LegalFooter({ className = '' }: { className?: string }) {
  const t = useT();
  const [open, setOpen] = useState<Doc>(null);

  return (
    <>
      <footer
        className={`flex items-center justify-center gap-3 text-meta text-muted ${className}`}
      >
        <button type="button" className="link link-hover" onClick={() => setOpen('terms')}>
          {t('legal.terms')}
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" className="link link-hover" onClick={() => setOpen('privacy')}>
          {t('legal.privacy')}
        </button>
      </footer>

      {open && <LegalDocModal doc={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * Terms of Service and Privacy Policy, as a dialog.
 *
 * Opened from this footer and from the sign-up consent line — both on the
 * sign-in screen, where there is no page underneath to go back to. The About
 * page shows the same body as a settings subpage instead (`LegalDocPage`),
 * because a screen reached from a settings row should leave the way every
 * other one does.
 */
export function LegalDocModal({ doc, onClose }: { doc: LegalDoc; onClose: () => void }) {
  const t = useT();
  const terms = doc === 'terms';

  return (
    <Modal
      title={terms ? t('about.terms') : t('about.privacyPolicy')}
      onClose={onClose}
      className="max-w-lg"
      actions={
        <button className="btn btn-primary" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      {/* The dialog is what scrolls here; the page version lets the settings
          pane do it. */}
      <div className="max-h-[60vh] overflow-y-auto pr-1">
        <LegalDocBody doc={doc} />
      </div>
    </Modal>
  );
}

/** The same document under the settings tab's own back chevron. */
export function LegalDocPage({ doc, onBack }: { doc: LegalDoc; onBack: () => void }) {
  const t = useT();
  const terms = doc === 'terms';
  return (
    <SettingsPage title={terms ? t('about.terms') : t('about.privacyPolicy')} onBack={onBack}>
      <LegalDocBody doc={doc} />
    </SettingsPage>
  );
}

/**
 * The document itself.
 *
 * Rendered from an array of sections rather than written as one run of prose,
 * which is what lets the index above it be generated instead of maintained. A
 * hand-written list of links to headings drifts on the first rename, and does
 * it silently: the link still scrolls somewhere, just to the wrong place.
 *
 * The text lives in `LegalTerms.tsx` and `LegalPrivacy.tsx`.
 */
function LegalDocBody({ doc }: { doc: LegalDoc }) {
  const t = useT();
  const top = useRef<HTMLParagraphElement>(null);
  const terms = doc === 'terms';
  const sections = terms ? termsSections : privacySections;

  const behavior = () =>
    isMotionReduced() || prefersReducedMotion() ? ('auto' as const) : ('smooth' as const);

  // Both documents are long enough that finding one answer means scrolling
  // past everything before it. Scrolling by element rather than by `#hash`:
  // this is a single-page app, and a hash would push a history entry whose
  // back button closes the document instead of going up. `scrollIntoView`
  // rather than a scrollTo on a container, because which element actually
  // scrolls differs between the dialog and the settings pane.
  function jump(id: string) {
    document.getElementById(id)?.scrollIntoView({ behavior: behavior(), block: 'start' });
  }

  return (
    <div className="text-body text-strong leading-relaxed">
      <p ref={top} className="text-meta text-muted scroll-mt-2">
        {t('legal.lastUpdated', { date: LAST_UPDATED })}
      </p>

      {/* Loud on purpose, and it removes itself. A policy that describes
          rights while printing an address nobody reads is worse than one
          that admits the address is not set up yet. */}
      {CONTACT_EMAIL_IS_PLACEHOLDER && (
        <p className="mt-3 rounded-field border border-warning/40 bg-warning/10 px-3 py-2 text-meta text-strong">
          {t('legal.placeholderContact')}
        </p>
      )}

      <div className="space-y-3 mt-3">{terms ? termsLead : privacyLead}</div>

      <nav aria-label="Sections" className="mt-4 rounded-field bg-base-200/50 px-3 py-2.5">
        <p className="text-micro font-medium uppercase tracking-wide text-subtle mb-1.5">
          {t('legal.inThisDocument')}
        </p>
        <ul className="space-y-0.5">
          {sections.map((section) => (
            <li key={section.id}>
              <button
                type="button"
                className="link link-hover text-left text-meta text-strong"
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
        className="btn btn-ghost btn-xs gap-1.5 mt-5 text-muted"
        onClick={() => top.current?.scrollIntoView({ behavior: behavior(), block: 'start' })}
      >
        <ArrowUp className="w-3 h-3" />
        {t('legal.backToTop')}
      </button>
    </div>
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
      <h4 id={section.id} className="font-semibold text-strong scroll-mt-2">
        {section.title}
      </h4>
      {section.body}
    </section>
  );
}
