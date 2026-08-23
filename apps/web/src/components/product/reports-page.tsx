'use client';

import { useState } from 'react';
import {
  ArrowLeft,
  CalendarRange,
  CheckCircle2,
  FileChartColumn,
  Inbox,
  Workflow,
} from 'lucide-react';
import type { ReportSnapshotDto } from '@leadops/core';
import type { ProductData } from '@/lib/product/types';
import {
  EmptyState,
  MetricTile,
  PageHeader,
  StatusBadge,
  formatDate,
  formatPercent,
} from './primitives';

function ReportDetail({ report, onBack }: { report: ReportSnapshotDto; onBack: () => void }) {
  const totalRuns = report.metrics.workflowSuccess + report.metrics.workflowFailure;
  return (
    <div className="detail-page">
      <button className="back-button" type="button" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back to reports
      </button>
      <PageHeader
        eyebrow={
          <>
            <StatusBadge tone="neutral">Immutable snapshot</StatusBadge>
            <span>Generated {formatDate(report.generatedAt)}</span>
          </>
        }
        title={`${formatDate(report.periodStart, { month: 'short', day: 'numeric' })} – ${formatDate(report.periodEnd, { month: 'short', day: 'numeric', year: 'numeric' })}`}
        description="A fixed weekly record that will not change when underlying data changes."
      />
      <div className="metrics-row report-detail-metrics">
        <MetricTile
          label="Leads received"
          value={String(report.metrics.leadsReceived)}
          context="New inquiries"
          icon={Inbox}
        />
        <MetricTile
          label="Qualification rate"
          value={formatPercent(report.metrics.qualificationRate)}
          context="Structured AI suggestions"
          icon={CheckCircle2}
          tone="success"
        />
        <MetricTile
          label="Approval conversion"
          value={formatPercent(report.metrics.approvalConversion)}
          context="Human-confirmed decisions"
          icon={CalendarRange}
          tone="brand"
        />
        <MetricTile
          label="Workflow success"
          value={formatPercent(totalRuns ? report.metrics.workflowSuccess / totalRuns : 0)}
          context={`${String(totalRuns)} total runs`}
          icon={Workflow}
        />
      </div>
      <section className="panel report-narrative">
        <h2>Weekly outcome summary</h2>
        <p>
          The operation received <strong>{report.metrics.leadsReceived} leads</strong>, converted{' '}
          <strong>{formatPercent(report.metrics.approvalConversion)}</strong> of reviewed
          opportunities, and recorded <strong>{report.metrics.appointments} appointments</strong>.
        </p>
        <div className="report-balance">
          <span>
            <strong>{report.metrics.workflowSuccess}</strong>
            <small>successful runs</small>
          </span>
          <span>
            <strong>{report.metrics.workflowFailure}</strong>
            <small>failed runs</small>
          </span>
          <span>
            <strong>{report.metrics.openIncidents}</strong>
            <small>open incidents</small>
          </span>
          <span>
            <strong>{report.metrics.resolvedIncidents}</strong>
            <small>resolved incidents</small>
          </span>
        </div>
      </section>
    </div>
  );
}

export function ReportsPage({ data }: { data: ProductData }) {
  const [selectedId, setSelectedId] = useState('');
  const selected = data.reports.find((report) => report.id === selectedId);
  if (selected)
    return (
      <ReportDetail
        report={selected}
        onBack={() => {
          setSelectedId('');
        }}
      />
    );
  return (
    <div className="product-page reports-page">
      <PageHeader
        eyebrow={
          <>
            <span>{data.selectedClient.name}</span>
            <span aria-hidden="true">/</span>
            <span>Weekly snapshots</span>
          </>
        }
        title="Reports"
        description="Fixed-period business outcomes built for client conversations, not ad-hoc BI."
      />
      {data.reports.length ? (
        <div className="report-grid">
          {data.reports.map((report, index) => (
            <button
              className="report-card"
              type="button"
              key={report.id}
              onClick={() => {
                setSelectedId(report.id);
              }}
            >
              <span className="report-card-top">
                <span className="report-icon">
                  <FileChartColumn size={20} aria-hidden="true" />
                </span>
                <StatusBadge tone={index === 0 ? 'brand' : 'neutral'}>
                  {index === 0 ? 'Latest' : 'Snapshot'}
                </StatusBadge>
              </span>
              <h2>
                {formatDate(report.periodStart, { month: 'short', day: 'numeric' })} –{' '}
                {formatDate(report.periodEnd, { month: 'short', day: 'numeric' })}
              </h2>
              <p>
                {report.metrics.leadsReceived} leads · {report.metrics.appointments} appointments
              </p>
              <dl>
                <div>
                  <dt>Qualification</dt>
                  <dd>{formatPercent(report.metrics.qualificationRate)}</dd>
                </div>
                <div>
                  <dt>Approval conversion</dt>
                  <dd>{formatPercent(report.metrics.approvalConversion)}</dd>
                </div>
              </dl>
              <span className="report-view">View report</span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No weekly reports yet"
          description="The first immutable report snapshot will appear after the weekly reporting job completes."
          icon={FileChartColumn}
        />
      )}
    </div>
  );
}
