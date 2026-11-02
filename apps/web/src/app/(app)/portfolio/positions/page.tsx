'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { BrokerOrdersCard, HoldingsCard, LivePositionsCard, Pnl, Tabs } from '@/components/live-account';
import { CopyOrdersTable } from '@/components/master-client-detail';
import { PageHeader } from '@/components/page-header';
import { TradeBookCard } from '@/components/trade-book';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useExitAllMine, usePortfolio, useTradeBook } from '@/lib/trading';

type Tab = 'positions' | 'holdings' | 'orders';

/** Client portfolio: Positions · Holdings · Orders in one page (tabs). */
export default function PositionsPage() {
  const portfolio = usePortfolio();
  const book = useTradeBook();
  const exitAll = useExitAllMine();
  const [exitOpen, setExitOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('positions');
  // /portfolio/positions?tab=holdings opens that tab (old Holdings / Orders links land here).
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab');
    if (t === 'holdings' || t === 'orders') setTab(t);
  }, []);
  const p = portfolio.data;
  const nPositions = book.data?.rows.length ?? 0;
  const nHoldings = (p?.live ?? []).reduce((a, x) => a + (x.holdings?.length ?? 0), 0);
  const nOrders = p?.copyOrders.length ?? 0;

  return (
    <>
      <PageHeader
        title="Portfolio"
        description="Today's positions, your holdings and today's orders. Closed positions stay listed with their P&L until the day ends."
        actions={
          <Button variant="destructive" size="sm" onClick={() => setExitOpen(true)}>
            Exit all &amp; stop auto trading
          </Button>
        }
      />
      <Dialog open={exitOpen} onOpenChange={setExitOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Exit all positions and stop auto trading?</DialogTitle>
            <DialogDescription>All your strategy subscriptions are turned OFF and every open position in your trading account is closed at MARKET.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExitOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={exitAll.isPending}
              onClick={() =>
                exitAll.mutate(undefined, {
                  onSuccess: (r) => (toast.success(`Auto trading stopped · ${r.orders} exit order(s)${r.failed ? `, ${r.failed} failed` : ''}`), setExitOpen(false)),
                  onError: (e) => toast.error(e.message),
                })
              }
            >
              {exitAll.isPending ? 'Exiting…' : 'Exit all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="grid gap-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'positions', label: `Positions (${nPositions})` },
            { value: 'holdings', label: `Holdings (${nHoldings})` },
            { value: 'orders', label: `Orders (${nOrders})` },
          ]}
        />

        {tab === 'positions' ? (
          <>
            <Card>
              <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6">
                <div>
                  <p className="text-xs text-muted-foreground">Strategy P&amp;L today (booked in software — incl. trades not executed in demat)</p>
                  <p className="text-2xl font-semibold">
                    <Pnl value={p?.todayPnl ?? 0} />
                  </p>
                </div>
                {p?.paperMode ? (
                  <p className="max-w-md rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
                    <strong>Paper mode</strong> — strategy trades are simulated; no real orders reach your broker.
                  </p>
                ) : null}
              </CardContent>
            </Card>
            <TradeBookCard />
            {portfolio.isLoading ? <p className="text-sm text-muted-foreground">Loading live data…</p> : null}
            {/* Broker card only for live trading (in paper mode the broker has no strategy positions). */}
            {p?.live.filter((a) => !p.paperMode || (a.positions ?? []).length > 0).map((a) => <LivePositionsCard key={a.accountId} a={a} />)}
          </>
        ) : null}

        {tab === 'holdings' ? (
          <>
            {portfolio.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
            {p?.live.map((a) => <HoldingsCard key={a.accountId} a={a} />)}
          </>
        ) : null}

        {tab === 'orders' ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Strategy orders today</CardTitle>
                <CardDescription>Every strategy trade placed (or skipped) for your account today — the list starts fresh every trading day.</CardDescription>
              </CardHeader>
              <CardContent>
                <CopyOrdersTable rows={p?.copyOrders ?? []} empty={portfolio.isLoading ? 'Loading…' : 'No strategy orders today'} />
              </CardContent>
            </Card>
            {p?.live.map((a) => <BrokerOrdersCard key={a.accountId} a={a} />)}
          </>
        ) : null}

        {p && p.live.length === 0 && p.paperPositions.length === 0 && tab !== 'orders' ? (
          <p className="text-sm text-muted-foreground">
            Connect your broker on the{' '}
            <Link className="underline" href="/broker">
              Broker connection
            </Link>{' '}
            page to see live positions and holdings.
          </p>
        ) : null}
      </div>
    </>
  );
}
