'use client';

import { useState } from 'react';
import { LiveAccountCard, PaperPositionsCard, Pnl, Tabs } from '@/components/live-account';
import { PageHeader } from '@/components/page-header';
import { OpenClientPanelButton } from '@/components/impersonate';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { brokerLabel, formatDateTime, formatINR } from '@/lib/format';
import { type CopyOrderRow, type HistoryRange, useClientLive, useMasterClient } from '@/lib/trading';

const LIC = { NONE: 'No licence', ACTIVE: 'Active', EXPIRING: 'Expiring soon', EXPIRED: 'Expired' } as const;

export function CopyOrdersTable({ rows, empty, showStrategy = true }: { rows: CopyOrderRow[]; empty: string; showStrategy?: boolean }) {
  const cols = showStrategy ? 7 : 6;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            {showStrategy ? <TableHead>Strategy</TableHead> : null}
            <TableHead>Trade</TableHead>
            <TableHead className="text-right">Filled</TableHead>
            <TableHead className="text-right">Avg</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Note</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={cols} className="py-6 text-center text-sm text-muted-foreground">
                {empty}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="whitespace-nowrap text-xs">{formatDateTime(c.createdAt)}</TableCell>
                {showStrategy ? <TableCell className="whitespace-nowrap text-sm">{c.strategyName ?? '—'}</TableCell> : null}
                <TableCell className="whitespace-nowrap">
                  <span className={c.side === 'BUY' ? 'text-success' : 'text-destructive'}>{c.side}</span> {c.quantity} <span className="font-medium">{c.symbol}</span>{' '}
                  <span className="text-xs text-muted-foreground">{c.exchange}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{c.filledQuantity}</TableCell>
                <TableCell className="text-right tabular-nums">{formatINR(c.averagePrice)}</TableCell>
                <TableCell>{c.errorCode === 'MISSED' ? <StatusBadge value="WARNING" label="Missed · paper" /> : <StatusBadge value={c.status} />}</TableCell>
                <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={c.errorMessage ?? ''}>
                  {c.errorMessage ?? (c.brokerOrderId ? `Order ${c.brokerOrderId}` : '')}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/** Master → one client: profile, licence, broker, strategies, live account and trade history. */
export function ClientDetail({ userId }: { userId: string }) {
  const [range, setRange] = useState<HistoryRange>('today');
  const [tab, setTab] = useState<'account' | 'history'>('account');
  const q = useMasterClient(userId, range);
  const live = useClientLive(userId);
  const d = q.data;

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.error || !d) return <p className="text-sm text-destructive">{q.error?.message ?? 'Client not found'}</p>;
  const p = d.profile;
  const broker = d.brokerAccounts.find((a) => a.status === 'CONNECTED') ?? d.brokerAccounts[0];
  const copying = d.strategies.filter((s) => s.copyStatus === 'ON').length;

  return (
    <>
      <PageHeader title={p.name} description={`${p.email}${p.mobile ? ` · ${p.mobile}` : ''} · client since ${formatDateTime(p.createdAt)}`} actions={<OpenClientPanelButton userId={p.id} name={p.name} />} />
      <div className="grid gap-4">
        <div className="fox-tiles grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Today's P&L" value={<Pnl value={d.todayPnl} />} hint="Your strategies only" />
          <StatCard
            label="Broker"
            value={broker ? brokerLabel(broker.broker) : 'None'}
            hint={broker ? `${broker.brokerClientId ?? ''} · ${broker.status.toLowerCase()} · ${broker.simulated ? 'paper' : 'live'}` : 'Not connected'}
            tone={broker?.status === 'CONNECTED' ? 'success' : 'destructive'}
          />
          <StatCard
            label="Licence"
            value={LIC[p.licenceStatus]}
            tone={p.licenceStatus === 'EXPIRED' ? 'destructive' : p.licenceStatus === 'NONE' ? 'default' : 'success'}
            hint={p.licenceExpiresAt ? `${formatDateTime(p.licenceAssignedAt)} → ${formatDateTime(p.licenceExpiresAt)}` : undefined}
          />
          <StatCard label="Strategies active" value={`${copying} / ${d.strategies.length}`} hint={`Last login ${formatDateTime(p.lastLoginAt)}`} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Strategies</CardTitle>
            <CardDescription>Your strategies assigned to this client.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Strategy</TableHead>
                  <TableHead>Allocation</TableHead>
                  <TableHead>Max loss / day</TableHead>
                  <TableHead>Auto-trading</TableHead>
                  <TableHead className="text-right">Trades today</TableHead>
                  <TableHead className="text-right">Today P&amp;L</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.strategies.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.strategyName}</TableCell>
                    <TableCell>{s.allocation}</TableCell>
                    <TableCell>{s.maxDailyLoss ? formatINR(s.maxDailyLoss) : '—'}</TableCell>
                    <TableCell>
                      <StatusBadge value={s.copyStatus} />
                      {s.copyStatus !== 'ON' && s.stoppedReason ? <div className="text-[11px] text-muted-foreground">{s.stoppedReason}</div> : null}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{s.today?.todayTrades ?? 0}</TableCell>
                    <TableCell className="text-right font-medium">
                      <Pnl value={s.today?.todayPnl ?? 0} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: 'account', label: 'Live account' },
            { value: 'history', label: 'Trade history' },
          ]}
        />

        {tab === 'account' ? (
          <div className="grid gap-4">
            {live.isLoading ? <p className="text-sm text-muted-foreground">Loading live data…</p> : null}
            {live.error ? <p className="text-sm text-destructive">{live.error.message}</p> : null}
            {live.data && live.data.paperPositions.length > 0 ? <PaperPositionsCard rows={live.data.paperPositions} canExit clientUserId={userId} /> : null}
            {live.data?.live.map((a) => <LiveAccountCard key={a.accountId} a={a} canExit clientUserId={userId} />)}
            {live.data && live.data.live.length === 0 && live.data.paperPositions.length === 0 ? (
              <p className="text-sm text-muted-foreground">This client has no connected broker yet.</p>
            ) : null}
          </div>
        ) : (
          <Card>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
              <div>
                <CardTitle>Client trades</CardTitle>
                <CardDescription>Every order placed (or skipped) for this client from your strategies.</CardDescription>
              </div>
              <Select className="w-40" value={range} onChange={(e) => setRange(e.target.value as HistoryRange)} aria-label="Period">
                <option value="today">Today</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="all">All time</option>
              </Select>
            </CardHeader>
            <CardContent>
              <CopyOrdersTable rows={d.orders} empty="No trades in this period" />
            </CardContent>
          </Card>
        )}
      </div>
    </>
  );
}
