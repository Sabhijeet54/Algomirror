import { canonicalFromParts } from './symbols';

/**
 * TradingView / Chartink alert → platform trade. The alert message is JSON, e.g.
 *   {"action":"BUY","underlying":"NIFTY","option":"CE","strike":"ATM","expiry":"nearest","lots":1,"spot":{{close}}}
 *   {"action":"SELL","exchange":"NFO","symbol":"NIFTY17NOV2625250CE","lots":2}
 *   {"action":"EXIT","underlying":"NIFTY"}            // square off this strategy's open NIFTY trades
 *   {"action":"EXIT_ALL"}                             // square off everything open in this strategy
 * TradingView's own placeholders work too: "action":"{{strategy.order.action}}" gives buy / sell.
 */
export type AlertAction = 'BUY' | 'SELL' | 'EXIT' | 'EXIT_ALL';
export type AlertProduct = 'INTRADAY' | 'DELIVERY' | 'CARRY_FORWARD';
export type AlertOrderType = 'MARKET' | 'LIMIT';

export interface AlertInput {
  action?: unknown;
  exchange?: unknown;
  symbol?: unknown;
  underlying?: unknown;
  option?: unknown;
  strike?: unknown;
  expiry?: unknown;
  spot?: unknown;
  lots?: unknown;
  qty?: unknown;
  product?: unknown;
  orderType?: unknown;
  price?: unknown;
  target?: unknown;
  stoploss?: unknown;
  targetPoints?: unknown;
  stoplossPoints?: unknown;
  trailPoints?: unknown;
}

export interface ParsedAlert {
  action: AlertAction;
  exchange: string;
  /** Exact platform symbol (when given). */
  symbol?: string;
  underlying?: string;
  /** CE / PE / FUT (derivatives by underlying). */
  option?: 'CE' | 'PE' | 'FUT';
  /** Number, or ATM / ATM+n / ATM-n (n strikes above / below the at-the-money strike). */
  strike?: number | { atmOffset: number };
  /** nearest (default) | next | monthly | YYYY-MM-DD */
  expiry: string;
  spot?: number;
  lots?: number;
  qty?: number;
  product: AlertProduct;
  orderType: AlertOrderType;
  price?: number;
  target?: number;
  stoploss?: number;
  targetPoints?: number;
  stoplossPoints?: number;
  /** Trailing stop loss step in points. */
  trailPoints?: number;
}

export class AlertError extends Error {}

const BSE_INDICES = new Set(['SENSEX', 'BANKEX', 'SENSEX50']);
const MCX_HINT = /^(CRUDEOIL|CRUDEOILM|NATURALGAS|NATGASMINI|GOLD|GOLDM|GOLDPETAL|SILVER|SILVERM|SILVERMIC|COPPER|ZINC|LEAD|ALUMINIUM|NICKEL)$/;
const EXCHANGES = new Set(['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD']);

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '');
const num = (v: unknown): number | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

/** Reads an alert body (object, or the raw text TradingView posts when the message isn't sent as JSON). */
export function readAlertBody(body: unknown): AlertInput {
  if (body && typeof body === 'object' && !Buffer.isBuffer(body)) return body as AlertInput;
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : typeof body === 'string' ? body : '';
  if (!text.trim()) throw new AlertError('Empty alert — put the JSON in the TradingView alert "Message" box.');
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object') return v as AlertInput;
  } catch {
    /* fall through */
  }
  throw new AlertError('Alert message is not valid JSON.');
}

export function parseAlert(input: AlertInput): ParsedAlert {
  const rawAction = str(input.action).toUpperCase().replace(/[\s-]+/g, '_');
  const action: AlertAction | null =
    rawAction === 'BUY' || rawAction === 'LONG'
      ? 'BUY'
      : rawAction === 'SELL' || rawAction === 'SHORT'
        ? 'SELL'
        : rawAction === 'EXIT' || rawAction === 'CLOSE' || rawAction === 'SQUARE_OFF' || rawAction === 'SQUAREOFF'
          ? 'EXIT'
          : rawAction === 'EXIT_ALL' || rawAction === 'CLOSE_ALL'
            ? 'EXIT_ALL'
            : null;
  if (!action) throw new AlertError('"action" must be BUY, SELL, EXIT or EXIT_ALL.');

  const symbol = str(input.symbol).toUpperCase().replace(/\s+/g, '') || undefined;
  const underlying = str(input.underlying).toUpperCase().replace(/\s+/g, '') || undefined;
  if (symbol && !/^[A-Z0-9&_-]{1,40}$/.test(symbol)) throw new AlertError('Invalid "symbol".');
  if (underlying && !/^[A-Z0-9&_-]{1,30}$/.test(underlying)) throw new AlertError('Invalid "underlying".');
  if (action !== 'EXIT_ALL' && !symbol && !underlying) throw new AlertError('Give "symbol" (exact contract) or "underlying" (e.g. NIFTY).');

  const rawOpt = str(input.option).toUpperCase();
  const option = rawOpt === 'CE' || rawOpt === 'CALL' ? 'CE' : rawOpt === 'PE' || rawOpt === 'PUT' ? 'PE' : rawOpt === 'FUT' || rawOpt === 'FUTURE' ? 'FUT' : undefined;
  if (rawOpt && !option) throw new AlertError('"option" must be CE, PE or FUT.');

  let exchange = str(input.exchange).toUpperCase();
  if (exchange && !EXCHANGES.has(exchange)) throw new AlertError(`Unknown exchange "${exchange}".`);
  if (!exchange) {
    const base = underlying ?? symbol ?? '';
    const derivative = !!option || (!!symbol && /\d/.test(symbol) && /(CE|PE|FUT)$/.test(symbol));
    if (MCX_HINT.test(underlying ?? '')) exchange = 'MCX';
    else if (derivative || (underlying && !symbol)) exchange = BSE_INDICES.has(base.replace(/\d.*$/, '')) ? 'BFO' : 'NFO';
    else exchange = 'NSE';
  }

  let strike: ParsedAlert['strike'];
  const rawStrike = str(input.strike).toUpperCase().replace(/\s+/g, '');
  if (rawStrike) {
    const m = /^ATM([+-]\d{1,2})?$/.exec(rawStrike);
    if (m) strike = { atmOffset: m[1] ? Number(m[1]) : 0 };
    else if (Number(rawStrike) > 0) strike = Number(rawStrike);
    else throw new AlertError('"strike" must be a number, ATM, ATM+1, ATM-2 …');
  }

  const expiry = str(input.expiry).toLowerCase() || 'nearest';
  if (!/^(nearest|next|monthly|\d{4}-\d{2}-\d{2})$/.test(expiry)) throw new AlertError('"expiry" must be nearest, next, monthly or YYYY-MM-DD.');

  const rawProduct = str(input.product).toUpperCase();
  const product: AlertProduct =
    !rawProduct || rawProduct === 'INTRADAY' || rawProduct === 'MIS'
      ? 'INTRADAY'
      : rawProduct === 'DELIVERY' || rawProduct === 'CNC'
        ? 'DELIVERY'
        : rawProduct === 'CARRY_FORWARD' || rawProduct === 'NRML' || rawProduct === 'CARRYFORWARD'
          ? 'CARRY_FORWARD'
          : (() => {
              throw new AlertError('"product" must be INTRADAY (MIS), DELIVERY (CNC) or CARRY_FORWARD (NRML).');
            })();
  const rawType = str(input.orderType).toUpperCase();
  const orderType: AlertOrderType = !rawType || rawType === 'MARKET' ? 'MARKET' : rawType === 'LIMIT' ? 'LIMIT' : (() => {
    throw new AlertError('"orderType" must be MARKET or LIMIT.');
  })();

  const out: ParsedAlert = { action, exchange, symbol, underlying, option, strike, expiry, product, orderType };
  const fields: [keyof ParsedAlert, unknown][] = [
    ['spot', input.spot],
    ['lots', input.lots],
    ['qty', input.qty],
    ['price', input.price],
    ['target', input.target],
    ['stoploss', input.stoploss],
    ['targetPoints', input.targetPoints],
    ['stoplossPoints', input.stoplossPoints],
    ['trailPoints', input.trailPoints],
  ];
  for (const [k, v] of fields) {
    const n = num(v);
    if (n == null) continue;
    if (n < 0) throw new AlertError(`"${k}" cannot be negative.`);
    (out as unknown as Record<string, number>)[k] = n;
  }
  if (out.lots != null && (!Number.isInteger(out.lots) || out.lots < 1)) throw new AlertError('"lots" must be a whole number ≥ 1.');
  if (out.qty != null && (!Number.isInteger(out.qty) || out.qty < 1)) throw new AlertError('"qty" must be a whole number ≥ 1.');
  if (orderType === 'LIMIT' && !out.price) throw new AlertError('A LIMIT order needs "price".');
  return out;
}

export interface ChainExpiry {
  date: string;
  lotSize: number;
  monthly: boolean;
  strikes: number[];
}

/** Picks the expiry: nearest (default), next, monthly or an exact date. */
export function pickExpiry(expiries: ChainExpiry[], want: string): ChainExpiry {
  if (!expiries.length) throw new AlertError('No live expiries for this underlying.');
  const e =
    want === 'next' ? expiries[1] : want === 'monthly' ? expiries.find((x) => x.monthly) : /^\d{4}-\d{2}-\d{2}$/.test(want) ? expiries.find((x) => x.date === want) : expiries[0];
  if (!e) throw new AlertError(`Expiry "${want}" not available (live: ${expiries.slice(0, 4).map((x) => x.date).join(', ')}).`);
  return e;
}

/** Strike for a number, or ATM ± n strikes around `spot`. */
export function pickStrike(strikes: number[], want: number | { atmOffset: number }, spot?: number): number {
  if (!strikes.length) throw new AlertError('No strikes listed for this expiry.');
  if (typeof want === 'number') {
    if (!strikes.includes(want)) throw new AlertError(`Strike ${want} is not listed for this expiry.`);
    return want;
  }
  if (!spot) throw new AlertError('ATM needs the underlying price — add "spot": {{close}} to the alert message.');
  let atm = 0;
  for (let i = 1; i < strikes.length; i++) if (Math.abs(strikes[i]! - spot) < Math.abs(strikes[atm]! - spot)) atm = i;
  const i = atm + want.atmOffset;
  if (i < 0 || i >= strikes.length) throw new AlertError(`ATM${want.atmOffset >= 0 ? '+' : ''}${want.atmOffset} is outside the strike list.`);
  return strikes[i]!;
}

/** Platform symbol of a derivative picked by underlying / expiry / strike. */
export function derivativeSymbol(underlying: string, expiry: string, option: 'CE' | 'PE' | 'FUT', strike: number | null): string {
  const s = canonicalFromParts(underlying, expiry, option === 'FUT' ? null : strike, option);
  if (!s) throw new AlertError('Could not build the contract symbol.');
  return s;
}

/** Target / stop loss: absolute prices win; else points from the entry price, in the trade's direction. */
export function exitLevels(a: Pick<ParsedAlert, 'target' | 'stoploss' | 'targetPoints' | 'stoplossPoints'>, side: 'BUY' | 'SELL', entry: number | null) {
  const dir = side === 'BUY' ? 1 : -1;
  const round = (n: number) => Math.round(n * 20) / 20; // 0.05 tick
  const targetPrice = a.target ?? (a.targetPoints && entry ? round(entry + dir * a.targetPoints) : undefined);
  const stop = a.stoploss ?? (a.stoplossPoints && entry ? round(entry - dir * a.stoplossPoints) : undefined);
  const stopLossPrice = stop != null && stop > 0 ? stop : undefined;
  if ((a.targetPoints || a.stoplossPoints) && !entry && a.target == null && a.stoploss == null) {
    throw new AlertError('Live price not available yet, so target / stop loss points can not be set — try again or send absolute "target" / "stoploss".');
  }
  return { targetPrice, stopLossPrice };
}

/** Does an open position's symbol belong to this underlying (NIFTY must not match NIFTYNXT50 or BANKNIFTY)? */
export function symbolOfUnderlying(symbol: string, underlying: string, option?: 'CE' | 'PE' | 'FUT'): boolean {
  if (!symbol.startsWith(underlying)) return false;
  const rest = symbol.slice(underlying.length);
  if (rest && !/^\d/.test(rest)) return false;
  return !option || symbol.endsWith(option);
}
