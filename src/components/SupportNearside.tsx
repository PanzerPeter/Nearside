import { useCallback, useEffect, useState } from 'react';
import { Bell, Database, Heart, Palette } from 'lucide-react';
import { DONATION_TIERS, donate, donationOffers, type DonationOffer } from '../lib/donations';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { isMobileNative } from '../lib/platform';
import { useT } from '../hooks/useT';

interface SupportNearsideProps {
  onClose: () => void;
}

/**
 * Voluntary support, and an honest account of where it goes.
 *
 * The bill is itemised on purpose. "Support development" is what an app says
 * when it would rather not be asked, and every other screen here refuses to be
 * vague. A donation screen that broke the habit would read as the one place
 * the app stopped being straight with you.
 *
 * Nothing here unlocks a feature. The largest tier hands over the theme packs,
 * which runs the other way: it gives away things that were already for sale
 * rather than putting anything new behind a price.
 */
export function SupportNearside({ onClose }: SupportNearsideProps) {
  const t = useT();
  const [offers, setOffers] = useState<Map<string, DonationOffer>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const toast = useToast();
  const native = isMobileNative();

  const load = useCallback(async () => {
    setOffers(await donationOffers());
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function give(tierId: string) {
    const offer = offers.get(tierId);
    if (!offer) return;
    setBusy(tierId);
    try {
      if (await donate(offer)) {
        const unlocks = DONATION_TIERS.find((t) => t.id === tierId)?.unlocksPacks;
        toast.success(
          unlocks ? t('support.thanksUnlocked') : t('support.thanks')
        );
      }
      // A cancelled payment is silent. `donate` reports it as false rather
      // than throwing, precisely so it does not land here as an error.
    } catch {
      toast.error(t('support.failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title={t('about.support')}
      onClose={onClose}
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <p className="text-sm text-base-content/70 leading-relaxed">{t('support.intro')}</p>

      <h3 className="text-xs font-medium uppercase tracking-wide text-base-content/50 mt-5 mb-2">
        {t('support.paysFor')}
      </h3>
      <ul className="space-y-2 text-sm text-base-content/70">
        <li className="flex items-start gap-2.5">
          <Database className="w-4 h-4 mt-0.5 shrink-0 text-base-content/50" />
          <span>
            <span className="font-medium text-base-content/85">Supabase Pro.</span>{' '}
            {t('support.supabase')}
          </span>
        </li>
        <li className="flex items-start gap-2.5">
          <Bell className="w-4 h-4 mt-0.5 shrink-0 text-base-content/50" />
          <span>
            <span className="font-medium text-base-content/85">OneSignal.</span>{' '}
            {t('support.onesignal')}
          </span>
        </li>
      </ul>

      <h3 className="text-xs font-medium uppercase tracking-wide text-base-content/50 mt-6 mb-2">
        {t('support.tiers')}
      </h3>
      <div className="space-y-3">
        {DONATION_TIERS.map((tier) => {
          const offer = offers.get(tier.id);
          const unavailable = !native || (!loading && !offer);
          return (
            <button
              key={tier.id}
              type="button"
              className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-colors hover:bg-base-content/5 disabled:hover:bg-transparent ${
                tier.unlocksPacks
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-base-content/10 bg-base-200/40'
              } ${unavailable ? 'opacity-50' : ''}`}
              onClick={() => void give(tier.id)}
              disabled={busy !== null || unavailable}
            >
              <span className="shrink-0 text-base-content/50">
                {tier.unlocksPacks ? (
                  <Palette className="w-4 h-4" />
                ) : (
                  <Heart className="w-4 h-4" />
                )}
              </span>

              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium">{tier.name}</span>
                <span className="block text-xs text-base-content/60">{t(tier.blurb)}</span>
              </span>

              <span className="shrink-0 text-xs">
                {busy === tier.id ? (
                  <span className="loading loading-spinner loading-xs" />
                ) : unavailable ? (
                  <span className="text-base-content/60">{t('common.unavailable')}</span>
                ) : (
                  <span
                    className={`badge badge-sm ${tier.unlocksPacks ? 'badge-primary' : 'badge-ghost'}`}
                  >
                    {offer?.priceString ?? t('common.loading')}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>

      <p className="text-xs text-base-content/55 mt-4 leading-relaxed">{t('support.note')}</p>
      {!native && (
        <p className="text-xs text-base-content/55 mt-2 text-center">{t('support.browserOnly')}</p>
      )}
    </Modal>
  );
}
