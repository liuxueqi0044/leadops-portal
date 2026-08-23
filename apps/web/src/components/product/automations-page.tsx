import { CheckCircle2, CircleAlert, Clock3, HeartPulse, TimerReset, Workflow } from 'lucide-react';
import type { ProductData } from '@/lib/product/types';
import {
  EmptyState,
  MetricTile,
  PageHeader,
  StatusBadge,
  formatDateTime,
  formatPercent,
  humanize,
  statusTone,
} from './primitives';

function workflowErrorMessage(error: Record<string, unknown> | null): string {
  return typeof error?.message === 'string' ? error.message : 'Saved for retry';
}

export function AutomationsPage({ data }: { data: ProductData }) {
  const total = data.dashboard.workflowSuccess + data.dashboard.workflowFailure;
  const successRate = total ? data.dashboard.workflowSuccess / total : 0;
  const running = data.workflowRuns.filter((run) => run.status === 'started').length;
  const failures = data.workflowRuns.filter((run) => run.status === 'failed');

  return (
    <div className="product-page automations-page">
      <PageHeader
        eyebrow={
          <>
            <span>{data.selectedClient.name}</span>
            <span aria-hidden="true">/</span>
            <span>Last 24 hours</span>
          </>
        }
        title="Automations"
        description="Business workflow health without exposing noisy node-level internals."
      />
      <div className="metrics-row">
        <MetricTile
          label="Success rate"
          value={formatPercent(successRate)}
          context={`${String(total)} completed or failed runs`}
          icon={HeartPulse}
          tone={successRate > 0.97 ? 'success' : 'warning'}
        />
        <MetricTile
          label="Running now"
          value={String(running)}
          context="Active workflow executions"
          icon={Clock3}
        />
        <MetricTile
          label="Failed"
          value={String(data.dashboard.workflowFailure)}
          context="Results remain stored for retry"
          icon={CircleAlert}
          tone={data.dashboard.workflowFailure ? 'warning' : 'success'}
        />
      </div>
      <div className="automation-grid">
        <section className="panel integration-panel">
          <div className="integration-hero">
            <span className="integration-logo">n8n</span>
            <div>
              <h2>Lead intake and outcomes</h2>
              <p>Signed events, qualification, approvals and callback delivery</p>
            </div>
            <StatusBadge tone={failures.length ? 'warning' : 'success'}>
              {failures.length ? 'Retrying safely' : 'Healthy'}
            </StatusBadge>
          </div>
          <dl className="integration-facts">
            <div>
              <dt>Last run</dt>
              <dd>{formatDateTime(data.workflowRuns[0]?.updatedAt)}</dd>
            </div>
            <div>
              <dt>Successful</dt>
              <dd>{data.dashboard.workflowSuccess}</dd>
            </div>
            <div>
              <dt>Client boundary</dt>
              <dd>Verified</dd>
            </div>
          </dl>
        </section>
        <section className="panel protection-panel">
          <span className="protection-icon">
            <TimerReset size={21} aria-hidden="true" />
          </span>
          <h2>Safe retries are active</h2>
          <p>
            External failures do not erase approval decisions. Delivery jobs retry with stable
            idempotency keys.
          </p>
        </section>
      </div>
      <section className="data-surface workflow-runs">
        <div className="table-title">
          <div>
            <h2>Recent workflow runs</h2>
            <p>Correlation-ready status history for this client</p>
          </div>
        </div>
        {data.workflowRuns.length ? (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.workflowRuns.map((run) => {
                  const end = run.succeededAt ?? run.failedAt;
                  const duration =
                    run.startedAt && end
                      ? `${String(Math.max(1, Math.round((Date.parse(end) - Date.parse(run.startedAt)) / 1000)))}s`
                      : 'In progress';
                  return (
                    <tr key={run.id}>
                      <td>
                        <span className="run-name">
                          <span className={`run-icon run-${run.status}`}>
                            {run.status === 'succeeded' ? (
                              <CheckCircle2 size={15} aria-hidden="true" />
                            ) : run.status === 'failed' ? (
                              <CircleAlert size={15} aria-hidden="true" />
                            ) : (
                              <Workflow size={15} aria-hidden="true" />
                            )}
                          </span>
                          <span>
                            <strong>Lead intake</strong>
                            <small>{run.externalRunId}</small>
                          </span>
                        </span>
                      </td>
                      <td>
                        <StatusBadge tone={statusTone(run.status)}>
                          {humanize(run.status)}
                        </StatusBadge>
                      </td>
                      <td>{formatDateTime(run.startedAt)}</td>
                      <td>{duration}</td>
                      <td className="outcome-copy">
                        {run.status === 'failed'
                          ? workflowErrorMessage(run.error)
                          : run.status === 'started'
                            ? 'Processing business event'
                            : 'Business result recorded'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            title="No workflow runs yet"
            description="Signed workflow activity will appear here after the first event arrives."
            icon={Workflow}
          />
        )}
      </section>
    </div>
  );
}
