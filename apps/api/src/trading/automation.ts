/**
 * Strategy automation settings (stored as JSON on Strategy.automation) and the pure helpers behind them:
 * time-based entry / exit, trailing stop loss, strategy daily max loss / profit, re-entry after a stop loss and
 * the Chartink scanner webhook.
 */

export class AutomationError extends Error {}

export interface ScheduleLeg {
  underlying: string;
  option: 'CE' | 'PE' | 'FUT';
  /** ATM offset in strikes (0 = ATM, 1 = one strike above, -1 = one below). Ignored for FUT. */
  strike: number;
  side: 'BUY' | 'SELL';
  lots: number;
}

export interface Schedule {
  /** Stable id (used for the once-a-day keys). */
  id: string;
  name: string;
  enabled: boolean;
  /** IST, HH:MM */
  entryTime: string;
  /** IST, HH:MM; null = no timed exit */
  exitTime: string | null;
  /** 1 = Monday … 5 = Friday */
  days: number[];
  expiry: 'nearest' | 'next' | 'monthly';
  product: 'INTRADAY' | 'CARRY_FORWARD';
  legs: ScheduleLeg[];
  targetPoints: number | null;
  stoplossPoints: number | null;
}

export const MAX_SCHEDULES = 10;

export interface AutomationSettings {
  /** Timed entries / exits of this strategy (several allowed, e.g. 09:20 straddle and 11:00 BANKNIFTY). */
  schedules: Schedule[];
  /** Trailing stop loss step in points for every new trade of the strategy that has a stop loss. */
  trailPoints: number | null;
  daily: { maxLoss: number | null; maxProfit: number | null };
  reentry: { enabled: boolean; max: number };
  chartink: {
    enabled: boolean;
    side: 'BUY' | 'SELL';
    qty: number;
    product: 'INTRADAY' | 'DELIVERY';
    targetPct: number | null;
    stoplossPct: number | null;
    maxStocks: number;
  };
}

export const DEFAULT_SCHEDULE: Omit<Schedule, 'id' | 'name'> = {
  enabled: false,
  entryTime: '09:20',
  exitTime: '15:15',
  days: [1, 2, 3, 4, 5],
  expiry: 'nearest',
  product: 'INTRADAY',
  legs: [],
  targetPoints: null,
  stoplossPoints: null,
};

export const DEFAULT_AUTOMATION: AutomationSettings = {
  schedules: [],
  trailPoints: null,
  daily: { maxLoss: null, maxProfit: null },
  reentry: { enabled: false, max: 1 },
  chartink: {
    enabled: false,
    side: 'BUY',
    qty: 1,
    product: 'INTRADAY',
    targetPct: null,
    stoplossPct: null,
    maxStocks: 5,
  },
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function posNum(v: unknown, what: string): number | null {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new AutomationError(`${what} must be a positive number`);
  return n;
}
function posInt(v: unknown, what: string, def: number, max: number): number {
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new AutomationError(`${what} must be a whole number from 1 to ${max}`);
  return n;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], def: T, what: string): T {
  if (v == null || v === '') return def;
  const s = String(v).toUpperCase();
  const hit = allowed.find((a) => a.toUpperCase() === s);
  if (!hit) throw new AutomationError(`${what} must be one of ${allowed.join(', ')}`);
  return hit;
}

/** Settings stored on a strategy (null / partial / old) → full settings with defaults. Never throws. */
export function readAutomation(stored: unknown): AutomationSettings {
  try {
    return normalizeAutomation(stored);
  } catch {
    return structuredClone(DEFAULT_AUTOMATION);
  }
}

/** One timed entry / exit. `n` (1-based) names it in error messages. */
export function normalizeSchedule(raw: unknown, n: number): Schedule {
  const d = DEFAULT_SCHEDULE;
  const s = obj(raw);
  const tag = `Schedule ${n}`;
  const id = /^[A-Za-z0-9_-]{1,40}$/.test(String(s.id ?? '')) ? String(s.id) : `s${n}`;
  const name = String(s.name ?? '').trim().slice(0, 60) || tag;
  const entryTime = s.entryTime == null || s.entryTime === '' ? d.entryTime : String(s.entryTime);
  if (!TIME.test(entryTime)) throw new AutomationError(`${name}: entry time must be HH:MM (24 hour, IST)`);
  const exitTime = s.exitTime == null || s.exitTime === '' ? null : String(s.exitTime);
  if (exitTime && !TIME.test(exitTime)) throw new AutomationError(`${name}: exit time must be HH:MM (24 hour, IST)`);
  if (exitTime && exitTime <= entryTime) throw new AutomationError(`${name}: exit time must be after the entry time`);
  const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number))].filter((x) => Number.isInteger(x) && x >= 1 && x <= 5).sort() : d.days;
  const legsIn = Array.isArray(s.legs) ? s.legs : [];
  if (legsIn.length > 6) throw new AutomationError(`${name}: at most 6 legs`);
  const legs: ScheduleLeg[] = legsIn.map((rawLeg, k) => {
    const l = obj(rawLeg);
    const leg = `${name}, leg ${k + 1}`;
    const underlying = String(l.underlying ?? '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z0-9&_-]{2,30}$/.test(underlying)) throw new AutomationError(`${leg}: enter the underlying (e.g. NIFTY)`);
    const strike = l.strike == null || l.strike === '' ? 0 : Number(l.strike);
    if (!Number.isInteger(strike) || Math.abs(strike) > 20) throw new AutomationError(`${leg}: strike offset must be a whole number from -20 to 20`);
    return {
      underlying,
      option: oneOf(l.option, ['CE', 'PE', 'FUT'] as const, 'CE', `${leg} option`),
      strike,
      side: oneOf(l.side, ['BUY', 'SELL'] as const, 'BUY', `${leg} side`),
      lots: posInt(l.lots, `${leg} lots`, 1, 100),
    };
  });
  const enabled = s.enabled === true;
  if (enabled && !legs.length) throw new AutomationError(`${name}: add at least one leg`);
  if (enabled && !days.length) throw new AutomationError(`${name}: pick at least one day`);
  return {
    id,
    name,
    enabled,
    entryTime,
    exitTime,
    days,
    expiry: (['nearest', 'next', 'monthly'] as const).find((e) => e === String(s.expiry ?? '').toLowerCase()) ?? 'nearest',
    product: oneOf(s.product, ['INTRADAY', 'CARRY_FORWARD'] as const, 'INTRADAY', `${name} product`),
    legs,
    targetPoints: posNum(s.targetPoints, `${name} target points`),
    stoplossPoints: posNum(s.stoplossPoints, `${name} stop loss points`),
  };
}

/** Validates a list of schedules (ids made unique). */
export function normalizeSchedules(list: unknown): Schedule[] {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length > MAX_SCHEDULES) throw new AutomationError(`At most ${MAX_SCHEDULES} schedules per strategy`);
  const seen = new Set<string>();
  return arr.map((raw, k) => {
    const sc = normalizeSchedule(raw, k + 1);
    let id = sc.id;
    for (let j = 2; seen.has(id); j++) id = `${sc.id}-${j}`;
    seen.add(id);
    return { ...sc, id };
  });
}

/** Validates settings sent by the master. Throws AutomationError with a readable message. */
export function normalizeAutomation(input: unknown): AutomationSettings {
  const i = obj(input);
  // Older settings had a single "schedule" object.
  const legacy = obj(i.schedule);
  const schedules = normalizeSchedules(
    Array.isArray(i.schedules) ? i.schedules : Object.keys(legacy).length && (legacy.enabled === true || (Array.isArray(legacy.legs) && legacy.legs.length)) ? [{ ...legacy, id: 's1' }] : [],
  );
  const dl = obj(i.daily);
  const re = obj(i.reentry);
  const ck = obj(i.chartink);
  return {
    schedules,
    trailPoints: posNum(i.trailPoints, 'Trailing stop loss points'),
    daily: {
      maxLoss: posNum(dl.maxLoss, 'Daily max loss'),
      maxProfit: posNum(dl.maxProfit, 'Daily max profit'),
    },
    reentry: {
      enabled: re.enabled === true,
      max: posInt(re.max, 'Re-entries', 1, 2),
    },
    chartink: {
      enabled: ck.enabled === true,
      side: oneOf(ck.side, ['BUY', 'SELL'] as const, 'BUY', 'Chartink side'),
      qty: posInt(ck.qty, 'Chartink quantity', 1, 100_000),
      product: oneOf(ck.product, ['INTRADAY', 'DELIVERY'] as const, 'INTRADAY', 'Chartink product'),
      targetPct: posNum(ck.targetPct, 'Chartink target %'),
      stoplossPct: posNum(ck.stoplossPct, 'Chartink stop loss %'),
      maxStocks: posInt(ck.maxStocks, 'Chartink max stocks', 5, 50),
    },
  };
}

/** Redis flag set when a strategy hits its daily max loss / profit: no new entries that IST day. */
export const dailyHaltKey = (strategyId: string, date: string) => `ctp:auto:halt:${strategyId}:${date}`;

// ------------------------------------------------------------ time (IST)

const IST_MS = 330 * 60_000;

/** IST calendar date, HH:MM and weekday (0 = Sunday) of an instant. */
export function istNow(now = new Date()): {
  date: string;
  hhmm: string;
  weekday: number;
  dayStart: Date;
} {
  const t = new Date(now.getTime() + IST_MS);
  const date = t.toISOString().slice(0, 10);
  return {
    date,
    hhmm: t.toISOString().slice(11, 16),
    weekday: t.getUTCDay(),
    dayStart: new Date(Date.parse(`${date}T00:00:00Z`) - IST_MS),
  };
}

/** A scheduled HH:MM is due when the clock is at it or up to 3 minutes past it (survives a restart / slow tick). */
export function isDue(at: string, hhmm: string): boolean {
  const m = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  const d = m(hhmm) - m(at);
  return d >= 0 && d < 3;
}

// ------------------------------------------------------------ schedule legs → alerts

/** One schedule leg as a webhook alert body (parsed by parseAlert). */
export function legAlert(leg: ScheduleLeg, s: Schedule): Record<string, unknown> {
  return {
    action: leg.side,
    underlying: leg.underlying,
    option: leg.option,
    ...(leg.option === 'FUT'
      ? {}
      : {
          strike: leg.strike === 0 ? 'ATM' : `ATM${leg.strike > 0 ? '+' : ''}${leg.strike}`,
        }),
    expiry: s.expiry,
    lots: leg.lots,
    product: s.product,
    ...(s.targetPoints ? { targetPoints: s.targetPoints } : {}),
    ...(s.stoplossPoints ? { stoplossPoints: s.stoplossPoints } : {}),
  };
}

// ------------------------------------------------------------ trailing stop loss

const tick05 = (n: number) => Math.round(n * 20) / 20;

/**
 * Trailing stop loss: each full `step` the price moves in favour beyond the anchor moves the stop loss (and the
 * anchor) by `step` in the same direction. Returns the new levels, or null when nothing moves.
 */
export function trailStep(p: {
  side: 'BUY' | 'SELL';
  stopLoss: number;
  anchor: number;
  step: number;
  ltp: number;
}): { stopLoss: number; anchor: number } | null {
  if (!(p.step > 0)) return null;
  const dir = p.side === 'BUY' ? 1 : -1;
  const moves = Math.floor(((p.ltp - p.anchor) * dir) / p.step + 1e-9);
  if (moves < 1) return null;
  return {
    stopLoss: tick05(p.stopLoss + dir * moves * p.step),
    anchor: tick05(p.anchor + dir * moves * p.step),
  };
}

// ------------------------------------------------------------ daily P&L of a strategy

export interface DaySignal {
  side: 'BUY' | 'SELL';
  entry: number | null;
  openQty: number;
  realizedPnl: number;
  ltp: number | null;
}

/** Realized + open P&L of the strategy's signals of the day (open legs without a live price count as 0). */
export function dayPnl(rows: DaySignal[]): number {
  let pnl = 0;
  for (const r of rows) {
    pnl += r.realizedPnl;
    if (r.openQty > 0 && r.entry != null && r.ltp != null) pnl += (r.ltp - r.entry) * r.openQty * (r.side === 'BUY' ? 1 : -1);
  }
  return Math.round(pnl * 100) / 100;
}

/** 'LOSS' / 'PROFIT' when the day's P&L reached a limit, else null. */
export function dailyLimitHit(pnl: number, daily: AutomationSettings['daily']): 'LOSS' | 'PROFIT' | null {
  if (daily.maxLoss != null && pnl <= -daily.maxLoss) return 'LOSS';
  if (daily.maxProfit != null && pnl >= daily.maxProfit) return 'PROFIT';
  return null;
}

// ------------------------------------------------------------ Chartink

/**
 * Chartink scan alert → stocks with their trigger prices. Chartink posts
 * {"stocks":"SBIN,RELIANCE","trigger_prices":"601.5,2890","scan_name":"…",…}.
 */
export function parseChartink(body: unknown): {
  scan: string;
  stocks: { symbol: string; price: number | null }[];
} {
  let b: unknown = body;
  if (typeof b === 'string') {
    try {
      b = JSON.parse(b);
    } catch {
      throw new AutomationError('Chartink alert is not JSON');
    }
  }
  const o = obj(b);
  const names = String(o.stocks ?? '')
    .split(',')
    .map((x) => x.trim().toUpperCase());
  const prices = String(o.trigger_prices ?? '')
    .split(',')
    .map((x) => Number(x.trim()));
  const stocks = names
    .map((symbol, n) => ({
      symbol,
      price: Number.isFinite(prices[n]) && prices[n]! > 0 ? prices[n]! : null,
    }))
    .filter((x) => /^[A-Z0-9&_-]{1,40}$/.test(x.symbol));
  if (!stocks.length) throw new AutomationError('Chartink alert has no stocks');
  const seen = new Set<string>();
  return {
    scan: String(o.scan_name ?? o.alert_name ?? 'Chartink').slice(0, 80),
    stocks: stocks.filter((x) => !seen.has(x.symbol) && seen.add(x.symbol)),
  };
}

/** % of a price → points (0.05 tick, at least one tick). */
export const pctPoints = (price: number, pct: number) => Math.max(0.05, tick05((price * pct) / 100));
