/**
 * Derivative symbol formats.
 *
 * The platform uses ONE canonical format everywhere (signals, copy orders, positions, LTP keys):
 *   options  NAME + DD + MON + YY + STRIKE + CE|PE   e.g. NIFTY19OCT2622700PE, SENSEX15OCT2673800CE
 *   futures  NAME + DD + MON + YY + FUT              e.g. NIFTY27OCT26FUT
 * Brokers / exchanges name the same contract differently, e.g. BSE & Zerodha weekly options
 * SENSEX26O1573800CE (YY + month code + DD) or monthly SENSEX26OCT73800CE (YY + MON, no day).
 * Adapters convert at the edge: canonical → broker symbol when placing orders / subscribing, and
 * broker symbol → canonical when reading orders / positions.
 */

import { canonicalSymbol } from './broker-adapter';

export const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
/** Weekly month code used by NSE/BSE compact symbols: 1–9, O (Oct), N (Nov), D (Dec). */
const WEEK_CODE = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'O', 'N', 'D'];

export interface Derivative {
  name: string;
  yy: string;
  month: number; // 1–12
  dd: string;
  type: 'CE' | 'PE' | 'FUT';
  strike?: string;
}

const CANON = new RegExp(`^([A-Z&\\-]+?)(\\d{2})(${MONTHS.join('|')})(\\d{2})(?:(\\d+(?:\\.\\d+)?)(CE|PE)|(FUT))$`);
const COMPACT_WEEKLY = /^([A-Z&\-]+?)(\d{2})([1-9OND])(\d{2})(\d+(?:\.\d+)?)(CE|PE)$/;

/** Parses a canonical derivative symbol (null for equities / unknown formats). */
export function parseCanonical(symbol: string): Derivative | null {
  const m = CANON.exec(symbol.toUpperCase());
  if (!m) return null;
  return { name: m[1]!, dd: m[2]!, month: MONTHS.indexOf(m[3]!) + 1, yy: m[4]!, ...(m[7] ? { type: 'FUT' as const } : { type: m[6] as 'CE' | 'PE', strike: m[5]! }) };
}

export function canonicalFrom(d: Derivative): string {
  const mon = MONTHS[d.month - 1]!;
  return d.type === 'FUT' ? `${d.name}${d.dd}${mon}${d.yy}FUT` : `${d.name}${d.dd}${mon}${d.yy}${Number(d.strike)}${d.type}`;
}

/** Canonical symbol from instrument-master fields (expiry YYYY-MM-DD). */
export function canonicalFromParts(name: string, expiry: string, strike: number | string | null, type: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(expiry);
  const t = type.toUpperCase();
  if (!m || !name || (t !== 'CE' && t !== 'PE' && t !== 'FUT')) return null;
  return canonicalFrom({ name: name.toUpperCase().replace(/\s+/g, ''), yy: m[1]!.slice(2), month: Number(m[2]), dd: m[3]!, type: t, strike: strike == null ? undefined : String(strike) });
}

/** Every name a broker might use for this contract (canonical first). */
export function symbolVariants(symbol: string): string[] {
  const sym = symbol.toUpperCase();
  const d = parseCanonical(sym);
  if (!d) return [sym];
  const mon = MONTHS[d.month - 1]!;
  const strike = d.strike != null ? String(Number(d.strike)) : '';
  const out =
    d.type === 'FUT'
      ? [sym, `${d.name}${d.yy}${mon}FUT`]
      : [sym, `${d.name}${d.yy}${WEEK_CODE[d.month - 1]}${d.dd}${strike}${d.type}`, `${d.name}${d.yy}${mon}${strike}${d.type}`, `${d.name}${d.yy}${mon}${d.dd}${strike}${d.type}`];
  return [...new Set(out)];
}

/**
 * Broker symbol → canonical, when it can be decided from the symbol alone (compact weekly options).
 * Monthly symbols without a day need the instrument master (see InstrumentsService).
 */
export function normalizeBrokerSymbol(symbol: string): string {
  const sym = canonicalSymbol(symbol);
  const m = COMPACT_WEEKLY.exec(sym);
  if (!m) return sym;
  const month = WEEK_CODE.indexOf(m[3]!) + 1;
  const dd = Number(m[4]);
  if (!month || dd < 1 || dd > 31) return sym;
  return canonicalFrom({ name: m[1]!, yy: m[2]!, month, dd: m[4]!, type: m[6] as 'CE' | 'PE', strike: m[5]! });
}

/**
 * Kite (Zerodha) instrument master, registered by InstrumentsService so broker adapters (plain classes,
 * no DI) can map symbols both ways.
 */
export interface KiteSymbolResolver {
  ensure(exchange: string): Promise<void>;
  toKite(exchange: string, canonical: string): string | undefined;
  fromKite(exchange: string, kiteSymbol: string): string | undefined;
}
export const kiteSymbols: { resolver?: KiteSymbolResolver } = {};

export const DERIVATIVE_EXCHANGES = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD']);
