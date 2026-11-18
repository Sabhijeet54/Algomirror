'use client';

import { useEffect, useState } from 'react';
import { Copy, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { PageHeader } from '@/components/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { copy, WebhookCard } from '@/components/webhook-card';
import { ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { StrategyView } from '@ctp/types';
import {
  useAutomationSchedules,
  useMasterStrategies,
  useSaveAutomation,
  useSaveSchedules,
  useStrategyAutomation,
  useStrategyWebhook,
  type AutomationSettings,
  type OrbSettings,
  type OrbToday,
  type ScheduleLeg,
  type ScheduleRow,
} from '@/lib/trading';

const TABS = [
  { id: 'tv', label: 'TradingView' },
  { id: 'chartink', label: 'Chartink' },
  { id: 'schedule', label: 'Time entry / exit' },
  { id: 'orb', label: 'ORB' },
  { id: 'trail', label: 'Trailing SL' },
  { id: 'daily', label: 'Daily max loss / profit' },
  { id: 'reentry', label: 'Re-entry' },
  { id: 'log', label: 'Alert log' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

export default function AutomationPage() {
  const strategies = useMasterStrategies();
  const list = strategies.data ?? [];
  const [selected, setSelected] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('tv');
  const sel = list.find((s) => s.id === selected) ?? list[0];

  return (
    <>
      <PageHeader
        title="Automation"
        description="Trades placed automatically in a strategy and copied to every client — alerts, timed entry / exit and risk rules."
      />
      {strategies.isLoading ? null : !sel ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">Create a strategy first.</CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex gap-1 overflow-x-auto border-b" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  '-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm',
                  tab === t.id ? 'border-primary font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'schedule' ? (
            <SchedulesTab strategies={list} />
          ) : (
            <>
              <StrategyPicker list={list} value={sel.id} onChange={setSelected} />
              {tab === 'tv' ? (
                <WebhookCard strategy={sel} />
              ) : tab === 'log' ? (
                <AlertLog strategyId={sel.id} />
              ) : (
                <SettingsTab key={sel.id} strategyId={sel.id} tab={tab} />
              )}
            </>
          )}
        </div>
      )}
    </>
  );
}

/** Which strategy this tab works on (each tab picks its own; Time entry picks one per schedule). */
function StrategyPicker({ list, value, onChange }: { list: StrategyView[]; value: string; onChange: (id: string) => void }) {
  const cur = list.find((s) => s.id === value);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Label htmlFor="auto-strategy" className="shrink-0">
        Strategy (signals go into)
      </Label>
      <div className="w-full max-w-xs">
        <Select id="auto-strategy" value={value} onChange={(e) => onChange(e.target.value)}>
          {list.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.status !== 'ACTIVE' ? ' (not active)' : ''}
            </option>
          ))}
        </Select>
      </div>
      {cur && cur.status !== 'ACTIVE' ? <span className="text-xs text-amber-600">Activate the strategy for automation to trade.</span> : null}
    </div>
  );
}

// ------------------------------------------------------------ settings tabs

function SettingsTab({ strategyId, tab }: { strategyId: string; tab: Exclude<Tab, 'tv' | 'log' | 'schedule'> }) {
  const q = useStrategyAutomation(strategyId);
  const save = useSaveAutomation(strategyId);
  const [form, setForm] = useState<AutomationSettings | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (q.data && !dirty) setForm(q.data.settings);
  }, [q.data, dirty]);

  if (q.error instanceof ApiError && q.error.status === 403) return <Notice text="Only the master can see and change automation." />;
  if (!form) return <Notice text={q.isLoading ? 'Loading…' : 'Could not load automation settings.'} />;

  const set = (fn: (f: AutomationSettings) => AutomationSettings) => {
    setForm((f) => (f ? fn(structuredClone(f)) : f));
    setDirty(true);
  };
  const submit = () => {
    const { schedules: _schedules, ...rest } = form;
    save.mutate(rest, {
      onSuccess: () => {
        setDirty(false);
        toast.success('Automation saved');
      },
      onError: (e) => toast.error((e as Error).message),
    });
  };

  const saveBar = (
    <div className="flex items-center gap-3">
      <Button onClick={submit} disabled={save.isPending || !dirty}>
        <Save /> Save
      </Button>
      {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
    </div>
  );

  if (tab === 'chartink') return <ChartinkCard strategyId={strategyId} form={form} set={set} saveBar={saveBar} />;
  if (tab === 'orb') return <OrbCard form={form} set={set} saveBar={saveBar} today={q.data?.orb ?? null} />;

  if (tab === 'trail') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Trailing stop loss</CardTitle>
          <CardDescription>
            Every time the price moves this many points in your favour, the stop loss moves up (BUY) or down (SELL) by the same points. Applies to new trades of
            this strategy that have a stop loss — Place trade, alerts, timed entry and re-entry.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Trail every (points)" hint="Empty = off. Example: 10 → price +10 moves SL +10.">
            <Input
              type="number"
              min={0}
              step="0.05"
              value={form.trailPoints ?? ''}
              onChange={(e) => set((f) => ({ ...f, trailPoints: numOrNull(e.target.value) }))}
              placeholder="e.g. 10"
            />
          </Field>
          {saveBar}
        </CardContent>
      </Card>
    );
  }

  if (tab === 'daily') {
    const today = q.data?.today;
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Daily max loss / profit {today?.halted ? <Badge variant="destructive">Stopped for today</Badge> : null}
          </CardTitle>
          <CardDescription>
            When today&apos;s P&amp;L of this strategy (booked + open, on your signal quantity) reaches a limit, every position of the strategy is squared off
            for you and all clients, and no new trade is taken in this strategy until tomorrow. Each timed schedule can also have its own limit
            (Time entry / exit tab).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {today ? (
            <div className="text-sm">
              Today&apos;s P&amp;L:{' '}
              <span className={cn('font-medium', today.pnl < 0 ? 'text-red-600' : today.pnl > 0 ? 'text-emerald-600' : '')}>
                ₹{today.pnl.toLocaleString('en-IN')}
              </span>
            </div>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Max loss (₹)" hint="Empty = no limit">
              <Input
                type="number"
                min={0}
                value={form.daily.maxLoss ?? ''}
                onChange={(e) =>
                  set((f) => ({
                    ...f,
                    daily: { ...f.daily, maxLoss: numOrNull(e.target.value) },
                  }))
                }
                placeholder="e.g. 5000"
              />
            </Field>
            <Field label="Max profit (₹)" hint="Empty = no limit">
              <Input
                type="number"
                min={0}
                value={form.daily.maxProfit ?? ''}
                onChange={(e) =>
                  set((f) => ({
                    ...f,
                    daily: { ...f.daily, maxProfit: numOrNull(e.target.value) },
                  }))
                }
                placeholder="e.g. 10000"
              />
            </Field>
          </div>
          {saveBar}
        </CardContent>
      </Card>
    );
  }

  // re-entry
  return (
    <Card>
      <CardHeader>
        <CardTitle>Re-entry after stop loss</CardTitle>
        <CardDescription>
          When a trade of this strategy hits its stop loss, the same trade is taken again at market with the same target / stop loss distance. Not after the
          timed exit or once the daily limit is reached.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Toggle
          checked={form.reentry.enabled}
          onChange={(v) => set((f) => ({ ...f, reentry: { ...f.reentry, enabled: v } }))}
          label="Re-enter after stop loss"
        />
        <Field label="Times per trade">
          <Select
            value={form.reentry.max}
            onChange={(e) =>
              set((f) => ({
                ...f,
                reentry: { ...f.reentry, max: Number(e.target.value) },
              }))
            }
          >
            <option value={1}>1 time</option>
            <option value={2}>2 times</option>
          </Select>
        </Field>
        {saveBar}
      </CardContent>
    </Card>
  );
}

type SetForm = (fn: (f: AutomationSettings) => AutomationSettings) => void;

const newSchedule = (strategyId: string, n: number): ScheduleRow => ({
  id: `s${Date.now().toString(36)}`,
  name: `Schedule ${n}`,
  strategyId,
  enabled: false,
  entryTime: '09:20',
  exitTime: '15:15',
  days: [1, 2, 3, 4, 5],
  expiry: 'nearest',
  product: 'INTRADAY',
  legs: [],
  targetPoints: null,
  targetUnit: 'POINTS',
  stoplossPoints: null,
  stoplossUnit: 'POINTS',
  maxLoss: null,
  maxProfit: null,
});

/** Every timed entry / exit of all my strategies; each one picks the strategy its signals go into. */
function SchedulesTab({ strategies }: { strategies: StrategyView[] }) {
  const q = useAutomationSchedules();
  const save = useSaveSchedules();
  const [rows, setRows] = useState<ScheduleRow[] | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (q.data && !dirty) setRows(q.data);
  }, [q.data, dirty]);

  if (q.error instanceof ApiError && q.error.status === 403) return <Notice text="Only the master can see and change automation." />;
  if (!rows) return <Notice text={q.isLoading ? 'Loading…' : 'Could not load schedules.'} />;

  const change = (next: ScheduleRow[]) => {
    setRows(next);
    setDirty(true);
  };
  const add = () => change([...rows, newSchedule(strategies[0]!.id, rows.length + 1)]);
  const submit = () =>
    save.mutate(rows, {
      onSuccess: () => {
        setDirty(false);
        toast.success('Schedules saved');
      },
      onError: (e) => toast.error((e as Error).message),
    });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle>Time entry / exit</CardTitle>
              <CardDescription>
                Add as many schedules as you need — e.g. 09:20 NIFTY straddle in one strategy and 11:00 BANKNIFTY in another. On the picked days each schedule trades
                its legs at the entry time (IST) in its strategy, and at the exit time squares off only what it entered. Strike is picked from the live price at
                entry (ATM ± strikes).
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={add}>
                <Plus /> Add schedule
              </Button>
              <Button onClick={submit} disabled={save.isPending || !dirty}>
                <Save /> Save all
              </Button>
            </div>
          </div>
          {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        </CardHeader>
        {!rows.length ? (
          <CardContent>
            <p className="text-sm text-muted-foreground">No schedules yet — click Add schedule.</p>
          </CardContent>
        ) : null}
      </Card>
      {rows.map((r, i) => (
        <ScheduleEditor
          key={r.id}
          s={r}
          strategies={strategies}
          onChange={(patch) => change(rows.map((x, n) => (n === i ? { ...x, ...patch } : x)))}
          onRemove={() => confirm(`Delete "${r.name}"?`) && change(rows.filter((_, n) => n !== i))}
        />
      ))}
      {rows.length ? (
        <div className="flex items-center gap-3">
          <Button onClick={submit} disabled={save.isPending || !dirty}>
            <Save /> Save all
          </Button>
          {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ScheduleEditor({
  s,
  strategies,
  onChange,
  onRemove,
}: {
  s: ScheduleRow;
  strategies: StrategyView[];
  onChange: (patch: Partial<ScheduleRow>) => void;
  onRemove: () => void;
}) {
  const setLeg = (i: number, patch: Partial<ScheduleLeg>) => onChange({ legs: s.legs.map((l, n) => (n === i ? { ...l, ...patch } : l)) });
  const strategy = strategies.find((x) => x.id === s.strategyId);
  return (
    <Card className={cn(!s.enabled && 'opacity-90')}>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{s.name || 'Untitled schedule'}</span>
            <Badge variant={s.enabled ? 'success' : 'secondary'}>{s.enabled ? 'Running' : 'Paused'}</Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {strategy?.name ?? 'No strategy'} · {s.entryTime}
            {s.exitTime ? ` to ${s.exitTime}` : ''} · {s.legs.length} leg{s.legs.length === 1 ? '' : 's'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Toggle checked={s.enabled} onChange={(v) => onChange({ enabled: v })} label={s.enabled ? 'On' : 'Off'} />
          <Button size="sm" variant="ghost" className="text-muted-foreground hover:text-destructive" onClick={onRemove}>
            <Trash2 /> Delete
          </Button>
        </div>
      </div>
      <CardContent className="space-y-6 pt-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Strategy (signals go into)" hint={strategy && strategy.status !== 'ACTIVE' ? 'Not active — activate it for this schedule to trade.' : undefined}>
            <Select value={s.strategyId} onChange={(e) => onChange({ strategyId: e.target.value })}>
              {strategies.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.status !== 'ACTIVE' ? ' (not active)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Name">
            <Input value={s.name} maxLength={60} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. 09:20 straddle" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Entry time (IST)">
            <Input type="time" value={s.entryTime} onChange={(e) => onChange({ entryTime: e.target.value })} />
          </Field>
          <Field label="Exit time (IST)" hint="Empty = no timed exit">
            <Input type="time" value={s.exitTime ?? ''} onChange={(e) => onChange({ exitTime: e.target.value || null })} />
          </Field>
          <Field label="Expiry">
            <Select value={s.expiry} onChange={(e) => onChange({ expiry: e.target.value as ScheduleRow['expiry'] })}>
              <option value="nearest">Nearest</option>
              <option value="next">Next</option>
              <option value="monthly">Monthly</option>
            </Select>
          </Field>
          <Field label="Product">
            <Select value={s.product} onChange={(e) => onChange({ product: e.target.value as ScheduleRow['product'] })}>
              <option value="INTRADAY">Intraday (MIS)</option>
              <option value="CARRY_FORWARD">Carry forward (NRML)</option>
            </Select>
          </Field>
        </div>

        <div className="space-y-1.5">
          <Label>Days</Label>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d, i) => {
              const day = i + 1;
              const on = s.days.includes(day);
              return (
                <Button key={d} size="sm" variant={on ? 'default' : 'outline'} onClick={() => onChange({ days: on ? s.days.filter((x) => x !== day) : [...s.days, day].sort() })}>
                  {d}
                </Button>
              );
            })}
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Label>Legs</Label>
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  onChange({
                    legs: [
                      { underlying: 'NIFTY', option: 'CE', strike: 0, side: 'SELL', lots: 1 },
                      { underlying: 'NIFTY', option: 'PE', strike: 0, side: 'SELL', lots: 1 },
                    ],
                  })
                }
              >
                NIFTY ATM straddle
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={s.legs.length >= 6}
                onClick={() => onChange({ legs: [...s.legs, { underlying: 'NIFTY', option: 'CE', strike: 0, side: 'BUY', lots: 1 }] })}
              >
                <Plus /> Add leg
              </Button>
            </div>
          </div>
          {s.legs.length ? (
            <div className="space-y-2">
              {s.legs.map((l, i) => (
                <div key={i} className="grid grid-cols-2 items-end gap-2 rounded-md border p-2 sm:grid-cols-[1fr_6rem_7rem_6rem_5rem_auto]">
                  <Field label="Underlying">
                    <Input value={l.underlying} onChange={(e) => setLeg(i, { underlying: e.target.value.toUpperCase() })} placeholder="NIFTY" />
                  </Field>
                  <Field label="Option">
                    <Select value={l.option} onChange={(e) => setLeg(i, { option: e.target.value as ScheduleLeg['option'] })}>
                      <option value="CE">CE</option>
                      <option value="PE">PE</option>
                      <option value="FUT">FUT</option>
                    </Select>
                  </Field>
                  <Field label="Strike">
                    <Select value={l.strike} disabled={l.option === 'FUT'} onChange={(e) => setLeg(i, { strike: Number(e.target.value) })}>
                      {Array.from({ length: 21 }, (_, n) => n - 10).map((n) => (
                        <option key={n} value={n}>
                          {n === 0 ? 'ATM' : `ATM${n > 0 ? '+' : ''}${n}`}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Side">
                    <Select value={l.side} onChange={(e) => setLeg(i, { side: e.target.value as ScheduleLeg['side'] })}>
                      <option value="BUY">BUY</option>
                      <option value="SELL">SELL</option>
                    </Select>
                  </Field>
                  <Field label="Lots">
                    <Input type="number" min={1} value={l.lots} onChange={(e) => setLeg(i, { lots: Math.max(1, Number(e.target.value) || 1) })} />
                  </Field>
                  <Button size="icon" variant="ghost" aria-label="Remove leg" onClick={() => onChange({ legs: s.legs.filter((_, n) => n !== i) })}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No legs yet.</p>
          )}
        </div>

        <Section title="Target and stop loss" note="Per leg, from each leg's entry price. % is of the entry premium (20% of ₹150 = 30 points).">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Target" hint="Empty = none">
              <UnitInput
                value={s.targetPoints}
                unit={s.targetUnit}
                onValue={(v) => onChange({ targetPoints: v })}
                onUnit={(u) => onChange({ targetUnit: u })}
                placeholder={s.targetUnit === 'PCT' ? 'e.g. 50' : 'e.g. 40'}
              />
            </Field>
            <Field label="Stop loss" hint="Empty = none">
              <UnitInput
                value={s.stoplossPoints}
                unit={s.stoplossUnit}
                onValue={(v) => onChange({ stoplossPoints: v })}
                onUnit={(u) => onChange({ stoplossUnit: u })}
                placeholder={s.stoplossUnit === 'PCT' ? 'e.g. 25' : 'e.g. 20'}
              />
            </Field>
          </div>
        </Section>

        <Section
          title="Daily max loss / profit for this schedule"
          note="Counts only this schedule's trades today (and their re-entries). When reached, its positions are squared off and it takes no more trades today. Other schedules keep running."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Max loss (₹)" hint="Empty = no limit">
              <Input type="number" min={0} value={s.maxLoss ?? ''} onChange={(e) => onChange({ maxLoss: numOrNull(e.target.value) })} placeholder="e.g. 3000" />
            </Field>
            <Field label="Max profit (₹)" hint="Empty = no limit">
              <Input type="number" min={0} value={s.maxProfit ?? ''} onChange={(e) => onChange({ maxProfit: numOrNull(e.target.value) })} placeholder="e.g. 6000" />
            </Field>
          </div>
        </Section>
      </CardContent>
    </Card>
  );
}

const ORB_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'];

function OrbCard({ form, set, saveBar, today }: { form: AutomationSettings; set: SetForm; saveBar: React.ReactNode; today: OrbToday | null }) {
  const o = form.orb;
  const setO = (patch: Partial<OrbSettings>) => set((f) => ({ ...f, orb: { ...f.orb, ...patch } }));
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const rangeEnd = hhmm(9 * 60 + 15 + o.rangeMinutes);
  const firstClose = hhmm(9 * 60 + 15 + o.rangeMinutes * 2);
  const target = o.stoploss && o.targetRatio ? Math.round(o.stoploss * o.targetRatio * 100) / 100 : null;
  const unit = o.stoplossUnit === 'PCT' ? '%' : ' pts';

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-6 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Opening range breakout (ORB)</span>
            <Badge variant={o.enabled ? 'success' : 'secondary'}>{o.enabled ? 'Running' : 'Paused'}</Badge>
          </div>
          <p className="mt-0.5 max-w-3xl text-xs text-muted-foreground">
            Range = {o.underlying}&apos;s high and low from 09:15 to {rangeEnd}. After that, when a {o.rangeMinutes} minute candle closes above the high, the ATM
            CALL is bought; when one closes below the low, the ATM PUT is bought. Prices are from the nearest {o.underlying} future.
          </p>
        </div>
        <Toggle checked={o.enabled} onChange={(v) => setO({ enabled: v })} label={o.enabled ? 'On' : 'Off'} />
      </div>
      <CardContent className="space-y-6 pt-5">
        {today && o.enabled ? (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-md border bg-muted/40 px-4 py-3 text-sm">
            <span className="font-medium">Today</span>
            {today.skipped ? (
              <span className="text-amber-600">No ORB today (range start was missed)</span>
            ) : (
              <>
                <span>
                  High <span className="tabular font-medium">{today.high ?? '—'}</span>
                </span>
                <span>
                  Low <span className="tabular font-medium">{today.low ?? '—'}</span>
                </span>
                <span className="text-muted-foreground">{today.ready ? 'Range ready, watching for a breakout' : 'Building the range'}</span>
                {today.entries ? (
                  <Badge variant="secondary">
                    {today.entries} entr{today.entries === 1 ? 'y' : 'ies'}, last {today.lastSide === 'CE' ? 'CALL' : 'PUT'}
                  </Badge>
                ) : null}
              </>
            )}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Underlying">
            <Input list="orb-underlyings" value={o.underlying} onChange={(e) => setO({ underlying: e.target.value.toUpperCase() })} placeholder="NIFTY" />
            <datalist id="orb-underlyings">
              {ORB_UNDERLYINGS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </Field>
          <Field label="Range / candle" hint={`Range 09:15 to ${rangeEnd}; first breakout candle closes at ${firstClose}`}>
            <Select value={o.rangeMinutes} onChange={(e) => setO({ rangeMinutes: Number(e.target.value) as OrbSettings['rangeMinutes'] })}>
              {[5, 10, 15, 30].map((m) => (
                <option key={m} value={m}>
                  {m} minutes
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Expiry">
            <Select value={o.expiry} onChange={(e) => setO({ expiry: e.target.value as OrbSettings['expiry'] })}>
              <option value="nearest">Nearest</option>
              <option value="next">Next</option>
              <option value="monthly">Monthly</option>
            </Select>
          </Field>
          <Field label="Lots">
            <Input type="number" min={1} value={o.lots} onChange={(e) => setO({ lots: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
        </div>

        <Section title="Stop loss and target" note="On the option premium. Target = stop loss × ratio (ratio 2 → 1:2).">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Stop loss" hint="Empty = none (then no target either; exit at the exit time)">
              <UnitInput value={o.stoploss} unit={o.stoplossUnit} onValue={(v) => setO({ stoploss: v })} onUnit={(u) => setO({ stoplossUnit: u })} placeholder={o.stoplossUnit === 'PCT' ? 'e.g. 25' : 'e.g. 20'} />
            </Field>
            <Field label="Target ratio" hint={target ? `Target = ${target}${unit}` : 'Needs a stop loss'}>
              <Select value={o.targetRatio ?? ''} onChange={(e) => setO({ targetRatio: numOrNull(e.target.value) })}>
                <option value="">No target (time exit)</option>
                {[1, 1.5, 2, 2.5, 3, 4, 5].map((r) => (
                  <option key={r} value={r}>
                    1 : {r}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        </Section>

        <Section title="Timing">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="No new entry after (IST)">
              <Input type="time" value={o.lastEntry} onChange={(e) => setO({ lastEntry: e.target.value })} />
            </Field>
            <Field label="Exit time (IST)" hint="ORB positions are squared off">
              <Input type="time" value={o.exitTime} onChange={(e) => setO({ exitTime: e.target.value })} />
            </Field>
            <Field label="Entries per day" hint="2nd entry only on a break of the other side">
              <Select value={o.maxEntries} onChange={(e) => setO({ maxEntries: Number(e.target.value) })}>
                <option value={1}>1</option>
                <option value={2}>2</option>
                <option value={3}>3</option>
              </Select>
            </Field>
          </div>
        </Section>
        {saveBar}
      </CardContent>
    </Card>
  );
}

function ChartinkCard({ strategyId, form, set, saveBar }: { strategyId: string; form: AutomationSettings; set: SetForm; saveBar: React.ReactNode }) {
  const hook = useStrategyWebhook(strategyId);
  const c = form.chartink;
  const setC = (patch: Partial<AutomationSettings['chartink']>) => set((f) => ({ ...f, chartink: { ...f.chartink, ...patch } }));
  const url = hook.data?.chartinkUrl;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Chartink scanner</CardTitle>
        <CardDescription>
          Paste this URL in a Chartink scan alert (Create alert → Webhook URL). Every stock the scan sends is traded on NSE in this strategy with the settings
          below.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {url ? (
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">Chartink webhook URL (keep it secret)</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 text-xs">{url}</code>
              <Button size="sm" variant="outline" onClick={() => void copy(url, 'URL')}>
                <Copy /> Copy
              </Button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-amber-600">Turn on the webhook in the TradingView tab first — Chartink uses the same secret URL.</p>
        )}
        <Toggle checked={c.enabled} onChange={(v) => setC({ enabled: v })} label="Trade Chartink alerts" />
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Side">
            <Select value={c.side} onChange={(e) => setC({ side: e.target.value as 'BUY' | 'SELL' })}>
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </Select>
          </Field>
          <Field label="Quantity per stock">
            <Input type="number" min={1} value={c.qty} onChange={(e) => setC({ qty: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
          <Field label="Product">
            <Select value={c.product} onChange={(e) => setC({ product: e.target.value as 'INTRADAY' | 'DELIVERY' })}>
              <option value="INTRADAY">Intraday (MIS)</option>
              <option value="DELIVERY">Delivery (CNC)</option>
            </Select>
          </Field>
          <Field label="Target %" hint="Empty = none">
            <Input type="number" min={0} step="0.1" value={c.targetPct ?? ''} onChange={(e) => setC({ targetPct: numOrNull(e.target.value) })} />
          </Field>
          <Field label="Stop loss %" hint="Empty = none">
            <Input type="number" min={0} step="0.1" value={c.stoplossPct ?? ''} onChange={(e) => setC({ stoplossPct: numOrNull(e.target.value) })} />
          </Field>
          <Field label="Max stocks per alert">
            <Input type="number" min={1} max={50} value={c.maxStocks} onChange={(e) => setC({ maxStocks: Math.max(1, Number(e.target.value) || 1) })} />
          </Field>
        </div>
        {saveBar}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------ alert log

function AlertLog({ strategyId }: { strategyId: string }) {
  const q = useStrategyWebhook(strategyId);
  if (q.error instanceof ApiError && q.error.status === 403) return <Notice text="Only the master can see the alert log." />;
  const rows = q.data?.recent ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Alert log</CardTitle>
        <CardDescription>Last 20 automation events of this strategy — TradingView, Chartink, timed entry / exit, daily limit and re-entry.</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <ul className="divide-y rounded-md border text-sm">
            {rows.map((r) => (
              <li key={`${r.at}-${r.message}`} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <Badge variant={r.ok ? 'success' : 'destructive'}>{r.ok ? 'OK' : 'Failed'}</Badge>
                <Badge variant="secondary">{r.action}</Badge>
                <span className="text-xs text-muted-foreground">{formatDateTime(r.at)}</span>
                <span className="min-w-0 flex-1">{r.message}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">{q.isLoading ? 'Loading…' : 'Nothing yet.'}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------ bits

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2.5 text-sm font-medium">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          checked ? 'bg-primary' : 'bg-muted-foreground/30',
        )}
      >
        <span
          className={cn('pointer-events-none absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm transition-transform duration-200', checked ? 'translate-x-5' : 'translate-x-0')}
        />
      </button>
      <span className="min-w-[1.75rem]">{label}</span>
    </label>
  );
}

/** A small titled block inside a card. */
function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3 border-t pt-5">
      <div>
        <h3 className="text-sm font-semibold">{title}</h3>
        {note ? <p className="mt-0.5 text-xs text-muted-foreground">{note}</p> : null}
      </div>
      {children}
    </div>
  );
}

/** Number input with a Points / % switch on its right. */
function UnitInput({
  value,
  unit,
  onValue,
  onUnit,
  placeholder,
}: {
  value: number | null;
  unit: 'POINTS' | 'PCT';
  onValue: (v: number | null) => void;
  onUnit: (u: 'POINTS' | 'PCT') => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-stretch gap-2">
      <div className="relative min-w-0 flex-1">
        <Input
          type="number"
          min={0}
          step={unit === 'PCT' ? '0.1' : '0.05'}
          value={value ?? ''}
          onChange={(e) => onValue(numOrNull(e.target.value))}
          placeholder={placeholder}
          className="pr-10"
        />
        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-muted-foreground">{unit === 'PCT' ? '%' : 'pts'}</span>
      </div>
      <div role="radiogroup" aria-label="Unit" className="inline-flex shrink-0 rounded-md border bg-muted/50 p-0.5">
        {(['POINTS', 'PCT'] as const).map((u) => (
          <button
            key={u}
            type="button"
            role="radio"
            aria-checked={unit === u}
            onClick={() => onUnit(u)}
            className={cn(
              'rounded px-3 text-xs font-medium transition-colors',
              unit === u ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {u === 'PCT' ? '%' : 'Points'}
          </button>
        ))}
      </div>
    </div>
  );
}

function Notice({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">{text}</CardContent>
    </Card>
  );
}
