'use client';

import { Pnl } from '@/components/live-account';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatINR, humanize } from '@/lib/format';
import { useMySignals } from '@/lib/trading';
import { cn } from '@/lib/utils';

const fmtTime = (iso: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso));

/**
 * Algo signals: every strategy trade booked for the client today in the SOFTWARE (entry / exit at the
 * strategy's prices, open / closed, P&L) — shown whether or not the order reached the demat.
 * Whether it really reached the demat is in the API log.
 */
export function AlgoSignalsCard({ compact = false }: { compact?: boolean }) {
  const q = useMySignals();
  const rows = q.data?.rows ?? [];
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Algo signals</CardTitle>
        <CardDescription>
          Total P&amp;L:{' '}
          <span className="text-base font-semibold">
            <Pnl value={q.data?.totalPnl ?? 0} />
          </span>
          {!compact ? <span className="ml-2 text-xs">· booked in the software — check API log to see if each order reached your demat</span> : null}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 [&>*]:min-w-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>S.No</TableHead>
                <TableHead>Algo name</TableHead>
                <TableHead>Script</TableHead>
                <TableHead>Side</TableHead>
                <TableHead>Entry time</TableHead>
                <TableHead className="text-right">Entry price</TableHead>
                <TableHead>Exit time</TableHead>
                <TableHead className="text-right">Exit price</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">P&amp;L</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} className="py-8 text-center text-sm text-muted-foreground">
                    {q.isLoading ? 'Loading…' : 'No signals today'}
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((r, i) => (
                  <TableRow key={r.tradeId}>
                    <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                    <TableCell className="whitespace-nowrap font-semibold">
                      {r.strategyName}
                      {r.mode === 'PAPER' ? <span className="ml-1 rounded bg-amber-400 px-1 text-[10px] font-semibold text-black">Paper</span> : null}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <span className="font-medium">{r.symbol}</span>
                      <div className="text-[11px] text-muted-foreground">
                        {r.exchange} · {humanize(r.productType)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={cn('rounded px-1.5 py-0.5 text-xs font-semibold text-white', r.side === 'BUY' ? 'bg-emerald-600' : 'bg-red-600')}>{r.side === 'BUY' ? 'Buy' : 'Sell'}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{fmtTime(r.entryAt)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatINR(r.entryPrice)}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs">{r.exitAt ? fmtTime(r.exitAt) : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.exitPrice != null ? formatINR(r.exitPrice) : r.ltp != null ? <span className="text-muted-foreground">LTP {formatINR(r.ltp)}</span> : '—'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right tabular-nums">
                      {r.quantity}
                      {r.lots != null ? <span className="text-xs text-muted-foreground"> · {r.lots} lot{r.lots === 1 ? '' : 's'}</span> : null}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <Pnl value={r.pnl} />
                    </TableCell>
                    <TableCell>
                      <span className={cn('rounded px-1.5 py-0.5 text-xs font-semibold', r.status === 'OPEN' ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200' : 'bg-primary text-primary-foreground')}>
                        {r.status === 'OPEN' ? 'Open' : 'Closed'}
                      </span>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <p>
            THIS SIGNAL DATA IS FOR TODAY ONLY. IT DOES NOT, DIRECTLY OR INDIRECTLY, INDICATE ANY PAST OR EXPECTED FUTURE RETURNS OR PERFORMANCE OF THE
            ALGORITHM.
          </p>
          <p className="mt-1">
            यह सिग्नल डेटा केवल आज के लिए है। यह एल्गोरिदम के पिछले या भविष्य के रिटर्न / प्रदर्शन का कोई संकेत नहीं देता। प्रतिभूति बाज़ार में निवेश
            जोखिम के अधीन है।
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
