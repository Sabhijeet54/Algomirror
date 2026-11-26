'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { LogOut, Pause, Pencil, Play, Plus, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import type { StrategyView } from '@ctp/types';
import { AssignClientDialog } from '@/components/assign-client-dialog';
import { ExitButton, LiveAccountCard, PaperPositionsCard, Pnl } from '@/components/live-account';
import { StatusBadge } from '@/components/status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { brokerLabel, formatDateTime, formatINR, humanize } from '@/lib/format';
import {
  type StrategyInput,
  useRemoveClient,
  useMasterLive,
  useMasterTrade,
  useMasterTrades,
  useSaveStrategy,
  useStrategyFollowers,
  useStrategyStatus,
  useExitStrategy,
} from '@/lib/trading';

/** Building blocks of the master workspace pages (/master/*). */

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD'];
const optNum = (v: string) => (v.trim() === '' ? undefined : Number(v));

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ---------------------------------------------------------------- strategy form
export function StrategyDialog({ open, onOpenChange, strategy }: { open: boolean; onOpenChange: (o: boolean) => void; strategy?: StrategyView | null }) {
  const save = useSaveStrategy();
  const [f, setF] = useState({ name: '', description: '', riskLevel: 'MEDIUM', exchanges: [] as string[], instruments: '', masterCapital: '', maxFollowers: '', maxOrderValue: '', maxQty: '' });
  useEffect(() => {
    if (!open) return;
    const s = strategy;
    setF({
      name: s?.name ?? '',
      description: s?.description ?? '',
      riskLevel: s?.riskLevel ?? 'MEDIUM',
      exchanges: s?.allowedExchanges ?? ['NSE'],
      instruments: (s?.allowedInstruments ?? []).join(', '),
      masterCapital: s ? String(Number(s.masterCapital)) : '',
      maxFollowers: s?.maxFollowers ? String(s.maxFollowers) : '',
      maxOrderValue: '',
      maxQty: '',
    });
  }, [open, strategy]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{strategy ? 'Edit strategy' : 'New strategy'}</DialogTitle>
          <DialogDescription>Clients follow a strategy and every trade you place in it is placed for them.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const body: StrategyInput = {
              name: f.name,
              description: f.description || undefined,
              riskLevel: f.riskLevel as StrategyInput['riskLevel'],
              allowedExchanges: f.exchanges,
              allowedInstruments: f.instruments.split(',').map((x) => x.trim()).filter(Boolean),
              masterCapital: Number(f.masterCapital || 0),
              maxFollowers: optNum(f.maxFollowers),
              maxOrderValue: optNum(f.maxOrderValue),
              maxQuantityPerOrder: optNum(f.maxQty),
            };
            save.mutate(
              { id: strategy?.id, body },
              { onSuccess: () => (toast.success('Strategy saved'), onOpenChange(false)), onError: (err) => toast.error(err.message) },
            );
          }}
        >
          <Field label="Name">
            <Input value={f.name} onChange={set('name')} required minLength={2} />
          </Field>
          <Field label="Description">
            <Textarea value={f.description} onChange={set('description')} rows={2} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Risk level">
              <Select value={f.riskLevel} onChange={set('riskLevel')}>
                <option value="LOW">Low</option>
                <option value="MEDIUM">Medium</option>
                <option value="HIGH">High</option>
              </Select>
            </Field>
            <Field label="Your capital (₹)" hint="Basis for proportional allocation">
              <Input type="number" min={0} value={f.masterCapital} onChange={set('masterCapital')} required />
            </Field>
          </div>
          <Field label="Allowed exchanges">
            <div className="flex flex-wrap gap-2">
              {EXCHANGES.map((x) => {
                const on = f.exchanges.includes(x);
                return (
                  <Button
                    key={x}
                    type="button"
                    size="sm"
                    variant={on ? 'default' : 'outline'}
                    onClick={() => setF((p) => ({ ...p, exchanges: on ? p.exchanges.filter((y) => y !== x) : [...p.exchanges, x] }))}
                  >
                    {x}
                  </Button>
                );
              })}
            </div>
          </Field>
          <Field label="Allowed symbols (optional)" hint="Comma separated, * as wildcard — e.g. NIFTY*, BANKNIFTY*, RELIANCE">
            <Input value={f.instruments} onChange={set('instruments')} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Max clients">
              <Input type="number" min={1} value={f.maxFollowers} onChange={set('maxFollowers')} />
            </Field>
            <Field label="Max order value ₹">
              <Input type="number" min={0} value={f.maxOrderValue} onChange={set('maxOrderValue')} />
            </Field>
            <Field label="Max qty / order">
              <Input type="number" min={1} value={f.maxQty} onChange={set('maxQty')} />
            </Field>
          </div>
          <DialogFooter>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- followers
export function FollowersCard({ strategy }: { strategy: StrategyView }) {
  const q = useStrategyFollowers(strategy.id);
  const remove = useRemoveClient(strategy.id);
  const [assignOpen, setAssignOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>Clients · {strategy.name}</CardTitle>
            <CardDescription>Who follows this strategy, their broker status and allocation.</CardDescription>
          </div>
          <Button size="sm" onClick={() => setAssignOpen(true)}>
            <Plus /> Assign client
          </Button>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead>Broker</TableHead>
              <TableHead>Allocation</TableHead>
              <TableHead>Auto-trading</TableHead>
              <TableHead className="text-right">Paper P&amp;L</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-6 text-center text-sm text-muted-foreground">
                  {q.isLoading ? 'Loading…' : 'No clients yet'}
                </TableCell>
              </TableRow>
            ) : (
              q.data!.map((f) => (
                <TableRow key={f.id}>
                  <TableCell>
                    <div className="font-medium">{f.followerName}</div>
                    <div className="text-xs text-muted-foreground">{f.followerEmail}</div>
                  </TableCell>
                  <TableCell>
                    {f.brokerAccount ? (
                      <div className="flex flex-col gap-1">
                        <span>
                          {brokerLabel(f.brokerAccount.broker)} <span className="text-xs text-muted-foreground">{f.brokerAccount.brokerClientId}</span>
                        </span>
                        <StatusBadge value={f.brokerAccount.tokenStatus === 'ACTIVE' ? 'CONNECTED' : f.brokerAccount.status} />
                      </div>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="text-sm">
                    {f.allocationMode === 'FIXED_QUANTITY'
                      ? f.fixedLots
                        ? `${f.fixedLots} lot(s)`
                        : `${f.fixedQuantity} qty`
                      : f.allocationMode === 'CAPITAL_PERCENTAGE'
                        ? `${+(Number(f.allocationPercent) / 100).toFixed(2)}× lots`
                        : `${formatINR(f.allocationAmount)} capital`}
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={f.copyStatus} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Pnl value={Number(f.paperRealizedPnl) + Number(f.paperUnrealizedPnl)} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button asChild size="sm" variant="outline" className="h-7 px-2 text-xs">
                        <Link href={`/master/client?id=${f.followerUserId}`}>View client</Link>
                      </Button>
                      {f.copyStatus !== 'OFF' ? (
                        <ExitButton
                          label="Remove"
                          pending={remove.isPending && remove.variables === f.id}
                          onConfirm={() =>
                            remove.mutate(f.id, {
                              onSuccess: () => toast.success(`${f.followerName ?? 'Client'} removed — auto-trading stopped`),
                              onError: (err) => toast.error(err.message),
                            })
                          }
                        />
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
      <AssignClientDialog strategy={strategy} scope="master" open={assignOpen} onOpenChange={setAssignOpen} />
    </Card>
  );
}

// ---------------------------------------------------------------- trades
function TradeDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const q = useMasterTrade(id);
  const t = q.data;
  return (
    <Dialog open={!!id} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t ? `${t.side} ${t.quantity} ${t.symbol}` : 'Trade'}</DialogTitle>
          <DialogDescription>{t ? `${t.exchange} · ${humanize(t.productType)} · ${formatDateTime(t.eventTimestamp)}` : ''}</DialogDescription>
        </DialogHeader>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Client</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Avg</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Note</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(t?.copyOrders ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  No clients were auto-trading when this trade happened.
                </TableCell>
              </TableRow>
            ) : (
              t!.copyOrders.map((c) => (
                <TableRow key={c.id}>
                  <TableCell>{c.followerName}</TableCell>
                  <TableCell className="text-right tabular-nums">{c.quantity}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(c.averagePrice)}</TableCell>
                  <TableCell>
                    <StatusBadge value={c.status} />
                  </TableCell>
                  <TableCell className="max-w-56 truncate text-xs text-muted-foreground" title={c.errorMessage ?? ''}>
                    {c.errorMessage ?? (c.brokerOrderId ? `Order ${c.brokerOrderId}` : '')}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </DialogContent>
    </Dialog>
  );
}

export function TradesCard() {
  const q = useMasterTrades();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Order log</CardTitle>
        <CardDescription>Today&apos;s entries and exits (placed here, auto TP/SL, or detected in your broker app) and how each was placed for every client. Older orders are in Trade history.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Time</TableHead>
              <TableHead>Trade</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Placed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(q.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  {q.isLoading ? 'Loading…' : 'No orders today'}
                </TableCell>
              </TableRow>
            ) : (
              q.data!.map((t) => {
                const c = t.copyStatusCounts;
                const ok = (c.FILLED ?? 0) + (c.SUBMITTED ?? 0);
                const bad = (c.FAILED ?? 0) + (c.REJECTED ?? 0);
                return (
                  <TableRow key={t.id} className="cursor-pointer" onClick={() => setOpen(t.id)}>
                    <TableCell className="whitespace-nowrap text-xs">{formatDateTime(t.eventTimestamp)}</TableCell>
                    <TableCell>
                      <span className={t.side === 'BUY' ? 'text-success' : 'text-destructive'}>{t.side}</span> {t.quantity} <span className="font-medium">{t.symbol}</span>{' '}
                      <span className="text-xs text-muted-foreground">{t.exchange}</span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{formatINR(t.averagePrice ?? t.price)}</TableCell>
                    <TableCell>
                      <StatusBadge value={t.status} />
                    </TableCell>
                    <TableCell className="text-sm">
                      {ok} ok{bad ? <span className="text-destructive"> · {bad} failed</span> : null}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </CardContent>
      <TradeDialog id={open} onClose={() => setOpen(null)} />
    </Card>
  );
}


// ---------------------------------------------------------------- strategies table

export function StrategiesCard({
  list,
  loading,
  selectedId,
  onSelect,
  onEdit,
}: {
  list: StrategyView[];
  loading: boolean;
  selectedId?: string;
  onSelect: (id: string) => void;
  onEdit: (s: StrategyView) => void;
}) {
  const status = useStrategyStatus();
  const exitAll = useExitStrategy();
  const [exitTarget, setExitTarget] = useState<StrategyView | null>(null);
  const [assignTo, setAssignTo] = useState<StrategyView | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Strategies</CardTitle>
        <CardDescription>Start a strategy to trade it; pause to stop trading for all its clients. Click a row to see its clients.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Clients</TableHead>
              <TableHead className="text-right">Capital</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-sm text-muted-foreground">
                  {loading ? 'Loading…' : 'No strategies yet — create your first one.'}
                </TableCell>
              </TableRow>
            ) : (
              list.map((s) => (
                <TableRow key={s.id} data-state={selectedId === s.id ? 'selected' : undefined} className="cursor-pointer" onClick={() => onSelect(s.id)}>
                  <TableCell>
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {humanize(s.riskLevel)} risk · {s.allowedExchanges.join(', ') || 'All exchanges'}
                    </div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={s.status} />
                  </TableCell>
                  <TableCell>
                    {s.activeFollowerCount ?? 0} active / {s.followerCount ?? 0}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(s.masterCapital)}</TableCell>
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <div className="flex justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => setAssignTo(s)}>
                        <UserPlus /> Assign client
                      </Button>
                      <Button size="sm" variant="ghost" title="Clients" onClick={() => onSelect(s.id)}>
                        <Users />
                      </Button>
                      <Button size="sm" variant="ghost" title="Edit" onClick={() => onEdit(s)}>
                        <Pencil />
                      </Button>
                      <Button size="sm" variant="ghost" title="Exit all client positions" onClick={() => setExitTarget(s)}>
                        <LogOut />
                      </Button>
                      {s.status === 'ACTIVE' ? (
                        <Button size="sm" variant="outline" disabled={status.isPending} onClick={() => status.mutate({ id: s.id, status: 'PAUSED' }, { onError: (e) => toast.error(e.message) })}>
                          <Pause /> Pause
                        </Button>
                      ) : (
                        <Button size="sm" disabled={status.isPending} onClick={() => status.mutate({ id: s.id, status: 'ACTIVE' }, { onError: (e) => toast.error(e.message) })}>
                          <Play /> Start
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
      <AssignClientDialog strategy={assignTo} scope="master" open={assignTo !== null} onOpenChange={(o) => !o && setAssignTo(null)} />
      <Dialog open={!!exitTarget} onOpenChange={(o) => !o && setExitTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Exit strategy · {exitTarget?.name}?</DialogTitle>
            <DialogDescription>
              Squares off every OPEN signal of this strategy (moves them to Closed history) and places MARKET exits for any copy position still open in
              client accounts.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setExitTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={exitAll.isPending}
              onClick={() =>
                exitTarget &&
                exitAll.mutate(exitTarget.id, {
                  onSuccess: (r) => (
                    toast.success(`${r.signalsClosed ?? 0} signal(s) closed · ${r.orders} extra exit order(s)${r.failed ? ` · ${r.failed} failed` : ''}`),
                    setExitTarget(null)
                  ),
                  onError: (e) => toast.error(e.message),
                })
              }
            >
              {exitAll.isPending ? 'Exiting…' : 'Exit all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------- my account

export function PaperModeNotice() {
  const live = useMasterLive();
  if (!live.data?.paperMode) return null;
  return (
    <p className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
      <strong>Paper mode is ON</strong> — no real orders are sent to any broker. Trades are simulated at the given/live price.
    </p>
  );
}

/** Master's own broker data + virtual signal book. */
export function MyAccountSection() {
  const live = useMasterLive();
  return (
    <div className="grid gap-4">
      {live.isLoading ? <p className="text-sm text-muted-foreground">Loading live data…</p> : null}
      {live.data && live.data.live.length === 0 && live.data.paperPositions.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Connect Angel One on the{' '}
          <Link href="/broker" className="underline">
            Broker accounts
          </Link>{' '}
          page to see live data.
        </p>
      ) : null}
      {live.data && live.data.paperPositions.length > 0 ? <PaperPositionsCard rows={live.data.paperPositions} title="My signal book (virtual)" canExit signalBook /> : null}
      {live.data?.live.map((a) => <LiveAccountCard key={a.accountId} a={a} />)}
    </div>
  );
}
