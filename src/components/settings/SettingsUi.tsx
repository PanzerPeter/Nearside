import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMobileBackClose } from '../../hooks/useMobileBackClose';

/**
 * The pieces every settings page is built from.
 *
 * They exist so a new setting is a row rather than a fresh arrangement of flex
 * classes: eight pages hand-laying the same "icon, label, sub-label, control"
 * shape is how the single-page version drifted into three slightly different
 * spacings for the same thing.
 */

interface RowShellProps {
  icon?: LucideIcon;
  label: string;
  /** The line under the label. Never truncated — the app says where Android's
   *  permission screens are down here, and clipping that is how it read
   *  before. */
  hint?: ReactNode;
  tone?: 'default' | 'warning' | 'error';
  children?: ReactNode;
}

const TONE = {
  default: 'text-base-content/60',
  warning: 'text-warning',
  error: 'text-error',
} as const;

function RowShell({ icon: Icon, label, hint, tone = 'default', children }: RowShellProps) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        {Icon && <Icon className={`w-4 h-4 shrink-0 ${TONE[tone]}`} />}
        <div className="min-w-0 text-left">
          <p className={`text-sm font-medium ${tone === 'error' ? 'text-error' : ''}`}>{label}</p>
          {hint && <p className="text-xs text-base-content/60">{hint}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

interface NavRowProps extends RowShellProps {
  onClick: () => void;
  /** The current answer, shown on the row itself. A settings list where every
   *  row has to be opened to find out what it says is a list of questions. */
  value?: string;
}

export function NavRow({ onClick, value, ...shell }: NavRowProps) {
  return (
    <button type="button" className="w-full text-left hover:bg-base-content/5" onClick={onClick}>
      <RowShell {...shell}>
        <span className="flex items-center gap-1.5 shrink-0">
          {value && <span className="text-xs text-base-content/50">{value}</span>}
          <ChevronRight className="w-4 h-4 text-base-content/40" />
        </span>
      </RowShell>
    </button>
  );
}

interface ToggleRowProps extends RowShellProps {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  /** Mid-flight, when the OS is being asked. The switch is replaced rather
   *  than left live: a second tap would race the first. */
  busy?: boolean;
}

export function ToggleRow({ checked, onChange, disabled, busy, ...shell }: ToggleRowProps) {
  return (
    <RowShell {...shell}>
      {busy ? (
        <span className="loading loading-spinner loading-sm shrink-0" />
      ) : (
        <input
          type="checkbox"
          className="toggle toggle-primary shrink-0"
          checked={checked}
          onChange={onChange}
          disabled={disabled}
          aria-label={shell.label}
        />
      )}
    </RowShell>
  );
}

/** A row that states something and offers one action, like an OS permission
 *  the app cannot grant itself. */
export function ActionRow({
  action,
  onAction,
  actionClass = 'btn-outline',
  ...shell
}: RowShellProps & {
  action: string;
  onAction: () => void;
  actionClass?: string;
}) {
  return (
    <RowShell {...shell}>
      <button className={`btn btn-sm shrink-0 ${actionClass}`} onClick={onAction}>
        {action}
      </button>
    </RowShell>
  );
}

/** A row that only states something — a permission the user has already
 *  granted, a count. `status` is the right-hand word. */
export function InfoRow({ status, ...shell }: RowShellProps & { status?: string }) {
  return (
    <RowShell {...shell}>
      {status && (
        <span className="text-xs text-base-content/60 shrink-0 tabular-nums">{status}</span>
      )}
    </RowShell>
  );
}

/** A titled card. The title is optional: a single unlabelled card reads as one
 *  group already, and a heading over it is furniture. */
export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="mb-4">
      {title && (
        <p className="text-xs font-medium uppercase tracking-wider text-base-content/60 px-1 mb-1.5">
          {title}
        </p>
      )}
      <div className="rounded-box border border-base-content/10 bg-base-200/40 divide-y divide-base-content/5 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

/** Prose between cards — the sentence that explains what a group of switches
 *  will and will not do. */
export function Note({ children }: { children: ReactNode }) {
  return <p className="text-xs text-base-content/60 leading-relaxed px-1 -mt-2 mb-4">{children}</p>;
}

/**
 * One settings subpage, with its own back affordance.
 *
 * The hardware back button is claimed here rather than by the caller: entries
 * stack, so a page pushes on top of the settings tab's own entry and back walks
 * page → settings → chats in the order the user opened them. The desktop dialog
 * has no hardware back, and `useMobileBackClose` no-ops above 1023px, so the
 * chevron is the only route out there — which is why it is a real button and
 * not a decoration on the title.
 */
export function SettingsPage({
  title,
  onBack,
  children,
}: {
  title: string;
  onBack: () => void;
  children: ReactNode;
}) {
  useMobileBackClose(true, onBack);

  return (
    <div>
      <div className="flex items-center gap-1 mb-4 -ml-2">
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square"
          onClick={onBack}
          aria-label="Back to settings"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
        <h3 className="font-semibold">{title}</h3>
      </div>
      {children}
    </div>
  );
}
