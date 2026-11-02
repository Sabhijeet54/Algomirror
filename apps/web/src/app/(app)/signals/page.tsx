'use client';

import { AlgoSignalsCard } from '@/components/algo-signals';
import { PageHeader } from '@/components/page-header';

export default function SignalsPage() {
  return (
    <>
      <PageHeader title="Signals" description="Every strategy trade booked for you today — open / closed and P&L in the software, whether or not it reached your demat." />
      <AlgoSignalsCard />
    </>
  );
}
