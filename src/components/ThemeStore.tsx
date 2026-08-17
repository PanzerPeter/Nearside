import { useCallback, useEffect, useState } from 'react';
import { Check, CheckCheck, Eye, Palette, RotateCcw, Send } from 'lucide-react';
import {
  FREE_THEMES,
  PACKS,
  applyTheme,
  hasAllPacksEntitlement,
  packOffers,
  purchasePack,
  restorePurchases,
  storedTheme,
  type PackOffer,
} from '../lib/purchases';
import { grantedPacks, ownedPacks } from '../lib/theme-grants';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';
import { isMobileNative } from '../lib/platform';
import { useT } from '../hooks/useT';
import type { MessageKey } from '../lib/i18n';

interface ThemeStoreProps {
  onClose: () => void;
}

/**
 * Cosmetic packs, and nothing else.
 *
 * Nothing functional sits behind a purchase — the messenger, the encryption,
 * the vault and pinning are all free and stay free. What is sold here is a
 * theme, and only the decorative ones: light mode and the OLED black are in
 * the free list above them. No advertisement appears in this component or
 * anywhere else in the app; see `no-ads.test.ts`, which enforces that at build
 * time.
 */
export function ThemeStore({ onClose }: ThemeStoreProps) {
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [offers, setOffers] = useState<Map<string, PackOffer>>(new Map());
  const [active, setActive] = useState(storedTheme);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Owned by donation rather than bought one at a time. Only changes the words
  // on the section, never what is unlocked.
  const [bySupport, setBySupport] = useState(false);
  // One preview open at a time: side by side they stop being a preview and
  // become a wall of tiny chats to compare against each other.
  const [previewing, setPreviewing] = useState<string | null>(null);
  const toast = useToast();
  const native = isMobileNative();
  const t = useT();

  const load = useCallback(async () => {
    const [mine, live, donated] = await Promise.all([
      ownedPacks(),
      packOffers(),
      hasAllPacksEntitlement(),
    ]);
    setOwned(mine);
    setOffers(live);
    setBySupport(donated);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function choose(theme: string) {
    applyTheme(theme);
    setActive(theme);
  }

  function togglePreview(theme: string) {
    setPreviewing((open) => (open === theme ? null : theme));
  }

  async function buy(packId: string) {
    const offer = offers.get(packId);
    if (!offer) return;
    setBusy(packId);
    try {
      if (await purchasePack(offer)) {
        setOwned((prev) => new Set(prev).add(packId));
        toast.success(t('themes.bought'));
        const pack = PACKS.find((p) => p.id === packId);
        if (pack) choose(pack.theme);
      }
      // A cancelled purchase is silent. Backing out is an ordinary thing to
      // do and does not deserve an error message.
    } catch {
      toast.error(t('themes.buyFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy('restore');
    try {
      // Restoring replaces the entitlement set rather than adding to it, so a
      // refunded pack disappears here as it should. Granted packs are re-read
      // beside it: they were never purchases, and dropping them would take the
      // showcase account's themes away the first time someone tapped this.
      const [restored, granted, donated] = await Promise.all([
        restorePurchases(),
        grantedPacks(),
        hasAllPacksEntitlement(),
      ]);
      // A restore that came back without the donation entitlement — a refund —
      // has to take the line away too, or the screen keeps thanking someone the
      // store no longer counts as a supporter.
      setBySupport(donated);
      setOwned(new Set([...restored, ...granted]));
      toast.success(
        restored.size > 0 ? t('themes.restored') : t('themes.nothingToRestore')
      );
    } catch {
      toast.error(t('themes.storeUnreachable'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title={t('themes.title')}
      onClose={onClose}
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <p className="text-sm text-base-content/70 leading-relaxed">{t('themes.intro')}</p>

      <h3 className="text-xs font-medium uppercase tracking-wide text-base-content/50 mt-5 mb-2">
        {t('themes.included')}
      </h3>
      <div className="space-y-3">
        {FREE_THEMES.map((theme) => (
          <ThemeCard
            key={theme.theme}
            name={theme.name}
            description={theme.description}
            swatches={theme.swatches}
            theme={theme.theme}
            selected={active === theme.theme}
            owned
            previewOpen={previewing === theme.theme}
            onTogglePreview={() => togglePreview(theme.theme)}
            onSelect={() => choose(theme.theme)}
          />
        ))}
      </div>

      <h3 className="text-xs font-medium uppercase tracking-wide text-base-content/50 mt-6 mb-2">
        {t('themes.packs')}
      </h3>
      {bySupport && (
        <p className="text-xs text-base-content/60 mb-2">{t('themes.bySupport')}</p>
      )}
      <div className="space-y-3">
        {PACKS.map((pack) => {
          const isOwned = owned.has(pack.id);
          const offer = offers.get(pack.id);
          return (
            <ThemeCard
              key={pack.id}
              name={pack.name}
              description={pack.description}
              swatches={pack.swatches}
              theme={pack.theme}
              selected={active === pack.theme}
              owned={isOwned}
              price={offer?.priceString}
              busy={busy === pack.id}
              unavailable={!isOwned && (!native || (!loading && !offer))}
              previewOpen={previewing === pack.theme}
              onTogglePreview={() => togglePreview(pack.theme)}
              onSelect={() => (isOwned ? choose(pack.theme) : void buy(pack.id))}
            />
          );
        })}
      </div>

      <button
        className="btn btn-ghost btn-sm w-full mt-4 gap-2"
        onClick={() => void restore()}
        disabled={busy !== null || !native}
      >
        <RotateCcw className="w-3.5 h-3.5" />
        {t('themes.restore')}
      </button>
      {!native && (
        <p className="text-xs text-base-content/55 mt-2 text-center">{t('themes.browserOnly')}</p>
      )}
    </Modal>
  );
}

interface ThemeCardProps {
  name: string;
  description: MessageKey;
  swatches: readonly string[];
  /** daisyUI theme name, so the preview can render itself in it. */
  theme: string;
  selected: boolean;
  owned: boolean;
  price?: string;
  busy?: boolean;
  unavailable?: boolean;
  previewOpen: boolean;
  onTogglePreview: () => void;
  onSelect: () => void;
}

function ThemeCard({
  name,
  description,
  swatches,
  theme,
  selected,
  owned,
  price,
  busy,
  unavailable,
  previewOpen,
  onTogglePreview,
  onSelect,
}: ThemeCardProps) {
  const t = useT();
  return (
    // The card is a container, not a button: it holds two of them. Nesting the
    // preview toggle inside the select button would be invalid markup, and the
    // browser would hand both taps to whichever one it decided owned the event.
    <div
      className={`w-full rounded-xl border transition-colors ${
        selected
          ? 'border-primary/50 bg-primary/5'
          : 'border-base-content/10 bg-base-200/40'
      } ${unavailable && !previewOpen ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center gap-1 p-1">
        <button
          type="button"
          className="flex flex-1 min-w-0 items-center gap-3 rounded-lg p-2 text-left hover:bg-base-content/5 disabled:hover:bg-transparent"
          onClick={onSelect}
          disabled={busy || unavailable}
          aria-pressed={selected}
        >
          <span className="flex shrink-0" aria-hidden>
            {swatches.map((colour, i) => (
              <span
                key={i}
                className="w-5 h-9 first:rounded-l-lg last:rounded-r-lg border border-black/10"
                style={{ background: colour }}
              />
            ))}
          </span>

          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium truncate">{name}</span>
            <span className="block text-xs text-base-content/60">{t(description)}</span>
          </span>

          <span className="shrink-0 text-xs">
            {busy ? (
              <span className="loading loading-spinner loading-xs" />
            ) : selected ? (
              <span className="flex items-center gap-1 text-primary font-medium">
                <Check className="w-3.5 h-3.5" />
                {t('themes.inUse')}
              </span>
            ) : owned ? (
              <span className="flex items-center gap-1 text-base-content/60">
                <Palette className="w-3.5 h-3.5" />
                {t('themes.use')}
              </span>
            ) : unavailable ? (
              <span className="text-base-content/60">{t('common.unavailable')}</span>
            ) : (
              <span className="badge badge-primary badge-sm">{price ?? t('common.loading')}</span>
            )}
          </span>
        </button>

        {/* Never disabled, even for a pack that cannot be bought on this
            device: looking at a theme is the one thing that should work
            everywhere, and it is the whole reason to open this screen in a
            browser. */}
        <button
          type="button"
          className={`btn btn-ghost btn-sm btn-square shrink-0 ${previewOpen ? 'btn-active' : ''}`}
          onClick={onTogglePreview}
          aria-expanded={previewOpen}
          aria-label={
            previewOpen
              ? t('themes.previewHide', { name })
              : t('themes.previewOpen', { name })
          }
          title={t('themes.preview')}
        >
          <Eye className="w-4 h-4" />
        </button>
      </div>

      {previewOpen && <ThemePreview theme={theme} />}
    </div>
  );
}

/**
 * A conversation, drawn in a theme the app is not wearing.
 *
 * `data-theme` on this element rather than on `<html>`, which is what makes a
 * preview a preview: the surrounding screen keeps the theme in use, nothing is
 * written to storage, and there is no state to walk back if the modal closes
 * mid-look. Every colour below comes from a daisyUI token, so this stays
 * honest for a theme added after it was written.
 */
function ThemePreview({ theme }: { theme: string }) {
  const t = useT();
  return (
    <div
      data-theme={theme}
      className="m-2 mt-0 rounded-lg overflow-hidden border border-base-content/10 text-base-content select-none"
      aria-hidden
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-base-200">
        <span className="w-6 h-6 rounded-full bg-neutral shrink-0" />
        <span className="min-w-0">
          <span className="block text-xs font-medium">Alex</span>
          <span className="flex items-center gap-1 text-[0.6rem] text-base-content/60">
            <span className="w-1.5 h-1.5 rounded-full bg-success" />
            {t('themes.sampleOnline')}
          </span>
        </span>
      </div>

      <div className="bg-base-300 px-3 py-3 space-y-2">
        <div className="flex">
          <span className="max-w-[80%] rounded-2xl rounded-bl-md bg-neutral text-neutral-content px-3 py-1.5 text-xs">
            {t('themes.sampleTheirs')}
          </span>
        </div>
        <div className="flex justify-end">
          <span className="max-w-[80%] rounded-2xl rounded-br-md bg-primary text-primary-content px-3 py-1.5 text-xs">
            {t('themes.sampleYours')}
            <span className="flex items-center justify-end gap-1 text-[0.6rem] leading-none mt-1">
              <span className="opacity-75">10:42</span>
              {/* The read tick, in the token the real one uses — it is the
                  detail a theme most often gets wrong, so it belongs in
                  anything claiming to show the theme. */}
              <CheckCheck
                className="w-3 h-3"
                strokeWidth={3.25}
                style={{ color: 'var(--receipt-read)' }}
              />
            </span>
          </span>
        </div>
      </div>

      <div className="flex items-center gap-2 px-3 py-2 bg-base-200">
        <span className="flex-1 rounded-full bg-base-100 px-3 py-1.5 text-[0.65rem] text-base-content/50">
          {t('themes.sampleComposer')}
        </span>
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-content shrink-0">
          <Send className="w-3 h-3" />
        </span>
      </div>
    </div>
  );
}
