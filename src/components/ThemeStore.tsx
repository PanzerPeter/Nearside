import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Check, CheckCheck, Eye, Palette, RotateCcw, Send } from 'lucide-react';
import {
  FREE_THEMES,
  PACKS,
  applyTheme,
  packOffers,
  packsFromEntitlements,
  purchasePack,
  restorePurchases,
  storedTheme,
  type PackOffer,
} from '../lib/purchases';
import { useToast } from '../hooks/useToast';
import { Modal } from './Modal';

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
  // One preview open at a time: side by side they stop being a preview and
  // become a wall of tiny chats to compare against each other.
  const [previewing, setPreviewing] = useState<string | null>(null);
  const toast = useToast();
  const native = Capacitor.isNativePlatform();

  const load = useCallback(async () => {
    const [entitlements, live] = await Promise.all([packsFromEntitlements(), packOffers()]);
    setOwned(entitlements);
    setOffers(live);
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
        toast.success('Thank you. Applying it now.');
        const pack = PACKS.find((p) => p.id === packId);
        if (pack) choose(pack.theme);
      }
      // A cancelled purchase is silent. Backing out is an ordinary thing to
      // do and does not deserve an error message.
    } catch {
      toast.error('The purchase did not go through.');
    } finally {
      setBusy(null);
    }
  }

  async function restore() {
    setBusy('restore');
    try {
      const restored = await restorePurchases();
      setOwned(restored);
      toast.success(
        restored.size > 0 ? 'Purchases restored.' : 'Nothing to restore on this account.'
      );
    } catch {
      toast.error('Could not reach the store.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal
      title="Appearance"
      onClose={onClose}
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="text-sm text-base-content/70 leading-relaxed">
        Every feature in Nearside is free: the encryption, the vault, group rooms, and pinning
        media to your phone. These are looks. Buying one is the only way to pay for any of it.
      </p>

      <h3 className="text-xs font-medium uppercase tracking-wide text-base-content/50 mt-5 mb-2">
        Included
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
        Packs
      </h3>
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
        Restore purchases
      </button>
      {!native && (
        <p className="text-xs text-base-content/55 mt-2 text-center">
          Purchases need the app. In a browser the packs are previews only.
        </p>
      )}
    </Modal>
  );
}

interface ThemeCardProps {
  name: string;
  description: string;
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
            <span className="block text-xs text-base-content/60">{description}</span>
          </span>

          <span className="shrink-0 text-xs">
            {busy ? (
              <span className="loading loading-spinner loading-xs" />
            ) : selected ? (
              <span className="flex items-center gap-1 text-primary font-medium">
                <Check className="w-3.5 h-3.5" />
                In use
              </span>
            ) : owned ? (
              <span className="flex items-center gap-1 text-base-content/60">
                <Palette className="w-3.5 h-3.5" />
                Use
              </span>
            ) : unavailable ? (
              <span className="text-base-content/60">Unavailable</span>
            ) : (
              <span className="badge badge-primary badge-sm">{price ?? 'Loading'}</span>
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
          aria-label={previewOpen ? `Hide ${name} preview` : `Preview ${name}`}
          title="Preview"
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
            online
          </span>
        </span>
      </div>

      <div className="bg-base-300 px-3 py-3 space-y-2">
        <div className="flex">
          <span className="max-w-[80%] rounded-2xl rounded-bl-md bg-neutral text-neutral-content px-3 py-1.5 text-xs">
            This is how a message from someone else looks.
          </span>
        </div>
        <div className="flex justify-end">
          <span className="max-w-[80%] rounded-2xl rounded-br-md bg-primary text-primary-content px-3 py-1.5 text-xs">
            And this is yours.
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
          Message
        </span>
        <span className="flex items-center justify-center w-6 h-6 rounded-full bg-primary text-primary-content shrink-0">
          <Send className="w-3 h-3" />
        </span>
      </div>
    </div>
  );
}
