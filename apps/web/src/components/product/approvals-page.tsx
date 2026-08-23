'use client';

import { useMemo, useState } from 'react';
import { Check, CheckCircle2, Clock3, ExternalLink, Scale, X } from 'lucide-react';
import type { ApprovalListItem } from '@leadops/core';
import type { ProductData } from '@/lib/product/types';
import {
  EmptyState,
  PageHeader,
  StatusBadge,
  formatDateTime,
  humanize,
  statusTone,
} from './primitives';

type Decision = 'approved' | 'rejected';

function ApprovalSheet({
  approval,
  mode,
  onClose,
  onDecided,
}: {
  approval: ApprovalListItem;
  mode: 'live' | 'demo';
  onClose: () => void;
  onDecided: (decision: Decision) => void;
}) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState<Decision | null>(null);
  const [error, setError] = useState('');
  const snapshot = approval.snapshot;

  async function decide(decision: Decision) {
    setSubmitting(decision);
    setError('');
    if (mode === 'demo') {
      onDecided(decision);
      setSubmitting(null);
      return;
    }
    try {
      const response = await fetch(`/api/v1/approvals/${approval.id}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reason: reason.trim() || undefined,
          expectedVersion: approval.version,
        }),
      });
      if (!response.ok) {
        if (response.status === 409)
          throw new Error(
            'Someone else already decided this request. Refresh to see the final result.',
          );
        throw new Error('The decision could not be saved. No external action was triggered.');
      }
      onDecided(decision);
    } catch (decisionError) {
      setError(
        decisionError instanceof Error ? decisionError.message : 'The decision could not be saved.',
      );
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div
      className="sheet-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        className="approval-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="approval-title"
      >
        <header className="sheet-header">
          <div>
            <span className="sheet-kicker">Human decision</span>
            <h2 id="approval-title">{snapshot.contactName ?? 'Approval request'}</h2>
            <p>
              {snapshot.company ?? 'Individual lead'} · expires {formatDateTime(approval.expiresAt)}
            </p>
          </div>
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close approval"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>
        <div className="sheet-body">
          <div className="decision-boundary">
            <Scale size={18} aria-hidden="true" />
            <p>
              <strong>You are confirming a business decision.</strong> The AI summary below is
              evidence, not the final decision.
            </p>
          </div>
          <div className="approval-score">
            <span>
              <strong>{String(snapshot.score ?? '—')}</strong>
              <small>AI score</small>
            </span>
            <div>
              <StatusBadge tone="info">
                {humanize(snapshot.qualificationDecision ?? 'pending')}
              </StatusBadge>
              <p>{snapshot.qualificationSummary ?? 'No qualification summary provided.'}</p>
            </div>
          </div>
          <section className="snapshot-section">
            <h3>Original request</h3>
            <blockquote>{snapshot.message ?? 'No customer message was included.'}</blockquote>
          </section>
          <section className="snapshot-section">
            <h3>Suggested next action</h3>
            <p>{snapshot.suggestedNextAction ?? 'No action was suggested.'}</p>
          </section>
          <label className="reason-field">
            <span>
              Decision note <small>Optional</small>
            </span>
            <textarea
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              maxLength={1000}
              placeholder="Add context for the audit trail"
            />
          </label>
          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="sheet-footer">
          <button
            className="reject-button"
            type="button"
            disabled={submitting !== null || approval.status !== 'pending'}
            onClick={() => void decide('rejected')}
          >
            <X size={16} aria-hidden="true" />
            {submitting === 'rejected' ? 'Saving…' : 'Reject'}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={submitting !== null || approval.status !== 'pending'}
            onClick={() => void decide('approved')}
          >
            <Check size={16} aria-hidden="true" />
            {submitting === 'approved' ? 'Saving…' : 'Approve'}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function ApprovalsPage({
  data,
  initialApprovalId,
}: {
  data: ProductData;
  initialApprovalId?: string;
}) {
  const [filter, setFilter] = useState<'pending' | 'completed'>('pending');
  const [items, setItems] = useState(data.approvals);
  const [selectedId, setSelectedId] = useState(initialApprovalId ?? '');
  const selected = items.find((approval) => approval.id === selectedId);
  const filtered = useMemo(
    () =>
      items.filter((approval) =>
        filter === 'pending' ? approval.status === 'pending' : approval.status !== 'pending',
      ),
    [filter, items],
  );

  function markDecided(decision: Decision) {
    setItems((current) =>
      current.map((item) =>
        item.id === selectedId
          ? {
              ...item,
              status: decision,
              version: item.version + 1,
              decidedAt: new Date().toISOString(),
              decidedBy: data.me.user.name,
            }
          : item,
      ),
    );
    setSelectedId('');
  }

  return (
    <div className="product-page approvals-page">
      <PageHeader
        eyebrow={
          <>
            <span>{data.selectedClient.name}</span>
            <span aria-hidden="true">/</span>
            <span>Human review</span>
          </>
        }
        title="Approvals"
        description="Make deliberate decisions from an immutable lead snapshot."
        action={
          data.mode === 'demo' ? (
            <a className="secondary-button" href="/approve/demo-token" target="_blank">
              Public page preview
              <ExternalLink size={14} aria-hidden="true" />
            </a>
          ) : undefined
        }
      />
      <div className="approval-stats">
        <div>
          <span className="stat-icon stat-warning">
            <Clock3 size={18} aria-hidden="true" />
          </span>
          <span>
            <strong>{items.filter((item) => item.status === 'pending').length}</strong>
            <small>Waiting for a decision</small>
          </span>
        </div>
        <div>
          <span className="stat-icon stat-success">
            <CheckCircle2 size={18} aria-hidden="true" />
          </span>
          <span>
            <strong>{items.filter((item) => item.status === 'approved').length}</strong>
            <small>Approved recently</small>
          </span>
        </div>
      </div>
      <div className="segmented-control" aria-label="Approval status">
        <button
          type="button"
          className={filter === 'pending' ? 'active' : ''}
          onClick={() => {
            setFilter('pending');
          }}
        >
          Needs decision
        </button>
        <button
          type="button"
          className={filter === 'completed' ? 'active' : ''}
          onClick={() => {
            setFilter('completed');
          }}
        >
          Completed
        </button>
      </div>
      {filtered.length ? (
        <div className="approval-list">
          {filtered.map((approval) => (
            <button
              className="approval-card"
              type="button"
              key={approval.id}
              onClick={() => {
                setSelectedId(approval.id);
              }}
            >
              <span className="approval-card-score">
                <strong>{String(approval.snapshot.score ?? '—')}</strong>
                <small>score</small>
              </span>
              <span className="approval-card-copy">
                <span className="approval-card-title">
                  <strong>{approval.snapshot.contactName ?? 'Approval request'}</strong>
                  <StatusBadge tone={statusTone(approval.status)}>
                    {humanize(approval.status)}
                  </StatusBadge>
                </span>
                <small>{approval.snapshot.company ?? 'Individual lead'}</small>
                <p>
                  {approval.snapshot.qualificationSummary ??
                    'Review the captured request before deciding.'}
                </p>
                <span className="approval-card-meta">
                  {approval.status === 'pending'
                    ? `Expires ${formatDateTime(approval.expiresAt)}`
                    : `Decided ${formatDateTime(approval.decidedAt)}`}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState
          title={filter === 'pending' ? 'The queue is clear' : 'No completed decisions yet'}
          description={
            filter === 'pending'
              ? 'There are no lead decisions waiting for this client.'
              : 'Completed approvals will remain visible here as an audit-friendly history.'
          }
          icon={CheckCircle2}
        />
      )}
      {selected ? (
        <ApprovalSheet
          approval={selected}
          mode={data.mode}
          onClose={() => {
            setSelectedId('');
          }}
          onDecided={markDecided}
        />
      ) : null}
    </div>
  );
}
