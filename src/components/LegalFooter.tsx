import { useState } from 'react';
import { Modal } from './Modal';

/** Which document to show. Exported because the two documents are reached from
 *  three places now — this footer, the settings page and the sign-up consent
 *  line — and all of them open the same modal below. */
export type LegalDoc = 'terms' | 'privacy';

type Doc = LegalDoc | null;

const LAST_UPDATED = 'August 7, 2026';

/**
 * Must be a working address before release. Google Play requires a contact on
 * the store listing, and a privacy policy that offers no route for a data
 * request does not satisfy the rights described in it.
 */
const CONTACT_EMAIL = 'you@example.com';

/** Where the Supabase project runs. Named because "the EU" is a claim someone
 *  may rely on, and eu-west-3 is Paris. */
const HOSTING_REGION = 'Paris, France (Supabase region eu-west-3)';

/**
 * Terms of Service and Privacy Policy.
 *
 * These are written from the code rather than from a template, and that is the
 * point of them. Every claim below matches something checkable: the table list
 * in `lib/server-view.ts`, the bucket policies in `supabase/storage/setup.sql`,
 * the keep limits in `lib/conversation.ts`, the plugins in `package.json`.
 * Where the app cannot deliver on a promise, the promise is not made. A privacy
 * policy for an encrypted messenger is read by people deciding whether to trust
 * it, so an inaccuracy here costs more than an inaccuracy almost anywhere else
 * in the codebase.
 *
 * If you change what the app stores or which company it talks to, this file
 * changes in the same commit.
 */
export function LegalFooter({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState<Doc>(null);

  return (
    <>
      <footer
        className={`flex items-center justify-center gap-3 text-xs text-base-content/60 ${className}`}
      >
        <button type="button" className="link link-hover" onClick={() => setOpen('terms')}>
          Terms
        </button>
        <span aria-hidden="true">·</span>
        <button type="button" className="link link-hover" onClick={() => setOpen('privacy')}>
          Privacy
        </button>
      </footer>

      {open && <LegalDocModal doc={open} onClose={() => setOpen(null)} />}
    </>
  );
}

export function LegalDocModal({ doc, onClose }: { doc: LegalDoc; onClose: () => void }) {
  return (
    <Modal
      title={doc === 'terms' ? 'Terms of Service' : 'Privacy Policy'}
      onClose={onClose}
      className="max-w-lg"
      actions={
        <button className="btn btn-primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="max-h-[60vh] overflow-y-auto pr-1 text-sm text-base-content/70 space-y-3 leading-relaxed">
        <p className="text-xs text-base-content/60">Last updated: {LAST_UPDATED}</p>
        {doc === 'terms' ? <TermsBody /> : <PrivacyBody />}
      </div>
    </Modal>
  );
}

/** A real heading rather than a bolded run-in, so the document can be skimmed
 *  by someone looking for one specific answer. */
function H({ children }: { children: React.ReactNode }) {
  return <h4 className="font-semibold text-base-content/85 pt-2">{children}</h4>;
}

function TermsBody() {
  return (
    <>
      <p>
        Nearside is an end-to-end encrypted messenger for Android. These terms are the agreement
        between you and the developer of Nearside. Creating an account means you accept them. If you
        do not, do not use the app.
      </p>

      <H>Who can use it</H>
      <p>
        You must be at least 16. That is the age at which you can consent to online services on your
        own under EU data protection law, and Nearside has no parental consent process.
      </p>

      <H>Your account, and the phrase that controls it</H>
      <p>
        You sign in with an email address and a password. Separately from that, the app generates a
        twelve word recovery phrase and derives your encryption keys from it. The phrase is held in
        your phone&rsquo;s hardware keystore and is never sent to the server, so nobody but you ever
        has it.
      </p>
      <p>
        The consequence is unusual and you should read it twice. If you lose both the phrase and the
        phone, your message history is gone permanently. There is no reset, no support process, and
        no copy anywhere to restore from. A password reset gets your account back; it does not get
        your messages back. Write the phrase down somewhere physical.
      </p>
      <p>
        You are responsible for what happens under your account, and for keeping your password and
        your phrase to yourself.
      </p>

      <H>What you may not do</H>
      <p>
        Do not use Nearside to send unlawful content, to harass or threaten anyone, to distribute
        malware, to infringe copyright, or to spam. Do not attempt to break, overload, or gain
        unauthorised access to the service or to other people&rsquo;s accounts. Do not use automated
        systems to create accounts or send messages.
      </p>

      <H>What we can and cannot do about abuse</H>
      <p>
        Message content is encrypted on your device and the server holds only ciphertext, so nobody
        operating Nearside can read a message, open an attachment, or moderate what is said. This is
        deliberate, and it is a real limitation: a report about the content of a conversation cannot
        be verified, only acted on against the account behaviour around it.
      </p>
      <p>
        Accounts can still be suspended or removed for abuse that is visible without reading
        anything, such as mass account creation, sending at machine speed, or a pattern of reports.
        Blocking is on your side: nobody can message you until you have connected with them, and you
        can delete the connection at any time.
      </p>

      <H>Your content</H>
      <p>
        Your messages and media stay yours. You grant no licence to anyone by sending them, because
        transmitting and storing ciphertext requires none. You are responsible for having the right
        to share whatever you share.
      </p>

      <H>Paid items</H>
      <p>
        Every function of Nearside is free. The encryption, the vault, group rooms, voice messages,
        and pinning media are not and will not be behind a payment. The only purchasable items are
        cosmetic colour themes, sold through Google Play and handled by Google. Refunds follow Google
        Play&rsquo;s policy, not ours, and we cannot issue one directly.
      </p>

      <H>Availability, and what gets deleted automatically</H>
      <p>
        Nearside is offered as it is, with no guarantee of uptime. Storage is finite, so each
        conversation keeps only its most recent 20 photos and videos and its most recent 50 voice
        messages on the server. Older attachments are removed. Pinning an item keeps it on your
        phone and exempts it from that trimming. Text messages are not trimmed.
      </p>

      <H>No warranty, and the limit of our liability</H>
      <p>
        The app is provided without warranties of any kind. It has not been audited by a third party,
        it does not have forward secrecy, and the &ldquo;Where this protection stops&rdquo; screen in
        Settings sets out in detail what it does not defend against. To the fullest extent the law
        allows, we are not liable for indirect or consequential loss, for lost data, or for loss of a
        recovery phrase. Nothing here limits liability that cannot be limited by law, including for
        death, personal injury, or fraud.
      </p>

      <H>Ending it</H>
      <p>
        You can delete your account at any time from Settings. That deletes your profile, your
        messages, your media, and your keys from the server. We may suspend or close an account that
        breaks these terms.
      </p>

      <H>Changes, law, and contact</H>
      <p>
        These terms may change. The date at the top says when they last did, and continuing to use
        Nearside after a change means accepting it. Hungarian law governs this agreement, and the
        courts of Hungary have jurisdiction, without affecting any mandatory protection you have as
        a consumer where you live.
      </p>
      <p>Questions: {CONTACT_EMAIL}</p>
    </>
  );
}

function PrivacyBody() {
  return (
    <>
      <p>
        This policy describes exactly what Nearside collects, where it goes, and who else sees it.
        It is written against the code, and Settings contains a screen called &ldquo;What the server
        knows&rdquo; that queries the live database as you and shows the same information as counted
        rows rather than as a description.
      </p>
      <p>
        The developer of Nearside is the data controller. Contact: {CONTACT_EMAIL}
      </p>

      <H>What never leaves your phone</H>
      <p>
        Your twelve word recovery phrase and the private keys derived from it live in the Android
        keystore and are never transmitted. So does the local database of messages this device has
        decrypted, which is what powers search and conversation previews; it is a separate file per
        account and is erased when you sign out. So does the list of contacts you have verified in
        person, and any media you pinned.
      </p>

      <H>What the server holds and cannot read</H>
      <p>
        Message bodies, captions, vault notes, room messages, and every photo, video, and voice
        recording are encrypted on your device before upload. The server stores a ciphertext and a
        nonce. Attachments are uploaded as opaque bytes with their file key sealed to the recipient,
        so neither the database nor the storage bucket can reveal them, and neither can a legal order
        served on the hosting provider.
      </p>

      <H>What the server holds and can read</H>
      <p>
        Encryption hides content, not the fact of a conversation. In plain text the server holds your
        email address and password hash, your display name, your avatar, your public keys, and when
        you were last seen. It holds who you are connected to and when you connected. For every
        message it holds the sender, the recipient, the timestamp, whether it was edited, deleted, or
        forwarded, and for attachments the file size and the length of a voice note.
      </p>
      <p>
        Four more things are stored as ordinary text and people are often surprised by them. Emoji
        reactions are not encrypted. Delivery and read timestamps are not encrypted. The private
        nicknames you give contacts are hidden from the contact but not from the server. Room titles
        are readable, because the server has to list your rooms, so treat a room title like the
        outside of an envelope.
      </p>
      <p>
        Your avatar is stored in a public bucket and served from a URL that needs no sign-in. Anyone
        who has that URL can view the image. Nothing links the URL to your email or your messages,
        but do not use an avatar you would not want seen outside the app.
      </p>

      <H>Why we are allowed to hold it</H>
      <p>
        Running the service you asked for is the performance of our contract with you, and that
        covers your account, your messages, and your connections. Keeping the service secure and
        preventing abuse, including the rate limits and the crash reporting below, rests on our
        legitimate interest in a working product. Notifications and purchases happen only when you
        turn them on or buy something.
      </p>

      <H>Where it is stored</H>
      <p>
        The database, authentication, file storage, and realtime connections all run on Supabase in{' '}
        {HOSTING_REGION}. Supabase processes this data on our instructions and does not use it for
        anything else.
      </p>

      <H>The other companies involved</H>
      <p>
        Notifications go through OneSignal, which receives your device&rsquo;s push token, your
        account identifier, and the text of the notification. Delivery to the handset is Google&rsquo;s
        Firebase Cloud Messaging. A notification never contains message content, and cannot: the
        server has no plaintext to put in one. The most it says is who a message is from, using the
        display name or the nickname you chose.
      </p>
      <p>
        Crash reports go to Google Firebase Crashlytics, and include a stack trace, your device model,
        and the Android version. They contain no message content.
      </p>
      <p>
        Theme purchases go through Google Play Billing and are tracked by RevenueCat, which receives
        your account identifier and the purchase receipt. Neither ever sees a message.
      </p>
      <p>
        Scanning a friend&rsquo;s QR code uses Google&rsquo;s ML Kit barcode scanner, which runs on
        the phone. The camera image is not uploaded anywhere.
      </p>
      <p>
        OneSignal, Google, and RevenueCat are based in the United States, so using notifications,
        crash reporting, or purchases involves a transfer outside the EU under those providers&rsquo;
        standard contractual clauses. Messaging itself does not leave the EU.
      </p>

      <H>How long it is kept</H>
      <p>
        Messages stay until you or the other person deletes them, or until you delete your account.
        Attachments are trimmed automatically once a conversation passes 20 photos and videos or 50
        voice messages, oldest first, unless you pinned them to this phone. Codes for adding a
        contact expire after ten minutes and work once. The record that a notification was sent
        exists so the same message is never announced twice.
      </p>

      <H>What you can ask for</H>
      <p>
        You can see your data without asking anyone: the &ldquo;What the server knows&rdquo; screen
        exports everything this account can read as a single JSON file, encrypted columns included as
        the ciphertext the server holds. You can correct your display name and avatar in Settings,
        and you can delete your account, your messages, your media, and your keys from Settings at
        any time. Deletion is immediate and cannot be undone.
      </p>
      <p>
        Beyond the app you have the rights the GDPR gives you: access, rectification, erasure,
        restriction, portability, and objection. Write to {CONTACT_EMAIL}. If you think we have
        handled your data badly you can complain to the Hungarian data protection authority, the
        NAIH, or to the authority where you live.
      </p>

      <H>Children</H>
      <p>
        Nearside is not for under 16s. If you believe a child has created an account, write to{' '}
        {CONTACT_EMAIL} and it will be removed.
      </p>

      <H>Changes</H>
      <p>
        If this policy changes, the date at the top changes with it. A change that affects what is
        collected or who receives it will be announced in the app before it takes effect.
      </p>
    </>
  );
}
