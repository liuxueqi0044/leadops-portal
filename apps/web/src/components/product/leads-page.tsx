'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  Filter,
  Gauge,
  Mail,
  Search,
  Sparkles,
  UserRound,
} from 'lucide-react';
import type { LeadDetailDto } from '@leadops/core';
import type { ProductData } from '@/lib/product/types';
import {
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateTime,
  humanize,
  statusTone,
} from './primitives';

const statuses = [
  'all',
  'received',
  'qualified',
  'needs_review',
  'approved',
  'rejected',
  'converted',
] as const;

function LeadScore({ score }: { score: number | null }) {
  return (
    <span className="score-cell">
      <strong>{score ?? '—'}</strong>
      <span className="score-track">
        <span style={{ width: `${String(score ?? 0)}%` }} />
      </span>
    </span>
  );
}

function LeadDetail({ lead, onBack }: { lead: LeadDetailDto; onBack: () => void }) {
  return (
    <div className="detail-page">
      <button className="back-button" type="button" onClick={onBack}>
        <ArrowLeft size={16} aria-hidden="true" />
        Back to leads
      </button>
      <PageHeader
        eyebrow={
          <>
            <StatusBadge tone={statusTone(lead.status)}>{humanize(lead.status)}</StatusBadge>
            <span>Received {formatDateTime(lead.receivedAt)}</span>
          </>
        }
        title={lead.contactName ?? 'Unnamed lead'}
        description={`${lead.company ?? 'Individual inquiry'} · ${lead.source}`}
        action={
          <div className="lead-score-hero">
            <Gauge size={18} aria-hidden="true" />
            <span>
              <strong>{lead.score ?? '—'}</strong>
              <small>AI score</small>
            </span>
          </div>
        }
      />
      <div className="detail-grid">
        <div className="detail-main">
          <section className="panel detail-section">
            <div className="detail-section-title">
              <span className="ai-label">
                <Sparkles size={15} aria-hidden="true" />
                AI suggestion
              </span>
              <StatusBadge tone="info">Advisory only</StatusBadge>
            </div>
            <h2>{lead.aiSuggestion?.summary ?? 'Qualification is still in progress.'}</h2>
            <p>
              {lead.aiSuggestion?.suggestedNextAction ?? 'No next action has been suggested yet.'}
            </p>
            <dl className="detail-facts">
              <div>
                <dt>Suggestion</dt>
                <dd>{humanize(lead.aiSuggestion?.decision ?? 'pending')}</dd>
              </div>
              <div>
                <dt>Confidence</dt>
                <dd>
                  {lead.confidence === null ? '—' : `${String(Math.round(lead.confidence * 100))}%`}
                </dd>
              </div>
              <div>
                <dt>Confirmed status</dt>
                <dd>{humanize(lead.confirmedStatus)}</dd>
              </div>
            </dl>
          </section>
          <section className="panel detail-section">
            <h2>Original inquiry</h2>
            <blockquote>{lead.message ?? 'No message was included.'}</blockquote>
          </section>
          <section className="panel detail-section">
            <h2>Activity timeline</h2>
            <ol className="history-list">
              {(lead.statusHistory ?? []).map((item, index) => (
                <li key={`${item.createdAt}-${String(index)}`}>
                  <span className="history-dot" />
                  <div>
                    <strong>{humanize(item.newStatus)}</strong>
                    <p>
                      {humanize(item.command)} · {humanize(item.performedBy)}
                    </p>
                    <time>{formatDateTime(item.createdAt)}</time>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        </div>
        <aside className="detail-aside">
          <section className="panel contact-card">
            <h2>Contact facts</h2>
            <dl>
              <div>
                <dt>
                  <Mail size={14} aria-hidden="true" />
                  Email
                </dt>
                <dd>{lead.email ?? 'Not provided'}</dd>
              </div>
              <div>
                <dt>
                  <Building2 size={14} aria-hidden="true" />
                  Company
                </dt>
                <dd>{lead.company ?? 'Not provided'}</dd>
              </div>
              <div>
                <dt>
                  <UserRound size={14} aria-hidden="true" />
                  Source
                </dt>
                <dd>{lead.source}</dd>
              </div>
            </dl>
          </section>
          <section className="panel outcome-card">
            <h2>Executed outcome</h2>
            <p>{lead.executedBusinessAction ?? 'No external business action has been recorded.'}</p>
          </section>
        </aside>
      </div>
    </div>
  );
}

export function LeadsPage({ data, initialLeadId }: { data: ProductData; initialLeadId?: string }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<(typeof statuses)[number]>('all');
  const [selectedId, setSelectedId] = useState(initialLeadId ?? '');
  const [details, setDetails] = useState(data.leadDetails);
  const [loadingId, setLoadingId] = useState('');
  const [detailError, setDetailError] = useState('');
  const selected = selectedId ? details[selectedId] : undefined;

  const openLead = useCallback(
    async (leadId: string) => {
      setSelectedId(leadId);
      setDetailError('');
      if (details[leadId] || data.mode === 'demo') return;
      setLoadingId(leadId);
      try {
        const response = await fetch(
          `/api/v1/clients/${encodeURIComponent(data.selectedClient.id)}/leads/${encodeURIComponent(leadId)}`,
        );
        if (!response.ok) throw new Error('The full lead record could not be loaded.');
        const detail = (await response.json()) as LeadDetailDto;
        if (!detail.id || detail.id !== leadId || !Array.isArray(detail.statusHistory)) {
          throw new Error('The server returned an invalid lead record.');
        }
        setDetails((current) => ({ ...current, [detail.id]: detail }));
      } catch (error) {
        setDetailError(
          error instanceof Error ? error.message : 'The full lead record could not be loaded.',
        );
      } finally {
        setLoadingId('');
      }
    },
    [data.mode, data.selectedClient.id, details],
  );

  useEffect(() => {
    if (initialLeadId && !details[initialLeadId]) void openLead(initialLeadId);
  }, [details, initialLeadId, openLead]);
  const filtered = useMemo(
    () =>
      data.leads.filter((lead) => {
        const matchesStatus = status === 'all' || lead.status === status;
        const searchText =
          `${lead.contactName ?? ''} ${lead.company ?? ''} ${lead.email ?? ''} ${lead.source}`.toLowerCase();
        return matchesStatus && searchText.includes(query.trim().toLowerCase());
      }),
    [data.leads, query, status],
  );

  if (selected)
    return (
      <LeadDetail
        lead={selected}
        onBack={() => {
          setSelectedId('');
        }}
      />
    );

  if (selectedId && loadingId === selectedId) {
    return (
      <EmptyState
        title="Loading lead details"
        description="Retrieving the original request and audit timeline."
      />
    );
  }

  if (selectedId && detailError) {
    return <EmptyState title="Lead details are unavailable" description={detailError} />;
  }

  return (
    <div className="product-page leads-page">
      <PageHeader
        eyebrow={
          <>
            <span>{data.selectedClient.name}</span>
            <span aria-hidden="true">/</span>
            <span>{data.leads.length} leads</span>
          </>
        }
        title="Leads"
        description="Review incoming demand, AI suggestions and confirmed business status."
      />
      <div className="filter-bar">
        <label className="filter-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search leads</span>
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Search name, company or email"
          />
        </label>
        <label className="filter-select">
          <Filter size={15} aria-hidden="true" />
          <span className="sr-only">Filter by status</span>
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as (typeof statuses)[number]);
            }}
          >
            {statuses.map((item) => (
              <option value={item} key={item}>
                {item === 'all' ? 'All statuses' : humanize(item)}
              </option>
            ))}
          </select>
        </label>
        <span className="filter-result">
          {filtered.length} result{filtered.length === 1 ? '' : 's'}
        </span>
      </div>
      {filtered.length ? (
        <div className="data-surface">
          <div className="data-table-wrap">
            <table className="data-table leads-table">
              <thead>
                <tr>
                  <th>Lead</th>
                  <th>Source</th>
                  <th>AI score</th>
                  <th>Status</th>
                  <th>Received</th>
                  <th>Next action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((lead) => (
                  <tr
                    key={lead.id}
                    onClick={() => {
                      void openLead(lead.id);
                    }}
                  >
                    <td>
                      <button className="row-link" type="button">
                        <span className="person-avatar">
                          {(lead.contactName ?? '?').slice(0, 1).toUpperCase()}
                        </span>
                        <span>
                          <strong>{lead.contactName ?? 'Unnamed lead'}</strong>
                          <small>{lead.company ?? lead.email ?? 'No company'}</small>
                        </span>
                      </button>
                    </td>
                    <td>{lead.source}</td>
                    <td>
                      <LeadScore score={lead.score} />
                    </td>
                    <td>
                      <StatusBadge tone={statusTone(lead.status)}>
                        {humanize(lead.status)}
                      </StatusBadge>
                    </td>
                    <td>{formatDateTime(lead.receivedAt)}</td>
                    <td className="next-action">
                      {lead.aiSuggestion?.suggestedNextAction ?? 'Await qualification'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="lead-card-list">
            {filtered.map((lead) => (
              <button
                className="lead-card"
                type="button"
                key={lead.id}
                onClick={() => {
                  void openLead(lead.id);
                }}
              >
                <span className="lead-card-head">
                  <span>
                    <strong>{lead.contactName ?? 'Unnamed lead'}</strong>
                    <small>{lead.company ?? lead.source}</small>
                  </span>
                  <StatusBadge tone={statusTone(lead.status)}>{humanize(lead.status)}</StatusBadge>
                </span>
                <span className="lead-card-meta">
                  <span>
                    AI score <strong>{lead.score ?? '—'}</strong>
                  </span>
                  <span>{formatDateTime(lead.receivedAt)}</span>
                </span>
                <p>{lead.aiSuggestion?.suggestedNextAction ?? 'Awaiting qualification'}</p>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <EmptyState
          title="No leads match these filters"
          description="Clear the search or choose a different status. No lead data was changed."
        />
      )}
    </div>
  );
}
