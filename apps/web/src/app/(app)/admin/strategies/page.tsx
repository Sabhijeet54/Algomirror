'use client';

import { ArrowLeftRight, PauseCircle, Plus, StopCircle, Trash2, UserPlus, Users } from 'lucide-react';
import { AssignClientDialog } from '@/components/assign-client-dialog';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { StrategyStatus } from '@ctp/types';
import { EnumSelect } from '@/components/enum-select';
import { Field, FilterBar } from '@/components/filter-bar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { ReasonDialog } from '@/components/reason-dialog';
import { StatusBadge } from '@/components/status-badge';
import { TableEmpty, TableError, TableLoading } from '@/components/table-states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, formatINR, humanize } from '@/lib/format';
import { useAdminAction, useAdminStrategies, useAdminStrategyFollowers, useAdminUsers } from '@/lib/queries';
import { useListState } from '@/lib/use-list-state';

const COLS = 8;

function useMasters() {
  const q = useAdminUsers({ role: 'MASTER', status: 'ACTIVE', page: 1, pageSize: 100 });
  return q.data?.items ?? [];
}

/** Admin creates a strategy for a master, or moves an existing strategy to another master. */
function AllocateDialog({ open, onClose, move }: { open: boolean; onClose: () => void; move: { id: string; name: string; masterUserId: string } | null }) {
  const masters = useMasters();
  const create = useAdminAction<Record<string, unknown>>('POST', () => '/admin/strategies');
  const reassign = useAdminAction<{ masterUserId: string }>('POST', (id) => `/admin/strategies/${id}/master`);
  const [f, setF] = useState({ masterUserId: '', name: '', description: '', riskLevel: 'MEDIUM', masterCapital: '' });
  const pending = create.isPending || reassign.isPending;
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.masterUserId) return toast.error('Select a master');
    const done = { onSuccess: () => (toast.success(move ? 'Strategy moved' : 'Strategy created for master'), onClose(), setF({ masterUserId: '', name: '', description: '', riskLevel: 'MEDIUM', masterCapital: '' })), onError: (err: Error) => toast.error(err.message) };
    if (move) reassign.mutate({ id: move.id, body: { masterUserId: f.masterUserId } }, done);
    else create.mutate({ id: '', body: { masterUserId: f.masterUserId, name: f.name.trim(), description: f.description.trim() || undefined, riskLevel: f.riskLevel, masterCapital: Number(f.masterCapital) || 0 } }, done);
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{move ? `Move “${move.name}” to another master` : 'Allocate a new strategy to a master'}</DialogTitle>
            <DialogDescription>{move ? 'Allowed only when the strategy has no open trades. Clients stay subscribed.' : 'The master sees it under Strategies and can start trading it.'}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="al-master">Master</Label>
            <Select id="al-master" value={f.masterUserId} onChange={(e) => setF({ ...f, masterUserId: e.target.value })}>
              <option value="">Select master…</option>
              {masters.filter((m) => m.id !== move?.masterUserId).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} ({m.email})
                </option>
              ))}
            </Select>
          </div>
          {move ? null : (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="al-name">Strategy name</Label>
                <Input id="al-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} maxLength={100} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="al-desc">Description</Label>
                <Input id="al-desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-1.5">
                  <Label htmlFor="al-risk">Risk</Label>
                  <Select id="al-risk" value={f.riskLevel} onChange={(e) => setF({ ...f, riskLevel: e.target.value })}>
                    <option value="LOW">Low</option>
                    <option value="MEDIUM">Medium</option>
                    <option value="HIGH">High</option>
                  </Select>
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="al-cap">Master capital (₹)</Label>
                  <Input id="al-cap" type="number" min={0} value={f.masterCapital} onChange={(e) => setF({ ...f, masterCapital: e.target.value })} />
                </div>
              </div>
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving…' : move ? 'Move strategy' : 'Create strategy'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function FollowersDialog({ strategy, onClose }: { strategy: { id: string; name: string } | null; onClose: () => void }) {
  const q = useAdminStrategyFollowers(strategy?.id ?? null);
  const stop = useAdminAction<{ reason: string }>('POST', (id) => `/admin/strategy-followers/${id}/stop`);
  const [stopId, setStopId] = useState<string | null>(null);
  return (
    <>
      <Dialog open={strategy !== null} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{strategy?.name} — followers</DialogTitle>
            <DialogDescription>Clients who have this strategy and their copy status. Use “Assign client” to add more.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto">
            {q.isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : !q.data?.length ? (
              <p className="text-sm text-muted-foreground">No followers yet.</p>
            ) : (
              <div className="divide-y rounded-lg border">
                {q.data.map((f) => (
                  <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
                    <div>
                      <Link href={`/admin/users/${f.followerUserId}`} className="font-medium hover:underline">
                        {f.followerName}
                      </Link>
                      <p className="text-muted-foreground">
                        {f.allocationMode === 'CAPITAL_PERCENTAGE'
                          ? `${+(Number(f.allocationPercent ?? 0) / 100).toFixed(2)}× lots`
                          : f.allocationMode === 'FIXED_QUANTITY'
                            ? f.fixedLots
                              ? `${f.fixedLots} lot(s)`
                              : `${f.fixedQuantity ?? 0} qty`
                            : `${formatINR(f.allocationAmount)} capital`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge value={f.copyStatus} label={`Copy ${f.copyStatus}`} />
                      {f.copyStatus !== 'OFF' ? (
                        <Button size="sm" variant="outline" onClick={() => setStopId(f.id)}>
                          <StopCircle /> Stop
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
      <ReasonDialog
        open={stopId !== null}
        onOpenChange={(o) => !o && setStopId(null)}
        title="Stop auto-trading for this client?"
        description="No new copy orders will be created for this subscription."
        confirmLabel="Stop auto-trading"
        pending={stop.isPending}
        onConfirm={(reason) =>
          stopId &&
          stop.mutate(
            { id: stopId, body: { reason } },
            { onSuccess: () => (toast.success('Auto-trading stopped'), setStopId(null)), onError: (e) => toast.error(e.message) },
          )
        }
      />
    </>
  );
}

export default function AdminStrategiesPage() {
  const list = useListState({ status: '', search: '' });
  const q = useAdminStrategies(list.params);
  const pause = useAdminAction<{ reason: string }>('POST', (id) => `/admin/strategies/${id}/pause`);
  const [pauseTarget, setPauseTarget] = useState<{ id: string; name: string } | null>(null);
  const [followersOf, setFollowersOf] = useState<{ id: string; name: string } | null>(null);
  const [assignTo, setAssignTo] = useState<{ id: string; name: string } | null>(null);
  const remove = useAdminAction<{ reason: string }>('POST', (id) => `/admin/strategies/${id}/remove`);
  const [removeTarget, setRemoveTarget] = useState<{ id: string; name: string } | null>(null);
  const [allocOpen, setAllocOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState<{ id: string; name: string; masterUserId: string } | null>(null);

  return (
    <>
      <PageHeader
        title="Strategies"
        description="Allocate strategies to masters, assign clients, or remove a strategy."
        actions={
          <Button onClick={() => setAllocOpen(true)}>
            <Plus /> Allocate strategy
          </Button>
        }
      />
      <Card className="overflow-hidden">
        <FilterBar onReset={list.reset} active={list.active}>
          <Field label="Search" className="grid w-56 gap-1.5">
            <Input placeholder="Strategy name" value={list.filters.search} onChange={(e) => list.setFilter('search', e.target.value)} />
          </Field>
          <Field label="Status">
            <EnumSelect value={list.filters.status} onChange={(v) => list.setFilter('status', v)} options={Object.values(StrategyStatus)} />
          </Field>
        </FilterBar>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Strategy</TableHead>
              <TableHead>Master</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Risk</TableHead>
              <TableHead>Instruments</TableHead>
              <TableHead className="text-right">Followers</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              <TableLoading cols={COLS} />
            ) : q.error ? (
              <TableError cols={COLS} error={q.error} />
            ) : !q.data?.items.length ? (
              <TableEmpty cols={COLS} message="No strategies match these filters." />
            ) : (
              q.data.items.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <span className="font-medium">{s.name}</span>
                    {s.description ? <div className="max-w-72 truncate text-xs text-muted-foreground">{s.description}</div> : null}
                  </TableCell>
                  <TableCell>
                    <Link href={`/admin/users/${s.masterUserId}`} className="hover:underline">
                      {s.masterName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={s.status} />
                  </TableCell>
                  <TableCell>{humanize(s.riskLevel)}</TableCell>
                  <TableCell className="text-xs">
                    {s.allowedExchanges.join(', ') || 'Any'}
                    {s.allowedInstruments.length ? <span className="text-muted-foreground"> · {s.allowedInstruments.join(', ')}</span> : null}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {s.activeFollowerCount ?? 0} active / {s.followerCount ?? 0}
                    {s.maxFollowers ? <span className="text-muted-foreground"> (max {s.maxFollowers})</span> : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(s.createdAt)}</TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-2">
                      {s.status === 'ARCHIVED' ? null : (
                      <Button size="sm" onClick={() => setAssignTo({ id: s.id, name: s.name })}>
                        <UserPlus /> Assign client
                      </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setFollowersOf({ id: s.id, name: s.name })}>
                        <Users /> Clients
                      </Button>
                      {s.status === 'ACTIVE' ? (
                        <Button size="sm" variant="outline" onClick={() => setPauseTarget({ id: s.id, name: s.name })}>
                          <PauseCircle /> Pause
                        </Button>
                      ) : null}
                      {s.status !== 'ARCHIVED' ? (
                        <>
                          <Button size="sm" variant="ghost" title="Move to another master" onClick={() => setMoveTarget({ id: s.id, name: s.name, masterUserId: s.masterUserId })}>
                            <ArrowLeftRight /> Master
                          </Button>
                          <Button size="sm" variant="ghost" className="text-destructive" title="Remove strategy" onClick={() => setRemoveTarget({ id: s.id, name: s.name })}>
                            <Trash2 /> Remove
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {q.data ? <Pagination page={list.page} pageSize={list.pageSize} total={q.data.total} onPage={list.setPage} /> : null}
      </Card>
      <FollowersDialog strategy={followersOf} onClose={() => setFollowersOf(null)} />
      <AssignClientDialog strategy={assignTo} scope="admin" open={assignTo !== null} onOpenChange={(o) => !o && setAssignTo(null)} />
      <AllocateDialog open={allocOpen || moveTarget !== null} move={moveTarget} onClose={() => (setAllocOpen(false), setMoveTarget(null))} />
      <ReasonDialog
        open={removeTarget !== null}
        onOpenChange={(o) => !o && setRemoveTarget(null)}
        title={`Remove ${removeTarget?.name ?? ''}?`}
        description="The strategy is archived and auto trading stops for every client on it. Trade history is kept."
        confirmLabel="Remove strategy"
        pending={remove.isPending}
        onConfirm={(reason) =>
          removeTarget &&
          remove.mutate(
            { id: removeTarget.id, body: { reason } },
            { onSuccess: () => (toast.success('Strategy removed'), setRemoveTarget(null)), onError: (e) => toast.error(e.message) },
          )
        }
      />
      <ReasonDialog
        open={pauseTarget !== null}
        onOpenChange={(o) => !o && setPauseTarget(null)}
        title={`Pause ${pauseTarget?.name ?? ''}?`}
        description="Followers stop receiving copies of this master's trades until the master restarts the strategy."
        confirmLabel="Pause strategy"
        pending={pause.isPending}
        onConfirm={(reason) =>
          pauseTarget &&
          pause.mutate(
            { id: pauseTarget.id, body: { reason } },
            { onSuccess: () => (toast.success('Strategy paused'), setPauseTarget(null)), onError: (e) => toast.error(e.message) },
          )
        }
      />
    </>
  );
}
