'use client';

import {
  ArrowLeftRight,
  BarChart3,
  CheckCircle2,
  Layers,
  OctagonX,
  PlayCircle,
  ShieldAlert,
  TriangleAlert,
  UserCheck,
  Users,
  Wallet,
  XCircle,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { ReasonDialog } from '@/components/reason-dialog';
import { StatCard } from '@/components/stat-card';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatDateTime, formatNumber } from '@/lib/format';
import { useAdminAction, useAdminDashboard, useAdminSystemHealth, useMe } from '@/lib/queries';
import { useAdminLatency } from '@/lib/trading';
import { MarketFeedPanel } from '@/components/market-feed-panel';

export default function AdminOverviewPage() {
  const stats = useAdminDashboard();
  const isFullAdmin = useMe().data?.role === 'ADMIN';
  const health = useAdminSystemHealth();
  const halt = useAdminAction<{ reason: string }>('POST', () => '/admin/copy-trading/halt');
  const resume = useAdminAction<{ reason: string }>('POST', () => '/admin/copy-trading/resume');
  const kill = useAdminAction<{ reason: string }, { stoppedFollowers: number; results: { orders: number; failed: number }[] }>('POST', () => '/admin/kill-switch');
  const latency = useAdminLatency();
  const [dialog, setDialog] = useState<'halt' | 'resume' | 'kill' | null>(null);

  const s = stats.data;
  const loading = stats.isLoading;
  const copyHalt = health.data?.copyHalt ?? null;

  return (
    <>
      <PageHeader
        title="Admin overview"
        description="Platform activity for today (IST). Refreshes automatically."
        actions={
          !isFullAdmin ? undefined : <>
            {copyHalt ? (
              <Button variant="outline" onClick={() => setDialog('resume')}>
                <PlayCircle /> Resume copy trading
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setDialog('halt')}>
                <OctagonX /> Halt copy trading
              </Button>
            )}
            <Button variant="destructive" onClick={() => setDialog('kill')}>
              <OctagonX /> KILL SWITCH
            </Button>
          </>
        }
      />

      {s?.paperMode ? (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2.5 text-sm">
          <ShieldAlert className="size-4 shrink-0" />
          <span>
            <strong>Paper mode is ON.</strong> No real broker orders can be placed (PAPER_MODE=true).
          </span>
        </div>
      ) : null}
      {copyHalt ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2.5 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>Copy trading is halted platform-wide</strong> since {formatDateTime(copyHalt.haltedAt)}. Reason: {copyHalt.reason}
          </span>
        </div>
      ) : null}

      <div className="fox-tiles mb-3 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Total users" value={formatNumber(s?.totalUsers)} loading={loading} icon={<Users />} />
        <StatCard
          label="This month"
          value={formatNumber(s?.newUsersThisMonth)}
          loading={loading}
          icon={<UserCheck />}
          hint={
            s
              ? s.newUsersLastMonth
                ? `${Math.round(((s.newUsersThisMonth - s.newUsersLastMonth) / s.newUsersLastMonth) * 100)}% vs last month (${s.newUsersLastMonth})`
                : `Last month: ${s.newUsersLastMonth}`
              : undefined
          }
        />
        <StatCard label="Expired users" value={formatNumber(s?.expiredUsers)} tone={s && s.expiredUsers > 0 ? 'destructive' : 'default'} loading={loading} icon={<XCircle />} hint="Licence expired" />
        <StatCard label="Active clients" value={formatNumber(s?.activeClients)} tone="success" loading={loading} icon={<CheckCircle2 />} hint="Broker connected" />
        <StatCard label="Expiring this week" value={formatNumber(s?.expiringThisWeek)} loading={loading} icon={<TriangleAlert />} hint="Licence ends in ≤ 7 days" />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Connected accounts" value={formatNumber(s?.connectedAccounts)} loading={loading} icon={<Wallet />} />
        <StatCard label="Active masters" value={formatNumber(s?.activeMasters)} loading={loading} icon={<UserCheck />} hint="With an active strategy" />
        <StatCard label="Active followers" value={formatNumber(s?.activeFollowers)} loading={loading} icon={<Users />} hint="Copy trading ON" />
        <StatCard label="Active strategies" value={formatNumber(s?.activeStrategies)} loading={loading} icon={<Layers />} />
        <StatCard label="Master trades today" value={formatNumber(s?.todaysMasterTrades)} loading={loading} icon={<BarChart3 />} />
        <StatCard
          label="Copy orders filled"
          value={formatNumber(s?.successfulCopyOrders)}
          tone="success"
          loading={loading}
          icon={<CheckCircle2 />}
          hint="Today"
        />
        <StatCard
          label="Copy orders failed"
          value={formatNumber(s?.failedCopyOrders)}
          tone={s && s.failedCopyOrders > 0 ? 'destructive' : 'default'}
          loading={loading}
          icon={<XCircle />}
          hint="Failed or rejected today"
        />
      </div>

      <Card className="mt-6 p-4">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <span className="font-medium">System</span>
          {(['database', 'redis', 'worker'] as const).map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5 capitalize">
              <span
                className={`size-2 rounded-full ${health.data?.[k] === 'connected' ? 'bg-success' : health.data ? 'bg-destructive' : 'bg-muted-foreground'}`}
              />
              {k}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5">
            <ArrowLeftRight className="size-3.5 text-muted-foreground" />
            Copy engine: {copyHalt ? 'halted' : 'accepting'}
          </span>
        </div>
      </Card>

      <div className="mt-4 grid gap-3">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Avg copy latency (today)" value={latency.data?.dbTodayAvgMs != null ? `${latency.data.dbTodayAvgMs} ms` : '—'} hint={`${latency.data?.dbTodayCount ?? 0} live orders`} />
          <StatCard label="p95 latency" value={latency.data?.p95Ms != null ? `${latency.data.p95Ms} ms` : '—'} hint="Last 1000 orders (this server)" />
        </div>
        <MarketFeedPanel showLatency={false} admin />
      </div>

      <ReasonDialog
        open={dialog === 'kill'}
        onOpenChange={(o) => setDialog(o ? 'kill' : null)}
        title="Activate KILL SWITCH?"
        description="Halts the copy engine, turns copy trading OFF for every client and exits ALL open positions in every connected client trading account at MARKET."
        confirmLabel="Kill switch — exit everything"
        pending={kill.isPending}
        onConfirm={(reason) =>
          kill.mutate(
            { id: 'all', body: { reason } },
            {
              onSuccess: (r) => (
                toast.success(`Kill switch done: ${r.stoppedFollowers} subscriptions stopped, ${r.results.reduce((a, x) => a + x.orders, 0)} exit orders`), setDialog(null)
              ),
              onError: (e) => toast.error(e.message),
            },
          )
        }
      />
      <ReasonDialog
        open={dialog === 'halt'}
        onOpenChange={(o) => setDialog(o ? 'halt' : null)}
        title="Halt all copy trading?"
        description="The copy engine will stop creating and submitting follower orders for every strategy until resumed. Existing broker orders are not cancelled."
        confirmLabel="Halt copy trading"
        pending={halt.isPending}
        onConfirm={(reason) =>
          halt.mutate(
            { id: '', body: { reason } },
            { onSuccess: () => (toast.success('Copy trading halted'), setDialog(null)), onError: (e) => toast.error(e.message) },
          )
        }
      />
      <ReasonDialog
        open={dialog === 'resume'}
        onOpenChange={(o) => setDialog(o ? 'resume' : null)}
        title="Resume copy trading?"
        description="Followers with copy trading ON will start receiving copies of new master trades again."
        confirmLabel="Resume"
        destructive={false}
        pending={resume.isPending}
        onConfirm={(reason) =>
          resume.mutate(
            { id: '', body: { reason } },
            { onSuccess: () => (toast.success('Copy trading resumed'), setDialog(null)), onError: (e) => toast.error(e.message) },
          )
        }
      />
    </>
  );
}
