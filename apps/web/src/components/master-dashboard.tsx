'use client';

import { ArrowRight, Building2, CandlestickChart, Layers, Users } from 'lucide-react';
import Link from 'next/link';
import { Pnl } from '@/components/live-account';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { brokerLabel } from '@/lib/format';
import { useMyBrokerAccounts } from '@/lib/queries';
import { useMasterClients, useMasterStrategies, useSignals } from '@/lib/trading';

/** Master's landing page: one glance at strategies, clients, today's trades and the broker session. */
export function MasterDashboard() {
  const strategies = useMasterStrategies();
  const clients = useMasterClients();
  const signals = useSignals('all', 'today');
  const brokers = useMyBrokerAccounts();
  const list = strategies.data ?? [];
  const cl = clients.data ?? [];
  const active = list.filter((s) => s.status === 'ACTIVE').length;
  const copying = cl.filter((c) => c.subscriptions.some((s) => s.copyStatus === 'ON')).length;
  const clientsPnl = cl.reduce((a, c) => a + c.todayPnl, 0);
  const openSignals = (signals.data ?? []).filter((s) => s.status === 'OPEN').length;
  const account = brokers.data?.find((a) => a.broker !== 'MOCK');

  return (
    <div className="mb-6 grid gap-4">
      <div className="fox-tiles grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Active strategies" value={`${active} / ${list.length}`} loading={strategies.isLoading} icon={<Layers />} />
        <StatCard label="Clients auto-trading" value={`${copying} / ${cl.length}`} loading={clients.isLoading} icon={<Users />} />
        <StatCard
          label="Signals today"
          value={String(signals.data?.length ?? 0)}
          hint={`${openSignals} open`}
          loading={signals.isLoading}
          icon={<CandlestickChart />}
        />
        <StatCard label="Clients' P&L today" value={<Pnl value={clientsPnl} />} loading={clients.isLoading} hint="All your clients together" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="size-4 text-primary" /> Broker (market data)
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 text-sm">
            {account ? (
              <span className="flex items-center gap-2">
                <span className="font-medium">{brokerLabel(account.broker)}</span>
                <span className="text-muted-foreground">{account.brokerClientId}</span>
                <StatusBadge value={account.status} />
              </span>
            ) : (
              <span className="text-muted-foreground">No broker connected</span>
            )}
            <Button asChild size="sm" variant="outline">
              <Link href="/broker">
                {account?.status === 'CONNECTED' ? 'Manage' : 'Connect'} <ArrowRight />
              </Link>
            </Button>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Quick links</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild size="sm">
              <Link href="/master/place-trade">Place trade</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/master/trades">Live trades</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/master/clients">Clients</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href="/master">Strategies</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
