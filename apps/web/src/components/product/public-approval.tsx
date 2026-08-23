'use client';

import { useState } from 'react';
import { Activity, Check, CircleAlert, Clock3, Scale, ShieldCheck, X } from 'lucide-react';
import type { PublicApprovalDto } from '@leadops/core';
import { StatusBadge, formatDateTime, humanize } from './primitives';

export function PublicApproval({ token, initial }: { token: string; initial: PublicApprovalDto }) {
  const [status, setStatus] = useState(initial.status);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function decide(decision: 'approved' | 'rejected') {
    setBusy(true);
    setError('');
    if (token === 'demo-token') {
      setStatus(decision);
      setBusy(false);
      return;
    }
    try {
      const response = await fetch(`/api/v1/approvals/public/${encodeURIComponent(token)}/decide`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, reason: reason.trim() || undefined }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? 'This request has already been decided.'
            : 'Your decision could not be saved. Please reopen the original link.',
        );
      setStatus(decision);
    } catch (decisionError) {
      setError(decisionError instanceof Error ? decisionError.message : 'Decision failed.');
    } finally {
      setBusy(false);
    }
  }

  if (status !== 'pending')
    return (
      <main id="main-content" className="public-approval-page">
        <section className="public-approval-card public-result">
          <span className={`public-result-icon ${status === 'approved' ? 'approved' : ''}`}>
            {status === 'approved' ? <Check size={24} /> : <X size={24} />}
          </span>
          <h1>Decision recorded</h1>
          <p>
            This request was <strong>{status}</strong>. You can close this page; the automation will
            receive the result safely.
          </p>
          <div className="public-trust">
            <ShieldCheck size={16} />
            One-time link · no other client information is shown
          </div>
        </section>
      </main>
    );

  return (
    <main id="main-content" className="public-approval-page">
      <header className="public-header">
        <span className="brand">
          <span className="brand-mark">
            <Activity size={18} />
          </span>
          <span className="brand-wordmark">LeadOps</span>
        </span>
        <span className="public-secure">
          <ShieldCheck size={15} />
          Secure decision link
        </span>
      </header>
      <section className="public-approval-card">
        <div className="public-card-heading">
          <span className="public-scale">
            <Scale size={22} />
          </span>
          <div>
            <span>Decision requested</span>
            <h1>{initial.snapshot.contactName ?? 'Lead approval'}</h1>
            <p>{initial.snapshot.company ?? 'Customer inquiry'}</p>
          </div>
          <StatusBadge tone="warning">
            <Clock3 size={12} />
            Expires {formatDateTime(initial.expiresAt)}
          </StatusBadge>
        </div>
        <div className="public-ai-summary">
          <span>
            <strong>{initial.snapshot.score ?? '—'}</strong>
            <small>AI score</small>
          </span>
          <div>
            <StatusBadge tone="info">
              {humanize(initial.snapshot.qualificationDecision ?? 'needs review')}
            </StatusBadge>
            <p>{initial.snapshot.qualificationSummary ?? 'Review the request before deciding.'}</p>
          </div>
        </div>
        <section className="public-snapshot">
          <h2>Original request</h2>
          <blockquote>{initial.snapshot.message ?? 'No message was included.'}</blockquote>
        </section>
        <section className="public-snapshot">
          <h2>Suggested next action</h2>
          <p>{initial.snapshot.suggestedNextAction ?? 'No action suggested.'}</p>
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
          />
        </label>
        {error ? (
          <p className="inline-error">
            <CircleAlert size={15} />
            {error}
          </p>
        ) : null}
        <div className="public-actions">
          <button
            className="reject-button"
            type="button"
            disabled={busy}
            onClick={() => void decide('rejected')}
          >
            <X size={16} />
            Reject
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => void decide('approved')}
          >
            <Check size={16} />
            Approve
          </button>
        </div>
        <p className="public-footnote">
          The AI recommendation is advisory. Your decision is the final business instruction.
        </p>
      </section>
    </main>
  );
}
