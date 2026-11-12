'use client';

import { useState } from 'react';
import { Copy, Power, RefreshCw, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import type { StrategyView } from '@ctp/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useStrategyWebhook, useWebhookChange } from '@/lib/trading';

/** Ready-to-paste TradingView alert messages. {{close}} is TradingView's chart price (used for ATM). */
const EXAMPLES: { title: string; json: string }[] = [
  { title: 'Buy ATM call (nearest expiry, 1 lot, SL / target in points)', json: '{"action":"BUY","underlying":"NIFTY","option":"CE","strike":"ATM","lots":1,"spot":{{close}},"stoplossPoints":15,"targetPoints":30}' },
  { title: 'Buy ATM put', json: '{"action":"BUY","underlying":"NIFTY","option":"PE","strike":"ATM","lots":1,"spot":{{close}}}' },
  { title: 'Exit all NIFTY trades of this strategy', json: '{"action":"EXIT","underlying":"NIFTY"}' },
  { title: 'TradingView strategy (buy / sell from the strategy)', json: '{"action":"{{strategy.order.action}}","underlying":"NIFTY","option":"FUT","lots":1}' },
  { title: 'Exact contract', json: '{"action":"SELL","symbol":"NIFTY17NOV2625250CE","lots":2}' },
  { title: 'Square off everything in this strategy', json: '{"action":"EXIT_ALL"}' },
];

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error('Could not copy — select and copy it manually');
  }
}

export function WebhookCard({ strategy }: { strategy: StrategyView }) {
  const q = useStrategyWebhook(strategy.id);
  const change = useWebhookChange(strategy.id);
  const [showHelp, setShowHelp] = useState(false);
  // Sub-admins can't see the secret URL: hide the card for them.
  if (q.error instanceof ApiError && q.error.status === 403) return null;
  const info = q.data;

  const run = (op: 'rotate' | 'disable') =>
    change.mutate(op, {
      onSuccess: () => toast.success(op === 'disable' ? 'Webhook turned off' : info?.enabled ? 'New webhook URL — update it in TradingView' : 'Webhook on'),
      onError: (e) => toast.error((e as Error).message),
    });

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Webhook className="size-4" /> TradingView webhook · {strategy.name}
              {info ? <Badge variant={info.enabled ? 'success' : 'secondary'}>{info.enabled ? 'On' : 'Off'}</Badge> : null}
            </CardTitle>
            <CardDescription>
              A TradingView alert posted to this URL places the trade in this strategy automatically and copies it to every client — same as Place trade.
              {strategy.status !== 'ACTIVE' ? ' The strategy must be active for alerts to trade.' : ''}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            {info?.enabled ? (
              <>
                <Button size="sm" variant="outline" disabled={change.isPending} onClick={() => confirm('Make a new URL? The old URL stops working — update your TradingView alerts.') && run('rotate')}>
                  <RefreshCw /> New URL
                </Button>
                <Button size="sm" variant="outline" disabled={change.isPending} onClick={() => run('disable')}>
                  <Power /> Turn off
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={change.isPending || q.isLoading} onClick={() => run('rotate')}>
                <Power /> Turn on
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {info?.enabled && info.url ? (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Webhook URL (keep it secret — anyone with it can trade this strategy)</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 text-xs">{info.url}</code>
              <Button size="sm" variant="outline" onClick={() => void copy(info.url!, 'URL')}>
                <Copy /> Copy
              </Button>
            </div>
          </div>
        ) : null}

        <div>
          <Button size="sm" variant="link" className="px-0" onClick={() => setShowHelp((v) => !v)}>
            {showHelp ? 'Hide' : 'Show'} alert message examples
          </Button>
          {showHelp ? (
            <div className="mt-2 space-y-3 text-sm">
              <p className="text-muted-foreground">
                In TradingView: Create alert → Notifications → Webhook URL = the URL above; Message = one of these. Fields: action (BUY / SELL / EXIT / EXIT_ALL),
                underlying + option (CE / PE / FUT) + strike (ATM, ATM+1, ATM-2 or a number) + expiry (nearest, next, monthly, YYYY-MM-DD) — or an exact symbol;
                lots or qty; product (INTRADAY / DELIVERY / CARRY_FORWARD); optional target / stoploss (price) or targetPoints / stoplossPoints.
              </p>
              {EXAMPLES.map((e) => (
                <div key={e.title} className="space-y-1">
                  <div className="text-xs font-medium">{e.title}</div>
                  <div className="flex items-start gap-2">
                    <code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 px-2 py-1.5 text-xs">{e.json}</code>
                    <Button size="icon" variant="ghost" aria-label="Copy" onClick={() => void copy(e.json, 'Message')}>
                      <Copy />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        {info?.recent.length ? (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Last alerts</div>
            <ul className="divide-y rounded-md border text-sm">
              {info.recent.map((r) => (
                <li key={`${r.at}-${r.message}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <Badge variant={r.ok ? 'success' : 'destructive'}>{r.ok ? 'OK' : 'Failed'}</Badge>
                  <span className="text-xs text-muted-foreground">{formatDateTime(r.at)}</span>
                  <span className="min-w-0 flex-1">{r.message}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : info?.enabled ? (
          <p className="text-sm text-muted-foreground">No alerts received yet.</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
