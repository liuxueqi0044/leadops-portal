'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BellRing, CheckCircle2, CircleAlert, ShieldCheck } from 'lucide-react';
import type { IncidentDetailResponse, IncidentDto } from '@leadops/core';
import type { ProductData } from '@/lib/product/types';
import {
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateTime,
  humanize,
  statusTone,
} from './primitives';

export function IncidentsPage({
  data,
  initialIncidentId,
}: {
  data: ProductData;
  initialIncidentId?: string;
}) {
  const [filter, setFilter] = useState<'active' | 'resolved'>('active');
  const [selectedId, setSelectedId] = useState(initialIncidentId ?? '');
  const [items, setItems] = useState(data.incidents);
  const [details, setDetails] = useState<Record<string, IncidentDetailResponse>>({});
  const [loadingId, setLoadingId] = useState('');
  const [detailError, setDetailError] = useState('');
  const selectedSummary = items.find((item) => item.id === selectedId);
  const selectedDetail = selectedId ? details[selectedId] : undefined;
  const selected = selectedDetail ?? selectedSummary;
  const filtered = useMemo(
    () =>
      items.filter((item) =>
        filter === 'active' ? item.status !== 'resolved' : item.status === 'resolved',
      ),
    [filter, items],
  );

  const openIncident = useCallback(
    async (incidentId: string) => {
      setSelectedId(incidentId);
      setDetailError('');
      if (details[incidentId] || data.mode === 'demo') return;
      setLoadingId(incidentId);
      try {
        const response = await fetch(`/api/v1/incidents/${encodeURIComponent(incidentId)}`);
        if (!response.ok) throw new Error('The incident history could not be loaded.');
        const detail = (await response.json()) as IncidentDetailResponse;
        if (
          !detail.id ||
          detail.id !== incidentId ||
          (detail.events && !Array.isArray(detail.events))
        ) {
          throw new Error('The server returned an invalid incident record.');
        }
        setDetails((current) => ({ ...current, [detail.id]: detail }));
      } catch (error) {
        setDetailError(
          error instanceof Error ? error.message : 'The incident history could not be loaded.',
        );
      } finally {
        setLoadingId('');
      }
    },
    [data.mode, details],
  );

  useEffect(() => {
    if (initialIncidentId && !details[initialIncidentId]) void openIncident(initialIncidentId);
  }, [details, initialIncidentId, openIncident]);

  async function transition(incident: IncidentDto, action: 'acknowledge' | 'resolve') {
    if (data.mode === 'live') {
      const response = await fetch(`/api/v1/incidents/${incident.id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedStatus: incident.status }),
      });
      if (!response.ok) return;
    }
    setItems((current) =>
      current.map((item) =>
        item.id === incident.id
          ? {
              ...item,
              status: action === 'resolve' ? 'resolved' : 'acknowledged',
              updatedAt: new Date().toISOString(),
            }
          : item,
      ),
    );
    setDetails((current) => {
      const detail = current[incident.id];
      return detail
        ? {
            ...current,
            [incident.id]: {
              ...detail,
              status: action === 'resolve' ? 'resolved' : 'acknowledged',
              updatedAt: new Date().toISOString(),
            },
          }
        : current;
    });
  }

  if (selected)
    return (
      <div className="detail-page">
        <button
          className="back-button"
          type="button"
          onClick={() => {
            setSelectedId('');
          }}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          Back to incidents
        </button>
        <PageHeader
          eyebrow={
            <>
              <StatusBadge tone={statusTone(selected.severity)}>
                {humanize(selected.severity)} severity
              </StatusBadge>
              <StatusBadge tone={statusTone(selected.status)}>
                {humanize(selected.status)}
              </StatusBadge>
            </>
          }
          title={humanize(selected.category)}
          description={selected.errorSummary ?? 'Workflow incident'}
          action={
            <div className="incident-actions">
              {selected.status === 'open' ? (
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => void transition(selected, 'acknowledge')}
                >
                  Acknowledge
                </button>
              ) : null}
              {selected.status !== 'resolved' ? (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void transition(selected, 'resolve')}
                >
                  Resolve incident
                </button>
              ) : null}
            </div>
          }
        />
        <div className="detail-grid incident-detail-grid">
          <section className="panel detail-section">
            <h2>Impact</h2>
            <p>{selected.errorSummary ?? 'No customer-facing impact summary is available.'}</p>
            <dl className="detail-facts">
              <div>
                <dt>Occurrences</dt>
                <dd>{selected.occurrenceCount}</dd>
              </div>
              <div>
                <dt>First seen</dt>
                <dd>{formatDateTime(selected.firstSeenAt)}</dd>
              </div>
              <div>
                <dt>Last seen</dt>
                <dd>{formatDateTime(selected.lastSeenAt)}</dd>
              </div>
            </dl>
            {selectedDetail?.events?.length ? (
              <div className="incident-event-history">
                <h2>Incident history</h2>
                <ol className="history-list">
                  {selectedDetail.events.map((event) => (
                    <li key={event.id}>
                      <span className="history-dot" />
                      <div>
                        <strong>{humanize(event.eventType)}</strong>
                        <p>{event.actor ? `By ${event.actor}` : 'System event'}</p>
                        <time>{formatDateTime(event.createdAt)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            ) : null}
          </section>
          <aside className="panel contact-card">
            <h2>Trace context</h2>
            <dl>
              <div>
                <dt>Category</dt>
                <dd>{humanize(selected.category)}</dd>
              </div>
              <div>
                <dt>Workflow</dt>
                <dd>{selected.workflowId?.slice(0, 12) ?? 'System job'}</dd>
              </div>
              <div>
                <dt>Fingerprint</dt>
                <dd className="mono-value">{selected.fingerprint}</dd>
              </div>
            </dl>
          </aside>
        </div>
      </div>
    );

  if (selectedId && loadingId === selectedId) {
    return (
      <EmptyState
        title="Loading incident details"
        description="Retrieving the event history and trace context."
      />
    );
  }

  if (selectedId && detailError) {
    return <EmptyState title="Incident details are unavailable" description={detailError} />;
  }

  return (
    <div className="product-page incidents-page">
      <PageHeader
        eyebrow={
          <>
            <span>{data.selectedClient.name}</span>
            <span aria-hidden="true">/</span>
            <span>Operational exceptions</span>
          </>
        }
        title="Incidents"
        description="Aggregate recurring failures into one calm, traceable response queue."
      />
      <div className="segmented-control">
        <button
          type="button"
          className={filter === 'active' ? 'active' : ''}
          onClick={() => {
            setFilter('active');
          }}
        >
          Open & acknowledged
        </button>
        <button
          type="button"
          className={filter === 'resolved' ? 'active' : ''}
          onClick={() => {
            setFilter('resolved');
          }}
        >
          Resolved
        </button>
      </div>
      {filtered.length ? (
        <div className="incident-list">
          {filtered.map((incident) => (
            <button
              className="incident-card"
              type="button"
              onClick={() => {
                void openIncident(incident.id);
              }}
              key={incident.id}
            >
              <span className={`incident-severity incident-severity-${incident.severity}`}>
                {incident.status === 'resolved' ? (
                  <ShieldCheck size={18} aria-hidden="true" />
                ) : (
                  <BellRing size={18} aria-hidden="true" />
                )}
              </span>
              <span className="incident-copy">
                <span>
                  <strong>{humanize(incident.category)}</strong>
                  <StatusBadge tone={statusTone(incident.status)}>
                    {humanize(incident.status)}
                  </StatusBadge>
                </span>
                <p>{incident.errorSummary ?? 'No impact summary'}</p>
                <small>
                  {incident.occurrenceCount} occurrence{incident.occurrenceCount === 1 ? '' : 's'} ·
                  last seen {formatDateTime(incident.lastSeenAt)}
                </small>
              </span>
              <StatusBadge
                tone={
                  incident.severity === 'critical' || incident.severity === 'high'
                    ? 'danger'
                    : incident.severity === 'medium'
                      ? 'warning'
                      : 'neutral'
                }
              >
                {humanize(incident.severity)}
              </StatusBadge>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          title={filter === 'active' ? 'No active incidents' : 'No resolved incidents'}
          description={
            filter === 'active'
              ? 'Your automation operation has no failures requiring attention.'
              : 'Resolved incidents will remain available for review.'
          }
          icon={filter === 'active' ? CheckCircle2 : CircleAlert}
        />
      )}
    </div>
  );
}
