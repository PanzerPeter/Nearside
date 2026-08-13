import { CONTACT_EMAIL, type LegalSection } from '../lib/legal';

/**
 * Terms of Service.
 *
 * Written against the code like the privacy policy beside it. Where the app
 * cannot deliver on a promise, the promise is not made. The abuse section says
 * plainly what nobody operating Nearside is able to do, because a term
 * claiming otherwise would be unenforceable and dishonest in the same breath.
 */
export const termsLead = (
  <p>
    Nearside is an end-to-end encrypted messenger. These terms are the agreement between you and
    the developer of Nearside. Creating an account means you accept them. If you do not, do not use
    the app.
  </p>
);

export const termsSections: LegalSection[] = [
  {
    id: 'terms-who',
    title: 'Who can use it',
    body: (
      <p>
        You must be at least 16. That is the age at which you can consent to online services on
        your own under EU data protection law, and Nearside has no parental consent process.
      </p>
    ),
  },
  {
    id: 'terms-account',
    title: 'Your account, and the phrase that controls it',
    body: (
      <>
        <p>
          You sign in with an email address and a password. Separately from that, the app generates
          a twelve word recovery phrase and derives your encryption keys from it. The phrase is held
          in your phone&rsquo;s hardware keystore and is never sent to the server, so nobody but you
          ever has it.
        </p>
        <p>
          The consequence is unusual and you should read it twice. If you lose both the phrase and
          the phone, your message history is gone permanently. There is no reset, no support
          process, and no copy anywhere to restore from. A password reset gets your account back; it
          does not get your messages back. Write the phrase down somewhere physical.
        </p>
        <p>
          You are responsible for what happens under your account, and for keeping your password and
          your phrase to yourself.
        </p>
      </>
    ),
  },
  {
    id: 'terms-conduct',
    title: 'What you may not do',
    body: (
      <p>
        Do not use Nearside to send unlawful content, to harass or threaten anyone, to distribute
        malware, to infringe copyright, or to spam. Do not attempt to break, overload, or gain
        unauthorised access to the service or to other people&rsquo;s accounts. Do not use automated
        systems to create accounts or send messages.
      </p>
    ),
  },
  {
    id: 'terms-abuse',
    title: 'What we can and cannot do about abuse',
    body: (
      <>
        <p>
          Message content is encrypted on your device and the server holds only ciphertext, so
          nobody operating Nearside can read a message, open an attachment, or moderate what is
          said. This is deliberate, and it is a real limitation: a report about the content of a
          conversation cannot be verified, only acted on against the account behaviour around it.
        </p>
        <p>
          Accounts can still be suspended or removed for abuse that is visible without reading
          anything, such as mass account creation, sending at machine speed, or a pattern of
          reports. Blocking is on your side: nobody can message you or call you until you have
          connected with them, and you can delete the connection at any time.
        </p>
      </>
    ),
  },
  {
    id: 'terms-content',
    title: 'Your content',
    body: (
      <p>
        Your messages and media stay yours. You grant no licence to anyone by sending them, because
        transmitting and storing ciphertext requires none. You are responsible for having the right
        to share whatever you share.
      </p>
    ),
  },
  {
    id: 'terms-paid',
    title: 'Paid items, and giving voluntarily',
    body: (
      <>
        <p>
          Every function of Nearside is free. The encryption, the vault, group rooms, voice
          messages, calls, and pinning media are not and will not be behind a payment. The only
          items sold are cosmetic colour themes.
        </p>
        <p>
          Settings also offers a voluntary contribution towards running costs, in a few fixed
          amounts. The smaller amounts grant nothing whatsoever and may be given as often as you
          like. The largest amount also unlocks every cosmetic theme pack. That is the one
          exception to the sentence above, and it runs in your favour: it hands over things already
          on sale rather than putting anything new behind a price. A contribution is not a
          subscription and buys no feature. Neither of us owes the other anything beyond the amount
          paid.
        </p>
        <p>
          The app store takes every payment and issues any refund, under its own refund policy. We
          cannot issue one directly.
        </p>
      </>
    ),
  },
  {
    id: 'terms-availability',
    title: 'Availability, and what gets deleted automatically',
    body: (
      <>
        <p>
          Nearside is offered as it is, with no guarantee of uptime. Storage is finite, so each
          conversation keeps only its most recent 20 photos and videos and its most recent 50 voice
          messages on the server. Older attachments are removed. Pinning an item keeps it on your
          phone and exempts it from that trimming. Text messages are not trimmed.
        </p>
        <p>
          Separately, either person in a conversation can set a disappearing-message timer. Once it
          is on, messages in that conversation are deleted from the server automatically when the
          timer runs out, for both of you, whether or not they were read.
        </p>
      </>
    ),
  },
  {
    id: 'terms-warranty',
    title: 'No warranty, and the limit of our liability',
    body: (
      <p>
        The app is provided without warranties of any kind. It has not been audited by a third
        party, it does not have forward secrecy, and the &ldquo;Where this protection stops&rdquo;
        screen in Settings sets out in detail what it does not defend against. To the fullest extent
        the law allows, we are not liable for indirect or consequential loss, for lost data, or for
        loss of a recovery phrase. Nothing here limits liability that cannot be limited by law,
        including for death, personal injury, or fraud.
      </p>
    ),
  },
  {
    id: 'terms-ending',
    title: 'Ending it',
    body: (
      <p>
        You can delete your account at any time from Settings. That deletes your profile, your
        messages, your media, and your keys from the server. We may suspend or close an account that
        breaks these terms.
      </p>
    ),
  },
  {
    id: 'terms-changes',
    title: 'Changes, law, and contact',
    body: (
      <>
        <p>
          These terms may change. The date at the top says when they last did, and continuing to use
          Nearside after a change means accepting it. Hungarian law governs this agreement, and the
          courts of Hungary have jurisdiction, without affecting any mandatory protection you have
          as a consumer where you live.
        </p>
        <p>Questions: {CONTACT_EMAIL}</p>
      </>
    ),
  },
];
