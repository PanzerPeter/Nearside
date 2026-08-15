import {
  AlertTriangle,
  Check,
  Clock,
  Lock,
  PhoneCall,
  PhoneOff,
  ShieldAlert,
  Timer,
  Users,
  X,
} from 'lucide-react';
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
            <PhoneCall className="w-4 h-4 text-base-content/60" />
            Calls show your IP address to the person you call
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            Voice and video go straight between the two phones, encrypted end to end, and no server
            ever holds the audio or a key to it. Nothing about a call is stored anywhere &mdash; not
            that it happened, not who to, not how long. The cost of connecting directly is that each
            phone learns the other&rsquo;s IP address, which is roughly a city and an internet
            provider. You already accepted this person as a contact, but it is more than a message
            reveals.
          </p>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            When a direct connection cannot be made &mdash; common on mobile networks &mdash; the
            call is relayed through Cloudflare instead. The relay carries encrypted packets it cannot
            open, and sees only that two addresses exchanged traffic.
          </p>
        </section>

        <section className="rounded-xl border border-base-content/10 bg-base-200/40 p-3.5">
          <h4 className="flex items-center gap-2 font-medium text-sm">
            <Users className="w-4 h-4 text-base-content/60" />
            A call only reaches the account you are signed into
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            Both halves of an incoming call &mdash; the notification that wakes the phone and the
            channel the call itself arrives on &mdash; belong to the account currently signed in on
            it. If you keep two accounts on this phone and someone calls the other one, that phone
            does not ring, and you will see the call only after switching back. Messages behave the
            same way. This is the price of an account&rsquo;s key never leaving the account: a
            second one cannot be listened for without being unlocked.
          </p>
        </section>

        <section className="rounded-xl border border-base-content/10 bg-base-200/40 p-3.5">
          <h4 className="flex items-center gap-2 font-medium text-sm">
            <PhoneOff className="w-4 h-4 text-base-content/60" />
            Declining from the lock screen does not always tell the caller
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            Decline always silences your phone. Telling the caller means sending them a message
            sealed with your key, and that key is reachable only once Nearside itself is running
            &mdash; which, on a phone that was asleep with the app closed, it may not be yet. When
            it is not, your phone goes quiet and theirs keeps ringing until it gives up, and they
            see no answer rather than declined.
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
            <Timer className="w-4 h-4 text-base-content/60" />
            Disappearing messages are deleted, not unsendable
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            When the timer runs out the row is deleted from the server and from the copy on your
            phone. It does not reach a screenshot, a photograph of the screen, or text somebody
            copied out before it went. If you would not say it to someone holding a camera, a timer
            does not change that.
          </p>
        </section>

        <section className="rounded-xl border border-base-content/10 bg-base-200/40 p-3.5">
          <h4 className="flex items-center gap-2 font-medium text-sm">
            <Lock className="w-4 h-4 text-base-content/60" />
            A sealed answer can be forced open with a junk one
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            Neither side&rsquo;s answer is released until both have answered, and the server enforces
            that without being able to read either one. What it cannot check is whether an answer is
            sincere: somebody who only wants to see yours can type anything and get it. The cost is
            that their answer is permanent &mdash; answers cannot be edited or withdrawn once sent
            &mdash; and it stays in the conversation with their name on it.
          </p>
        </section>

        <section className="rounded-xl border border-base-content/10 bg-base-200/40 p-3.5">
          <h4 className="flex items-center gap-2 font-medium text-sm">
            <Lock className="w-4 h-4 text-base-content/60" />
            The app lock is not encryption
          </h4>
          <p className="text-sm text-base-content/75 leading-relaxed mt-2">
            It asks for a passphrase before Nearside opens, and it keeps the decrypted copy of your
            messages on this phone closed until you answer. It does not add a layer of encryption on
            top of what is already there, and it does not protect against someone who can read this
            phone&rsquo;s storage directly. Your recovery phrase also opens it, so it stops nobody
            who has that &mdash; they could read everything from a phone of their own anyway.
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
