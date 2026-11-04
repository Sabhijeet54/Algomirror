'use client';

import { Activity, Plus, RotateCw, X, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { brokerLabel } from '@/lib/format';
import { useFeedAction, useFeedStatus, useMasterLatency } from '@/lib/trading';

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/**
 * Live-feed health (Live/Down, last tick age) and copy-order latency. The feed is shared by all masters, so the
 * instrument list and feed controls are shown to the platform admin only (`admin`).
 */
export function MarketFeedPanel({ showLatency = true, admin = false }: { showLatency?: boolean; admin?: boolean }) {
  const feed = useFeedStatus();
  const latency = useMasterLatency(showLatency);
  const action = useFeedAction();
  const now = useNow();
  const [add, setAdd] = useState('');
  const st = feed.data;
  const ago = st?.lastTickAt ? Math.max(0, Math.round((now - new Date(st.lastTickAt).getTime()) / 1000)) : null;
  const err = (e: Error) => toast.error(e.message);

  const badge =
    st?.state === 'LIVE' ? (
      <Badge variant="success">🟢 Live</Badge>
    ) : st?.state === 'CONNECTING' ? (
      <Badge variant="warning">🟡 Connecting</Badge>
    ) : st?.state === 'DOWN' ? (
      <Badge variant="destructive">🔴 Down</Badge>
    ) : (
      <Badge variant="secondary">⚪ Stopped</Badge>
    );

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className={showLatency ? 'lg:col-span-2' : 'lg:col-span-3'}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <Activity className="size-4" /> Live market feed {badge}
          </CardTitle>
          <CardDescription>
            Live prices come from a master's Angel One data account — it never places orders.{admin ? ' The whole app (all masters) uses this feed.' : ' The feed is shared, so other masters’ instruments are not shown here.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className={admin ? 'grid grid-cols-2 gap-3 sm:grid-cols-4' : 'grid grid-cols-3 gap-3'}>
            <div>
              <div className="text-xs text-muted-foreground">Broker</div>
              <div className="font-medium">{st?.broker ? brokerLabel(st.broker) : '—'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Last tick</div>
              <div className="font-medium tabular-nums">{ago === null ? '—' : `${ago}s ago`}</div>
            </div>
            {admin ? (
              <div>
                <div className="text-xs text-muted-foreground">Instruments</div>
                <div className="font-medium tabular-nums">{st?.subscribed.length ?? 0}</div>
              </div>
            ) : null}
            <div>
              <div className="text-xs text-muted-foreground">Reconnects</div>
              <div className="font-medium tabular-nums">{st?.reconnects ?? 0}</div>
            </div>
          </div>
          {st?.error ? <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">{st.error}</p> : null}
          {admin ? (
          <>
          <div className="flex flex-wrap gap-1.5">
            {st?.subscribed.map((k) => (
              <Badge key={k} variant="outline" className="font-mono">
                {k}
                <button aria-label={`Remove ${k}`} className="ml-1 opacity-60 hover:opacity-100" onClick={() => action.mutate({ kind: 'unsubscribe', instruments: [k] }, { onError: err })}>
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const list = add.split(/[,\s]+/).filter(Boolean).map((x) => x.toUpperCase());
              if (!list.length) return;
              action.mutate({ kind: 'subscribe', instruments: list }, { onSuccess: () => setAdd(''), onError: err });
            }}
          >
            <Input className="min-w-0 flex-1" placeholder="NSE:INFY, NFO:NIFTY24OCT25000CE" value={add} onChange={(e) => setAdd(e.target.value)} />
            <Button type="submit" size="sm" variant="outline" disabled={action.isPending}>
              <Plus /> Subscribe
            </Button>
          </form>
          </>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" disabled={action.isPending} onClick={() => action.mutate({ kind: 'restart' }, { onSuccess: () => toast.success('Feed restarted'), onError: err })}>
              <RotateCw /> Restart feed
            </Button>
            {admin ? (
              <Button size="sm" variant="ghost" disabled={action.isPending} onClick={() => action.mutate({ kind: 'broker', broker: 'ANGEL_ONE' }, { onError: err })}>
                Use Angel One
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
      {showLatency ? (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Zap className="size-4" /> Copy speed
          </CardTitle>
          <CardDescription>Master trade detected → broker acknowledged, per client order.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <div className="text-xs text-muted-foreground">Average today</div>
            <div className="text-2xl font-semibold tabular-nums">{latency.data?.todayAvgMs != null ? `${latency.data.todayAvgMs} ms` : '—'}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Orders today</div>
            <div className="text-2xl font-semibold tabular-nums">{latency.data?.todayCount ?? 0}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">p95</div>
            <div className="font-medium tabular-nums">{latency.data?.p95Ms != null ? `${latency.data.p95Ms} ms` : '—'}</div>
          </div>
          <div>
            <div className="text-xs text-muted-foreground">Last</div>
            <div className="font-medium tabular-nums">{latency.data?.lastMs != null ? `${latency.data.lastMs} ms` : '—'}</div>
          </div>
        </CardContent>
      </Card>
      ) : null}
    </div>
  );
}
