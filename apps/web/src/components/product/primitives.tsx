import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { ArrowRight, Inbox, RefreshCw, ShieldX } from 'lucide-react';
import Link from 'next/link';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'brand';

export function StatusBadge({ children, tone = 'neutral' }: { children: ReactNode; tone?: Tone }) {
  return <span className={`status-badge status-${tone}`}>{children}</span>;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow ? <div className="page-eyebrow">{eyebrow}</div> : null}
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      {action ? <div className="page-actions">{action}</div> : null}
    </header>
  );
}

export function SectionHeader({
  title,
  description,
  href,
  actionLabel,
}: {
  title: string;
  description?: string;
  href?: string;
  actionLabel?: string;
}) {
  return (
    <div className="section-header">
      <div>
        <h2>{title}</h2>
        {description ? <p>{description}</p> : null}
      </div>
      {href && actionLabel ? (
        <a className="text-button" href={href}>
          {actionLabel}
          <ArrowRight size={15} aria-hidden="true" />
        </a>
      ) : null}
    </div>
  );
}

export function MetricTile({
  label,
  value,
  context,
  icon: Icon,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  context: string;
  icon: LucideIcon;
  tone?: Tone;
}) {
  return (
    <article className="metric-tile">
      <span className={`metric-icon metric-icon-${tone}`}>
        <Icon size={17} aria-hidden="true" />
      </span>
      <div>
        <span className="metric-label">{label}</span>
        <strong className="metric-value">{value}</strong>
        <p>{context}</p>
      </div>
    </article>
  );
}

export function EmptyState({
  title,
  description,
  icon: Icon = Inbox,
  action,
}: {
  title: string;
  description: string;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="state-panel">
      <span className="state-icon">
        <Icon size={22} aria-hidden="true" />
      </span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="state-panel state-error" role="alert">
      <span className="state-icon">
        <ShieldX size={22} aria-hidden="true" />
      </span>
      <h2>We could not load this workspace</h2>
      <p>{message}</p>
      <Link className="secondary-button" href="/">
        <RefreshCw size={15} aria-hidden="true" />
        Try again
      </Link>
    </div>
  );
}

export function DemoNotice() {
  return (
    <div className="demo-notice" role="status">
      <span>Preview mode</span>
      <p>
        This is deterministic sample data for product review. Sign in to work with live client data.
      </p>
    </div>
  );
}

export function formatDate(
  value: string | null | undefined,
  options?: Intl.DateTimeFormatOptions,
): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat(
    'en',
    options ?? { month: 'short', day: 'numeric', year: 'numeric' },
  ).format(new Date(value));
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatPercent(value: number): string {
  return new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 }).format(value);
}

export function humanize(value: string): string {
  return value.replaceAll('_', ' ').replace(/\b\w/gu, (character) => character.toUpperCase());
}

export function statusTone(status: string): Tone {
  if (['approved', 'qualified', 'converted', 'succeeded', 'resolved', 'active'].includes(status))
    return 'success';
  if (['pending', 'needs_review', 'started', 'acknowledged'].includes(status)) return 'warning';
  if (['rejected', 'failed', 'critical', 'revoked'].includes(status)) return 'danger';
  return 'neutral';
}
