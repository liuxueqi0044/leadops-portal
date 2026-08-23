import type {
  ApprovalListItem,
  ClientSummaryDto,
  IncidentDto,
  LeadDetailDto,
  LeadSummaryDto,
  MeResponse,
  OperationsDashboardResponse,
  ReportSnapshotDto,
  WorkflowRunDto,
} from '@leadops/core';

export type ProductSection =
  | 'overview'
  | 'leads'
  | 'approvals'
  | 'automations'
  | 'incidents'
  | 'reports'
  | 'clients'
  | 'settings';

export interface IntegrationSummary {
  id: string;
  clientId: string;
  name: string;
  status: string;
  callbackUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProductData {
  me: MeResponse;
  selectedClient: ClientSummaryDto;
  dashboard: OperationsDashboardResponse;
  leads: LeadSummaryDto[];
  leadDetails: Record<string, LeadDetailDto>;
  approvals: ApprovalListItem[];
  workflowRuns: WorkflowRunDto[];
  incidents: IncidentDto[];
  reports: ReportSnapshotDto[];
  integrations: IntegrationSummary[];
  mode: 'live' | 'demo';
}

export interface ApiErrorShape {
  error?: string | { code?: string; message?: string };
  message?: string;
}
