'use client';

import { useState } from 'react';
import { Building2, Check, Plus, X } from 'lucide-react';
import type { ClientSummaryDto } from '@leadops/core';
import type { ProductData } from '@/lib/product/types';
import { PageHeader, StatusBadge, formatDate, statusTone } from './primitives';

export function ClientsPage({ data }: { data: ProductData }) {
  const [clients, setClients] = useState(data.me.clients);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const canManage = ['agency_owner', 'agency_admin', 'platform_admin'].includes(
    data.me.organization.role,
  );

  async function createClient() {
    if (!name.trim()) return;
    setError('');
    if (data.mode === 'demo') {
      const client: ClientSummaryDto = {
        id: crypto.randomUUID(),
        name: name.trim(),
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setClients((current) => [...current, client]);
      setCreating(false);
      setName('');
      return;
    }
    const response = await fetch('/api/v1/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() }),
    });
    if (!response.ok) {
      setError('The client could not be created. Your existing workspaces were not changed.');
      return;
    }
    const client = (await response.json()) as ClientSummaryDto;
    setClients((current) => [...current, client]);
    setCreating(false);
    setName('');
  }

  return (
    <div className="product-page clients-page">
      <PageHeader
        eyebrow={
          <>
            <span>{data.me.organization.name}</span>
            <span aria-hidden="true">/</span>
            <span>{clients.length} clients</span>
          </>
        }
        title="Clients"
        description="Manage the agency workspaces that enforce every data and permission boundary."
        action={
          canManage ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setCreating(true);
              }}
            >
              <Plus size={16} aria-hidden="true" />
              New client
            </button>
          ) : (
            <StatusBadge tone="neutral">Read only</StatusBadge>
          )
        }
      />
      {creating ? (
        <section className="inline-create" aria-label="Create client">
          <div>
            <h2>Create a client workspace</h2>
            <p>Names are visible to assigned agency and client users.</p>
          </div>
          <label>
            <span>Client name</span>
            <input
              value={name}
              onChange={(event) => {
                setName(event.target.value);
              }}
              maxLength={200}
              autoFocus
            />
          </label>
          {error ? <p className="inline-error">{error}</p> : null}
          <div>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setCreating(false);
              }}
            >
              <X size={15} aria-hidden="true" />
              Cancel
            </button>
            <button className="primary-button" type="button" onClick={() => void createClient()}>
              <Check size={15} aria-hidden="true" />
              Create workspace
            </button>
          </div>
        </section>
      ) : null}
      <div className="client-grid">
        {clients.map((client) => (
          <a
            className="client-card"
            href={`/?section=overview&client=${client.id}`}
            key={client.id}
          >
            <span className="client-card-avatar">
              <Building2 size={20} aria-hidden="true" />
            </span>
            <span className="client-card-copy">
              <span>
                <strong>{client.name}</strong>
                <StatusBadge tone={statusTone(client.status)}>{client.status}</StatusBadge>
              </span>
              <small>Created {formatDate(client.createdAt)}</small>
              <p>
                {client.id === data.selectedClient.id
                  ? 'Current workspace'
                  : 'Open client operations'}
              </p>
            </span>
          </a>
        ))}
      </div>
    </div>
  );
}
