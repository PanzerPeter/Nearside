import type { LucideIcon } from 'lucide-react';
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
import type { MessageKey } from '../lib/i18n';
import { useT } from '../hooks/useT';

interface SecurityLimitsProps {
  onClose: () => void;
}

/** The three shapes a section comes in: what holds, what does not, and the one
 *  that sends the reader to a different app. */
type Tone = 'good' | 'warn' | 'plain' | 'stop';

const TONE: Record<Tone, { section: string; heading: string; icon: string }> = {
  good: {
    section: 'border-success/25 bg-success/5',
    heading: 'text-success',
    icon: '',
  },
  warn: {
    section: 'border-warning/25 bg-warning/5',
    heading: 'text-warning',
    icon: '',
  },
  plain: {
    section: 'border-base-content/10 bg-base-200/40',
    heading: '',
    icon: 'text-base-content/60',
  },
  stop: {
    section: 'border-error/30 bg-error/5',
    heading: 'text-error',
    icon: '',
  },
};

/**
 * The screen's content, as data.
 *
 * Written out rather than hand-laid as eleven near-identical blocks of JSX: the
 * sections differ only in their icon, their tone and their words, and a list
 * makes adding an honest admission a one-line change rather than a copy of the
 * block above it. The words themselves are message keys, so this screen says
 * the same thing in every language the app speaks.
 */
const SECTIONS: { tone: Tone; icon: LucideIcon; title: MessageKey; body: MessageKey[] }[] = [
  { tone: 'good', icon: Check, title: 'limits.protectsTitle', body: ['limits.protectsBody'] },
  { tone: 'warn', icon: X, title: 'limits.notProtectsTitle', body: ['limits.notProtectsBody'] },
  {
    tone: 'plain',
    icon: PhoneCall,
    title: 'limits.callIpTitle',
    body: ['limits.callIpBody', 'limits.callRelayBody'],
  },
  { tone: 'plain', icon: Users, title: 'limits.oneAccountTitle', body: ['limits.oneAccountBody'] },
  { tone: 'plain', icon: PhoneOff, title: 'limits.declineTitle', body: ['limits.declineBody'] },
  { tone: 'plain', icon: Clock, title: 'limits.forwardTitle', body: ['limits.forwardBody'] },
  { tone: 'plain', icon: Timer, title: 'limits.timerTitle', body: ['limits.timerBody'] },
  { tone: 'plain', icon: Lock, title: 'limits.sealedTitle', body: ['limits.sealedBody'] },
  { tone: 'plain', icon: Lock, title: 'limits.appLockTitle', body: ['limits.appLockBody'] },
  {
    tone: 'plain',
    icon: AlertTriangle,
    title: 'limits.unauditedTitle',
    body: ['limits.unauditedBody'],
  },
  { tone: 'stop', icon: ShieldAlert, title: 'limits.signalTitle', body: ['limits.signalBody'] },
];

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
  const t = useT();

  return (
    <Modal
      title={t('privacy.limits')}
      onClose={onClose}
      className="max-w-lg"
      actions={
        <button className="btn btn-ghost" onClick={onClose}>
          {t('common.close')}
        </button>
      }
    >
      <div className="space-y-4">
        {SECTIONS.map(({ tone, icon: Icon, title, body }) => (
          <section key={title} className={`rounded-xl border p-3.5 ${TONE[tone].section}`}>
            <h4 className={`flex items-center gap-2 font-medium text-sm ${TONE[tone].heading}`}>
              <Icon className={`w-4 h-4 ${TONE[tone].icon}`} />
              {t(title)}
            </h4>
            {body.map((paragraph) => (
              <p
                key={paragraph}
                className="text-sm text-base-content/75 leading-relaxed mt-2"
              >
                {t(paragraph)}
              </p>
            ))}
          </section>
        ))}
      </div>
    </Modal>
  );
}
