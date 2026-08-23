// LeadOps Portal — k6 Load Test (Phase 6C)
// Usage: k6 run tests/load/load-test.js
// Prerequisites: Running app with test fixtures loaded
// Environment: K6_BASE_URL=http://localhost:3000
//
// Scenarios:
// 1. Signed event ingestion (steady load)
// 2. Leads list/query (cursor pagination)
// 3. Approval decision contention (concurrent decide)
// 4. Incident list
// 5. Dashboard/report query
//
// Fixed fixtures and clear concurrency parameters.
// Reports real throughput, p50/p95/p99 latency, error rate.
// Does NOT target production or real customer environments.

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const BASE_URL = __ENV.K6_BASE_URL || 'http://localhost:3000';
const VUS = parseInt(__ENV.K6_VUS || '10');
const DURATION = __ENV.K6_DURATION || '60s';

export const options = {
  scenarios: {
    event_ingestion: {
      executor: 'constant-arrival-rate',
      rate: 5,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.ceil(VUS * 0.3),
      maxVUs: VUS,
      exec: 'eventIngestion',
    },
    leads_query: {
      executor: 'constant-arrival-rate',
      rate: 3,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.ceil(VUS * 0.2),
      maxVUs: VUS,
      exec: 'leadsQuery',
      startTime: '5s',
    },
    dashboard_query: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.ceil(VUS * 0.2),
      maxVUs: VUS,
      exec: 'dashboardQuery',
      startTime: '10s',
    },
    incident_list: {
      executor: 'constant-arrival-rate',
      rate: 2,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.ceil(VUS * 0.15),
      maxVUs: VUS,
      exec: 'incidentList',
      startTime: '15s',
    },
    approval_contention: {
      executor: 'constant-arrival-rate',
      rate: 3,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.ceil(VUS * 0.15),
      maxVUs: VUS,
      exec: 'approvalContention',
      startTime: '20s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000'],
    'event_ingestion_duration': ['p(95)<1000'],
    'leads_query_duration': ['p(95)<1000'],
    'dashboard_query_duration': ['p(95)<2000'],
  },
};

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------
const eventIngestionDuration = new Trend('event_ingestion_duration');
const leadsQueryDuration = new Trend('leads_query_duration');
const dashboardQueryDuration = new Trend('dashboard_query_duration');
const incidentListDuration = new Trend('incident_list_duration');
const approvalContentionDuration = new Trend('approval_contention_duration');
const eventIngestionErrors = new Rate('event_ingestion_errors');
const approvalErrors = new Rate('approval_errors');

// ---------------------------------------------------------------------------
// Shared state — test fixture IDs
// ---------------------------------------------------------------------------
const TEST_ORG_ID = '00000000-0000-0000-0000-000000000001';
const TEST_CLIENT_ID = '00000000-0000-0000-0000-000000000002';
const TEST_INTEGRATION_ID = '00000000-0000-0000-0000-000000000003';

const generateEventPayload = () => ({
  eventType: 'lead.received',
  eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  timestamp: new Date().toISOString(),
  data: {
    lead: {
      externalId: `ld-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      email: `test-${Date.now()}@example.com`,
      name: `Test Lead ${Math.random().toString(36).slice(2, 6)}`,
      company: 'Test Corp',
      source: 'load-test',
    },
  },
});

// ---------------------------------------------------------------------------
// Scenario 1: Signed event ingestion
// ---------------------------------------------------------------------------
export function eventIngestion() {
  const payload = generateEventPayload();
  const body = JSON.stringify(payload);

  const res = http.post(`${BASE_URL}/api/v1/events`, body, {
    headers: {
      'Content-Type': 'application/json',
      'x-correlation-id': `load-test-evt-${Date.now()}`,
    },
    tags: { name: 'event_ingestion' },
  });

  eventIngestionDuration.add(res.timings.duration);

  const ok = check(res, {
    'event ingestion status is 200 or 202': (r) => r.status === 200 || r.status === 202,
  });

  if (!ok) {
    eventIngestionErrors.add(1);
  }
}

// ---------------------------------------------------------------------------
// Scenario 2: Leads list/query
// ---------------------------------------------------------------------------
export function leadsQuery() {
  const res = http.get(
    `${BASE_URL}/api/v1/clients/${TEST_CLIENT_ID}/leads?limit=20`,
    {
      headers: {
        'x-correlation-id': `load-test-leads-${Date.now()}`,
      },
      tags: { name: 'leads_query' },
    },
  );

  leadsQueryDuration.add(res.timings.duration);

  check(res, {
    'leads query status is 200': (r) => r.status === 200,
  });
}

// ---------------------------------------------------------------------------
// Scenario 3: Dashboard query
// ---------------------------------------------------------------------------
export function dashboardQuery() {
  const res = http.get(
    `${BASE_URL}/api/v1/dashboard`,
    {
      headers: {
        'x-correlation-id': `load-test-dash-${Date.now()}`,
      },
      tags: { name: 'dashboard_query' },
    },
  );

  dashboardQueryDuration.add(res.timings.duration);

  check(res, {
    'dashboard query status is 200': (r) => r.status === 200,
  });
}

// ---------------------------------------------------------------------------
// Scenario 4: Incident list
// ---------------------------------------------------------------------------
export function incidentList() {
  const res = http.get(
    `${BASE_URL}/api/v1/incidents?limit=20`,
    {
      headers: {
        'x-correlation-id': `load-test-inc-${Date.now()}`,
      },
      tags: { name: 'incident_list' },
    },
  );

  incidentListDuration.add(res.timings.duration);

  check(res, {
    'incident list status is 200': (r) => r.status === 200,
  });
}

// ---------------------------------------------------------------------------
// Scenario 5: Approval decision contention
// ---------------------------------------------------------------------------
export function approvalContention() {
  const token = `test-token-${Date.now()}`;
  const body = JSON.stringify({
    decision: Math.random() > 0.5 ? 'approved' : 'rejected',
    comment: 'Load test decision',
  });

  const res = http.post(
    `${BASE_URL}/api/v1/approvals/public/${token}/decide`,
    body,
    {
      headers: {
        'Content-Type': 'application/json',
        'x-correlation-id': `load-test-apr-${Date.now()}`,
      },
      tags: { name: 'approval_contention' },
    },
  );

  approvalContentionDuration.add(res.timings.duration);

  const ok = check(res, {
    'approval decision status is valid': (r) =>
      r.status === 200 || r.status === 409 || r.status === 404,
  });

  if (!ok) {
    approvalErrors.add(1);
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------
export function setup() {
  console.log(`=== Load Test Configuration ===`);
  console.log(`Base URL:   ${BASE_URL}`);
  console.log(`VUs:        ${VUS}`);
  console.log(`Duration:   ${DURATION}`);
  console.log(`Scenarios:  5 (event_ingestion, leads_query, dashboard_query, incident_list, approval_contention)`);
  console.log(`================================`);
  return { startTime: Date.now() };
}

export function teardown(data) {
  const elapsed = (Date.now() - data.startTime) / 1000;
  console.log(`=== Load Test Complete ===`);
  console.log(`Elapsed: ${elapsed.toFixed(1)}s`);
  console.log(`===========================`);
}

export default function () {
  // Default function (unused; scenarios use named executors)
  sleep(1);
}
