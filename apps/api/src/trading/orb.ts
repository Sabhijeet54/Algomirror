/**
 * ORB (opening range breakout), pure logic.
 *
 * The range is the high / low of the underlying from 09:15 IST for `rangeMinutes` (5 → 09:15–09:20, 15 → 09:15–09:30).
 * After that, the first live price above the range high buys a CALL and the first price below the range low buys a PUT,
 * straight away inside the running candle (no waiting for a candle close). Stop loss is on the option premium (points or %), target is
 * stop loss × ratio. All positions of the ORB are squared off at the exit time.
 */
import { AutomationError } from './automation-error';

export const ORB_RANGES = [5, 10, 15, 30] as const;
export type OrbRange = (typeof ORB_RANGES)[number];
export const ORB_OPEN = 9 * 60 + 15; // 09:15 IST in minutes
/** The range counts only when prices were seen from its first minute (no half range after a late start / restart). */
const START_GRACE_S = 60;

export interface OrbSettings {
  enabled: boolean;
  /** NIFTY, BANKNIFTY, SENSEX … (the range is built on its nearest future's price). */
  underlying: string;
  rangeMinutes: OrbRange;
  expiry: 'nearest' | 'next' | 'monthly';
  lots: number;
  /** Stop loss on the option premium: points, or % of the entry premium. Null = none. */
  stoploss: number | null;
  stoplossUnit: 'POINTS' | 'PCT';
  /** Target = stop loss × ratio (1 = 1:1, 2 = 1:2). Null = no target (exit at the exit time). */
  targetRatio: number | null;
  /** No new entry after this time (IST HH:MM). */
  lastEntry: string;
  /** Square off the ORB's positions at this time (IST HH:MM). */
  exitTime: string;
  /** Entries per day. A second entry is taken only on a breakout to the other side (the first position is closed). */
  maxEntries: number;
}

export const DEFAULT_ORB: OrbSettings = {
  enabled: false,
  underlying: 'NIFTY',
  rangeMinutes: 15,
  expiry: 'nearest',
  lots: 1,
  stoploss: null,
  stoplossUnit: 'POINTS',
  targetRatio: 2,
  lastEntry: '11:00',
  exitTime: '15:15',
  maxEntries: 1,
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Validates ORB settings sent by the master (throws AutomationError). */
export function normalizeOrb(raw: unknown): OrbSettings {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const d = DEFAULT_ORB;
  const underlying = String(o.underlying ?? d.underlying)
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9&_-]{2,30}$/.test(underlying)) throw new AutomationError('ORB: enter the underlying (e.g. NIFTY)');
  const rangeMinutes = Number(o.rangeMinutes ?? d.rangeMinutes) as OrbRange;
  if (!ORB_RANGES.includes(rangeMinutes)) throw new AutomationError('ORB: range must be 5, 10, 15 or 30 minutes');
  const lots = o.lots == null || o.lots === '' ? d.lots : Number(o.lots);
  if (!Number.isInteger(lots) || lots < 1 || lots > 100) throw new AutomationError('ORB: lots must be a whole number from 1 to 100');
  const stoplossUnit = String(o.stoplossUnit ?? 'POINTS').toUpperCase() === 'PCT' ? 'PCT' : 'POINTS';
  const stoploss = o.stoploss == null || o.stoploss === '' ? null : Number(o.stoploss);
  if (stoploss != null && (!Number.isFinite(stoploss) || stoploss <= 0)) throw new AutomationError('ORB: stop loss must be a positive number');
  if (stoploss != null && stoplossUnit === 'PCT' && stoploss >= 100) throw new AutomationError('ORB: stop loss % must be below 100');
  const targetRatio = o.targetRatio === undefined ? d.targetRatio : o.targetRatio === null || o.targetRatio === '' ? null : Number(o.targetRatio);
  if (targetRatio != null && (!Number.isFinite(targetRatio) || targetRatio <= 0 || targetRatio > 20)) throw new AutomationError('ORB: target ratio must be above 0 (e.g. 2 for 1:2)');
  const lastEntry = String(o.lastEntry || d.lastEntry);
  const exitTime = String(o.exitTime || d.exitTime);
  if (!TIME.test(lastEntry) || !TIME.test(exitTime)) throw new AutomationError('ORB: times must be HH:MM (24 hour, IST)');
  if (mins(lastEntry) <= ORB_OPEN + rangeMinutes) throw new AutomationError('ORB: last entry must be after the range ends');
  if (mins(exitTime) <= mins(lastEntry)) throw new AutomationError('ORB: exit time must be after the last entry time');
  const maxEntries = o.maxEntries == null || o.maxEntries === '' ? d.maxEntries : Number(o.maxEntries);
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 3) throw new AutomationError('ORB: entries per day must be 1, 2 or 3');
  return {
    enabled: o.enabled === true,
    underlying,
    rangeMinutes,
    expiry: (['nearest', 'next', 'monthly'] as const).find((e) => e === String(o.expiry ?? '').toLowerCase()) ?? 'nearest',
    lots,
    stoploss,
    stoplossUnit,
    targetRatio,
    lastEntry,
    exitTime,
    maxEntries,
  };
}

/** Day state of one ORB (kept in Redis so a restart neither loses the range nor repeats an entry). */
export interface OrbState {
  /** Range high / low; null until the first price inside the range window. */
  high: number | null;
  low: number | null;
  /** Prices were seen from the range's first minute. */
  fromStart: boolean;
  /** Range finished and logged. */
  ready: boolean;
  /** Range could not be used today (started late); nothing more happens. */
  skipped: boolean;
  /** Legacy (candle-close version); `close` is now just the last price seen after the range. */
  candle: number | null;
  close: number | null;
  entries: number;
  lastSide: 'CE' | 'PE' | null;
}

export const newOrbState = (): OrbState => ({ high: null, low: null, fromStart: false, ready: false, skipped: false, candle: null, close: null, entries: 0, lastSide: null });

export type OrbEvent =
  | { type: 'RANGE'; high: number; low: number }
  | { type: 'SKIP'; reason: string }
  | { type: 'ENTRY'; option: 'CE' | 'PE'; /** Price that broke the range. */ close: number; level: number };

/**
 * Feeds one price at `sec` seconds after IST midnight. Returns the new state and what happened. Once the range is
 * set, a price above its high (CALL) or below its low (PUT) enters at once; a later entry needs the other side.
 */
export function orbOnPrice(prev: OrbState, cfg: Pick<OrbSettings, 'rangeMinutes' | 'lastEntry' | 'maxEntries'>, sec: number, price: number): { state: OrbState; events: OrbEvent[] } {
  const s: OrbState = { ...prev };
  const events: OrbEvent[] = [];
  if (s.skipped || !(price > 0)) return { state: s, events };
  const open = ORB_OPEN * 60;
  const end = open + cfg.rangeMinutes * 60;
  if (sec < open) return { state: s, events };

  if (sec < end) {
    if (s.high == null) s.fromStart = sec < open + START_GRACE_S;
    s.high = Math.max(s.high ?? price, price);
    s.low = Math.min(s.low ?? price, price);
    return { state: s, events };
  }

  if (!s.ready) {
    if (s.high == null || s.low == null || !s.fromStart) {
      s.skipped = true;
      events.push({ type: 'SKIP', reason: s.high == null ? 'no price during the range' : 'prices missing from the start of the range (late start or restart)' });
      return { state: s, events };
    }
    s.ready = true;
    events.push({ type: 'RANGE', high: s.high, low: s.low });
  }

  // Live breakout: the first price beyond the range (strictly above the high / below the low) enters.
  const side = price > s.high! ? 'CE' : price < s.low! ? 'PE' : null;
  if (side && sec <= mins(cfg.lastEntry) * 60 && s.entries < cfg.maxEntries && side !== s.lastSide) {
    s.entries++;
    s.lastSide = side;
    events.push({ type: 'ENTRY', option: side, close: price, level: side === 'CE' ? s.high! : s.low! });
  }
  s.close = price;
  return { state: s, events };
}

/** Option alert body for an ORB entry (BUY the CALL / PUT at the money). */
export function orbAlert(cfg: OrbSettings, option: 'CE' | 'PE', spot: number): Record<string, unknown> {
  const pct = cfg.stoplossUnit === 'PCT';
  return {
    action: 'BUY',
    underlying: cfg.underlying,
    option,
    strike: 'ATM',
    spot,
    expiry: cfg.expiry,
    lots: cfg.lots,
    product: 'INTRADAY',
    ...(cfg.stoploss ? { [pct ? 'stoplossPct' : 'stoplossPoints']: cfg.stoploss } : {}),
    ...(cfg.stoploss && cfg.targetRatio ? { [pct ? 'targetPct' : 'targetPoints']: Math.round(cfg.stoploss * cfg.targetRatio * 100) / 100 } : {}),
  };
}
