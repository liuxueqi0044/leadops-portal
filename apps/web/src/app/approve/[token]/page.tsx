import { notFound } from 'next/navigation';
import { publicApprovalDtoSchema, type PublicApprovalDto } from '@leadops/core';
import { PublicApproval } from '@/components/product/public-approval';

const demoApproval: PublicApprovalDto = {
  tokenStatus: 'valid',
  status: 'pending',
  expiresAt: '2026-08-13T00:00:00.000Z',
  snapshot: {
    contactName: 'Marcus Reed',
    company: null,
    message: 'Severe tooth pain since last night. Can someone see me today? I have Delta Dental.',
    score: 92,
    qualificationDecision: 'needs_review',
    qualificationSummary:
      'Urgent care request with strong intent; insurance details still need confirmation.',
    suggestedNextAction: 'Confirm coverage before offering the same-day slot.',
  },
};

export default async function PublicApprovalPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  let approval: PublicApprovalDto;
  if (token === 'demo-token' && process.env.NODE_ENV !== 'production') approval = demoApproval;
  else {
    const baseUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
    const response = await fetch(
      `${baseUrl}/api/v1/approvals/public/${encodeURIComponent(token)}`,
      { cache: 'no-store' },
    );
    if (!response.ok) notFound();
    approval = publicApprovalDtoSchema.parse(await response.json());
  }
  return <PublicApproval token={token} initial={approval} />;
}
