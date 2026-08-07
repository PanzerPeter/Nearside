import { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Check, Palette, RotateCcw } from 'lucide-react';
import {
  DEFAULT_THEME,
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
 * theme. No advertisement appears in this component or anywhere else in the
 * app; see `no-ads.test.ts`, which enforces that at build time.
 */
export function ThemeStore({ onClose }: ThemeStoreProps) {
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [offers, setOffers] = useState<Map<string, PackOffer>>(new Map());
  const [active, setActive] = useState(storedTheme);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

      <div className="space-y-3 mt-4">
        <ThemeCard
          name="Nearside"
          description="The theme the app ships with."
          swatches={['#1a1b1e', '#2a2c31', '#3b82f6']}
          selected={active === DEFAULT_THEME}
          owned
          onSelect={() => choose(DEFAULT_THEME)}
        />

        {PACKS.map((pack) => {
          const isOwned = owned.has(pack.id);
          const offer = offers.get(pack.id);
          return (
            <ThemeCard
              key={pack.id}
              name={pack.name}
              description={pack.description}
              swatches={pack.swatches}
              selected={active === pack.theme}
              owned={isOwned}
              price={offer?.priceString}
              busy={busy === pack.id}
              unavailable={!isOwned && (!native || (!loading && !offer))}
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
          Purchases need the Android app. In a browser these are previews only.
        </p>
      )}
    </Modal>
  );
}

interface ThemeCardProps {
  name: string;
  description: string;
  swatches: readonly string[];
  selected: boolean;
  owned: boolean;
  price?: string;
  busy?: boolean;
  unavailable?: boolean;
  onSelect: () => void;
}

function ThemeCard({
  name,
  description,
  swatches,
  selected,
  owned,
  price,
  busy,
  unavailable,
  onSelect,
}: ThemeCardProps) {
  return (
    <button
      type="button"
      className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
        selected
          ? 'border-primary/50 bg-primary/5'
          : 'border-base-content/10 bg-base-200/40 hover:bg-base-content/5'
      } ${unavailable ? 'opacity-50' : ''}`}
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
  );
}
