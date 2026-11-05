'use client';

import { KeyRound, Layers, Search, Trash2, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { AddClientDialog } from '@/components/master-add-client';
import { LicenceDialog, UserStrategiesDialog } from '@/components/admin-user-dialogs';
import Link from 'next/link';
import { useState } from 'react';
import { Pnl } from '@/components/live-account';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { brokerLabel, formatDateTime } from '@/lib/format';
import { useMe } from '@/lib/queries';
import { type MasterClientRow, useDeleteMasterClient, useMasterClients, useMasterLicenceQuota } from '@/lib/trading';

const LIC = { NONE: 'No licence', ACTIVE: 'Active', EXPIRING: 'Expiring', EXPIRED: 'Expired' } as const;
const LIC_TONE = { NONE: 'text-muted-foreground', ACTIVE: 'text-success', EXPIRING: 'text-warning', EXPIRED: 'text-destructive' } as const;

export default function MasterClientsPage() {
  const q = useMasterClients();
  const [search, setSearch] = useState('');
  const [lic, setLic] = useState<MasterClientRow | null>(null);
  const [strat, setStrat] = useState<MasterClientRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [del, setDel] = useState<MasterClientRow | null>(null);
  const me = useMe();
  // A master's sub-admin cannot delete clients.
  const canDelete = !(me.data as { isSubAdmin?: boolean } | undefined)?.isSubAdmin;
  const quota = useMasterLicenceQuota();
  const rows = (q.data ?? []).filter((c) => {
    const t = search.trim().toLowerCase();
    return !t || c.name.toLowerCase().includes(t) || c.email.toLowerCase().includes(t) || (c.mobile ?? '').includes(t);
  });
  const total = rows.reduce((a, c) => a + c.todayPnl, 0);

  return (
    <>
      <PageHeader
        title="Clients"
        description="Everyone who follows your strategies. Open a client to see all of their data."
        actions={
          <div className="flex items-center gap-4">
            <span className="rounded-full bg-primary/10 px-3 py-1 text-sm font-medium text-primary" title="Licences you can still give (set by admin). Demo is free.">
              Licences left: {quota.data?.remaining ?? '—'}
            </span>
            <span className="text-sm">
              Today&apos;s P&amp;L (all clients): <strong><Pnl value={total} /></strong>
            </span>
            <Button onClick={() => setAddOpen(true)}>
              <UserPlus /> Create client
            </Button>
          </div>
        }
      />
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <div className="relative w-full max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input className="pl-8" placeholder="Name, email or mobile" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Client</TableHead>
                  <TableHead>Mobile</TableHead>
                  <TableHead>Broker</TableHead>
                  <TableHead>Strategies</TableHead>
                  <TableHead>Licence</TableHead>
                  <TableHead className="text-right">Trades today</TableHead>
                  <TableHead className="text-right">Today P&amp;L</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      {q.isLoading ? 'Loading…' : q.error ? q.error.message : 'No clients yet — press “Create client”.'}
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((c) => (
                    <TableRow key={c.userId}>
                      <TableCell>
                        <Link href={`/master/client?id=${c.userId}`} className="font-medium hover:underline">
                          {c.name}
                        </Link>
                        <div className="text-xs text-muted-foreground">{c.email}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{c.mobile ?? '—'}</TableCell>
                      <TableCell>
                        {c.broker ? (
                          <div className="flex flex-col gap-1">
                            <span className="text-sm">
                              {brokerLabel(c.broker.broker)} <span className="text-xs text-muted-foreground">{c.broker.brokerClientId}</span>
                            </span>
                            <span className="flex gap-1">
                              <StatusBadge value={c.broker.status} />
                              <StatusBadge value={c.broker.simulated ? 'PAUSED' : 'ACTIVE'} label={c.broker.simulated ? 'Paper' : 'Live'} />
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">Not connected</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col gap-1 text-xs">
                          {c.subscriptions.map((s) => (
                            <span key={s.followerId} className="flex items-center gap-1.5">
                              <StatusBadge value={s.copyStatus} label={s.copyStatus === 'ON' ? 'ON' : s.copyStatus} />
                              <span className="font-medium">{s.strategyName}</span>
                              <span className="text-muted-foreground">{s.allocation}</span>
                            </span>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        <div className={`font-medium ${LIC_TONE[c.licenceStatus]}`}>
                          {LIC[c.licenceStatus]}
                          {c.demo ? <span className="ml-1 rounded bg-amber-100 px-1 text-amber-800">Demo</span> : null}
                        </div>
                        {c.licenceExpiresAt ? <div className="text-muted-foreground">till {formatDateTime(c.licenceExpiresAt)}</div> : null}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{c.todayTrades}</TableCell>
                      <TableCell className="text-right font-medium">
                        <Pnl value={c.todayPnl} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" title="Assign / edit licence" onClick={() => setLic(c)}>
                            <KeyRound /> Licence
                          </Button>
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" title="Allocate / remove strategies" onClick={() => setStrat(c)}>
                            <Layers /> Strategies
                          </Button>
                          <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
                            <Link href={`/master/client?id=${c.userId}`}>Details</Link>
                          </Button>
                          {canDelete ? (
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs text-destructive hover:text-destructive" title="Delete client" aria-label={`Delete ${c.name}`} onClick={() => setDel(c)}>
                              <Trash2 />
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <LicenceDialog
        scope="master"
        user={lic ? { id: lic.userId, name: lic.name, mobile: lic.mobile, licenceDays: lic.licenceDays ?? null, licenceExpiresAt: lic.licenceExpiresAt, demo: lic.demo } : null}
        onClose={() => setLic(null)}
      />
      <AddClientDialog open={addOpen} onOpenChange={setAddOpen} onCreated={(c) => setStrat({ userId: c.id, name: c.name, email: c.email } as MasterClientRow)} />
      <UserStrategiesDialog scope="master" user={strat ? { id: strat.userId, name: strat.name, email: strat.email } : null} onClose={() => setStrat(null)} />
      <DeleteClientDialog client={del} onClose={() => setDel(null)} />
    </>
  );
}

/** Confirm before deleting: copying stops, login is blocked, broker keys are wiped; trade history stays. */
function DeleteClientDialog({ client, onClose }: { client: MasterClientRow | null; onClose: () => void }) {
  const del = useDeleteMasterClient();
  const copying = client?.subscriptions.some((s) => s.copyStatus === 'ON') ?? false;
  return (
    <Dialog open={!!client} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete {client?.name}?</DialogTitle>
          <DialogDescription>{client?.email}</DialogDescription>
        </DialogHeader>
        <ul className="list-disc space-y-1 pl-5 text-sm">
          <li>Removed from all your strategies — copy trading stops.</li>
          <li>Logged out and can no longer log in. The email can be used again for a new client.</li>
          <li>Broker disconnected and saved broker API keys deleted.</li>
          <li>Past trades stay in your trade history.</li>
        </ul>
        <p className="rounded-md bg-destructive/10 p-2 text-sm text-destructive">
          Open positions in the client&apos;s broker are <strong>not</strong> closed — exit them first.{copying ? ' This client is copying right now.' : ''} This cannot be undone.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={del.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={del.isPending || !client}
            onClick={() =>
              client &&
              del.mutate(client.userId, {
                onSuccess: () => {
                  toast.success(`${client.name} deleted`);
                  onClose();
                },
                onError: (e) => toast.error(e.message),
              })
            }
          >
            <Trash2 /> {del.isPending ? 'Deleting…' : 'Delete client'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
