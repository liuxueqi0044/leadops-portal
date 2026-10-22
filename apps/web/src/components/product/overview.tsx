import {
  ArrowDownRight,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  Inbox,
  Sparkles,
  UserCheck,
} from 'lucide-react';
import type { ProductData } from '@/lib/product/types';
import {
  DemoNotice,
  StatusBadge,
  formatDateTime,
  formatPercent,
  humanize,
  statusTone,
} from './primitives';
import './overview.css';

function percentOf(value: number, total: number): string {
  return total > 0 ? formatPercent(value / total) : '—';
}

function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

export function Overview({ data }: { data: ProductData }) {
  const { dashboard, selectedClient, approvals, incidents, workflowRuns, leads } = data;
  const client = encodeURIComponent(selectedClient.id);
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const openIncidents = incidents.filter((incident) => incident.status !== 'resolved');
  const recentRuns = workflowRuns.slice(0, 3);
  const totalRuns = dashboard.workflowSuccess + dashboard.workflowFailure;
  const attentionCount = pending.length + openIncidents.length;
  const funnel = [
    { label: 'Received leads', value: dashboard.leadsReceived },
    { label: 'Qualified leads', value: dashboard.totalQualified },
    { label: 'Approved decisions', value: dashboard.totalApproved },
    { label: 'Booked appointments', value: dashboard.appointments },
  ];
  const largestTotal = Math.max(...funnel.map((stage) => stage.value));
  const metrics = [
    {
      label: 'Leads received',
      value: dashboard.leadsReceived,
      context: 'Opportunities in your pipeline',
      icon: Inbox,
    },
    {
      label: 'Qualified leads',
      value: dashboard.totalQualified,
      context: dashboard.leadsReceived
        ? `${formatPercent(dashboard.qualificationRate)} of received leads currently qualified`
        : 'No received leads yet',
      icon: Sparkles,
    },
    {
      label: 'Approved decisions',
      value: dashboard.totalApproved,
      context:
        dashboard.totalApproved + dashboard.totalRejected
          ? `${formatPercent(dashboard.approvalConversion)} of completed decisions approved`
          : 'No completed decisions yet',
      icon: UserCheck,
    },
    {
      label: 'Appointments booked',
      value: dashboard.appointments,
      context: 'Recorded appointment bookings',
      icon: CalendarDays,
    },
  ];

  return (
    <div className="product-page ops-overview">
      <header className="ops-heading">
        <div>
          <div className="ops-eyebrow">Your workspace at a glance</div>
          <h1>Workspace overview</h1>
          <p>A clear view of your pipeline, and what needs you next.</p>
        </div>
        <span className="ops-period">
          <CalendarDays size={16} aria-hidden="true" />
          All-time snapshot
        </span>
      </header>
      {data.mode === 'demo' ? <DemoNotice /> : null}

      <section className="ops-metrics" aria-label="Lead outcomes">
        {metrics.map(({ label, value, context, icon: Icon }) => (
          <article className="ops-metric" key={label}>
            <div className="ops-metric-label">
              <span>{label}</span>
              <Icon size={16} aria-hidden="true" />
            </div>
            <strong>{value.toLocaleString('en')}</strong>
            <p>{context}</p>
          </article>
        ))}
      </section>

      <div className="ops-primary-grid">
        <section className="ops-panel ops-funnel-panel">
          <div className="ops-panel-heading">
            <div>
              <h2>Pipeline &amp; outcome totals</h2>
              <p>Your lead operation, in perspective.</p>
            </div>
            <a className="ops-text-link" href={`/?section=leads&client=${client}`}>
              View leads <ArrowRight size={15} aria-hidden="true" />
            </a>
          </div>
          <div className="ops-funnel">
            {funnel.map((stage) => {
              const ratio = largestTotal > 0 ? stage.value / largestTotal : 0;
              return (
                <div className="ops-funnel-row" key={stage.label}>
                  <span className="ops-funnel-label">{stage.label}</span>
                  <div className="ops-funnel-track" aria-hidden="true">
                    <span
                      style={{ width: `${String(Math.min(100, Math.max(0, ratio * 100)))}%` }}
                    />
                  </div>
                  <span className="ops-funnel-value">
                    <strong>{stage.value.toLocaleString('en')}</strong>
                  </span>
                </div>
              );
            })}
            <div className="ops-funnel-note">
              <ArrowDownRight size={18} aria-hidden="true" />
              {largestTotal > 0 ? (
                <p>
                  Lead totals reflect current status. Decisions and bookings can include multiple
                  records per lead.
                </p>
              ) : (
                <p>Your pipeline will take shape as leads arrive.</p>
              )}
            </div>
          </div>
        </section>

        <section className="ops-panel ops-queue-panel">
          <div className="ops-panel-heading">
            <div>
              <h2>Needs your attention</h2>
              <p>A few decisions keep things moving.</p>
            </div>
            <StatusBadge tone={attentionCount ? 'warning' : 'success'}>
              {attentionCount} {attentionCount === 1 ? 'item' : 'items'}
            </StatusBadge>
          </div>
          <div className="ops-queue-list">
            {pending.slice(0, 2).map((approval) => (
              <a
                className="ops-queue-item"
                href={`/?section=approvals&client=${client}&approval=${encodeURIComponent(approval.id)}`}
                key={approval.id}
              >
                <span className="ops-queue-icon">
                  <UserCheck size={18} aria-hidden="true" />
                </span>
                <span className="ops-queue-copy">
                  <strong>{approval.snapshot.contactName ?? 'Unnamed lead'}</strong>
                  <span>
                    {approval.snapshot.suggestedNextAction ?? 'Review the qualification snapshot'}
                  </span>
                  <small>Approval pending</small>
                </span>
                <ChevronRight className="ops-queue-chevron" size={17} aria-hidden="true" />
              </a>
            ))}
            {openIncidents.slice(0, 1).map((incident) => (
              <a
                className="ops-queue-item"
                href={`/?section=incidents&client=${client}&incident=${encodeURIComponent(incident.id)}`}
                key={incident.id}
              >
                <span className="ops-queue-icon ops-queue-icon-incident">
                  <CircleAlert size={18} aria-hidden="true" />
                </span>
                <span className="ops-queue-copy">
                  <strong>{humanize(incident.category)}</strong>
                  <span>{incident.errorSummary ?? 'A workflow issue needs your review'}</span>
                  <small className="ops-incident-label">Open incident</small>
                </span>
                <ChevronRight className="ops-queue-chevron" size={17} aria-hidden="true" />
              </a>
            ))}
            {!attentionCount ? (
              <div className="ops-empty ops-queue-clear">
                <CheckCircle2 size={24} aria-hidden="true" />
                <strong>You’re all caught up</strong>
                <p>No pending approvals or open incidents in this view.</p>
              </div>
            ) : null}
          </div>
          <div className="ops-queue-footer">
            <a href={`/?section=approvals&client=${client}`}>
              Approvals <span>{pending.length}</span>
              <ArrowRight size={14} aria-hidden="true" />
            </a>
            <a href={`/?section=incidents&client=${client}`}>
              Incidents <span>{openIncidents.length}</span>
              <ArrowRight size={14} aria-hidden="true" />
            </a>
          </div>
        </section>
      </div>

      <div className="ops-secondary-grid">
        <section className="ops-panel ops-leads-panel">
          <div className="ops-panel-heading">
            <div>
              <h2>Recent leads</h2>
              <p>The latest people in your pipeline.</p>
            </div>
            <a className="ops-text-link" href={`/?section=leads&client=${client}`}>
              View all <ArrowRight size={15} aria-hidden="true" />
            </a>
          </div>
          <div className="ops-lead-labels" aria-hidden="true">
            <span>Contact / source</span>
            <span>Status</span>
            <span>AI score</span>
          </div>
          <div className="ops-lead-list">
            {leads.slice(0, 4).map((lead) => {
              const name = lead.contactName ?? 'Unnamed lead';
              return (
                <a
                  className="ops-lead-row"
                  href={`/?section=leads&client=${client}&lead=${encodeURIComponent(lead.id)}`}
                  key={lead.id}
                >
                  <span className="ops-lead-person">
                    <span className="ops-avatar" aria-hidden="true">
                      {initials(name)}
                    </span>
                    <span>
                      <strong>{name}</strong>
                      <small>{humanize(lead.source)}</small>
                    </span>
                  </span>
                  <StatusBadge tone={statusTone(lead.status)}>{humanize(lead.status)}</StatusBadge>
                  <span
                    className="ops-lead-score"
                    aria-label={`AI score: ${lead.score === null ? 'not available' : String(lead.score)}`}
                  >
                    {lead.score ?? '—'}
                    <ChevronRight size={15} aria-hidden="true" />
                  </span>
                </a>
              );
            })}
            {!leads.length ? (
              <div className="ops-empty">
                <Inbox size={22} aria-hidden="true" />
                <p>No leads received yet.</p>
              </div>
            ) : null}
          </div>
          <div className="ops-advisory">
            <Sparkles size={14} aria-hidden="true" /> AI scores guide review. People make the
            decisions.
          </div>
        </section>

        <section className="ops-panel ops-health-panel">
          <div className="ops-panel-heading">
            <div>
              <h2>Automation health</h2>
              <p>Your latest workflow activity.</p>
            </div>
            <span
              className={`ops-health-dot ${dashboard.workflowFailure ? 'ops-health-dot-warning' : ''}`}
              aria-hidden="true"
            />
          </div>
          <div className="ops-health-metrics">
            <div>
              <strong>{percentOf(dashboard.workflowSuccess, totalRuns)}</strong>
              <span>success rate</span>
            </div>
            <div>
              <strong>{dashboard.workflowSuccess}</strong>
              <span>succeeded</span>
            </div>
            <div className={dashboard.workflowFailure ? 'ops-failed-count' : ''}>
              <strong>{dashboard.workflowFailure}</strong>
              <span>failed</span>
            </div>
          </div>
          <div className="ops-runs">
            {recentRuns.map((run) => (
              <div className="ops-run" key={run.id}>
                <span>
                  <strong>{run.externalRunId}</strong>
                  <small>{formatDateTime(run.updatedAt)}</small>
                </span>
                <StatusBadge tone={statusTone(run.status)}>{humanize(run.status)}</StatusBadge>
              </div>
            ))}
            {!recentRuns.length ? (
              <div className="ops-empty">
                <Clock3 size={20} aria-hidden="true" />
                <p>No workflow runs yet.</p>
              </div>
            ) : null}
          </div>
          <a className="ops-health-footer" href={`/?section=automations&client=${client}`}>
            View workflow health <ArrowRight size={15} aria-hidden="true" />
          </a>
        </section>
      </div>
    </div>
  );
}
