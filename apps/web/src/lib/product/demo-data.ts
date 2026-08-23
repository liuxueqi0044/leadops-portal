import type {
  ApprovalListItem,
  IncidentDto,
  LeadDetailDto,
  LeadSummaryDto,
  MeResponse,
  OperationsDashboardResponse,
  ReportSnapshotDto,
  WorkflowRunDto,
} from '@leadops/core';
import type { IntegrationSummary, ProductData } from './types';

const id = {
  organization: '10000000-0000-4000-8000-000000000001',
  user: '10000000-0000-4000-8000-000000000002',
  northstar: '10000000-0000-4000-8000-000000000003',
  atlas: '10000000-0000-4000-8000-000000000004',
  integration: '10000000-0000-4000-8000-000000000005',
  workflow: '10000000-0000-4000-8000-000000000006',
} as const;

const now = '2026-08-12T03:42:00.000Z';
const daysAgo = (days: number, hour = 10): string =>
  new Date(Date.UTC(2026, 7, 12 - days, hour, 15, 0)).toISOString();

export const demoMe: MeResponse = {
  user: {
    id: id.user,
    email: 'jordan@northstar.example',
    name: 'Jordan Smith',
    emailVerified: true,
    createdAt: '2026-01-18T09:00:00.000Z',
  },
  organization: {
    id: id.organization,
    name: 'Harborline Automation',
    slug: 'harborline',
    role: 'agency_owner',
  },
  clients: [
    {
      id: id.northstar,
      name: 'Northstar Dental',
      status: 'active',
      createdAt: '2026-01-20T09:00:00.000Z',
      updatedAt: now,
    },
    {
      id: id.atlas,
      name: 'Atlas Home Services',
      status: 'active',
      createdAt: '2026-03-02T09:00:00.000Z',
      updatedAt: daysAgo(2),
    },
  ],
};

const leadSeeds: {
  id: string;
  name: string;
  company: string | null;
  source: string;
  status: string;
  score: number | null;
  email: string;
  decision: 'qualified' | 'needs_review' | 'disqualified' | null;
  summary: string | null;
  nextAction: string | null;
  receivedAt: string;
  message: string;
}[] = [
  {
    id: '20000000-0000-4000-8000-000000000001',
    name: 'Olivia Chen',
    company: 'Chen & Co.',
    source: 'Website',
    status: 'converted',
    score: 94,
    email: 'olivia@example.com',
    decision: 'qualified',
    summary: 'Strong implant intent, budget and preferred appointment window are clear.',
    nextAction: 'Book a consultation within 24 hours.',
    receivedAt: daysAgo(0, 11),
    message:
      'I need a consultation for two implants and would like to understand timing and financing.',
  },
  {
    id: '20000000-0000-4000-8000-000000000002',
    name: 'Marcus Reed',
    company: null,
    source: 'Google Ads',
    status: 'needs_review',
    score: 92,
    email: 'marcus@example.com',
    decision: 'needs_review',
    summary: 'Urgent care request with strong intent; insurance details still need confirmation.',
    nextAction: 'Confirm coverage before offering the same-day slot.',
    receivedAt: daysAgo(0, 10),
    message: 'Severe tooth pain since last night. Can someone see me today? I have Delta Dental.',
  },
  {
    id: '20000000-0000-4000-8000-000000000003',
    name: 'Jamie Park',
    company: 'Park Studio',
    source: 'Referral',
    status: 'approved',
    score: 87,
    email: 'jamie@example.com',
    decision: 'qualified',
    summary: 'Referral lead seeking a cosmetic consultation with a specific six-week timeline.',
    nextAction: 'Send the consultation preparation guide.',
    receivedAt: daysAgo(1, 15),
    message: 'Referred by Maya. I am considering veneers before an event in October.',
  },
  {
    id: '20000000-0000-4000-8000-000000000004',
    name: 'Priya Shah',
    company: 'Lumen Labs',
    source: 'Website',
    status: 'qualified',
    score: 81,
    email: 'priya@example.com',
    decision: 'qualified',
    summary: 'Clear orthodontic treatment interest and good availability.',
    nextAction: 'Invite to the next assessment window.',
    receivedAt: daysAgo(2, 9),
    message: 'I would like to explore clear aligners and can come in most Friday mornings.',
  },
  {
    id: '20000000-0000-4000-8000-000000000005',
    name: 'Theo Martin',
    company: null,
    source: 'Facebook',
    status: 'received',
    score: null,
    email: 'theo@example.com',
    decision: null,
    summary: null,
    nextAction: null,
    receivedAt: daysAgo(2, 8),
    message: 'Can you send general pricing for a cleaning?',
  },
  {
    id: '20000000-0000-4000-8000-000000000006',
    name: 'Eleanor Finch',
    company: 'Finch Legal',
    source: 'Website',
    status: 'rejected',
    score: 34,
    email: 'eleanor@example.com',
    decision: 'disqualified',
    summary: 'The inquiry is for a service outside the clinic scope.',
    nextAction: 'Send a polite referral to a specialist.',
    receivedAt: daysAgo(3, 12),
    message: 'Do you provide full pediatric sedation dentistry for a two-year-old?',
  },
  {
    id: '20000000-0000-4000-8000-000000000007',
    name: 'Ravi Patel',
    company: null,
    source: 'Google Ads',
    status: 'needs_review',
    score: 76,
    email: 'ravi@example.com',
    decision: 'needs_review',
    summary: 'High intent but requested treatment date may be unrealistic.',
    nextAction: 'Review availability before responding.',
    receivedAt: daysAgo(4, 16),
    message: 'Looking for whitening before this Saturday. Is there any appointment open?',
  },
];

function leadSeedAt(index: number): (typeof leadSeeds)[number] {
  const lead = leadSeeds[index];
  if (!lead) throw new Error(`Missing demo lead seed ${String(index)}`);
  return lead;
}

export const demoLeads: LeadSummaryDto[] = leadSeeds.map((lead) => ({
  id: lead.id,
  source: lead.source,
  externalId: `web-${lead.id.slice(-4)}`,
  status: lead.status,
  contactName: lead.name,
  email: lead.email,
  phone: null,
  company: lead.company,
  score: lead.score,
  aiSuggestion: lead.decision
    ? {
        decision: lead.decision,
        summary: lead.summary,
        suggestedNextAction: lead.nextAction,
      }
    : null,
  confirmedStatus: lead.status,
  executedBusinessAction: lead.status === 'converted' ? 'Consultation booked' : null,
  receivedAt: lead.receivedAt,
  qualifiedAt:
    lead.score === null ? null : new Date(Date.parse(lead.receivedAt) + 180_000).toISOString(),
  createdAt: lead.receivedAt,
  updatedAt: lead.receivedAt,
}));

export const demoLeadDetails: Record<string, LeadDetailDto> = Object.fromEntries(
  leadSeeds.map((lead, index) => {
    const summary = demoLeads[index];
    if (!summary) throw new Error(`Missing demo lead summary ${String(index)}`);
    return [
      lead.id,
      {
        ...summary,
        message: lead.message,
        confidence: lead.score === null ? null : Math.min(0.98, lead.score / 100 + 0.03),
        metadata: {
          campaign: lead.source === 'Google Ads' ? 'search-intent-q3' : 'organic',
          preferredChannel: 'email',
        },
        statusHistory: [
          {
            previousStatus: null,
            newStatus: 'received',
            command: 'lead.received',
            performedBy: 'n8n',
            createdAt: lead.receivedAt,
          },
          ...(lead.score === null
            ? []
            : [
                {
                  previousStatus: 'received',
                  newStatus: lead.status,
                  command: 'qualification.completed',
                  performedBy: 'ai_provider',
                  createdAt: new Date(Date.parse(lead.receivedAt) + 180_000).toISOString(),
                },
              ]),
        ],
      },
    ];
  }),
);

export const demoApprovals: ApprovalListItem[] = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    clientId: id.northstar,
    leadId: leadSeedAt(1).id,
    status: 'pending',
    version: 1,
    expiresAt: '2026-08-12T16:00:00.000Z',
    snapshot: {
      leadId: leadSeedAt(1).id,
      contactName: 'Marcus Reed',
      company: null,
      message: leadSeedAt(1).message,
      score: 92,
      qualificationSummary: leadSeedAt(1).summary,
      qualificationDecision: 'needs_review',
      suggestedNextAction: leadSeedAt(1).nextAction,
    },
    requestedBy: 'lead-qualification',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    createdAt: daysAgo(0, 10),
    updatedAt: daysAgo(0, 10),
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    clientId: id.northstar,
    leadId: leadSeedAt(6).id,
    status: 'pending',
    version: 1,
    expiresAt: '2026-08-13T00:00:00.000Z',
    snapshot: {
      leadId: leadSeedAt(6).id,
      contactName: 'Ravi Patel',
      score: 76,
      qualificationSummary: leadSeedAt(6).summary,
      qualificationDecision: 'needs_review',
      suggestedNextAction: leadSeedAt(6).nextAction,
    },
    requestedBy: 'lead-qualification',
    decidedBy: null,
    decidedAt: null,
    decisionReason: null,
    createdAt: daysAgo(1, 16),
    updatedAt: daysAgo(1, 16),
  },
  {
    id: '30000000-0000-4000-8000-000000000003',
    clientId: id.northstar,
    leadId: leadSeedAt(2).id,
    status: 'approved',
    version: 2,
    expiresAt: '2026-08-12T00:00:00.000Z',
    snapshot: {
      leadId: leadSeedAt(2).id,
      contactName: 'Jamie Park',
      company: 'Park Studio',
      score: 87,
      qualificationSummary: leadSeedAt(2).summary,
      qualificationDecision: 'qualified',
      suggestedNextAction: leadSeedAt(2).nextAction,
    },
    requestedBy: 'lead-qualification',
    decidedBy: 'Jordan Smith',
    decidedAt: daysAgo(1, 16),
    decisionReason: 'Timeline and fit confirmed.',
    createdAt: daysAgo(1, 15),
    updatedAt: daysAgo(1, 16),
  },
];

export const demoWorkflowRuns: WorkflowRunDto[] = Array.from({ length: 8 }, (_, index) => {
  const failed = index === 2;
  const started = index === 0;
  const createdAt = daysAgo(Math.floor(index / 2), 11 - (index % 2));
  return {
    id: `40000000-0000-4000-8000-00000000000${String(index + 1)}`,
    organizationId: id.organization,
    clientId: id.northstar,
    workflowId: id.workflow,
    externalRunId: `n8n-${String(4821 - index)}`,
    status: started ? 'started' : failed ? 'failed' : 'succeeded',
    startedAt: createdAt,
    succeededAt:
      started || failed
        ? null
        : new Date(Date.parse(createdAt) + 14_000 + index * 900).toISOString(),
    failedAt: failed ? new Date(Date.parse(createdAt) + 18_000).toISOString() : null,
    error: failed
      ? {
          name: 'HubSpotRateLimit',
          message: 'CRM accepted the retry; the lead remains safely queued.',
        }
      : null,
    createdAt,
    updatedAt: createdAt,
  };
});

export const demoIncidents: IncidentDto[] = [
  {
    id: '50000000-0000-4000-8000-000000000001',
    organizationId: id.organization,
    clientId: id.northstar,
    integrationId: id.integration,
    workflowId: id.workflow,
    fingerprint: 'hubspot|rate-limit',
    category: 'external_provider',
    severity: 'medium',
    status: 'open',
    occurrenceCount: 3,
    errorSummary:
      'HubSpot temporarily delayed one lead sync. The result is stored and retrying safely.',
    firstSeenAt: daysAgo(0, 9),
    lastSeenAt: daysAgo(0, 11),
    acknowledgedAt: null,
    acknowledgedBy: null,
    resolvedAt: null,
    resolvedBy: null,
    createdAt: daysAgo(0, 9),
    updatedAt: daysAgo(0, 11),
  },
  {
    id: '50000000-0000-4000-8000-000000000002',
    organizationId: id.organization,
    clientId: id.northstar,
    integrationId: id.integration,
    workflowId: id.workflow,
    fingerprint: 'calendar|timeout',
    category: 'timeout',
    severity: 'low',
    status: 'resolved',
    occurrenceCount: 1,
    errorSummary: 'Calendar confirmation timed out once and completed on retry.',
    firstSeenAt: daysAgo(5, 13),
    lastSeenAt: daysAgo(5, 13),
    acknowledgedAt: daysAgo(5, 13),
    acknowledgedBy: 'Jordan Smith',
    resolvedAt: daysAgo(5, 14),
    resolvedBy: 'system',
    createdAt: daysAgo(5, 13),
    updatedAt: daysAgo(5, 14),
  },
];

export const demoReports: ReportSnapshotDto[] = [0, 1, 2].map((week) => ({
  id: `60000000-0000-4000-8000-00000000000${String(week + 1)}`,
  organizationId: id.organization,
  clientId: id.northstar,
  periodStart: new Date(Date.UTC(2026, 7, 3 - week * 7)).toISOString(),
  periodEnd: new Date(Date.UTC(2026, 7, 10 - week * 7)).toISOString(),
  generationVersion: 1,
  metrics: {
    leadsReceived: 76 - week * 8,
    qualificationRate: 0.63 - week * 0.03,
    approvalConversion: 0.78 - week * 0.04,
    appointments: 21 - week * 2,
    workflowSuccess: 102 - week * 5,
    workflowFailure: 1 + week,
    openIncidents: week === 0 ? 1 : 0,
    resolvedIncidents: 2 + week,
  },
  correlationId: `weekly-northstar-${String(week + 31)}`,
  generatedAt: new Date(Date.UTC(2026, 7, 10 - week * 7, 1)).toISOString(),
  createdAt: new Date(Date.UTC(2026, 7, 10 - week * 7, 1)).toISOString(),
}));

export const demoIntegrations: IntegrationSummary[] = [
  {
    id: id.integration,
    clientId: id.northstar,
    name: 'Northstar n8n',
    status: 'active',
    callbackUrl: 'https://automation.example.com/webhook/approval-result',
    createdAt: '2026-01-20T10:00:00.000Z',
    updatedAt: daysAgo(4),
  },
];

export const demoDashboard: OperationsDashboardResponse = {
  leadsReceived: 76,
  qualificationRate: 0.63,
  approvalConversion: 0.78,
  appointments: 21,
  workflowSuccess: 102,
  workflowFailure: 1,
  openIncidents: 1,
  resolvedIncidents: 3,
  totalLeads: 76,
  totalQualified: 48,
  totalApproved: 29,
  totalRejected: 7,
  avgScore: 78.4,
};

const defaultClient = demoMe.clients[0];
if (!defaultClient) throw new Error('Demo workspace requires a default client');

export const demoProductData: ProductData = {
  me: demoMe,
  selectedClient: defaultClient,
  dashboard: demoDashboard,
  leads: demoLeads,
  leadDetails: demoLeadDetails,
  approvals: demoApprovals,
  workflowRuns: demoWorkflowRuns,
  incidents: demoIncidents,
  reports: demoReports,
  integrations: demoIntegrations,
  mode: 'demo',
};
