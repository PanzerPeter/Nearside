import { useState } from 'react';
import { FileText, Heart, Keyboard, Lock, Scale } from 'lucide-react';
import { APP_VERSION } from '../../lib/version';
import { SupportNearside } from '../SupportNearside';
import { OpenSourceLicenses } from '../OpenSourceLicenses';
import { LegalDocPage, type LegalDoc } from '../LegalFooter';
import { Card, InfoRow, NavRow } from './SettingsUi';
import { isCoarsePointer } from '../../lib/device';
import { useT } from '../../hooks/useT';

/** The documents used to be reachable only from the sign-in screen's footer,
 *  which a signed-in user never sees again. */
export function AboutPage() {
  const t = useT();
  const [showSupport, setShowSupport] = useState(false);
  const [showLicenses, setShowLicenses] = useState(false);
  const [legalDoc, setLegalDoc] = useState<LegalDoc | null>(null);
  // A shortcut nobody can be told about is a shortcut nobody uses. Hidden on a
  // touchscreen, where there is no key to press and the card would be four
  // rows of instructions for hardware that is not there.
  const [keyboard] = useState(() => !isCoarsePointer());
  /** ⌘ on a Mac, Ctrl everywhere else. Only the label: `lib/shortcuts.ts`
   *  accepts either modifier on every platform, so a wrong guess here costs a
   *  wrong symbol in a list and never a shortcut that does not work.
   *  `navigator.platform` is deprecated and missing in some contexts, hence
   *  the user-agent string and the guard around both. */
  const mod = /Mac/i.test(
    (typeof navigator === 'undefined' ? '' : navigator.userAgent) || ''
  )
    ? '⌘'
    : 'Ctrl';

  // Subpages rather than modals, like every other route out of a settings row:
  // see `SettingsPage`.
  if (showSupport) return <SupportNearside onBack={() => setShowSupport(false)} />;
  if (showLicenses) return <OpenSourceLicenses onBack={() => setShowLicenses(false)} />;
  if (legalDoc) return <LegalDocPage doc={legalDoc} onBack={() => setLegalDoc(null)} />;

  return (
    <>
      <Card>
        {/* A donation is not a look and not a legal document, so it leads here
            rather than sitting under either. */}
        <NavRow icon={Heart} label={t('about.support')} onClick={() => setShowSupport(true)} />
        <NavRow
          icon={Scale}
          label={t('about.licenses')}
          onClick={() => setShowLicenses(true)}
        />
        <NavRow icon={FileText} label={t('about.terms')} onClick={() => setLegalDoc('terms')} />
        <NavRow icon={Lock} label={t('about.privacyPolicy')} onClick={() => setLegalDoc('privacy')} />
      </Card>

      {keyboard && (
        <Card title={t('shortcuts.title')}>
          <InfoRow icon={Keyboard} label={t('shortcuts.findChat')} status={`${mod}+K`} />
          <InfoRow icon={Keyboard} label={t('shortcuts.searchChat')} status={`${mod}+F`} />
          <InfoRow icon={Keyboard} label={t('shortcuts.prevChat')} status="Alt+↑" />
          <InfoRow icon={Keyboard} label={t('shortcuts.nextChat')} status="Alt+↓" />
          <InfoRow icon={Keyboard} label={t('shortcuts.archiveChat')} status={`${mod}+E`} />
        </Card>
      )}

      {/* A bug report that names a version is worth several that don't, and an
          app store's build number is not something anyone reads back. */}
      <p className="px-1 text-meta text-faint">Nearside {APP_VERSION}</p>

    </>
  );
}
