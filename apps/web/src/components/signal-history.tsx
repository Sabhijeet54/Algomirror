'use client';

import { Download, Pencil, RefreshCw, RotateCcw, Target, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ExitButton, Pnl } from '@/components/live-account';
import { PageHeader } from '@/components/page-header';
import { REASON, TpSlDialog } from '@/components/signal-desk';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatINR, humanize } from '@/lib/format';
import { useAdminStrategies } from '@/lib/queries';
import { useMasterStrategies } from '@/lib/trading';
import { type AdminSignalRow, type SignalRow, useAdminSignalMutations, useAdminSignals, useLtps, useSquareOffSignal } from '@/lib/trading';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

const istDate = (offsetDays = 0) => new Date(Date.now() + 330 * 60_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);
const fmtDate = (iso: string) => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso));
const fmtTime = (iso: string) => new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

type Row = AdminSignalRow & { liveLtp: number | null; pnl: number };

const DERIVATIVE_EXCHANGES = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD']);
/** Index / stock a trade is on: NIFTY17NOV2625200CE → NIFTY, BANKNIFTY25NOVFUT → BANKNIFTY, RELIANCE-EQ → RELIANCE. */
export function underlyingOf(exchange: string, symbol: string): string {
  const sym = symbol.toUpperCase();
  if (DERIVATIVE_EXCHANGES.has(exchange.toUpperCase())) {
    const m = /^([A-Z&-]+?)\d{2}[A-Z]{3}/.exec(sym);
    if (m) return m[1]!;
  }
  return sym.replace(/-(EQ|BE)$/, '');
}

/** Excel opens UTF-8 CSV with a BOM directly (₹ and names stay intact). */
function exportCsv(rows: Row[], multiplier: number) {
  const head = ['Strategy', 'Master', 'Script', 'Exchange', 'Execution date', 'Side', 'Quantity', 'Entry', 'Entry time', 'Exit', 'Exit time', 'Exit reason', 'Target', 'Stop loss', 'Status', 'LTP', 'PNL'];
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      r.strategyName,
      r.masterName,
      r.symbol,
      r.exchange,
      fmtDate(r.entryAt),
      r.side,
      r.quantity * multiplier,
      r.entryPrice,
      fmtTime(r.entryAt),
      r.exitPrice,
      r.exitAt ? fmtTime(r.exitAt) : '',
      r.exitReason ? (REASON[r.exitReason] ?? r.exitReason) : '',
      r.targetPrice,
      r.stopLossPrice,
      r.status,
      r.liveLtp,
      (r.pnl * multiplier).toFixed(2),
    ]
      .map(esc)
      .join(','),
  );
  const blob = new Blob(['﻿' + [head.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `signals-${istDate()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function EditSignalDialog({ row, onClose, scope }: { row: Row | null; onClose: () => void; scope: 'admin' | 'master' }) {
  const { edit } = useAdminSignalMutations(scope);
  const [f, setF] = useState({ entry: '', exit: '', qty: '' });
  useEffect(() => {
    if (row) setF({ entry: row.entryPrice != null ? String(row.entryPrice) : '', exit: row.exitPrice != null ? String(row.exitPrice) : '', qty: String(row.quantity) });
  }, [row]);
  const num = (v: string) => (v.trim() === '' ? undefined : Number(v));
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Edit trade</DialogTitle>
          <DialogDescription>
            {row ? `${row.strategyName ?? ''} · ${row.side} ${row.symbol}` : ''} — corrects this trade in history and recalculates its P&amp;L. Client orders are not changed.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-3">
          <div className="grid gap-1.5">
            <Label htmlFor="es-qty">Quantity</Label>
            <Input id="es-qty" type="number" min={1} value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="es-entry">Entry ₹</Label>
            <Input id="es-entry" type="number" min={0} step="0.05" value={f.entry} onChange={(e) => setF({ ...f, entry: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="es-exit">Exit ₹</Label>
            <Input id="es-exit" type="number" min={0} step="0.05" disabled={row?.exitPrice == null} value={f.exit} onChange={(e) => setF({ ...f, exit: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={edit.isPending}
            onClick={() =>
              row &&
              edit.mutate(
                {
                  id: row.id,
                  entryPrice: num(f.entry),
                  exitPrice: row.exitPrice != null ? num(f.exit) : undefined,
                  quantity: num(f.qty) !== row.quantity ? num(f.qty) : undefined,
                },
                { onSuccess: () => (toast.success('Trade updated'), onClose()), onError: (e) => toast.error(e.message) },
              )
            }
          >
            {edit.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Past performance per strategy for the filtered period. */
function PerformanceCard({ rows, mult }: { rows: Row[]; mult: number }) {
  const by = new Map<string, { name: string; trades: number; closed: number; wins: number; pnl: number; best: number; worst: number }>();
  for (const r of rows) {
    const k = r.strategyId ?? 'none';
    const cur = by.get(k) ?? { name: r.strategyName ?? '—', trades: 0, closed: 0, wins: 0, pnl: 0, best: -Infinity, worst: Infinity };
    const pnl = r.pnl * mult;
    cur.trades += 1;
    cur.pnl += pnl;
    if (r.status === 'CLOSED') {
      cur.closed += 1;
      if (pnl > 0) cur.wins += 1;
      cur.best = Math.max(cur.best, pnl);
      cur.worst = Math.min(cur.worst, pnl);
    }
    by.set(k, cur);
  }
  const list = [...by.values()].sort((a, b) => b.pnl - a.pnl);
  if (!list.length) return null;
  return (
    <Card>
      <CardContent className="overflow-x-auto pt-6">
        <h2 className="mb-3 text-base font-semibold">Strategy performance (selected period)</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Strategy</TableHead>
              <TableHead className="text-right">Trades</TableHead>
              <TableHead className="text-right">Win rate</TableHead>
              <TableHead className="text-right">Best</TableHead>
              <TableHead className="text-right">Worst</TableHead>
              <TableHead className="text-right">Total P&amp;L</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((x) => (
              <TableRow key={x.name}>
                <TableCell className="font-medium">{x.name}</TableCell>
                <TableCell className="text-right tabular-nums">{x.trades}</TableCell>
                <TableCell className="text-right tabular-nums">{x.closed ? `${Math.round((x.wins / x.closed) * 100)}% (${x.wins}/${x.closed})` : '—'}</TableCell>
                <TableCell className="text-right">{x.closed ? <Pnl value={x.best} /> : '—'}</TableCell>
                <TableCell className="text-right">{x.closed ? <Pnl value={x.worst} /> : '—'}</TableCell>
                <TableCell className="text-right font-semibold">
                  <Pnl value={x.pnl} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

export function SignalHistory({ scope }: { scope: 'admin' | 'master' }) {
  const defaults = { from: istDate(), to: istDate(), strategyIds: [] as string[], status: 'all' as 'all' | 'open' | 'closed' };
  const [draft, setDraft] = useState(defaults);
  const [applied, setApplied] = useState(defaults);
  const [multiplier, setMultiplier] = useState('1');
  /** Index / stock filter, applied on the loaded trades (options come from what was actually traded). */
  const [underlying, setUnderlying] = useState('all');
  const [tpslRow, setTpslRow] = useState<SignalRow | null>(null);
  const [editRow, setEditRow] = useState<Row | null>(null);
  const [deleteRow, setDeleteRow] = useState<Row | null>(null);
  const { remove } = useAdminSignalMutations(scope);
  const adminStrategies = useAdminStrategies({ page: 1, pageSize: 100 }, { enabled: scope === 'admin' });
  const masterStrategies = useMasterStrategies(scope === 'master');
  const strategies = { data: scope === 'admin' ? adminStrategies.data : masterStrategies.data ? { items: masterStrategies.data } : undefined };
  const q = useAdminSignals(applied, scope);
  const squareOff = useSquareOffSignal(scope);

  const rows = q.data ?? [];
  const openKeys = useMemo(() => rows.filter((r) => r.status === 'OPEN').map((r) => `${r.exchange}:${r.symbol}`), [rows]);
  const ltps = useLtps(openKeys).data;
  const mult = Number(multiplier) > 0 ? Number(multiplier) : 1;

  const underlyings = useMemo(() => [...new Set(rows.map((r) => underlyingOf(r.exchange, r.symbol)))].sort(), [rows]);
  const shown = underlying === 'all' ? rows : rows.filter((r) => underlyingOf(r.exchange, r.symbol) === underlying);
  const view: Row[] = shown.map((r) => {
    const ltp = r.status === 'OPEN' ? (ltps?.[`${r.exchange}:${r.symbol}`.toUpperCase()]?.ltp ?? r.ltp) : null;
    const dir = r.side === 'BUY' ? 1 : -1;
    const unrealized = r.status === 'OPEN' && ltp != null && r.entryPrice != null ? r.openQuantity * (ltp - r.entryPrice) * dir : 0;
    return { ...r, liveLtp: ltp, pnl: r.realizedPnl + unrealized };
  });
  const total = view.reduce((s, r) => s + r.pnl, 0) * mult;
  const toggleStrategy = (id: string) =>
    setDraft((d) => ({ ...d, strategyIds: d.strategyIds.includes(id) ? d.strategyIds.filter((x) => x !== id) : [...d.strategyIds, id] }));

  return (
    <>
      <PageHeader
        title="Trade history"
        description={scope === 'master' ? 'Your strategies only — filter by date and strategy, edit / delete trades, export to Excel. Open trades stream live LTP.' : "Every trade of every strategy — past performance with entry, exit, target / stop loss and P&L. Open trades stream live LTP."}
        actions={
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <label className="flex items-center gap-2 text-muted-foreground" htmlFor="pnl-mult">
              <span title="Scales quantity and P&L shown (e.g. 2 = results for 2× lots). Display only.">Lot multiplier ×</span>
              <Input id="pnl-mult" className="h-8 w-20" type="number" min={0.01} step="any" value={multiplier} onChange={(e) => setMultiplier(e.target.value)} />
            </label>
            <span>
              Total PNL <span className="text-xs text-muted-foreground">(display only)</span> <strong><Pnl value={total} /></strong>
            </span>
            <span className="rounded-md bg-primary/10 px-2 py-1 font-medium text-primary">{view.length} trades</span>
          </div>
        }
      />
      <Card>
        <CardContent className="grid gap-4 pt-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sig-from">Start date</Label>
              <Input id="sig-from" type="date" value={draft.from} max={draft.to} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sig-to">End date</Label>
              <Input id="sig-to" type="date" value={draft.to} min={draft.from} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sig-status">Status</Label>
              <Select id="sig-status" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as typeof draft.status })} className="w-32">
                <option value="all">All</option>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sig-underlying">Index / stock</Label>
              <Select id="sig-underlying" value={underlying} onChange={(e) => setUnderlying(e.target.value)} className="w-36">
                <option value="all">All</option>
                {underlying !== 'all' && !underlyings.includes(underlying) ? <option value={underlying}>{underlying}</option> : null}
                {underlyings.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            </div>
            <details className="relative">
              <summary className="flex h-9 cursor-pointer list-none items-center rounded-md border px-3 text-sm">
                {draft.strategyIds.length ? `${draft.strategyIds.length} strateg${draft.strategyIds.length > 1 ? 'ies' : 'y'}` : 'All strategies'} ▾
              </summary>
              <div className="absolute z-20 mt-1 max-h-72 w-64 overflow-y-auto rounded-md border bg-card p-2 shadow-lg">
                {(strategies.data?.items ?? []).map((s) => (
                  <label key={s.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                    <input type="checkbox" className="size-4" checked={draft.strategyIds.includes(s.id)} onChange={() => toggleStrategy(s.id)} />
                    {s.name}
                  </label>
                ))}
                {strategies.data?.items.length === 0 ? <p className="px-2 py-1.5 text-sm text-muted-foreground">No strategies</p> : null}
              </div>
            </details>
            <Button onClick={() => setApplied(draft)}>Filter</Button>
            <Button variant="outline" onClick={() => (setDraft(defaults), setApplied(defaults), setUnderlying('all'))}>
              <RotateCcw /> Reset
            </Button>
            <Button variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={cn(q.isFetching && 'animate-spin')} /> Refresh
            </Button>
            <Button variant="outline" className="ml-auto border-emerald-600 text-emerald-700 dark:text-emerald-400" disabled={!view.length} onClick={() => exportCsv(view, mult)}>
              <Download /> Export to Excel
            </Button>
          </div>

          {openKeys.length ? (
            <div className="flex items-center gap-2 rounded-md bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400">
              <span className="rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-bold text-white">LIVE</span> Streaming LTP for open signals
            </div>
          ) : null}

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Strategy</TableHead>
                  <TableHead>Script</TableHead>
                  <TableHead>Execution date</TableHead>
                  <TableHead>Side</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Entry</TableHead>
                  <TableHead>Entry time</TableHead>
                  <TableHead className="text-right">Exit</TableHead>
                  <TableHead>Exit time</TableHead>
                  <TableHead>TP / SL</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">LTP</TableHead>
                  <TableHead className="text-right">PNL</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {view.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={14} className="py-8 text-center text-sm text-muted-foreground">
                      {q.isLoading ? 'Loading…' : q.error ? q.error.message : 'No signals in this period'}
                    </TableCell>
                  </TableRow>
                ) : (
                  view.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap font-medium">
                        {r.strategyName ?? '—'}
                        {r.masterName ? <div className="text-[11px] font-normal text-muted-foreground">{r.masterName}</div> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                        {r.symbol}
                        <div className="font-sans text-[11px]">{r.exchange} · {humanize(r.productType)}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{fmtDate(r.entryAt)}</TableCell>
                      <TableCell className={cn('text-xs font-semibold', r.side === 'BUY' ? 'text-success' : 'text-destructive')}>{r.side}</TableCell>
                      <TableCell className="text-right tabular-nums">{r.quantity * mult}</TableCell>
                      <TableCell className="text-right tabular-nums text-success">{formatINR(r.entryPrice)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{fmtTime(r.entryAt)}</TableCell>
                      <TableCell className="text-right tabular-nums text-destructive">{r.exitPrice != null ? formatINR(r.exitPrice) : 'N/A'}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {r.exitAt ? fmtTime(r.exitAt) : 'N/A'}
                        {r.exitReason ? <div className="text-[11px]">{REASON[r.exitReason] ?? humanize(r.exitReason)}</div> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs tabular-nums">
                        {r.targetPrice != null || r.stopLossPrice != null ? (
                          <>
                            <div className="text-success">T {r.targetPrice != null ? formatINR(r.targetPrice) : '—'}</div>
                            <div className="text-destructive">SL {r.stopLossPrice != null ? formatINR(r.stopLossPrice) : '—'}</div>
                          </>
                        ) : (
                          '—'
                        )}
                      </TableCell>
                      <TableCell className={cn('text-xs font-semibold', r.status === 'OPEN' ? 'text-success' : 'text-primary')}>{r.status === 'OPEN' ? 'OPEN' : 'CLOSE'}</TableCell>
                      <TableCell className="text-right font-medium tabular-nums text-primary">{r.liveLtp != null ? formatINR(r.liveLtp) : '—'}</TableCell>
                      <TableCell className="text-right font-medium">
                        <Pnl value={r.pnl * mult} />
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setEditRow(r)}>
                            <Pencil className="size-3.5" /> Edit
                          </Button>
                          {r.status === 'CLOSED' ? (
                            <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={() => setDeleteRow(r)}>
                              <Trash2 className="size-3.5" /> Delete
                            </Button>
                          ) : null}
                        </div>
                        {r.status === 'OPEN' ? (
                          <div className="mt-1 flex justify-end gap-2">
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setTpslRow(r)}>
                              <Target className="size-3.5" /> TP/SL
                            </Button>
                            <ExitButton
                              label="Square off"
                              pending={squareOff.isPending && squareOff.variables === r.id}
                              onConfirm={() =>
                                squareOff.mutate(r.id, {
                                  onSuccess: (x) => toast.success(`${r.symbol} squared off${x.exitPrice != null ? ` @ ${formatINR(x.exitPrice)}` : ''}`),
                                  onError: (err) => toast.error(err.message),
                                })
                              }
                            />
                          </div>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
      <div className="mt-4">
        <PerformanceCard rows={view} mult={mult} />
      </div>
      <TpSlDialog row={tpslRow} onClose={() => setTpslRow(null)} scope={scope} />
      <EditSignalDialog scope={scope} row={editRow} onClose={() => setEditRow(null)} />
      <Dialog open={!!deleteRow} onOpenChange={(o) => !o && setDeleteRow(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete this trade?</DialogTitle>
            <DialogDescription>
              {deleteRow ? `${deleteRow.strategyName ?? ''} · ${deleteRow.side} ${deleteRow.symbol} (${fmtDate(deleteRow.entryAt)})` : ''} is removed from trade history and
              performance. Client orders are not changed.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteRow(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() =>
                deleteRow &&
                remove.mutate(deleteRow.id, { onSuccess: () => (toast.success('Trade deleted'), setDeleteRow(null)), onError: (e) => toast.error(e.message) })
              }
            >
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
