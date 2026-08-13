import { CONTACT_EMAIL, HOSTING_REGION, type LegalSection } from '../lib/legal';

/**
 * Privacy Policy.
 *
 * Written from the code rather than from a template, and that is the point of
 * it. Every claim matches something checkable: the table list in
 * `lib/server-view.ts`, the bucket policies in `supabase/storage/setup.sql`,
 * the keep limits in `lib/conversation.ts`, the expiry job in
 * `0029_disappearing.sql`, the providers named in the edge functions. A policy
 * for an encrypted messenger is read by people deciding whether to trust it,
 * so an inaccuracy here costs more than one almost anywhere else in the
 * codebase.
 *
 * If you change what the app stores or which company it talks to, this file
 * changes in the same commit.
 */
export const privacyLead = (
  <>
    <p>
      This policy describes exactly what Nearside collects, where it goes, and who else sees it. It
      is written against the code, and Settings contains a screen called &ldquo;What the server
      knows&rdquo; that queries the live database as you and shows the same information as counted
      rows rather than as a description.
    </p>
    <p>The developer of Nearside is the data controller. Contact: {CONTACT_EMAIL}</p>
  </>
);

export const privacySections: LegalSection[] = [
  {
    id: 'privacy-local',
    title: 'What never leaves your phone',
    body: (
      <p>
        Your twelve word recovery phrase and the private keys derived from it live in the
        phone&rsquo;s hardware keystore and are never transmitted. So does the local database of
        messages this device has decrypted, which is what powers search and conversation previews;
        it is a separate file per account and is erased when you sign out. So does the list of
        contacts you have verified in person, and any media you pinned.
      </p>
    ),
  },
  {
    id: 'privacy-sealed',
    title: 'What the server holds and cannot read',
    body: (
      <p>
        Message bodies, captions, vault notes, room messages, and every photo, video, and voice
        recording are encrypted on your device before upload. The server stores a ciphertext and a
        nonce. Attachments are uploaded as opaque bytes with their file key sealed to the recipient,
        so neither the database nor the storage bucket can reveal them, and neither can a legal order
        served on the hosting provider.
      </p>
    ),
  },
  {
    id: 'privacy-readable',
    title: 'What the server holds and can read',
    body: (
      <>
        <p>
          Encryption hides content, not the fact of a conversation. In plain text the server holds
          your email address and password hash, your display name, your avatar, your public keys,
          and when you were last seen. It holds who you are connected to and when you connected. For
          every message it holds the sender, the recipient, the timestamp, whether it was edited,
          deleted, or forwarded, and for attachments the file size and the length of a voice note.
        </p>
        <p>
          Four more things are stored as ordinary text and people are often surprised by them. Emoji
          reactions are not encrypted. Delivery and read timestamps are not encrypted. The private
          nicknames you give contacts are hidden from the contact but not from the server. Room
          titles are readable, because the server has to list your rooms, so treat a room title like
          the outside of an envelope.
        </p>
        <p>
          Your avatar is stored in a public bucket and served from a URL that needs no sign-in.
          Anyone who has that URL can view the image. Nothing links the URL to your email or your
          messages, but do not use an avatar you would not want seen outside the app.
        </p>
      </>
    ),
  },
  {
    id: 'privacy-calls',
    title: 'Voice and video calls',
    body: (
      <>
        <p>
          A call does not go through our server. Audio and video travel directly between the two
          phones and are encrypted in transit by WebRTC. Nothing about a call is recorded and there
          is no table of calls to keep: the setup messages are sealed to the other person&rsquo;s
          key and sent over a channel that stores nothing at all, so no record of who called whom,
          or for how long, exists to be handed over.
        </p>
        <p>
          Setting up that direct connection exchanges network addresses, so{' '}
          <strong>the person you are in a call with can see your IP address</strong>, and you can
          see theirs. That is how every peer-to-peer call works, including on other messengers. It
          only happens with someone you have already connected with, since nobody else can call
          you.
        </p>
        <p>
          When a direct connection cannot be made, the call falls back to a relay operated by
          Cloudflare, which forwards the encrypted stream without being able to decrypt it.
          Credentials for that relay are issued per call and expire shortly after. Cloudflare sees
          that a relayed call happened and how much data it moved.
        </p>
        <p>
          Ringing a phone that is asleep uses a push notification, described below. It carries the
          caller&rsquo;s name so you know who is calling, and nothing else about the call.
        </p>
      </>
    ),
  },
  {
    id: 'privacy-basis',
    title: 'Why we are allowed to hold it',
    body: (
      <p>
        Running the service you asked for is the performance of our contract with you, and that
        covers your account, your messages, your calls, and your connections. Keeping the service
        secure and preventing abuse, including the rate limits and the crash reporting below, rests
        on our legitimate interest in a working product. Notifications, calls, and payments happen
        only when you turn them on or use them.
      </p>
    ),
  },
  {
    id: 'privacy-where',
    title: 'Where it is stored',
    body: (
      <p>
        The database, authentication, file storage, and realtime connections all run on Supabase in{' '}
        {HOSTING_REGION}. Supabase processes this data on our instructions and does not use it for
        anything else.
      </p>
    ),
  },
  {
    id: 'privacy-processors',
    title: 'The other companies involved',
    body: (
      <>
        <p>
          Notifications go through OneSignal, which receives your device&rsquo;s push token, your
          account identifier, and the text of the notification. Delivery to the handset is
          Google&rsquo;s Firebase Cloud Messaging. A notification never contains message content,
          and cannot: the server has no plaintext to put in one. The most it says is who a message
          or a call is from, using the display name or the nickname you chose.
        </p>
        <p>
          Cloudflare provides the relay that carries a call when the two phones cannot reach each
          other directly, as described above. It receives the encrypted stream and the network
          addresses of both ends.
        </p>
        <p>
          Crash reports go to Google Firebase Crashlytics, and include a stack trace, your device
          model, and the operating system version. They contain no message content.
        </p>
        <p>
          Theme purchases and voluntary contributions go through the app store&rsquo;s billing and
          are tracked by RevenueCat, which receives your account identifier and the purchase
          receipt. Neither ever sees a message, and neither tells us your name, your address, or
          your card details.
        </p>
        <p>
          Scanning a friend&rsquo;s QR code uses Google&rsquo;s ML Kit barcode scanner, which runs
          on the phone. The camera image is not uploaded anywhere.
        </p>
        <p>
          OneSignal, Google, Cloudflare, and RevenueCat are based in the United States, so using
          notifications, relayed calls, crash reporting, or payments involves a transfer outside the
          EU under those providers&rsquo; standard contractual clauses. Messaging itself does not
          leave the EU.
        </p>
      </>
    ),
  },
  {
    id: 'privacy-retention',
    title: 'How long it is kept',
    body: (
      <>
        <p>
          Messages stay until you or the other person deletes them, or until you delete your
          account. Attachments are trimmed automatically once a conversation passes 20 photos and
          videos or 50 voice messages, oldest first, unless you pinned them to this phone. Codes for
          adding a contact expire after ten minutes and work once. The record that a notification was
          sent exists so the same message is never announced twice.
        </p>
        <p>
          If a disappearing-message timer is set on a conversation, that takes precedence. The server
          stamps an expiry on each new message in it and a scheduled job deletes them once it passes,
          for both people, read or not. The timer is set by either of you and applies to messages
          sent after it was turned on.
        </p>
      </>
    ),
  },
  {
    id: 'privacy-rights',
    title: 'What you can ask for',
    body: (
      <>
        <p>
          You can see your data without asking anyone: the &ldquo;What the server knows&rdquo; screen
          exports everything this account can read as a single JSON file, encrypted columns included
          as the ciphertext the server holds. You can correct your display name and avatar in
          Settings, and you can delete your account, your messages, your media, and your keys from
          Settings at any time. Deletion is immediate and cannot be undone.
        </p>
        <p>
          Beyond the app you have the rights the GDPR gives you: access, rectification, erasure,
          restriction, portability, and objection. Write to {CONTACT_EMAIL}. If you think we have
          handled your data badly you can complain to the Hungarian data protection authority, the
          NAIH, or to the authority where you live.
        </p>
      </>
    ),
  },
  {
    id: 'privacy-children',
    title: 'Children',
    body: (
      <p>
        Nearside is not for under 16s. If you believe a child has created an account, write to{' '}
        {CONTACT_EMAIL} and it will be removed.
      </p>
    ),
  },
  {
    id: 'privacy-changes',
    title: 'Changes',
    body: (
      <p>
        If this policy changes, the date at the top changes with it. A change that affects what is
        collected or who receives it will be announced in the app before it takes effect.
      </p>
    ),
  },
];
