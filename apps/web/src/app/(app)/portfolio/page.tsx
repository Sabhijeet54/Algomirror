'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { FollowDialog } from '@/components/follow-dialog';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { humanize } from '@/lib/format';
import { type StrategyWithSub, useDisconnectStrategy, useFollowStrategies, useToggleCopy } from '@/lib/trading';
import Link from 'next/link';

/** Client: the strategies an admin / master assigned to me, my allocation and Start / Stop. */
export default function MyStrategiesPage() {
  const strategies = useFollowStrategies();
  const toggle = useToggleCopy();
  const disconnect = useDisconnectStrategy();
  const [follow, setFollow] = useState<StrategyWithSub | null>(null);

  return (
    <>
      <PageHeader title="My strategies" description="Strategies you are connected to. Change the lot multiplier, Start / Stop auto trading, or Disconnect."
        actions={
          <Button asChild>
            <Link href="/portfolio/marketplace">Browse marketplace</Link>
          </Button>
        } />
      <Card>
        <CardHeader>
          <CardTitle>Connected strategies</CardTitle>
          <CardDescription>Connect more from the Marketplace. Disconnecting removes the strategy and its trades from your screens.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Strategy</TableHead>
                <TableHead>Master</TableHead>
                <TableHead>Risk</TableHead>
                <TableHead>Allocation</TableHead>
                <TableHead>Auto trading</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(strategies.data ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-sm text-muted-foreground">
                    {strategies.isLoading ? 'Loading…' : 'You are not connected to any strategy yet — open the Marketplace to connect one.'}
                  </TableCell>
                </TableRow>
              ) : (
                strategies.data!.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="font-medium">{s.name}</div>
                      <div className="max-w-72 truncate text-xs text-muted-foreground">{s.description}</div>
                    </TableCell>
                    <TableCell>{s.masterName}</TableCell>
                    <TableCell>{humanize(s.riskLevel)}</TableCell>
                    <TableCell>{s.allocationLabel ?? '—'}</TableCell>
                    <TableCell>
                      {s.subscription ? <StatusBadge value={s.subscription.copyStatus} /> : null}
                      {s.status !== 'ACTIVE' ? <div className="text-[11px] text-muted-foreground">Strategy {s.status.toLowerCase()}</div> : null}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" onClick={() => setFollow(s)}>
                          Lot size
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={disconnect.isPending}
                          onClick={() => {
                            if (!window.confirm(`Disconnect ${s.name}? Auto trading stops and its trades are removed from your screens. Open positions in your broker are not closed.`)) return;
                            disconnect.mutate(s.id, { onSuccess: () => toast.success(`${s.name} disconnected`), onError: (e) => toast.error(e.message) });
                          }}
                        >
                          Disconnect
                        </Button>
                        {s.subscription ? (
                          s.subscription.copyStatus === 'ON' ? (
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={toggle.isPending}
                              onClick={() => toggle.mutate({ id: s.subscription!.id, action: 'stop' }, { onSuccess: () => toast.success('Auto-trading stopped'), onError: (e) => toast.error(e.message) })}
                            >
                              Stop
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              disabled={toggle.isPending || s.status !== 'ACTIVE'}
                              onClick={() => toggle.mutate({ id: s.subscription!.id, action: 'start' }, { onSuccess: () => toast.success('Auto-trading started'), onError: (e) => toast.error(e.message) })}
                            >
                              Start
                            </Button>
                          )
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      <FollowDialog s={follow} onClose={() => setFollow(null)} />
    </>
  );
}
