'use client';

import { PaperModeNotice, TradesCard } from '@/components/master-desk';
import { PageHeader } from '@/components/page-header';
import { SignalsCard } from '@/components/signal-desk';

export default function MasterTradesPage() {
  return (
    <>
      <PageHeader title="Live trades" description="Your signals (open and closed) and how each order was placed for every client." />
      <PaperModeNotice />
      <div className="grid gap-4">
        <SignalsCard />
        <TradesCard />
      </div>
    </>
  );
}
