import { useState } from 'react';
import { Modal } from './Modal';

type Doc = 'terms' | 'privacy' | null;

const LAST_UPDATED = 'July 20, 2026';

/**
 * Small, unobtrusive footer with Terms of Service and Privacy Policy links.
 * Self-contained: manages its own modal state so it can be dropped anywhere.
 * Intentionally omitted from the messaging view to stay out of the way.
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

      {open && <LegalModal doc={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function LegalModal({ doc, onClose }: { doc: Exclude<Doc, null>; onClose: () => void }) {
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

function TermsBody() {
  return (
    <>
      <p>
        Chatly is a simple real-time chat service. By creating an account or using Chatly, you
        agree to these terms. If you do not agree, please do not use the service.
      </p>
      <p>
        <span className="font-semibold text-base-content/80">Your account.</span> You are
        responsible for keeping your login credentials secure and for all activity under your
        account. You must provide a valid email address and choose a username that does not
        impersonate others or violate anyone&apos;s rights.
      </p>
      <p>
        <span className="font-semibold text-base-content/80">Acceptable use.</span> Do not use
        Chatly to send unlawful, harassing, hateful, or infringing content, to spam other users,
        or to attempt to disrupt or gain unauthorized access to the service. We may suspend or
        remove accounts that break these rules.
      </p>
      <p>
        <span className="font-semibold text-base-content/80">Your content.</span> You keep
        ownership of the messages and media you send. You are responsible for what you share and
        for having the right to share it.
      </p>
      <p>
        <span className="font-semibold text-base-content/80">No warranty.</span> Chatly is
        provided &quot;as is,&quot; without warranties of any kind. We do not guarantee that the
        service will be uninterrupted, secure, or error-free, and we are not liable for any loss
        arising from your use of it, to the fullest extent permitted by law.
      </p>
      <p>
        We may update these terms from time to time. Continued use after a change means you accept
        the updated terms.
      </p>
    </>
  );
}

function PrivacyBody() {
  return (
    <>
      <p>
        This policy explains what information Chatly collects and how it is used. We aim to collect
        only what is needed to run the service.
      </p>
      <p>
        <span className="font-semibold text-base-content/80">What we collect.</span> Your email
        address (for sign-in and account recovery), your chosen username, an optional profile
        avatar, and the messages and media you send to other users.
      </p>
      <p>
        <span className="font-semibold text-base-content/80">How it is used.</span> This data is
        used solely to provide the chat service: to authenticate you, show your profile to your
        friends, and deliver your messages. We do not sell your personal data or use it for
        advertising.
      </p>
      <p>
        <span className="font-semibold text-base-content/80">Storage and processing.</span> Account
        data and messages are stored and processed through Supabase, our backend and authentication
        provider, on our behalf. Your session is kept on your own device so you stay signed in
        between visits.
      </p>
      <p>
        <span className="font-semibold text-base-content/80">Your choices.</span> You can update
        your username and avatar at any time in settings. You can permanently delete your account,
        messages and media yourself at any time from Settings → Delete account.
      </p>
      <p>
        We may update this policy from time to time; the date above shows when it last changed.
      </p>
    </>
  );
}
