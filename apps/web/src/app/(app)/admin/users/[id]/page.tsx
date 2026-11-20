'use client';

import { ArrowLeft, Ban, CheckCircle2, Unplug, StopCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { ReasonDialog } from '@/components/reason-dialog';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { brokerLabel, formatDateTime, formatINR, humanize } from '@/lib/format';
import { useAdminAction, useAdminUser, useMe } from '@/lib/queries';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words font-medium">{children}</span>
    </div>
  );
}

type DialogState =
  | { kind: 'disable' }
  | { kind: 'enable' }
  | { kind: 'disconnect'; id: string; broker: string }
  | { kind: 'stop'; id: string; strategy: string }
  | null;

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: me } = useMe();
  const q = useAdminUser(id);
  const setStatus = useAdminAction<{ status: string; reason?: string }>('PATCH', (uid) => `/admin/users/${uid}/status`);
  const disconnect = useAdminAction<{ reason: string }>('POST', (aid) => `/admin/broker-accounts/${aid}/disconnect`);
  const stopCopy = useAdminAction<{ reason: string }>('POST', (fid) => `/admin/strategy-followers/${fid}/stop`);
  const [dialog, setDialog] = useState<DialogState>(null);

  const done = (msg: string) => ({
    onSuccess: () => {
      toast.success(msg);
      setDialog(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.error || !q.data) return <p className="text-sm text-destructive">{q.error?.message ?? 'User not found'}</p>;
  const u = q.data;
  const isSelf = me?.id === u.id;

  return (
    <>
      <Link href="/admin/users" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="size-4" /> Users
      </Link>
      <PageHeader
        title={u.name}
        description={u.email}
        actions={
          isSelf ? null : u.status === 'ACTIVE' ? (
            <Button variant="destructive" onClick={() => setDialog({ kind: 'disable' })}>
              <Ban /> Disable user
            </Button>
          ) : (
            <Button variant="outline" onClick={() => setDialog({ kind: 'enable' })}>
              <CheckCircle2 /> Re-enable user
            </Button>
          )
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent className="divide-y">
            <Row label="Email">{u.email}</Row>
            <Row label="Mobile">{u.mobile ?? '—'}</Row>
            <Row label="Status">
              <StatusBadge value={u.status} />
            </Row>
            <Row label="Role">
              <StatusBadge value={u.role} />
            </Row>
            <Row label="Email verified">{u.emailVerified ? 'Yes' : 'No'}</Row>
            <Row label="Last login">{formatDateTime(u.lastLoginAt)}</Row>
            <Row label="Joined">{formatDateTime(u.createdAt)}</Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Trading account</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {u.brokerAccounts.length === 0 ? (
              <p className="text-sm text-muted-foreground">No broker account connected.</p>
            ) : (
              u.brokerAccounts.map((a) => (
                <div key={a.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{brokerLabel(a.broker)}</span>
                    {a.status !== 'DISCONNECTED' ? (
                      <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'disconnect', id: a.id, broker: brokerLabel(a.broker) })}>
                        <Unplug /> Disconnect
                      </Button>
                    ) : null}
                  </div>
                  <div className="mt-1 divide-y">
                    <Row label="Client ID">{a.brokerClientId ?? '—'}</Row>
                    <Row label="Status">
                      <StatusBadge value={a.status} />
                    </Row>
                    <Row label="Token status">
                      <StatusBadge value={a.tokenStatus} />
                    </Row>
                    <Row label="Token expiry">{a.isPaper ? 'Not applicable (paper)' : formatDateTime(a.tokenExpiresAt)}</Row>
                    {a.lastError ? <Row label="Last error">{a.lastError}</Row> : null}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {u.role !== 'ADMIN' && u.role !== 'SUB_ADMIN' ? (
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{u.role === 'MASTER' ? 'Strategies' : 'Auto-trading'}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {u.role === 'MASTER' ? (
                u.strategies.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No strategies yet.</p>
                ) : (
                  u.strategies.map((s) => (
                    <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                      <div>
                        <p className="font-medium">{s.name}</p>
                        <p className="text-muted-foreground">
                          {humanize(s.riskLevel)} risk · {s.followerCount ?? 0} followers · capital {formatINR(s.masterCapital)}
                        </p>
                      </div>
                      <StatusBadge value={s.status} />
                    </div>
                  ))
                )
              ) : u.follows.length === 0 ? (
                <p className="text-sm text-muted-foreground">Not following any strategy.</p>
              ) : (
                u.follows.map((f) => (
                  <div key={f.id} className="rounded-lg border p-3 text-sm">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-medium">{f.strategyName}</span>
                      <div className="flex items-center gap-2">
                        <StatusBadge value={f.copyStatus} label={`Copy ${f.copyStatus === 'ON' ? 'active' : humanize(f.copyStatus).toLowerCase()}`} />
                        {f.copyStatus !== 'OFF' ? (
                          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'stop', id: f.id, strategy: f.strategyName ?? 'strategy' })}>
                            <StopCircle /> Stop auto-trading
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <div className="mt-2 grid gap-x-6 sm:grid-cols-2">
                      <Row label="Allocation">
                        {formatINR(f.allocationAmount)}
                        {f.allocationPercent ? ` · ${Number(f.allocationPercent)}%` : ''}
                      </Row>
                      <Row label="Mode">{humanize(f.allocationMode)}</Row>
                      <Row label="Max trade value">{formatINR(f.maxTradeValue)}</Row>
                      <Row label="Daily loss limit">{formatINR(f.maxDailyLoss)}</Row>
                      {f.stoppedReason ? <Row label="Stopped">{f.stoppedReason}</Row> : null}
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        ) : null}
      </div>

      <ReasonDialog
        open={dialog?.kind === 'disable'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Disable ${u.name}?`}
        description="Signs the user out everywhere, stops all their auto-trading and pauses any strategies they run as a master."
        confirmLabel="Disable user"
        pending={setStatus.isPending}
        onConfirm={(reason) => setStatus.mutate({ id: u.id, body: { status: 'DISABLED', reason } }, done('User disabled'))}
      />
      <ReasonDialog
        open={dialog?.kind === 'enable'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Re-enable ${u.name}?`}
        description="The user can sign in again. Auto-trading and strategies stay stopped until they restart them."
        confirmLabel="Re-enable"
        destructive={false}
        pending={setStatus.isPending}
        onConfirm={(reason) => setStatus.mutate({ id: u.id, body: { status: 'ACTIVE', reason } }, done('User re-enabled'))}
      />
      <ReasonDialog
        open={dialog?.kind === 'disconnect'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Disconnect ${dialog?.kind === 'disconnect' ? dialog.broker : ''} account?`}
        description="Deletes the stored broker session and stops auto-trading through this account. The user must re-authorise to reconnect."
        confirmLabel="Disconnect"
        pending={disconnect.isPending}
        onConfirm={(reason) => dialog?.kind === 'disconnect' && disconnect.mutate({ id: dialog.id, body: { reason } }, done('Broker account disconnected'))}
      />
      <ReasonDialog
        open={dialog?.kind === 'stop'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Stop auto-trading ${dialog?.kind === 'stop' ? dialog.strategy : ''}?`}
        description="No new copy orders will be created for this follower on this strategy. Open positions are not closed."
        confirmLabel="Stop auto-trading"
        pending={stopCopy.isPending}
        onConfirm={(reason) => dialog?.kind === 'stop' && stopCopy.mutate({ id: dialog.id, body: { reason } }, done('Auto-trading stopped'))}
      />
    </>
  );
}
