import type { ProductData, ProductSection } from '@/lib/product/types';
import { ApprovalsPage } from './approvals-page';
import { AutomationsPage } from './automations-page';
import { ClientsPage } from './clients-page';
import { IncidentsPage } from './incidents-page';
import { LeadsPage } from './leads-page';
import { Overview } from './overview';
import { ReportsPage } from './reports-page';
import { SettingsPage } from './settings-page';

export function ProductRouter({
  section,
  data,
  leadId,
  approvalId,
  incidentId,
}: {
  section: ProductSection;
  data: ProductData;
  leadId?: string;
  approvalId?: string;
  incidentId?: string;
}) {
  switch (section) {
    case 'leads':
      return <LeadsPage data={data} initialLeadId={leadId} />;
    case 'approvals':
      return <ApprovalsPage data={data} initialApprovalId={approvalId} />;
    case 'automations':
      return <AutomationsPage data={data} />;
    case 'incidents':
      return <IncidentsPage data={data} initialIncidentId={incidentId} />;
    case 'reports':
      return <ReportsPage data={data} />;
    case 'clients':
      return <ClientsPage data={data} />;
    case 'settings':
      return <SettingsPage data={data} />;
    default:
      return <Overview data={data} />;
  }
}
