'use client';

import { useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { brokerLabel } from '@/lib/format';
import { type ApiLogRow, useApiLog } from '@/lib/trading';
import { cn } from '@/lib/utils';

const EXEC_STYLE: Record<ApiLogRow['execution'], string> = {
  success: 'bg-emerald-600 text-white',
  error: 'bg-red-600 text-white',
  pending: 'bg-amber-400 text-black',
  paper: 'bg-muted text-muted-foreground',
  skipped: 'bg-slate-500 text-white',
};

const fmt = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

const todayIst = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);

/**
 * API log: every broker call for my account — order placement / exit for each strategy trade and broker
 * login / session events — with the broker's answer. This is where to check whether a trade reached the demat.
 */
export default function ApiLogPage() {
  const [execution, setExecution] = useState('any');
  const [type, setType] = useState('any');
  const [q, setQ] = useState('');
  const [date, setDate] = useState(todayIst());
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<ApiLogRow | null>(null);
  const log = useApiLog({ execution, type, q: q || undefined, page, date });
  const d = log.data;
  const pages = d ? Math.max(1, Math.ceil(d.total / d.pageSize)) : 1;
  const reset = <T,>(set: (v: T) => void) => (v: T) => (set(v), setPage(1));

  return (
    <>
      <PageHeader title="API log" description="Every order the software sent to your broker for a strategy trade (and broker logins) with the broker's response — check here whether a trade reached your demat." />
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3 space-y-0">
          <CardTitle className="text-base">API log</CardTitle>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-primary">{d?.date === todayIst() ? `Today (${d.date})` : (d?.date ?? date)}</span> · {d ? `${d.total} entr${d.total === 1 ? 'y' : 'ies'}` : '…'}
          </p>
        </CardHeader>
        <CardContent className="grid gap-4 [&>*]:min-w-0">
          <div className="grid gap-3 sm:grid-cols-[repeat(3,minmax(0,12rem))_1fr]">
            <div className="grid gap-1.5">
              <Label htmlFor="al-date">Date</Label>
              <Input id="al-date" type="date" value={date} max={todayIst()} onChange={(e) => reset(setDate)(e.target.value || todayIst())} />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="al-exec">Execution</Label>
              <Select id="al-exec" value={execution} onChange={(e) => reset(setExecution)(e.target.value)}>
                <option value="any">Any</option>
                <option value="success">Success</option>
                <option value="error">Error</option>
                <option value="pending">Pending</option>
                <option value="skipped">Not sent</option>
                <option value="paper">Paper</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="al-type">Signal type</Label>
              <Select id="al-type" value={type} onChange={(e) => reset(setType)(e.target.value)}>
                <option value="any">Any</option>
                <option value="ENTRY">Entry</option>
                <option value="EXIT">Exit</option>
                <option value="LOGIN">Broker login</option>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="al-q">Global search</Label>
              <Input id="al-q" placeholder="Broker, symbol, error text, order id…" value={q} onChange={(e) => reset(setQ)(e.target.value)} />
            </div>
          </div>

          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Username</TableHead>
                  <TableHead>Broker</TableHead>
                  <TableHead>Login ID</TableHead>
                  <TableHead>Strategy</TableHead>
                  <TableHead>Signal</TableHead>
                  <TableHead>Execution</TableHead>
                  <TableHead>API response</TableHead>
                  <TableHead>Created at</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {!d?.items.length ? (
                  <TableRow>
                    <TableCell colSpan={8} className="py-8 text-center text-sm text-muted-foreground">
                      {log.isLoading ? 'Loading…' : 'No API calls for this day'}
                    </TableCell>
                  </TableRow>
                ) : (
                  d.items.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="whitespace-nowrap">
                        <span className="font-medium">{r.userName}</span>
                        <div className="text-[11px] text-muted-foreground">{r.email}</div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">{r.broker === 'PAPER' ? 'Paper (no broker)' : brokerLabel(r.broker)}</TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">{r.loginId ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap">{r.strategy ?? '—'}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">
                        {r.type === 'LOGIN' ? (
                          'Broker login'
                        ) : (
                          <>
                            <span className={r.side === 'BUY' ? 'text-success' : 'text-destructive'}>{r.side}</span> {r.quantity} {r.symbol}
                            <span className="block text-muted-foreground">{r.type === 'EXIT' ? 'Exit' : 'Entry'}</span>
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-semibold', EXEC_STYLE[r.execution])}>{r.execution === 'skipped' ? 'not sent' : r.execution}</span>
                      </TableCell>
                      <TableCell>
                        <Button size="sm" onClick={() => setOpen(r)}>
                          View response
                        </Button>
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{fmt(r.at)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Page {page} of {pages}
            </span>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>API response</DialogTitle>
            <DialogDescription>
              {open ? `${open.broker === 'PAPER' ? 'Paper' : brokerLabel(open.broker)} · ${fmt(open.at)}` : ''}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60dvh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-xs">{open ? JSON.stringify(open.response, null, 2) : ''}</pre>
        </DialogContent>
      </Dialog>
    </>
  );
}
