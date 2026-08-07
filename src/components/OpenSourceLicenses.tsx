import { ExternalLink } from 'lucide-react';
import { Modal } from './Modal';

interface OpenSourceLicensesProps {
  onClose: () => void;
}

interface Dependency {
  name: string;
  what: string;
  license: string;
  url: string;
}

/**
 * The libraries Nearside is built on.
 *
 * Listed with what each one actually does rather than as a wall of names: for
 * a product whose central claim is that its cryptography is standard, "which
 * library does the encrypting" is the load-bearing fact, and burying it in an
 * alphabetical list of forty transitive dependencies would hide it.
 */
const DEPENDENCIES: Dependency[] = [
  {
    name: 'libsodium',
    what: 'All of the cryptography: X25519 key exchange, XSalsa20-Poly1305 sealing, Ed25519 signatures.',
    license: 'ISC',
    url: 'https://github.com/jedisct1/libsodium',
  },
  {
    name: '@scure/bip39',
    what: 'The twelve-word recovery phrase and the seed derived from it.',
    license: 'MIT',
    url: 'https://github.com/paulmillr/scure-bip39',
  },
  {
    name: 'Google ML Kit Barcode Scanning',
    what: 'Reading a connect code or a safety number off another phone’s screen.',
    license: 'Apache-2.0',
    url: 'https://developers.google.com/ml-kit/terms',
  },
  {
    name: '@capacitor-mlkit/barcode-scanning',
    what: 'The Capacitor bridge to the scanner above.',
    license: 'Apache-2.0',
    url: 'https://github.com/capawesome-team/capacitor-mlkit',
  },
  {
    name: 'qrcode-generator',
    what: 'Drawing your own connect code and safety number as a QR.',
    license: 'MIT',
    url: 'https://github.com/kazuhikoarase/qrcode-generator',
  },
  {
    name: 'Capacitor',
    what: 'The Android shell, and the plugins for secure storage, SQLite, the filesystem, the camera and the media library.',
    license: 'MIT',
    url: 'https://github.com/ionic-team/capacitor',
  },
  {
    name: 'capacitor-secure-storage-plugin',
    what: 'Holding your key in the Android Keystore.',
    license: 'MIT',
    url: 'https://github.com/martinkasa/capacitor-secure-storage-plugin',
  },
  {
    name: '@capacitor-community/sqlite',
    what: 'The on-device store of decrypted messages that search and previews read from.',
    license: 'MIT',
    url: 'https://github.com/capacitor-community/sqlite',
  },
  {
    name: 'supabase-js',
    what: 'Talking to Postgres, Auth, Realtime and Storage.',
    license: 'MIT',
    url: 'https://github.com/supabase/supabase-js',
  },
  {
    name: 'React',
    what: 'The user interface.',
    license: 'MIT',
    url: 'https://github.com/facebook/react',
  },
  {
    name: 'daisyUI',
    what: 'The component styles on top of Tailwind CSS.',
    license: 'MIT',
    url: 'https://github.com/saadeghi/daisyui',
  },
  {
    name: 'Tailwind CSS',
    what: 'The styling system underneath daisyUI.',
    license: 'MIT',
    url: 'https://github.com/tailwindlabs/tailwindcss',
  },
  {
    name: 'lucide-react',
    what: 'Every icon in the app.',
    license: 'ISC',
    url: 'https://github.com/lucide-icons/lucide',
  },
  {
    name: 'emoji-mart',
    what: 'The emoji picker and the reaction palette.',
    license: 'MIT',
    url: 'https://github.com/missive/emoji-mart',
  },
  {
    name: 'Inter',
    what: 'The typeface.',
    license: 'SIL OFL 1.1',
    url: 'https://github.com/rsms/inter',
  },
  {
    name: 'Workbox',
    what: 'The service worker in the browser build.',
    license: 'MIT',
    url: 'https://github.com/GoogleChrome/workbox',
  },
  {
    name: 'OneSignal',
    what: 'Delivering notifications. It is told an account id and never a message.',
    license: 'Modified MIT',
    url: 'https://github.com/OneSignal/OneSignal-Cordova-SDK',
  },
  {
    name: 'RevenueCat',
    what: 'The purchase of a cosmetic pack, and nothing else.',
    license: 'MIT',
    url: 'https://github.com/RevenueCat/purchases-capacitor',
  },
  {
    name: 'Firebase Crashlytics',
    what: 'Crash reports. They carry a stack trace, never message content.',
    license: 'Apache-2.0',
    url: 'https://firebase.google.com/terms',
  },
];

export function OpenSourceLicenses({ onClose }: OpenSourceLicensesProps) {
  return (
    <Modal
      title="Open source"
      onClose={onClose}
      className="max-w-lg"
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="text-sm text-base-content/70 leading-relaxed">
        Nearside is built on other people&rsquo;s work. The cryptography in particular is standard
        and borrowed on purpose — a messenger that rolled its own would be a worse one.
      </p>

      <ul className="space-y-2.5 mt-4">
        {DEPENDENCIES.map((dep) => (
          <li
            key={dep.name}
            className="rounded-xl border border-base-content/10 bg-base-200/40 p-3"
          >
            <div className="flex items-baseline justify-between gap-3">
              <a
                href={dep.url}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-sm inline-flex items-center gap-1 hover:text-primary"
              >
                {dep.name}
                <ExternalLink className="w-3 h-3 opacity-60" />
              </a>
              <span className="text-[11px] text-base-content/55 shrink-0">{dep.license}</span>
            </div>
            <p className="text-xs text-base-content/65 leading-relaxed mt-1">{dep.what}</p>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
