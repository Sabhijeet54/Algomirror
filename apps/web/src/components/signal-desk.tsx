'use client';

import { RefreshCw, Target } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { StrategyView } from '@ctp/types';
import { ExitButton, Pnl } from '@/components/live-account';
import { ScriptCombobox } from '@/components/script-combobox';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatDateTime, formatINR, humanize } from '@/lib/format';
import {
  type MasterOrderInput,
  type SignalRow,
  type FnoExchange,
  useFnoChain,
  useFnoScripts,
  useLtps,
  usePlaceMasterOrder,
  useSetSignalTpSl,
  useSignals,
  useSquareOffSignal,
} from '@/lib/trading';
import { cn } from '@/lib/utils';

// ------------------------------------------------------------------ instrument builder

type Segment = 'NSE:EQ' | 'NSE:FUT' | 'NSE:OPT' | 'BSE:EQ' | 'BSE:FUT' | 'BSE:OPT' | 'MCX:FUT' | 'MCX:OPT';
const SEGMENTS: { value: Segment; label: string }[] = [
  { value: 'NSE:EQ', label: 'NSE · Equity' },
  { value: 'NSE:FUT', label: 'NSE · Futures' },
  { value: 'NSE:OPT', label: 'NSE · Options' },
  { value: 'BSE:EQ', label: 'BSE · Equity' },
  { value: 'BSE:FUT', label: 'BSE · Futures' },
  { value: 'BSE:OPT', label: 'BSE · Options' },
  { value: 'MCX:FUT', label: 'MCX · Futures' },
  { value: 'MCX:OPT', label: 'MCX · Options' },
];
const fmtExpiry = (d: string) => new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Exchange + broker trading symbol (Angel One SmartAPI format: NIFTY19OCT2622600PE, NIFTY28OCT26FUT, SBIN). */
export function buildInstrument(seg: Segment, script: string, expiry: string, strike: string, opt: 'CE' | 'PE'): { exchange: string; symbol: string } | null {
  const s = script.trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return null;
  const [venue, kind] = seg.split(':') as ['NSE' | 'BSE' | 'MCX', 'EQ' | 'FUT' | 'OPT'];
  if (kind === 'EQ') return { exchange: venue, symbol: s };
  const exchange = venue === 'NSE' ? 'NFO' : venue === 'BSE' ? 'BFO' : 'MCX';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(expiry);
  if (!m) return null;
  const date = `${m[3]}${MONTHS[Number(m[2]) - 1]}${m[1]!.slice(2)}`;
  if (kind === 'FUT') return { exchange, symbol: `${s}${date}FUT` };
  const k = strike.trim();
  if (!k || !(Number(k) > 0)) return null;
  return { exchange, symbol: `${s}${date}${Number(k)}${opt}` };
}

const LOT_KEY = 'ctp.lotsize.';
function rememberedLot(script: string): string {
  try {
    return window.localStorage.getItem(LOT_KEY + script.trim().toUpperCase()) ?? '';
  } catch {
    return '';
  }
}

function Field({ label, children, hint, htmlFor }: { label: string; children: React.ReactNode; hint?: string; htmlFor?: string }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

// ------------------------------------------------------------------ order form

export function SignalForm({ strategies }: { strategies: StrategyView[] }) {
  const place = usePlaceMasterOrder();
  const active = strategies.filter((s) => s.status === 'ACTIVE');
  const [f, setF] = useState({
    strategyId: '',
    script: 'NIFTY',
    segment: 'NSE:OPT' as Segment,
    expiry: '',
    lotSize: '',
    lots: '1',
    strike: '',
    opt: 'CE' as 'CE' | 'PE',
    productType: 'INTRADAY' as MasterOrderInput['productType'],
    orderType: 'MARKET' as 'MARKET' | 'LIMIT',
    price: '',
    tpsl: false,
    target: '',
    stoploss: '',
  });
  useEffect(() => {
    if (!f.strategyId && active[0]) setF((p) => ({ ...p, strategyId: active[0]!.id }));
  }, [active, f.strategyId]);
  useEffect(() => {
    const lot = rememberedLot(f.script);
    if (lot) setF((p) => (p.lotSize ? p : { ...p, lotSize: lot }));
  }, [f.script]);

  // Only the segments the selected strategy allows (its "Allowed exchanges"); none set = all.
  const strategy = active.find((x) => x.id === f.strategyId);
  const segments = SEGMENTS.filter((x) => {
    const allowed = strategy?.allowedExchanges ?? [];
    if (!allowed.length) return true;
    const [v, k] = x.value.split(':');
    const ex = k === 'EQ' ? v : v === 'NSE' ? 'NFO' : v === 'BSE' ? 'BFO' : 'MCX';
    return allowed.includes(ex as never);
  });
  useEffect(() => {
    if (segments.length && !segments.some((x) => x.value === f.segment)) setF((p) => ({ ...p, segment: segments[0]!.value, expiry: '', strike: '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.strategyId, segments.length]);
  const kind = f.segment.split(':')[1] as 'EQ' | 'FUT' | 'OPT';
  const derivative = kind !== 'EQ';

  // Full F&O list from the broker instrument master: scripts, live expiries, strikes and lot size.
  const venue = f.segment.split(':')[0];
  const fnoEx: FnoExchange | null = !derivative ? null : venue === 'NSE' ? 'NFO' : venue === 'BSE' ? 'BFO' : 'MCX';
  const scripts = useFnoScripts(fnoEx, f.script);
  const chain = useFnoChain(fnoEx, f.script, kind === 'FUT' ? 'FUT' : 'OPT');
  const expiries = chain.data?.expiries ?? [];
  const catalog = derivative && expiries.length > 0;
  const selExpiry = expiries.find((e) => e.date === f.expiry);
  const strikes = selExpiry?.strikes ?? [];
  // Nearest expiry is picked automatically (weekly if the script has weeklies, else monthly) + its lot size.
  useEffect(() => {
    if (!catalog) return;
    const keep = expiries.find((e) => e.date === f.expiry);
    const pick = keep ?? expiries[0]!;
    setF((p) => (p.expiry === pick.date && p.lotSize === String(pick.lotSize) ? p : { ...p, expiry: pick.date, lotSize: String(pick.lotSize) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, chain.data]);
  // Strike: keep a valid one, else the middle of the chain (ATM-ish).
  useEffect(() => {
    if (!catalog || kind !== 'OPT' || !strikes.length) return;
    if (strikes.includes(Number(f.strike))) return;
    setF((p) => ({ ...p, strike: String(strikes[Math.floor(strikes.length / 2)]) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalog, kind, f.expiry, strikes.length]);
  const inst = buildInstrument(f.segment, f.script, f.expiry, f.strike, f.opt);
  // Ask for a live price only for a finished contract: every key asked for is subscribed on the shared feed,
  // so half-typed scripts ("NSE:B", "NSE:BA"…) or a stale expiry/strike after a segment switch flooded it.
  const [typedScript, setTypedScript] = useState(f.script);
  useEffect(() => {
    const t = setTimeout(() => setTypedScript(f.script), 700);
    return () => clearTimeout(t);
  }, [f.script]);
  const priceable =
    !!inst &&
    (derivative
      ? catalog && !!selExpiry && (kind === 'FUT' || strikes.includes(Number(f.strike)))
      : typedScript === f.script && f.script.trim().length >= 2);
  const ltpKey = priceable && inst ? `${inst.exchange}:${inst.symbol}`.toUpperCase() : '';
  const ltp = useLtps(ltpKey ? [ltpKey] : []).data?.[ltpKey]?.ltp ?? null;
  const lotSize = derivative ? Number(f.lotSize) || 0 : 1;
  const quantity = (Number(f.lots) || 0) * (derivative ? lotSize : 1);
  // My open position in this exact contract (open signals of the selected strategy).
  const openSignals = useSignals('open', 'all').data ?? [];
  const openNet = inst
    ? openSignals
        .filter((r) => r.strategyId === f.strategyId && r.exchange === inst.exchange && r.symbol === inst.symbol && r.productType === f.productType)
        .reduce((a, r) => a + (r.side === 'BUY' ? r.openQuantity : -r.openQuantity), 0)
    : 0;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = (side: 'BUY' | 'SELL') => {
    if (!f.strategyId) return toast.error('Choose a strategy');
    const exiting = openNet !== 0 && (side === 'SELL') === openNet > 0;
    if (!exiting && openNet === 0 && side === 'SELL' && derivative) {
      if (!window.confirm('You have no open BUY in this contract — this SELL opens a NEW short position for all clients. Continue?')) return;
    }
    if (!inst) return toast.error(derivative ? 'Fill script, expiry' + (kind === 'OPT' ? ' and strike' : '') : 'Enter a script');
    if (derivative && !lotSize) return toast.error('Enter the lot size');
    if (!(quantity > 0)) return toast.error('Quantity must be at least 1');
    if (f.orderType === 'LIMIT' && !(Number(f.price) > 0)) return toast.error('Enter the limit price');
    const target = f.tpsl && f.target ? Number(f.target) : undefined;
    const stoploss = f.tpsl && f.stoploss ? Number(f.stoploss) : undefined;
    const ref = f.orderType === 'LIMIT' ? Number(f.price) : ltp;
    if (ref != null) {
      if (target != null && (side === 'BUY' ? target <= ref : target >= ref)) return toast.error(`Target must be ${side === 'BUY' ? 'above' : 'below'} ${ref}`);
      if (stoploss != null && (side === 'BUY' ? stoploss >= ref : stoploss <= ref)) return toast.error(`Stop loss must be ${side === 'BUY' ? 'below' : 'above'} ${ref}`);
    }
    try {
      if (derivative) window.localStorage.setItem(LOT_KEY + f.script.trim().toUpperCase(), String(lotSize));
    } catch {
      /* ignore */
    }
    // Exit never exceeds the open position (no accidental opposite trade).
    const qty = exiting ? Math.min(quantity, Math.abs(openNet)) : quantity;
    if (exiting && qty < quantity) toast.info(`Only ${Math.abs(openNet)} open — exiting ${qty}`);
    const body: MasterOrderInput = {
      strategyId: f.strategyId,
      exchange: inst.exchange,
      symbol: inst.symbol,
      side,
      quantity: qty,
      orderType: f.orderType,
      productType: f.productType,
      price: f.orderType === 'LIMIT' ? Number(f.price) : undefined,
      lotSize: derivative ? lotSize : undefined,
      targetPrice: target,
      stopLossPrice: stoploss,
    };
    place.mutate(body, {
      onSuccess: (t) => {
        const ok = t.copyOrders.filter((c) => c.status === 'FILLED' || c.status === 'SUBMITTED').length;
        toast.success(`${side} ${qty} ${inst.symbol}${exiting ? ' (exit)' : ''} · copied to ${ok}/${t.copyOrders.length} clients`);
      },
      onError: (err) => toast.error(err.message),
    });
  };

  return (
    <Card id="place-trade" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Place signal</CardTitle>
        <CardDescription>
          Pick segment and script — expiry (nearest first), strikes and lot size come from the exchange contract list automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">Start (activate) a strategy first to send signals.</p>
        ) : (
          <form className="grid gap-4" onSubmit={(e) => e.preventDefault()}>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Strategy" htmlFor="sg-strategy">
                <Select id="sg-strategy" value={f.strategyId} onChange={set('strategyId')}>
                  {active.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Script" htmlFor="sg-script">
                <ScriptCombobox
                  id="sg-script"
                  value={f.script}
                  onChange={(v) => setF((p) => ({ ...p, script: v, lotSize: rememberedLot(v), expiry: '', strike: '' }))}
                  options={fnoEx ? (scripts.data ?? []) : null}
                  loading={scripts.isFetching}
                  placeholder={fnoEx ? 'Type R → RELIANCE, S → SENSEX…' : 'e.g. SBIN'}
                />
              </Field>
              <Field label="Segment" htmlFor="sg-seg">
                <Select id="sg-seg" value={f.segment} onChange={set('segment')}>
                  {segments.map((x) => (
                    <option key={x.value} value={x.value}>
                      {x.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Product" htmlFor="sg-product">
                <Select id="sg-product" value={f.productType} onChange={set('productType')}>
                  <option value="INTRADAY">Intraday (MIS)</option>
                  <option value="CARRY_FORWARD">Carry forward (NRML)</option>
                  <option value="DELIVERY">Delivery (CNC)</option>
                </Select>
              </Field>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {derivative ? (
                <>
                  <Field
                    label="Expiry"
                    htmlFor="sg-exp"
                    hint={catalog ? 'Nearest expiry is selected automatically' : chain.isFetching ? 'Loading expiries…' : f.script.trim() ? 'Script not in F&O list — enter the date' : undefined}
                  >
                    {catalog ? (
                      <Select
                        id="sg-exp"
                        value={f.expiry}
                        onChange={(e) => {
                          const ex = expiries.find((x) => x.date === e.target.value);
                          setF((p) => ({ ...p, expiry: e.target.value, lotSize: ex ? String(ex.lotSize) : p.lotSize }));
                        }}
                      >
                        {expiries.map((x, i) => (
                          <option key={x.date} value={x.date}>
                            {fmtExpiry(x.date)} · {x.monthly ? 'Monthly' : 'Weekly'}
                            {i === 0 ? ' (nearest)' : ''}
                          </option>
                        ))}
                      </Select>
                    ) : (
                      <Input id="sg-exp" type="date" value={f.expiry} onChange={set('expiry')} />
                    )}
                  </Field>
                  <Field label="Lot size" htmlFor="sg-lot" hint={catalog ? 'From the exchange contract list' : 'Remembered per script — verify after exchange revisions'}>
                    {catalog ? (
                      <div id="sg-lot" className="flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm font-semibold tabular-nums">
                        {f.lotSize || '—'}
                      </div>
                    ) : (
                      <Input id="sg-lot" type="number" min={1} inputMode="numeric" value={f.lotSize} onChange={set('lotSize')} />
                    )}
                  </Field>
                </>
              ) : null}
              <Field label={derivative ? 'Lots' : 'Quantity'} htmlFor="sg-lots" hint={derivative && lotSize ? `= ${quantity} qty` : undefined}>
                <Input id="sg-lots" type="number" min={1} inputMode="numeric" value={f.lots} onChange={set('lots')} />
              </Field>
              {kind === 'OPT' ? (
                <Field label="Strike" htmlFor="sg-strike">
                  {catalog && strikes.length ? (
                    <Select id="sg-strike" value={f.strike} onChange={set('strike')}>
                      {strikes.map((k) => (
                        <option key={k} value={String(k)}>
                          {k}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input id="sg-strike" type="number" min={0} step="any" inputMode="decimal" value={f.strike} onChange={set('strike')} />
                  )}
                </Field>
              ) : null}
            </div>

            <div className="flex flex-wrap items-end gap-x-6 gap-y-4">
              {kind === 'OPT' ? (
                <fieldset className="grid gap-1.5">
                  <legend className="mb-1.5 text-sm font-medium">Option</legend>
                  <div className="flex gap-4">
                    {(['CE', 'PE'] as const).map((o) => (
                      <label key={o} className="flex items-center gap-2 text-sm">
                        <input type="radio" name="sg-opt" className="size-4" checked={f.opt === o} onChange={() => setF((p) => ({ ...p, opt: o }))} />
                        {o}
                      </label>
                    ))}
                  </div>
                </fieldset>
              ) : null}
              <Field label="Order" htmlFor="sg-ot">
                <Select id="sg-ot" value={f.orderType} onChange={set('orderType')}>
                  <option value="MARKET">Market</option>
                  <option value="LIMIT">Limit</option>
                </Select>
              </Field>
              {f.orderType === 'LIMIT' ? (
                <Field label="Limit price" htmlFor="sg-price">
                  <Input id="sg-price" type="number" min={0} step="0.05" inputMode="decimal" value={f.price} onChange={set('price')} />
                </Field>
              ) : null}
              <div className="grid gap-1 text-sm">
                <span className="text-muted-foreground">Instrument</span>
                <span className="font-mono font-medium">{inst ? `${inst.exchange}:${inst.symbol}` : '—'}</span>
                <span className="text-xs text-muted-foreground">LTP {ltp != null ? formatINR(ltp) : 'waiting for feed…'}</span>
                <span className={cn('text-xs font-medium', openNet > 0 ? 'text-success' : openNet < 0 ? 'text-destructive' : 'text-muted-foreground')}>
                  {openNet === 0 ? 'No open position' : `Open: ${openNet > 0 ? 'BUY' : 'SELL'} ${Math.abs(openNet)}${lotSize > 1 ? ` (${Math.abs(openNet) / lotSize} lot)` : ''}`}
                </span>
              </div>
            </div>

            <label className="flex w-fit items-center gap-2 text-sm font-medium">
              <input type="checkbox" role="switch" className="size-4" checked={f.tpsl} onChange={(e) => setF((p) => ({ ...p, tpsl: e.target.checked }))} />
              Target / Stoploss
            </label>
            {f.tpsl ? (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Field label="Target price" htmlFor="sg-tp" hint="Exits this signal when LTP reaches it">
                  <Input id="sg-tp" type="number" min={0} step="0.05" inputMode="decimal" value={f.target} onChange={set('target')} />
                </Field>
                <Field label="Stop loss price" htmlFor="sg-sl" hint="Exits this signal when LTP reaches it">
                  <Input id="sg-sl" type="number" min={0} step="0.05" inputMode="decimal" value={f.stoploss} onChange={set('stoploss')} />
                </Field>
              </div>
            ) : null}

            <div className="flex gap-3">
              <Button type="button" className="min-w-24 bg-emerald-600 text-white hover:bg-emerald-700" disabled={place.isPending} onClick={() => submit('BUY')}>
                {openNet < 0 ? 'Buy (exit)' : 'Buy'}
              </Button>
              <Button type="button" variant="destructive" className="min-w-24" disabled={place.isPending} onClick={() => submit('SELL')}>
                {openNet > 0 ? 'Sell (exit)' : 'Sell'}
              </Button>
              {place.isPending ? <span className="self-center text-sm text-muted-foreground">Sending…</span> : null}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------------ executed signals

export const REASON: Record<string, string> = {
  TARGET: 'Target hit',
  STOPLOSS: 'SL hit',
  SQUARE_OFF: 'Squared off',
  STRATEGY_EXIT: 'Strategy exit',
  MASTER_EXIT: 'Master exit',
  AUTO_SQUARE_OFF: 'Auto square-off',
  KILL_SWITCH: 'Kill switch',
};

export function TpSlDialog({ row, onClose, scope = 'master' }: { row: SignalRow | null; onClose: () => void; scope?: 'master' | 'admin' }) {
  const save = useSetSignalTpSl(scope);
  const [tp, setTp] = useState('');
  const [sl, setSl] = useState('');
  useEffect(() => {
    if (row) {
      setTp(row.targetPrice != null ? String(row.targetPrice) : '');
      setSl(row.stopLossPrice != null ? String(row.stopLossPrice) : '');
    }
  }, [row]);
  const submit = (clear = false) => {
    if (!row) return;
    save.mutate(
      { id: row.id, targetPrice: clear || !tp ? null : Number(tp), stopLossPrice: clear || !sl ? null : Number(sl) },
      {
        onSuccess: () => (toast.success(clear ? 'Target / stop loss removed' : 'Target / stop loss saved'), onClose()),
        onError: (err) => toast.error(err.message),
      },
    );
  };
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Target / Stoploss</DialogTitle>
          <DialogDescription>
            {row ? `${row.side} ${row.symbol} · entry ${formatINR(row.entryPrice)}` : ''}. Applies to this signal only — when LTP reaches a level, this
            signal is squared off for you and all clients.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Target" htmlFor="tp-in">
            <Input id="tp-in" type="number" min={0} step="0.05" inputMode="decimal" value={tp} onChange={(e) => setTp(e.target.value)} />
          </Field>
          <Field label="Stop loss" htmlFor="sl-in">
            <Input id="sl-in" type="number" min={0} step="0.05" inputMode="decimal" value={sl} onChange={(e) => setSl(e.target.value)} />
          </Field>
        </div>
        <DialogFooter className="gap-2">
          {row && (row.targetPrice != null || row.stopLossPrice != null) ? (
            <Button variant="ghost" disabled={save.isPending} onClick={() => submit(true)}>
              Remove
            </Button>
          ) : null}
          <Button disabled={save.isPending} onClick={() => submit(false)}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function SignalsCard() {
  const [status, setStatus] = useState<'all' | 'open' | 'closed'>('open');
  const [scope, setScope] = useState<'today' | 'all'>('today');
  const q = useSignals(status, scope);
  const squareOff = useSquareOffSignal();
  const [tpslRow, setTpslRow] = useState<SignalRow | null>(null);
  const rows = q.data ?? [];
  const openKeys = useMemo(() => rows.filter((r) => r.status === 'OPEN').map((r) => `${r.exchange}:${r.symbol}`), [rows]);
  const ltps = useLtps(openKeys).data;

  const view = rows.map((r) => {
    const ltp = r.status === 'OPEN' ? (ltps?.[`${r.exchange}:${r.symbol}`.toUpperCase()]?.ltp ?? r.ltp) : null;
    const dir = r.side === 'BUY' ? 1 : -1;
    const unrealized = r.status === 'OPEN' && ltp != null && r.entryPrice != null ? r.openQuantity * (ltp - r.entryPrice) * dir : 0;
    return { ...r, liveLtp: ltp, pnl: r.realizedPnl + unrealized };
  });
  const total = view.reduce((s, r) => s + r.pnl, 0);

  return (
    <Card id="trades" className="scroll-mt-20">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              Executed signals
              <span className="text-sm font-normal text-muted-foreground">({scope === 'today' ? 'today' : 'all time'})</span>
            </CardTitle>
            <CardDescription>
              Each signal has its own target / stop loss and square off — nothing is applied to all at once. Total P&amp;L <Pnl value={total} />
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-md border" role="group" aria-label="Status filter">
              {(['all', 'open', 'closed'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={status === s}
                  onClick={() => setStatus(s)}
                  className={cn('px-3 py-1.5 text-sm capitalize transition-colors', status === s ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                >
                  {s}
                </button>
              ))}
            </div>
            <Select aria-label="Period" value={scope} onChange={(e) => setScope(e.target.value as 'today' | 'all')} className="h-8 w-28">
              <option value="today">Today</option>
              <option value="all">All time</option>
            </Select>
            <Button size="sm" variant="outline" onClick={() => void q.refetch()} disabled={q.isFetching}>
              <RefreshCw className={cn(q.isFetching && 'animate-spin')} /> Refresh
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Strategy</TableHead>
              <TableHead>Instrument</TableHead>
              <TableHead>Dir</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead className="text-right">Entry ₹</TableHead>
              <TableHead>Exit</TableHead>
              <TableHead className="text-right">Exit ₹</TableHead>
              <TableHead>TP / SL</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">LTP</TableHead>
              <TableHead className="text-right">P&amp;L</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.length === 0 ? (
              <TableRow>
                <TableCell colSpan={13} className="py-8 text-center text-sm text-muted-foreground">
                  {q.isLoading ? 'Loading…' : status === 'open' ? 'No open signals' : 'No signals yet'}
                </TableCell>
              </TableRow>
            ) : (
              view.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="whitespace-nowrap">{r.strategyName ?? '—'}</TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">
                    {r.symbol} <span className="text-muted-foreground">{r.exchange}</span>
                    <div className="font-sans text-[11px] text-muted-foreground">{humanize(r.productType)}</div>
                  </TableCell>
                  <TableCell>
                    <span className={cn('rounded px-1.5 py-0.5 text-xs font-semibold text-white', r.side === 'BUY' ? 'bg-emerald-600' : 'bg-red-600')}>{r.side}</span>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {r.status === 'OPEN' && r.openQuantity !== r.quantity ? `${r.openQuantity}/${r.quantity}` : r.quantity}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{formatDateTime(r.entryAt)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatINR(r.entryPrice)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {r.exitAt ? formatDateTime(r.exitAt) : '—'}
                    {r.exitReason ? <div className="text-[11px] text-muted-foreground">{REASON[r.exitReason] ?? humanize(r.exitReason)}</div> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{r.exitPrice != null ? formatINR(r.exitPrice) : '—'}</TableCell>
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
                  <TableCell>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-xs font-semibold',
                        r.status === 'OPEN' ? 'bg-amber-400/90 text-black' : 'bg-muted text-muted-foreground',
                      )}
                    >
                      {r.status}
                    </span>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums text-primary">{r.liveLtp != null ? formatINR(r.liveLtp) : '—'}</TableCell>
                  <TableCell className="text-right font-medium">
                    <Pnl value={r.pnl} />
                  </TableCell>
                  <TableCell className="text-right">
                    {r.status === 'OPEN' ? (
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setTpslRow(r)}>
                          <Target className="size-3.5" /> TP/SL
                        </Button>
                        <ExitButton
                          label="Square off"
                          pending={squareOff.isPending && squareOff.variables === r.id}
                          onConfirm={() =>
                            squareOff.mutate(r.id, {
                              onSuccess: (x) => toast.success(`${r.symbol} squared off${x.exitPrice != null ? ` @ ${formatINR(x.exitPrice)}` : ''} for you and all clients`),
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
      </CardContent>
      <TpSlDialog row={tpslRow} onClose={() => setTpslRow(null)} />
    </Card>
  );
}
