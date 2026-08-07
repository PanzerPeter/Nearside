import { AlertTriangle, Check, Clock, ShieldAlert, X } from 'lucide-react';
import { Modal } from './Modal';

interface SecurityLimitsProps {
  onClose: () => void;
}

/**
 * Where the protection stops.
 *
 * Shipping a privacy promise to people who may rely on it for their safety
 * carries an obligation to say where it ends, and a paragraph in a repository
 * nobody outside this project reads does not discharge that. This screen names
 * Signal, on purpose, because some of the people who install a private
 * messenger should be using a different one.
 *
 * It carries no logic and it is one of the most important screens in the app.
 */
export function SecurityLimits({ onClose }: SecurityLimitsProps) {
  return (
    <Modal
      title="Where this protection stops"
      onClose={onClose}
      className="max-w-lg"
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="space-y-4">
        <section className="rounded-xl border border-success/25 bg-success/5 p-3.5">
          <h4 className="flex items-center gap-2 font-medium text-sm text-success">
            <Check className="w-4 h-4" />
            What Nearside protects
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            Message and vault contents, and every photo, video and voice note, are encrypted on your
            device before they leave it. The server stores ciphertext. Nobody with access to the
            database, the hosting provider, or a legal order to either can read them.
          </p>
        </section>

        <section className="rounded-xl border border-warning/25 bg-warning/5 p-3.5">
          <h4 className="flex items-center gap-2 font-medium text-sm text-warning">
            <X className="w-4 h-4" />
            What it does not protect
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            Who you talk to, when, and how often. How large each message and attachment is. That
            metadata is visible to the server, and it is shown to you in full on the &ldquo;What the
            server knows&rdquo; screen. Room titles and the nicknames you give contacts are stored
            as ordinary text too.
          </p>
        </section>

        <section className="rounded-xl border border-base-content/10 bg-base-200/40 p-3.5">
          <h4 className="flex items-center gap-2 font-medium text-sm">
            <Clock className="w-4 h-4 text-base-content/60" />
            No forward secrecy
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            If your key is ever stolen, every message an attacker also captured can be decrypted,
            including old ones. Signal&rsquo;s ratchet prevents this by changing keys constantly.
            Nearside does not implement it.
          </p>
        </section>

        <section className="rounded-xl border border-base-content/10 bg-base-200/40 p-3.5">
          <h4 className="flex items-center gap-2 font-medium text-sm">
            <AlertTriangle className="w-4 h-4 text-base-content/60" />
            Unaudited
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            The cryptography is standard (libsodium, X25519, XSalsa20-Poly1305, Ed25519) and used in
            a standard way. No third party has reviewed this implementation.
          </p>
        </section>

        <section className="rounded-xl border border-error/30 bg-error/5 p-3.5">
          <h4 className="flex items-center gap-2 font-medium text-sm text-error">
            <ShieldAlert className="w-4 h-4" />
            If you are at real risk, use Signal
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            If a state adversary or a well-resourced attacker may target you specifically, use
            Signal instead. It has forward secrecy, sealed sender, and years of audits. Nearside is
            built for people who want ordinary conversations to stay ordinary. It is not built for
            people whose lives depend on the tool.
          </p>
        </section>
      </div>
    </Modal>
  );
}
