'use client';

import { useState } from 'react';
import { Check, Copy, KeyRound, Link2, RotateCw, ShieldCheck } from 'lucide-react';
import type { ProductData } from '@/lib/product/types';
import { PageHeader, StatusBadge, formatDateTime, statusTone } from './primitives';

export function SettingsPage({ data }: { data: ProductData }) {
  const [copied, setCopied] = useState(false);
  const [integrations, setIntegrations] = useState(data.integrations);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  const integration = integrations[0];
  const canManage = ['agency_owner', 'agency_admin', 'platform_admin'].includes(
    data.me.organization.role,
  );
  async function copy(value: string) {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  }

  async function createIntegration() {
    setCreating(true);
    setError('');
    try {
      if (data.mode === 'demo') {
        setIntegrations([
          {
            id: crypto.randomUUID(),
            clientId: data.selectedClient.id,
            name: `${data.selectedClient.name} n8n`,
            status: 'active',
            callbackUrl: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ]);
        setSecret('demo_secret_visible_once');
        return;
      }
      const response = await fetch('/api/v1/integrations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: data.selectedClient.id,
          name: `${data.selectedClient.name} n8n`,
        }),
      });
      if (!response.ok) throw new Error('The integration could not be created.');
      const result = (await response.json()) as {
        integration: ProductData['integrations'][number];
        secret: string;
      };
      setIntegrations([{ ...result.integration, updatedAt: result.integration.createdAt }]);
      setSecret(result.secret);
    } catch (actionError) {
      setError(
        actionError instanceof Error
          ? actionError.message
          : 'The integration could not be created.',
      );
    } finally {
      setCreating(false);
    }
  }

  async function rotateSecret() {
    if (!integration) return;
    setRotating(true);
    setError('');
    try {
      if (data.mode === 'demo') {
        setSecret('demo_rotated_secret_visible_once');
        return;
      }
      const response = await fetch(
        `/api/v1/integrations/${encodeURIComponent(integration.id)}?action=rotate-secret`,
        { method: 'POST' },
      );
      if (!response.ok) throw new Error('The integration secret could not be rotated.');
      const result = (await response.json()) as { secret: string };
      setSecret(result.secret);
    } catch (actionError) {
      setError(
        actionError instanceof Error ? actionError.message : 'The secret could not be rotated.',
      );
    } finally {
      setRotating(false);
    }
  }
  return (
    <div className="product-page settings-page">
      <PageHeader
        eyebrow={
          <>
            <span>{data.me.organization.name}</span>
            <span aria-hidden="true">/</span>
            <span>Workspace controls</span>
          </>
        }
        title="Settings"
        description="Integration boundaries, provider status and account context."
      />
      <div className="settings-grid">
        <section className="panel settings-section">
          <div className="settings-title">
            <span className="settings-icon">
              <Link2 size={19} aria-hidden="true" />
            </span>
            <div>
              <h2>n8n integration</h2>
              <p>Signed event intake and registered approval callback</p>
            </div>
            {integration ? (
              <StatusBadge tone={statusTone(integration.status)}>{integration.status}</StatusBadge>
            ) : null}
          </div>
          {integration ? (
            <div className="settings-fields">
              <div>
                <span>Name</span>
                <strong>{integration.name}</strong>
              </div>
              <div>
                <span>Integration ID</span>
                <code>{integration.id}</code>
                <button
                  type="button"
                  onClick={() => void copy(integration.id)}
                  aria-label="Copy integration ID"
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </div>
              <div>
                <span>Callback</span>
                <strong>
                  {integration.callbackUrl ? 'Registered and protected' : 'Not configured'}
                </strong>
              </div>
              <div>
                <span>Updated</span>
                <strong>{formatDateTime(integration.updatedAt)}</strong>
              </div>
            </div>
          ) : (
            <div className="settings-empty">
              <p>No integration is configured for this client.</p>
              {canManage ? (
                <button
                  className="primary-button"
                  type="button"
                  disabled={creating}
                  onClick={() => void createIntegration()}
                >
                  {creating ? 'Creating…' : 'Create integration'}
                </button>
              ) : (
                <StatusBadge tone="neutral">Read only</StatusBadge>
              )}
            </div>
          )}
        </section>
        <section className="panel settings-section">
          <div className="settings-title">
            <span className="settings-icon">
              <ShieldCheck size={19} aria-hidden="true" />
            </span>
            <div>
              <h2>Security posture</h2>
              <p>Tenant and delivery safeguards</p>
            </div>
          </div>
          <ul className="check-list">
            <li>
              <Check size={15} aria-hidden="true" />
              Database row-level isolation enforced
            </li>
            <li>
              <Check size={15} aria-hidden="true" />
              Approval links are hashed and one-time
            </li>
            <li>
              <Check size={15} aria-hidden="true" />
              Callback destinations are pre-registered
            </li>
            <li>
              <Check size={15} aria-hidden="true" />
              Sensitive log fields are redacted
            </li>
          </ul>
        </section>
        <section className="panel settings-section">
          <div className="settings-title">
            <span className="settings-icon">
              <KeyRound size={19} aria-hidden="true" />
            </span>
            <div>
              <h2>Secret rotation</h2>
              <p>Old signatures remain valid only during the controlled overlap.</p>
            </div>
          </div>
          {secret ? (
            <div className="secret-reveal" role="status">
              <p>
                <strong>Copy this secret now.</strong> It will not be shown again.
              </p>
              <code>{secret}</code>
              <button type="button" onClick={() => void copy(secret)}>
                {copied ? <Check size={15} /> : <Copy size={15} />}Copy
              </button>
            </div>
          ) : null}
          {error ? (
            <p className="inline-error" role="alert">
              {error}
            </p>
          ) : null}
          <button
            className="secondary-button"
            type="button"
            disabled={!integration || !canManage || rotating}
            onClick={() => void rotateSecret()}
          >
            <RotateCw size={15} aria-hidden="true" />
            {rotating ? 'Rotating…' : 'Rotate integration secret'}
          </button>
        </section>
      </div>
    </div>
  );
}
