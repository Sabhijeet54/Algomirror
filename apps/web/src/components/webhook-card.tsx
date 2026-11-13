'use client';

import { useMemo, useState } from 'react';
import { Copy, Power, RefreshCw, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import type { StrategyView } from '@ctp/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api';
import { useFnoScripts, useStrategyWebhook, useWebhookChange, type FnoExchange } from '@/lib/trading';

/** Ready-to-paste TradingView alert messages. {{close}} is TradingView's chart price (used for ATM). */
const EXAMPLES: { title: string; json: string }[] = [
  { title: 'Buy ATM call (nearest expiry, 1 lot, SL / target in points)', json: '{"action":"BUY","underlying":"NIFTY","option":"CE","strike":"ATM","lots":1,"spot":{{close}},"stoplossPoints":15,"targetPoints":30}' },
  { title: 'Buy ATM put', json: '{"action":"BUY","underlying":"NIFTY","option":"PE","strike":"ATM","lots":1,"spot":{{close}}}' },
  { title: 'Exit all NIFTY trades of this strategy', json: '{"action":"EXIT","underlying":"NIFTY"}' },
  { title: 'TradingView strategy (buy / sell from the strategy)', json: '{"action":"{{strategy.order.action}}","underlying":"NIFTY","option":"FUT","lots":1}' },
  { title: 'Exact contract', json: '{"action":"SELL","symbol":"NIFTY17NOV2625250CE","lots":2}' },
  { title: 'Square off everything in this strategy', json: '{"action":"EXIT_ALL"}' },
];

export async function copy(text: string, what: string) {
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
              <Webhook className="size-4" /> TradingView webhook
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

        {info?.enabled ? <AlertBuilder strategy={strategy} /> : <p className="text-sm text-muted-foreground">Turn the webhook on to build the TradingView alert.</p>}

        <div>
          <Button size="sm" variant="link" className="px-0" onClick={() => setShowHelp((v) => !v)}>
            {showHelp ? 'Hide' : 'Show'} more message examples
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
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------ alert builder (spot / index signal → option)

const SEGMENTS: { id: FnoExchange; label: string }[] = [
  { id: 'NFO', label: 'NSE F&O' },
  { id: 'BFO', label: 'BSE F&O' },
  { id: 'MCX', label: 'MCX' },
];
const STRIKES = ['ITM3', 'ITM2', 'ITM1', 'ATM', 'OTM1', 'OTM2', 'OTM3'];

/**
 * Builds the TradingView alert message for this strategy: the signal on the spot / index chart decides the option —
 * BUY → call, SELL → put — and the strike, expiry, lots and target / stop loss come from here.
 */
function AlertBuilder({ strategy }: { strategy: StrategyView }) {
  const [segment, setSegment] = useState<FnoExchange>('NFO');
  const [script, setScript] = useState('NIFTY');
  const [expiry, setExpiry] = useState<'nearest' | 'next' | 'monthly'>('nearest');
  const [strike, setStrike] = useState('ATM');
  const [lots, setLots] = useState(1);
  const [target, setTarget] = useState('');
  const [stoploss, setStoploss] = useState('');
  const [source, setSource] = useState<'strategy' | 'indicator'>('strategy');
  const scripts = useFnoScripts(segment, script);
  const lotSize = scripts.data?.find((s) => s.name === script.trim().toUpperCase())?.lotSize ?? null;

  const message = (action: string) => {
    const t = Number(target);
    const sl = Number(stoploss);
    // {{close}} = the chart price when the alert fires (spot / index) → ATM strike.
    return `{"action":"${action}","exchange":"${segment}","underlying":"${script.trim().toUpperCase()}","option":"AUTO","strike":"${strike}","expiry":"${expiry}","lots":${lots},"spot":{{close}}${t > 0 ? `,"targetPoints":${t}` : ''}${sl > 0 ? `,"stoplossPoints":${sl}` : ''}}`;
  };
  const messages = useMemo(
    () =>
      source === 'strategy'
        ? [{ title: 'Alert message (one alert on the strategy)', json: message('{{strategy.market_position}}') }]
        : [
            { title: 'BUY alert message → buys a CALL', json: message('BUY') },
            { title: 'SELL alert message → buys a PUT', json: message('SELL') },
          ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [source, segment, script, expiry, strike, lots, target, stoploss],
  );

  return (
    <div className="space-y-4 rounded-md border p-3">
      <div>
        <div className="text-sm font-medium">Alert builder · {strategy.name}</div>
        <p className="text-xs text-muted-foreground">
          Put the alert on the spot / index chart. A BUY signal buys a CALL, a SELL signal buys a PUT — the open option on the other side is closed first. Strike is
          picked from the chart price when the alert fires.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <BField label="Segment">
          <Select value={segment} onChange={(e) => setSegment(e.target.value as FnoExchange)}>
            {SEGMENTS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </Select>
        </BField>
        <BField label="Script" hint={lotSize ? `Lot size ${lotSize}` : 'Type to search, e.g. NIFTY, BANKNIFTY, RELIANCE'}>
          <Input list="tv-scripts" value={script} onChange={(e) => setScript(e.target.value.toUpperCase())} placeholder="NIFTY" />
          <datalist id="tv-scripts">
            {(scripts.data ?? []).map((s) => (
              <option key={s.name} value={s.name} />
            ))}
          </datalist>
        </BField>
        <BField label="Expiry">
          <Select value={expiry} onChange={(e) => setExpiry(e.target.value as typeof expiry)}>
            <option value="nearest">Nearest (current)</option>
            <option value="next">Next</option>
            <option value="monthly">Monthly</option>
          </Select>
        </BField>
        <BField label="Call / Put">
          <Input value="From signal: BUY → CE, SELL → PE" readOnly disabled />
        </BField>
        <BField label="Strike">
          <Select value={strike} onChange={(e) => setStrike(e.target.value)}>
            {STRIKES.map((s) => (
              <option key={s} value={s}>
                {s === 'ATM' ? 'ATM (at the money)' : s.startsWith('ITM') ? `ITM ${s.slice(3)} (in the money)` : `OTM ${s.slice(3)} (out of the money)`}
              </option>
            ))}
          </Select>
        </BField>
        <BField label="Lots" hint={lotSize ? `= ${lots * lotSize} qty` : undefined}>
          <Input type="number" min={1} value={lots} onChange={(e) => setLots(Math.max(1, Math.floor(Number(e.target.value)) || 1))} />
        </BField>
        <BField label="Target (points)" hint="On the option price; empty = none">
          <Input type="number" min={0} step="0.05" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. 30" />
        </BField>
        <BField label="Stop loss (points)" hint="On the option price; empty = none">
          <Input type="number" min={0} step="0.05" value={stoploss} onChange={(e) => setStoploss(e.target.value)} placeholder="e.g. 15" />
        </BField>
      </div>
      <BField label="Signal from">
        <Select value={source} onChange={(e) => setSource(e.target.value as typeof source)}>
          <option value="strategy">TradingView strategy (one alert; flat = exit)</option>
          <option value="indicator">Indicator (two alerts: BUY and SELL)</option>
        </Select>
      </BField>
      {messages.map((m) => (
        <div key={m.title} className="space-y-1">
          <div className="text-xs font-medium">{m.title}</div>
          <div className="flex items-start gap-2">
            <code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 px-2 py-1.5 text-xs">{m.json}</code>
            <Button size="sm" variant="outline" onClick={() => void copy(m.json, 'Message')}>
              <Copy /> Copy
            </Button>
          </div>
        </div>
      ))}
      <p className="text-xs text-muted-foreground">
        In TradingView: Create alert → Condition = your strategy / indicator → Notifications → Webhook URL = the URL above → Message = the message above.
      </p>
    </div>
  );
}

function BField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}
