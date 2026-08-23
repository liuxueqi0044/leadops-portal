import { headers } from 'next/headers';
import {
  approvalsListResponseSchema,
  incidentsListResponseSchema,
  leadsListResponseSchema,
  meResponseSchema,
  operationsDashboardResponseSchema,
  reportsListResponseSchema,
  workflowRunsListResponseSchema,
} from '@leadops/core';
import { z } from 'zod';
import { demoProductData } from './demo-data';
import type { ProductData } from './types';

const integrationsResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().uuid(),
      clientId: z.string().uuid(),
      name: z.string(),
      status: z.string(),
      callbackUrl: z.string().nullable(),
      createdAt: z.coerce.string(),
      updatedAt: z.coerce.string(),
    }),
  ),
});

function emptyDashboard(): ProductData['dashboard'] {
  return {
    leadsReceived: 0,
    qualificationRate: 0,
    approvalConversion: 0,
    appointments: 0,
    workflowSuccess: 0,
    workflowFailure: 0,
    openIncidents: 0,
    resolvedIncidents: 0,
    totalLeads: 0,
    totalQualified: 0,
    totalApproved: 0,
    totalRejected: 0,
    avgScore: null,
  };
}

async function fetchJson(path: string, cookie: string): Promise<unknown> {
  const requestHeaders = await headers();
  const host = requestHeaders.get('host') ?? 'localhost:3000';
  const protocol = requestHeaders.get('x-forwarded-proto') ?? 'http';
  const response = await fetch(`${protocol}://${host}${path}`, {
    headers: { cookie },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`Request failed: ${path} (${String(response.status)})`);
  return response.json() as Promise<unknown>;
}

export async function loadProductData(selectedClientId?: string): Promise<ProductData> {
  const requestHeaders = await headers();
  const cookie = requestHeaders.get('cookie') ?? '';
  const previewRequested = requestHeaders.get('x-leadops-preview') === '1';

  if (!cookie.includes('better-auth.session_token=')) {
    if (process.env.NODE_ENV === 'production' && !previewRequested) {
      throw new Error('UNAUTHENTICATED');
    }
    return selectedClientId
      ? {
          ...demoProductData,
          selectedClient:
            demoProductData.me.clients.find((client) => client.id === selectedClientId) ??
            demoProductData.selectedClient,
        }
      : demoProductData;
  }

  const me = meResponseSchema.parse(await fetchJson('/api/v1/me', cookie));
  const selectedClient =
    me.clients.find((client) => client.id === selectedClientId) ??
    me.clients.find((client) => client.status === 'active') ??
    me.clients[0];

  if (!selectedClient) {
    return {
      me,
      selectedClient: {
        id: '00000000-0000-0000-0000-000000000000',
        name: 'No client workspace',
        status: 'archived',
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      dashboard: emptyDashboard(),
      leads: [],
      leadDetails: {},
      approvals: [],
      workflowRuns: [],
      incidents: [],
      reports: [],
      integrations: [],
      mode: 'live',
    };
  }

  const clientId = encodeURIComponent(selectedClient.id);
  const [dashboard, leads, approvals, workflowRuns, incidents, reports, integrations] =
    await Promise.all([
      fetchJson(`/api/v1/dashboard?clientId=${clientId}`, cookie).then((value) =>
        operationsDashboardResponseSchema.parse(value),
      ),
      fetchJson(`/api/v1/clients/${clientId}/leads?limit=50`, cookie).then((value) =>
        leadsListResponseSchema.parse(value),
      ),
      fetchJson(`/api/v1/approvals?clientId=${clientId}&limit=50`, cookie).then((value) =>
        approvalsListResponseSchema.parse(value),
      ),
      fetchJson(`/api/v1/workflow-runs?clientId=${clientId}&limit=50`, cookie).then((value) =>
        workflowRunsListResponseSchema.parse(value),
      ),
      fetchJson(`/api/v1/incidents?clientId=${clientId}&limit=50`, cookie).then((value) =>
        incidentsListResponseSchema.parse(value),
      ),
      fetchJson(`/api/v1/reports?clientId=${clientId}&limit=50`, cookie).then((value) =>
        reportsListResponseSchema.parse(value),
      ),
      fetchJson('/api/v1/integrations', cookie).then((value) =>
        integrationsResponseSchema.parse(value),
      ),
    ]);

  return {
    me,
    selectedClient,
    dashboard,
    leads: leads.items,
    leadDetails: {},
    approvals: approvals.items,
    workflowRuns: workflowRuns.items,
    incidents: incidents.items,
    reports: reports.items,
    integrations: integrations.items.filter(
      (integration) => integration.clientId === selectedClient.id,
    ),
    mode: 'live',
  };
}
