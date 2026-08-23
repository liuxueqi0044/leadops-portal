import { redirect } from 'next/navigation';
import { AppShell } from '@/components/product/app-shell';
import { ProductRouter } from '@/components/product/product-router';
import { ErrorState, EmptyState } from '@/components/product/primitives';
import { loadProductData } from '@/lib/product/server-data';
import type { ProductSection } from '@/lib/product/types';

const SECTIONS: readonly ProductSection[] = [
  'overview',
  'leads',
  'approvals',
  'automations',
  'incidents',
  'reports',
  'clients',
  'settings',
];

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const rawSection = typeof params.section === 'string' ? params.section : 'overview';
  const section = SECTIONS.includes(rawSection as ProductSection)
    ? (rawSection as ProductSection)
    : 'overview';
  const clientId = typeof params.client === 'string' ? params.client : undefined;

  try {
    const data = await loadProductData(clientId);
    const clientLevel = data.me.organization.role.startsWith('client_');
    const restrictedSection = clientLevel && (section === 'clients' || section === 'settings');
    return (
      <AppShell
        me={data.me}
        selectedClientId={data.selectedClient.id}
        activeSection={section}
        pendingApprovals={data.approvals.filter((approval) => approval.status === 'pending').length}
        openIncidents={data.incidents.filter((incident) => incident.status !== 'resolved').length}
        mode={data.mode}
      >
        {restrictedSection ? (
          <EmptyState
            title="This page is managed by your agency"
            description="Your role can work inside the assigned client workspace, but it cannot access agency administration."
          />
        ) : (
          <ProductRouter
            section={section}
            data={data}
            leadId={typeof params.lead === 'string' ? params.lead : undefined}
            approvalId={typeof params.approval === 'string' ? params.approval : undefined}
            incidentId={typeof params.incident === 'string' ? params.incident : undefined}
          />
        )}
      </AppShell>
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'UNAUTHENTICATED') redirect('/login');
    return (
      <main className="standalone-state">
        <ErrorState message="The service is unavailable. Please try again or contact your workspace administrator." />
      </main>
    );
  }
}
