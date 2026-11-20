'use client';

import { PaperModeNotice } from '@/components/master-desk';
import { MarketFeedPanel } from '@/components/market-feed-panel';
import { PageHeader } from '@/components/page-header';
import { SignalForm } from '@/components/signal-desk';
import { useMasterStrategies } from '@/lib/trading';

export default function PlaceTradePage() {
  const strategies = useMasterStrategies();
  return (
    <>
      <PageHeader title="Place trade" description="Every trade you place here is placed for the clients of the selected strategy." />
      <PaperModeNotice />
      <div className="grid gap-4">
        <SignalForm strategies={strategies.data ?? []} />
        <MarketFeedPanel />
      </div>
    </>
  );
}
