'use client';

import { CheckCircle2, History, Layers, Users } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { FollowDialog } from '@/components/follow-dialog';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { formatDateTime, formatINR, humanize } from '@/lib/format';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { type MarketplaceRow, useMarketplace, useStrategyHistory } from '@/lib/trading';
import { cn } from '@/lib/utils';

const TILE = ['bg-[var(--tile-mint)]', 'bg-[var(--tile-violet)]', 'bg-[var(--tile-sand)]', 'bg-[var(--tile-lime)]', 'bg-[var(--tile-sky)]'];

function HistoryDialog({ s, onClose }: { s: { id: string; name: string } | null; onClose: () => void }) {
  const q = useStrategyHistory(s?.id ?? null);
  const rows = q.data ?? [];
  const pnl = rows.reduce((a, r) => a + (r.realizedPnl ?? 0), 0);
  return (
    <Dialog open={s !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{s?.name} — last 7 days</DialogTitle>
          <DialogDescription>
            Trades taken by this strategy in the last 7 days{rows.length ? ` · ${rows.length} trades · P&L ${formatINR(pnl)} (master quantity)` : ''}.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          {q.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : !rows.length ? (
            <p className="text-sm text-muted-foreground">No trades in the last 7 days.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="p-2">Date</th>
                  <th className="p-2">Symbol</th>
                  <th className="p-2">Side</th>
                  <th className="p-2 text-right">Qty</th>
                  <th className="p-2 text-right">Entry</th>
                  <th className="p-2 text-right">Exit</th>
                  <th className="p-2 text-right">P&L</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap p-2 text-muted-foreground">{formatDateTime(r.entryAt)}</td>
                    <td className="p-2 font-medium">
                      {r.symbol} <span className="text-xs text-muted-foreground">{r.exchange}</span>
                    </td>
                    <td className={cn('p-2 font-semibold', r.side === 'BUY' ? 'text-success' : 'text-destructive')}>{r.side}</td>
                    <td className="tabular p-2 text-right">{r.quantity}</td>
                    <td className="tabular p-2 text-right">{r.entryPrice ?? '—'}</td>
                    <td className="tabular p-2 text-right">{r.status === 'OPEN' ? <span className="text-xs text-amber-700">Open</span> : (r.exitPrice ?? '—')}</td>
                    <td className={cn('tabular p-2 text-right', r.realizedPnl > 0 ? 'text-success' : r.realizedPnl < 0 ? 'text-destructive' : '')}>{r.status === 'OPEN' ? '—' : formatINR(r.realizedPnl)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Client marketplace: every strategy — connect with a lot multiplier, manage / disconnect in My strategies. */
export default function MarketplacePage() {
  const q = useMarketplace();
  const [pick, setPick] = useState<MarketplaceRow | null>(null);
  const [hist, setHist] = useState<{ id: string; name: string } | null>(null);
  const rows = q.data ?? [];
  return (
    <>
      <PageHeader title="Marketplace" description="Strategies assigned to you by your master. Connect one with your lot size — auto trading starts right away (paper trading needs no demat; live needs your broker connected)." />
      {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {!q.isLoading && rows.length === 0 ? <p className="text-sm text-muted-foreground">No strategy assigned to you yet — contact your master.</p> : null}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((s, i) => (
          <Card key={s.id} className="flex flex-col overflow-hidden">
            <div className={cn('flex items-start justify-between gap-3 p-5', TILE[i % TILE.length])}>
              <div className="min-w-0">
                <p className="truncate text-lg font-bold text-ink">{s.name}</p>
                <p className="text-xs text-ink/70">by {s.masterName ?? 'Master'}</p>
              </div>
              <Layers className="size-6 shrink-0 text-ink/70" />
            </div>
            <CardContent className="flex flex-1 flex-col gap-3 pt-4">
              {s.description ? <p className="line-clamp-2 text-sm text-muted-foreground">{s.description}</p> : null}
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-muted px-2 py-0.5">{humanize(s.riskLevel)} risk</span>
                <span className="rounded-full bg-muted px-2 py-0.5">{s.allowedExchanges.join(', ') || 'All exchanges'}</span>
                <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5">
                  <Users className="size-3" /> {s.followerCount ?? 0}
                </span>
                {s.status !== 'ACTIVE' ? <span className="rounded-full bg-amber-100 px-2 py-0.5 text-amber-800">{s.status === 'DRAFT' ? 'Not started by master' : humanize(s.status)}</span> : null}
              </div>
              <Button size="sm" variant="ghost" className="justify-start px-0 text-primary" onClick={() => setHist({ id: s.id, name: s.name })}>
                <History /> Last 7 days trades
              </Button>
              <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                {s.connected ? (
                  <>
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-success">
                      <CheckCircle2 className="size-4" /> Connected · {s.allocationLabel}
                    </span>
                    <Button asChild size="sm" variant="outline">
                      <Link href="/portfolio">Manage</Link>
                    </Button>
                  </>
                ) : (
                  <Button className="w-full" onClick={() => setPick(s)}>
                    Connect
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <FollowDialog s={pick} onClose={() => setPick(null)} />
      <HistoryDialog s={hist} onClose={() => setHist(null)} />
    </>
  );
}
