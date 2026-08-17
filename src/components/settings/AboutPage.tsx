import { useState } from 'react';
import { FileText, Heart, Lock, Scale } from 'lucide-react';
import { APP_VERSION } from '../../lib/version';
import { SupportNearside } from '../SupportNearside';
import { OpenSourceLicenses } from '../OpenSourceLicenses';
import { LegalDocModal, type LegalDoc } from '../LegalFooter';
import { Card, NavRow } from './SettingsUi';
import { useT } from '../../hooks/useT';

/** The documents used to be reachable only from the sign-in screen's footer,
 *  which a signed-in user never sees again. */
export function AboutPage() {
  const t = useT();
  const [showSupport, setShowSupport] = useState(false);
  const [showLicenses, setShowLicenses] = useState(false);
  const [legalDoc, setLegalDoc] = useState<LegalDoc | null>(null);

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

      {/* A bug report that names a version is worth several that don't, and an
          app store's build number is not something anyone reads back. */}
      <p className="px-1 text-xs text-base-content/40">Nearside {APP_VERSION}</p>

      {showSupport && <SupportNearside onClose={() => setShowSupport(false)} />}
      {showLicenses && <OpenSourceLicenses onClose={() => setShowLicenses(false)} />}
      {legalDoc && <LegalDocModal doc={legalDoc} onClose={() => setLegalDoc(null)} />}
    </>
  );
}
