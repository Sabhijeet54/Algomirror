import { randomBytes } from 'node:crypto';
import type { Exchange, OrderStatus, OrderType, ProductType } from '@ctp/database';
import { fetch as undiciFetch } from 'undici';
import { BrokerInstrumentStore, headerIndex, parseCsv, type BrokerInstrument } from '../market-data/broker-instruments';
import { BrokerApiError, brokerFetch } from '../brokers/broker-http';
import {
  AdapterOptions,
  assertCanTrade,
  BrokerAdapter,
  BrokerFunds,
  BrokerHolding,
  BrokerOrder,
  BrokerPosition,
  canonicalSymbol,
  FO_EXCHANGES,
  ModifyOrderInput,
  num,
  PlaceOrderInput,
  toExchange,
} from './broker-adapter';
import { canonicalFromParts, normalizeBrokerSymbol } from './symbols';

export const GROWW_API_ROOT = 'https://api.groww.in/v1';
const INSTRUMENTS_URL = 'https://growwapi-assets.groww.in/instruments/instrument.csv';

/** Platform exchange ↔ Groww (exchange, segment). */
const OUT: Record<string, { exchange: string; segment: string }> = {
  NSE: { exchange: 'NSE', segment: 'CASH' },
  BSE: { exchange: 'BSE', segment: 'CASH' },
  NFO: { exchange: 'NSE', segment: 'FNO' },
  BFO: { exchange: 'BSE', segment: 'FNO' },
  MCX: { exchange: 'MCX', segment: 'COMMODITY' },
};
const IN: Record<string, string> = Object.fromEntries(Object.entries(OUT).map(([k, v]) => [`${v.exchange}:${v.segment}`, k]));
/** Segments queried for the order book / positions. */
const SEGMENTS = ['CASH', 'FNO'];

const PRODUCT_OUT: Record<ProductType, string> = { DELIVERY: 'CNC', INTRADAY: 'MIS', CARRY_FORWARD: 'NRML' };
const PRODUCT_IN: Record<string, ProductType> = { CNC: 'DELIVERY', MIS: 'INTRADAY', NRML: 'CARRY_FORWARD' };
const TYPE_OUT: Record<OrderType, string> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', SL_M: 'SL_M' };
const TYPE_IN: Record<string, OrderType> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', SL_M: 'SL_M' };

export function growwStatus(s: string): OrderStatus {
  const v = (s ?? '').toUpperCase();
  if (v === 'EXECUTED' || v === 'COMPLETED' || v === 'DELIVERY_AWAITED') return 'FILLED';
  if (v === 'REJECTED' || v === 'FAILED') return 'REJECTED';
  if (v === 'CANCELLED') return 'CANCELLED';
  if (['NEW', 'ACKED', 'OPEN', 'TRIGGER_PENDING', 'APPROVED', 'CANCELLATION_REQUESTED', 'MODIFICATION_REQUESTED'].includes(v)) return 'OPEN';
  return 'UNKNOWN';
}

/** Groww order_reference_id: 8–20 alphanumerics, at most two hyphens. Keeps our "ctp…" tag as the prefix. */
export function growwReference(tag?: string): string {
  const prefix = (tag ?? 'ctp').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'ctp';
  const rand = randomBytes(8).toString('hex');
  return `${prefix}-${rand}`.slice(0, 20);
}

/** "2026-11-10T10:15:30" (IST, no zone) → Date. */
function istTime(s: unknown): Date {
  if (!s) return new Date();
  const v = String(s).replace(' ', 'T');
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}+05:30`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Next 05:55 IST (Groww tokens die at 6:00 AM). */
function next555(now = new Date()): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const at = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 5, 55) - 330 * 60_000;
  return new Date(at > now.getTime() ? at : at + 86_400_000);
}

/** Groww instrument master: one public CSV for NSE / BSE cash + F&O (and MCX). Key = trading_symbol. */
export const growwInstruments = new BrokerInstrumentStore(
  'Groww',
  (ex) => (OUT[ex] ? 'ALL' : undefined),
  async () => {
    const res = await undiciFetch(INSTRUMENTS_URL, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseCsv(await res.text());
    const col = headerIndex(rows[0] ?? []);
    const iEx = col('exchange'), iSeg = col('segment'), iTs = col('trading_symbol'), iType = col('instrument_type');
    const iSeries = col('series'), iUnder = col('underlying_symbol'), iExp = col('expiry_date'), iStrike = col('strike_price'), iLot = col('lot_size');
    if (iEx < 0 || iSeg < 0 || iTs < 0 || iType < 0) throw new Error('unexpected Groww instrument header');
    const out: BrokerInstrument[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]!;
      const exchange = IN[`${(r[iEx] ?? '').toUpperCase()}:${(r[iSeg] ?? '').toUpperCase()}`];
      const ts = (r[iTs] ?? '').trim().toUpperCase();
      if (!exchange || !ts) continue;
      const type = (r[iType] ?? '').toUpperCase();
      let symbol: string | null = null;
      if (type === 'CE' || type === 'PE' || type === 'FUT') {
        symbol = canonicalFromParts((r[iUnder] ?? '').trim(), (r[iExp] ?? '').trim(), type === 'FUT' ? null : Number(r[iStrike]), type);
      } else if (type === 'EQ' || type === 'IDX') {
        const series = (r[iSeries] ?? '').toUpperCase();
        if (exchange === 'NSE' && series && series !== 'EQ' && series !== 'BE') continue;
        symbol = ts;
      }
      if (!symbol) continue;
      out.push({ exchange, symbol, key: ts, lotSize: Number(r[iLot]) || 1, tradingSymbol: ts });
    }
    return out;
  },
);

interface GrowwEnvelope<T> {
  status?: string;
  payload?: T;
  error?: { code?: string; message?: string };
}

/**
 * Groww Trade API adapter (REST, v1). Contracts are named by Groww's trading_symbol + (exchange, segment).
 * Orders need the client's static IP whitelisted on the Groww API key (SEBI).
 */
export class GrowwAdapter implements BrokerAdapter {
  readonly broker = 'GROWW';

  constructor(
    private readonly accessToken: string,
    private readonly proxyUrl?: string,
    private readonly opts?: AdapterOptions,
  ) {}

  private async call<T>(path: string, method: 'GET' | 'POST' = 'GET', payload?: object): Promise<T> {
    const { status: http, body } = await brokerFetch<GrowwEnvelope<T>>(`${GROWW_API_ROOT}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        'X-API-VERSION': '1.0',
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      proxyUrl: this.proxyUrl,
    });
    if (http === 401) throw new BrokerApiError('Groww session expired — reconnect.', 401, 'TOKEN_EXPIRED');
    if (http < 200 || http >= 300 || (body?.status && body.status !== 'SUCCESS')) {
      throw new BrokerApiError(body?.error?.message || `Groww request failed (HTTP ${http}).`, http, body?.error?.code);
    }
    return body?.payload as T;
  }

  private async instrument(exchange: string, symbol: string): Promise<BrokerInstrument> {
    await growwInstruments.ensure(exchange);
    const hit = growwInstruments.get(exchange, canonicalSymbol(symbol));
    if (!hit) throw new BrokerApiError(`Groww: instrument ${exchange}:${symbol} not found in Groww's instrument list.`);
    return hit;
  }

  private async decode(ex: unknown, seg: unknown, ts: unknown): Promise<{ exchange: Exchange; symbol: string }> {
    const platform = IN[`${String(ex ?? 'NSE').toUpperCase()}:${String(seg ?? 'CASH').toUpperCase()}`] ?? 'NSE';
    const raw = String(ts ?? '').toUpperCase();
    await growwInstruments.ensure(platform).catch(() => undefined);
    const hit = growwInstruments.fromKey(platform, raw) ?? growwInstruments.fromKey(platform, raw.replace(/-(EQ|BE)$/, ''));
    return { exchange: toExchange(platform), symbol: hit?.symbol ?? normalizeBrokerSymbol(raw) };
  }

  private segmentOf(exchange: string): { exchange: string; segment: string } {
    const s = OUT[exchange];
    if (!s) throw new BrokerApiError(`Groww does not support exchange ${exchange}.`);
    return s;
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const inst = await this.instrument(o.exchange, o.symbol);
    const seg = this.segmentOf(o.exchange);
    const d = await this.call<{ groww_order_id?: string }>('/order/create', 'POST', {
      trading_symbol: inst.tradingSymbol ?? inst.key,
      quantity: o.quantity,
      price: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? o.price : 0,
      trigger_price: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? o.triggerPrice : undefined,
      validity: 'DAY',
      exchange: seg.exchange,
      segment: seg.segment,
      product: PRODUCT_OUT[o.productType],
      order_type: TYPE_OUT[o.orderType],
      transaction_type: o.side,
      order_reference_id: growwReference(o.tag),
    });
    if (!d?.groww_order_id) throw new BrokerApiError('Groww did not return an order id.');
    return { brokerOrderId: String(d.groww_order_id) };
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    await this.call('/order/modify', 'POST', {
      groww_order_id: o.brokerOrderId,
      segment: this.segmentOf(o.exchange).segment,
      order_type: TYPE_OUT[o.orderType],
      quantity: o.quantity,
      price: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? o.price : 0,
      trigger_price: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? o.triggerPrice : undefined,
    });
  }

  /** Groww needs the segment to cancel — find the order in the day's book. */
  async cancelOrder(brokerOrderId: string): Promise<void> {
    const row = (await this.rawOrders()).find((r) => String(r.groww_order_id) === brokerOrderId);
    if (!row) throw new BrokerApiError('Groww: order not found in today’s order book.');
    await this.call('/order/cancel', 'POST', { segment: row.segment ?? 'CASH', groww_order_id: brokerOrderId });
  }

  private async rawOrders(): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    for (const segment of SEGMENTS) {
      for (let page = 0; page < 20; page++) {
        const d = await this.call<{ order_list?: Record<string, unknown>[] }>(`/order/list?segment=${segment}&page=${page}&page_size=100`);
        const list = Array.isArray(d?.order_list) ? d.order_list : [];
        out.push(...list.map((r) => ({ segment, ...r })));
        if (list.length < 100) break;
      }
    }
    return out;
  }

  async orders(): Promise<BrokerOrder[]> {
    const out: BrokerOrder[] = [];
    for (const r of await this.rawOrders()) {
      const { exchange, symbol } = await this.decode(r.exchange, r.segment, r.trading_symbol);
      out.push({
        brokerOrderId: String(r.groww_order_id),
        exchange,
        symbol,
        side: String(r.transaction_type).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        orderType: TYPE_IN[String(r.order_type).toUpperCase()] ?? 'MARKET',
        productType: PRODUCT_IN[String(r.product).toUpperCase()] ?? (FO_EXCHANGES.includes(exchange) ? 'CARRY_FORWARD' : 'INTRADAY'),
        quantity: Number(r.quantity) || 0,
        filledQuantity: Number(r.filled_quantity) || 0,
        price: num(r.price),
        averagePrice: num(r.average_fill_price),
        triggerPrice: num(r.trigger_price),
        status: growwStatus(String(r.order_status)),
        statusMessage: r.remark ? String(r.remark) : undefined,
        tag: r.order_reference_id ? String(r.order_reference_id) : undefined,
        timestamp: istTime(r.exchange_time || r.created_at),
        raw: r,
      });
    }
    return out;
  }

  async positions(): Promise<BrokerPosition[]> {
    const out: BrokerPosition[] = [];
    for (const segment of SEGMENTS) {
      const d = await this.call<{ positions?: Record<string, unknown>[] }>(`/positions/user?segment=${segment}`);
      for (const p of Array.isArray(d?.positions) ? d.positions : []) {
        const { exchange, symbol } = await this.decode(p.exchange, p.segment ?? segment, p.trading_symbol);
        out.push({
          exchange,
          symbol,
          productType: PRODUCT_IN[String(p.product).toUpperCase()] ?? (FO_EXCHANGES.includes(exchange) ? 'CARRY_FORWARD' : 'INTRADAY'),
          quantity: Number(p.quantity) || 0,
          averagePrice: num(p.net_price) ?? 0,
          lastPrice: null,
          pnl: num(p.realised_pnl),
        });
      }
    }
    return out;
  }

  async holdings(): Promise<BrokerHolding[]> {
    const d = await this.call<{ holdings?: Record<string, unknown>[] }>('/holdings/user');
    return (Array.isArray(d?.holdings) ? d.holdings : []).map((h) => ({
      exchange: 'NSE' as Exchange,
      symbol: canonicalSymbol(String(h.trading_symbol ?? '')),
      quantity: Number(h.quantity) || 0,
      averagePrice: num(h.average_price) ?? 0,
      lastPrice: null,
      pnl: null,
    }));
  }

  async funds(): Promise<BrokerFunds> {
    const d = await this.call<Record<string, unknown> & { equity_margin_details?: Record<string, unknown> }>('/margins/detail/user');
    return { availableCash: num(d?.equity_margin_details?.cnc_balance_available) ?? num(d?.clear_cash), net: num(d?.clear_cash) };
  }

  async ltp(exchange: Exchange, symbol: string): Promise<number | null> {
    try {
      const inst = await this.instrument(exchange, symbol);
      const seg = this.segmentOf(exchange);
      const key = `${seg.exchange}_${inst.tradingSymbol ?? inst.key}`;
      const d = await this.call<Record<string, number | { ltp?: number }>>(`/live-data/ltp?segment=${seg.segment}&exchange_symbols=${encodeURIComponent(key)}`);
      const v = d?.[key];
      return num(typeof v === 'object' && v ? v.ltp : v);
    } catch {
      return null;
    }
  }
}

/** Groww login: TOTP-type API key + 6-digit TOTP → access token (valid till 6:00 AM). */
export class GrowwClient {
  constructor(private readonly proxyUrl?: string) {}

  async loginWithTotp(apiKey: string, totpCode: string): Promise<{ accessToken: string; expiresAt: Date }> {
    type TokenBody = { token?: string; expiry?: string };
    const { status: http, body } = await brokerFetch<TokenBody & GrowwEnvelope<TokenBody>>(`${GROWW_API_ROOT}/token/api/access`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key_type: 'totp', totp: totpCode }),
      proxyUrl: this.proxyUrl,
    });
    const t = body?.token ? body : body?.payload;
    if (http < 200 || http >= 300 || !t?.token) {
      throw new BrokerApiError(body?.error?.message || `Groww login failed (HTTP ${http}). Check the API key (TOTP type) and TOTP secret.`, http, body?.error?.code);
    }
    const exp = t.expiry ? istTime(t.expiry) : null;
    return { accessToken: t.token, expiresAt: exp && exp.getTime() > Date.now() ? exp : next555() };
  }
}
