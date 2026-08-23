import {
  CalendarDays,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Gauge,
  Inbox,
  Sparkles,
  UserCheck,
  Workflow,
} from 'lucide-react';
import type { ProductData } from '@/lib/product/types';
import {
  DemoNotice,
  MetricTile,
  PageHeader,
  SectionHeader,
  StatusBadge,
  formatDateTime,
  formatPercent,
  humanize,
  statusTone,
} from './primitives';

export function Overview({ data }: { data: ProductData }) {
  const { dashboard, selectedClient, approvals, incidents, workflowRuns, leads } = data;
  const pending = approvals.filter((approval) => approval.status === 'pending');
  const openIncidents = incidents.filter((incident) => incident.status !== 'resolved');
  const recentRuns = workflowRuns.slice(0, 4);
  const funnel = [
    { label: 'Leads received', value: dashboard.leadsReceived, ratio: 1 },
    {
      label: 'AI qualified',
      value: dashboard.totalQualified,
      ratio: dashboard.leadsReceived ? dashboard.totalQualified / dashboard.leadsReceived : 0,
    },
    {
      label: 'Human approved',
      value: dashboard.totalApproved,
      ratio: dashboard.leadsReceived ? dashboard.totalApproved / dashboard.leadsReceived : 0,
    },
    {
      label: 'Appointments',
      value: dashboard.appointments,
      ratio: dashboard.leadsReceived ? dashboard.appointments / dashboard.leadsReceived : 0,
    },
  ];

  return (
    <div className="product-page overview-page">
      <PageHeader
        eyebrow={
          <>
            <span>{selectedClient.name}</span>
            <span aria-hidden="true">/</span>
            <StatusBadge tone={data.mode === 'live' ? 'success' : 'neutral'}>
              {data.mode === 'live' ? 'Live workspace' : 'Sample data'}
            </StatusBadge>
          </>
        }
        title={`Good morning, ${data.me.user.name.split(/\s+/u)[0] ?? 'there'}.`}
        description="A clear view of lead outcomes, pending decisions and automation health."
        action={
          <span className="date-button">
            <CalendarDays size={16} aria-hidden="true" />
            Last 7 days
          </span>
        }
      />
      {data.mode === 'demo' ? <DemoNotice /> : null}

      <section
        className={`operation-strip ${dashboard.workflowFailure || openIncidents.length ? 'operation-strip-warning' : ''}`}
        aria-label="Operations summary"
      >
        <span className="operation-strip-icon">
          {dashboard.workflowFailure || openIncidents.length ? (
            <CircleAlert size={17} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={17} aria-hidden="true" />
          )}
        </span>
        <div>
          <strong>
            {dashboard.workflowFailure || openIncidents.length
              ? 'Your outcomes are safe, but one workflow needs attention.'
              : 'Your lead operation is healthy.'}
          </strong>
          <p>
            {dashboard.workflowSuccess} successful runs · {dashboard.workflowFailure} failed ·{' '}
            {openIncidents.length} open incident{openIncidents.length === 1 ? '' : 's'}
          </p>
        </div>
        <a href={`/?section=automations&client=${selectedClient.id}`}>Inspect health</a>
      </section>

      <div className="overview-metrics">
        <article className="metric-feature">
          <div>
            <span>Qualified leads</span>
            <strong>{dashboard.totalQualified}</strong>
            <p>{formatPercent(dashboard.qualificationRate)} of incoming leads</p>
          </div>
          <div
            className="score-orbit"
            aria-label={`Average lead score ${dashboard.avgScore?.toFixed(0) ?? 'not available'}`}
          >
            <span>{dashboard.avgScore?.toFixed(0) ?? '—'}</span>
            <small>avg score</small>
          </div>
        </article>
        <MetricTile
          label="Approval conversion"
          value={formatPercent(dashboard.approvalConversion)}
          context={`${String(dashboard.totalApproved)} decisions approved`}
          icon={UserCheck}
          tone="brand"
        />
        <MetricTile
          label="Appointments"
          value={String(dashboard.appointments)}
          context="Confirmed business outcomes"
          icon={CalendarDays}
          tone="success"
        />
        <MetricTile
          label="Automation success"
          value={formatPercent(
            dashboard.workflowSuccess + dashboard.workflowFailure
              ? dashboard.workflowSuccess / (dashboard.workflowSuccess + dashboard.workflowFailure)
              : 0,
          )}
          context={`${String(dashboard.workflowSuccess + dashboard.workflowFailure)} workflow runs`}
          icon={Workflow}
        />
      </div>

      <div className="overview-grid overview-grid-primary">
        <section className="panel">
          <SectionHeader
            title="Lead funnel"
            description="How inquiries moved toward a booked appointment"
            href={`/?section=leads&client=${selectedClient.id}`}
            actionLabel="View leads"
          />
          <div className="funnel-list">
            {funnel.map((stage) => (
              <div className="funnel-row" key={stage.label}>
                <div className="funnel-label-row">
                  <span>{stage.label}</span>
                  <span>
                    <strong>{stage.value}</strong>
                    <small>{formatPercent(stage.ratio)}</small>
                  </span>
                </div>
                <div className="funnel-track">
                  <span
                    className="funnel-fill"
                    style={{ width: `${String(Math.max(2, stage.ratio * 100))}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="funnel-insight">
            <Sparkles size={16} aria-hidden="true" />
            <p>
              <strong>AI remains advisory.</strong> Qualification suggestions are separated from
              confirmed human decisions and completed actions.
            </p>
          </div>
        </section>

        <section className="panel attention-panel">
          <SectionHeader title="Needs attention" description="Ordered by business impact and age" />
          <div className="attention-summary">
            <strong>{pending.length + openIncidents.length}</strong>
            <span>open items</span>
            {pending[0] ? (
              <StatusBadge tone="warning">
                Oldest · {formatDateTime(pending.at(-1)?.createdAt)}
              </StatusBadge>
            ) : null}
          </div>
          <div className="attention-list">
            {pending.slice(0, 2).map((approval) => (
              <a
                className="attention-item"
                href={`/?section=approvals&client=${selectedClient.id}&approval=${approval.id}`}
                key={approval.id}
              >
                <span className="attention-item-icon attention-icon-warning">
                  <UserCheck size={17} aria-hidden="true" />
                </span>
                <span className="attention-item-copy">
                  <strong>{approval.snapshot.contactName ?? 'Lead'} needs a decision</strong>
                  <small>
                    {approval.snapshot.suggestedNextAction ?? 'Review the qualification snapshot'}
                  </small>
                </span>
              </a>
            ))}
            {openIncidents.slice(0, 1).map((incident) => (
              <a
                className="attention-item"
                href={`/?section=incidents&client=${selectedClient.id}&incident=${incident.id}`}
                key={incident.id}
              >
                <span className="attention-item-icon attention-icon-danger">
                  <CircleAlert size={17} aria-hidden="true" />
                </span>
                <span className="attention-item-copy">
                  <strong>{humanize(incident.category)}</strong>
                  <small>{incident.errorSummary ?? 'Workflow issue requires review'}</small>
                </span>
              </a>
            ))}
            {!pending.length && !openIncidents.length ? (
              <div className="attention-clear">
                <CheckCircle2 size={18} aria-hidden="true" />
                <span>
                  <strong>Nothing is waiting</strong>
                  <small>Your team is caught up.</small>
                </span>
              </div>
            ) : null}
          </div>
          <a
            className="primary-button attention-action"
            href={`/?section=approvals&client=${selectedClient.id}`}
          >
            Open approval queue
          </a>
        </section>
      </div>

      <div className="overview-grid overview-grid-secondary">
        <section className="panel activity-panel">
          <SectionHeader
            title="Recent lead activity"
            description="Decision-relevant updates, without workflow noise"
            href={`/?section=leads&client=${selectedClient.id}`}
            actionLabel="View all"
          />
          <ol className="activity-list">
            {leads.slice(0, 4).map((lead) => (
              <li key={lead.id}>
                <span className={`timeline-icon timeline-${statusTone(lead.status)}`}>
                  <Inbox size={16} aria-hidden="true" />
                </span>
                <div>
                  <div className="timeline-title">
                    <strong>
                      {lead.contactName ?? 'Unnamed lead'} · {humanize(lead.status)}
                    </strong>
                    <time>{formatDateTime(lead.receivedAt)}</time>
                  </div>
                  <p>
                    {lead.aiSuggestion?.summary ??
                      `New ${lead.source} inquiry is ready for qualification.`}
                  </p>
                  <span className="timeline-meta">
                    <Gauge size={13} aria-hidden="true" />
                    {lead.score === null
                      ? 'Awaiting score'
                      : `AI score ${String(lead.score)} · suggestion only`}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="panel health-panel">
          <SectionHeader title="Automation health" description="Latest workflow runs" />
          <div className="health-summary">
            <span className="health-summary-icon">
              <Workflow size={20} aria-hidden="true" />
            </span>
            <div>
              <strong>{dashboard.workflowFailure ? 'Stable with retries' : 'Healthy'}</strong>
              <small>{dashboard.workflowSuccess} completed successfully</small>
            </div>
            <StatusBadge tone={dashboard.workflowFailure ? 'warning' : 'success'}>
              {dashboard.workflowFailure
                ? `${String(dashboard.workflowFailure)} needs review`
                : 'All operational'}
            </StatusBadge>
          </div>
          <div className="compact-list">
            {recentRuns.map((run) => (
              <div className="compact-row" key={run.id}>
                <span>
                  <strong>Lead intake</strong>
                  <small>{run.externalRunId}</small>
                </span>
                <span className="compact-row-end">
                  <StatusBadge tone={statusTone(run.status)}>{humanize(run.status)}</StatusBadge>
                  <small>{formatDateTime(run.updatedAt)}</small>
                </span>
              </div>
            ))}
            {!recentRuns.length ? (
              <div className="compact-empty">
                <Clock3 size={16} aria-hidden="true" />
                No workflow runs yet
              </div>
            ) : null}
          </div>
          <a
            className="secondary-button health-action"
            href={`/?section=automations&client=${selectedClient.id}`}
          >
            Inspect workflow health
          </a>
        </section>
      </div>
    </div>
  );
}
