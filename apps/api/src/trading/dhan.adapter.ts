import type { Exchange, OrderStatus, OrderType, ProductType } from '@ctp/database';
import { fetch as undiciFetch } from 'undici';
import { BrokerInstrumentStore, headerIndex, csvRows, type BrokerInstrument } from '../market-data/broker-instruments';
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

export const DHAN_API_ROOT = 'https://api.dhan.co/v2';
const AUTH_ROOT = 'https://auth.dhan.co';
const SCRIP_MASTER = 'https://images.dhan.co/api-data/api-scrip-master.csv';

/** Platform exchange ↔ Dhan exchangeSegment. */
const SEG_OUT: Record<string, string> = { NSE: 'NSE_EQ', BSE: 'BSE_EQ', NFO: 'NSE_FNO', BFO: 'BSE_FNO', MCX: 'MCX_COMM', CDS: 'NSE_CURRENCY', BCD: 'BSE_CURRENCY' };
const SEG_IN: Record<string, string> = Object.fromEntries(Object.entries(SEG_OUT).map(([k, v]) => [v, k]));
/** Scrip master (exchange id + segment letter) → platform exchange. */
const MASTER_EX: Record<string, string> = { 'NSE:E': 'NSE', 'BSE:E': 'BSE', 'NSE:D': 'NFO', 'BSE:D': 'BFO', 'MCX:M': 'MCX', 'NSE:C': 'CDS', 'BSE:C': 'BCD' };

const PRODUCT_OUT: Record<ProductType, string> = { DELIVERY: 'CNC', INTRADAY: 'INTRADAY', CARRY_FORWARD: 'MARGIN' };
const PRODUCT_IN: Record<string, ProductType> = { CNC: 'DELIVERY', INTRADAY: 'INTRADAY', MARGIN: 'CARRY_FORWARD', MTF: 'DELIVERY', CO: 'INTRADAY', BO: 'INTRADAY' };
const TYPE_OUT: Record<OrderType, string> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'STOP_LOSS', SL_M: 'STOP_LOSS_MARKET' };
const TYPE_IN: Record<string, OrderType> = { MARKET: 'MARKET', LIMIT: 'LIMIT', STOP_LOSS: 'SL', STOP_LOSS_MARKET: 'SL_M' };

function status(s: string): OrderStatus {
  const v = (s ?? '').toUpperCase();
  if (v === 'TRADED') return 'FILLED';
  if (v === 'REJECTED') return 'REJECTED';
  if (v === 'CANCELLED' || v === 'EXPIRED') return 'CANCELLED';
  if (v === 'PENDING' || v === 'TRANSIT' || v === 'PART_TRADED' || v === 'TRIGGERED') return 'OPEN';
  return 'UNKNOWN';
}

/** "2026-10-16 10:15:30" (IST) → Date. */
function istTime(s: unknown): Date {
  const d = s ? new Date(`${String(s).replace(' ', 'T')}+05:30`) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Dhan scrip master: one public CSV for every exchange (security id per segment). */
export const dhanInstruments = new BrokerInstrumentStore(
  'Dhan',
  (ex) => (SEG_OUT[ex] ? 'ALL' : undefined),
  async () => {
    const res = await undiciFetch(SCRIP_MASTER, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = csvRows(await res.text());
    const col = headerIndex(rows.next().value ?? []);
    const iEx = col('SEM_EXM_EXCH_ID', 'EXCH_ID'), iSeg = col('SEM_SEGMENT', 'SEGMENT'), iId = col('SEM_SMST_SECURITY_ID', 'SECURITY_ID');
    const iInst = col('SEM_INSTRUMENT_NAME', 'INSTRUMENT'), iTs = col('SEM_TRADING_SYMBOL'), iLot = col('SEM_LOT_UNITS', 'LOT_SIZE');
    const iExp = col('SEM_EXPIRY_DATE', 'SM_EXPIRY_DATE'), iStrike = col('SEM_STRIKE_PRICE', 'STRIKE_PRICE'), iOpt = col('SEM_OPTION_TYPE', 'OPTION_TYPE');
    const iSeries = col('SEM_SERIES', 'SERIES'), iUnder = col('UNDERLYING_SYMBOL');
    if (iEx < 0 || iSeg < 0 || iId < 0 || iTs < 0) throw new Error('unexpected Dhan scrip master header');
    const out: BrokerInstrument[] = [];
    for (const r of rows) {
      const exchange = MASTER_EX[`${r[iEx]}:${r[iSeg]}`];
      if (!exchange || !r[iId]) continue;
      const inst = (r[iInst] ?? '').toUpperCase();
      const ts = (r[iTs] ?? '').trim().toUpperCase();
      let symbol: string | null = null;
      if (inst.startsWith('OPT') || inst.startsWith('FUT')) {
        const type = inst.startsWith('FUT') ? 'FUT' : (r[iOpt] ?? '').toUpperCase();
        const under = (iUnder >= 0 && r[iUnder] ? r[iUnder]! : ts.split('-')[0] ?? '').toUpperCase();
        symbol = canonicalFromParts(under, (r[iExp] ?? '').slice(0, 10), type === 'FUT' ? null : Number(r[iStrike]), type);
      } else if (inst === 'EQUITY') {
        const series = (r[iSeries] ?? '').toUpperCase();
        if (exchange === 'NSE' && series && series !== 'EQ' && series !== 'BE') continue;
        symbol = ts || null;
      }
      if (!symbol) continue;
      out.push({ exchange, symbol, key: r[iId]!.trim(), lotSize: Number(r[iLot]) || 1, tradingSymbol: ts });
    }
    return out;
  },
);

interface DhanError {
  errorCode?: string;
  errorMessage?: string;
  errorType?: string;
  internalErrorMessage?: string;
}

/**
 * DhanHQ v2 REST adapter. Contracts are identified by (exchangeSegment, securityId) from Dhan's public
 * scrip master. Orders need the client's static IP whitelisted with Dhan (SEBI, from 1 April 2026).
 */
export class DhanAdapter implements BrokerAdapter {
  readonly broker = 'DHAN';

  constructor(
    private readonly clientId: string,
    private readonly accessToken: string,
    private readonly proxyUrl?: string,
    private readonly opts?: AdapterOptions,
  ) {}

  private async call<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', payload?: object): Promise<T> {
    const { status: http, body } = await brokerFetch<T & DhanError>(`${DHAN_API_ROOT}${path}`, {
      method,
      headers: { 'access-token': this.accessToken, 'client-id': this.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: payload ? JSON.stringify(payload) : undefined,
      proxyUrl: this.proxyUrl,
    });
    if (http < 200 || http >= 300 || (body && (body as DhanError).errorCode)) {
      const e = body as DhanError | undefined;
      throw new BrokerApiError(e?.errorMessage || e?.internalErrorMessage || `Dhan request failed (HTTP ${http}).`, http, e?.errorCode);
    }
    return body;
  }

  private async instrument(exchange: string, symbol: string): Promise<BrokerInstrument> {
    await dhanInstruments.ensure(exchange);
    const hit = dhanInstruments.get(exchange, canonicalSymbol(symbol));
    if (!hit) throw new BrokerApiError(`Dhan: instrument ${exchange}:${symbol} not found in Dhan's scrip master.`);
    return hit;
  }

  private async decode(seg: unknown, id: unknown, ts: unknown): Promise<{ exchange: Exchange; symbol: string }> {
    const ex = SEG_IN[String(seg)] ?? 'NSE';
    await dhanInstruments.ensure(ex).catch(() => undefined);
    const hit = dhanInstruments.fromKey(ex, String(id ?? ''));
    return { exchange: toExchange(ex), symbol: hit?.symbol ?? normalizeBrokerSymbol(String(ts ?? '').replace(/-/g, '')) };
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const inst = await this.instrument(o.exchange, o.symbol);
    const d = await this.call<{ orderId?: string }>('/orders', 'POST', {
      dhanClientId: this.clientId,
      correlationId: o.tag ? o.tag.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 30) : undefined,
      transactionType: o.side,
      exchangeSegment: SEG_OUT[o.exchange],
      productType: PRODUCT_OUT[o.productType],
      orderType: TYPE_OUT[o.orderType],
      validity: 'DAY',
      securityId: inst.key,
      quantity: o.quantity,
      disclosedQuantity: 0,
      price: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? o.price : 0,
      triggerPrice: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? o.triggerPrice : 0,
      afterMarketOrder: false,
    });
    if (!d?.orderId) throw new BrokerApiError('Dhan did not return an order id.');
    return { brokerOrderId: String(d.orderId) };
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    await this.call(`/orders/${encodeURIComponent(o.brokerOrderId)}`, 'PUT', {
      dhanClientId: this.clientId,
      orderId: o.brokerOrderId,
      orderType: TYPE_OUT[o.orderType],
      quantity: o.quantity,
      price: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? o.price : 0,
      triggerPrice: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? o.triggerPrice : 0,
      disclosedQuantity: 0,
      validity: 'DAY',
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.call(`/orders/${encodeURIComponent(brokerOrderId)}`, 'DELETE');
  }

  async orders(): Promise<BrokerOrder[]> {
    const rows = (await this.call<Record<string, unknown>[]>('/orders')) ?? [];
    const out: BrokerOrder[] = [];
    for (const r of Array.isArray(rows) ? rows : []) {
      const { exchange, symbol } = await this.decode(r.exchangeSegment, r.securityId, r.tradingSymbol);
      out.push({
        brokerOrderId: String(r.orderId),
        exchange,
        symbol,
        instrumentToken: r.securityId ? String(r.securityId) : undefined,
        side: String(r.transactionType) === 'SELL' ? 'SELL' : 'BUY',
        orderType: TYPE_IN[String(r.orderType)] ?? 'MARKET',
        productType: PRODUCT_IN[String(r.productType)] ?? 'INTRADAY',
        quantity: Number(r.quantity) || 0,
        filledQuantity: Number(r.filledQty) || 0,
        price: num(r.price),
        averagePrice: num(r.averageTradedPrice),
        triggerPrice: num(r.triggerPrice),
        status: status(String(r.orderStatus)),
        statusMessage: r.omsErrorDescription ? String(r.omsErrorDescription) : undefined,
        tag: r.correlationId ? String(r.correlationId) : undefined,
        timestamp: istTime(r.exchangeTime && r.exchangeTime !== 'NA' ? r.exchangeTime : r.createTime),
        raw: r,
      });
    }
    return out;
  }

  async positions(): Promise<BrokerPosition[]> {
    const rows = (await this.call<Record<string, unknown>[]>('/positions')) ?? [];
    const out: BrokerPosition[] = [];
    for (const p of Array.isArray(rows) ? rows : []) {
      const { exchange, symbol } = await this.decode(p.exchangeSegment, p.securityId, p.tradingSymbol);
      const net = Number(p.netQty) || 0;
      out.push({
        exchange,
        symbol,
        productType: PRODUCT_IN[String(p.productType)] ?? (FO_EXCHANGES.includes(exchange) ? 'CARRY_FORWARD' : 'INTRADAY'),
        quantity: net,
        averagePrice: num(net >= 0 ? p.buyAvg : p.sellAvg) ?? num(p.costPrice) ?? 0,
        lastPrice: null,
        pnl: (num(p.realizedProfit) ?? 0) + (num(p.unrealizedProfit) ?? 0),
      });
    }
    return out;
  }

  async holdings(): Promise<BrokerHolding[]> {
    let rows: Record<string, unknown>[] = [];
    try {
      rows = (await this.call<Record<string, unknown>[]>('/holdings')) ?? [];
    } catch (err) {
      // Dhan answers an error (not []) when the demat has no holdings.
      if (err instanceof BrokerApiError && /no holdings|DH-907/i.test(`${err.message} ${err.brokerCode}`)) return [];
      throw err;
    }
    return (Array.isArray(rows) ? rows : []).map((h) => ({
      exchange: toExchange(/^(NSE|BSE)$/.test(String(h.exchange)) ? String(h.exchange) : 'NSE'),
      symbol: canonicalSymbol(String(h.tradingSymbol ?? '')),
      quantity: Number(h.totalQty) || 0,
      averagePrice: num(h.avgCostPrice) ?? 0,
      lastPrice: null,
      pnl: null,
    }));
  }

  async funds(): Promise<BrokerFunds> {
    const d = await this.call<Record<string, unknown>>('/fundlimit');
    return { availableCash: num(d?.availabelBalance ?? d?.availableBalance), net: num(d?.sodLimit) };
  }

  async ltp(exchange: Exchange, symbol: string): Promise<number | null> {
    try {
      const inst = await this.instrument(exchange, symbol);
      const seg = SEG_OUT[exchange]!;
      const d = await this.call<{ data?: Record<string, Record<string, { last_price?: number }>> }>('/marketfeed/ltp', 'POST', { [seg]: [Number(inst.key)] });
      return num(d?.data?.[seg]?.[inst.key]?.last_price);
    } catch {
      return null;
    }
  }
}

/** Dhan login: access token from client ID + PIN + TOTP (valid 24 h), or a pasted token checked against the API. */
export class DhanClient {
  constructor(private readonly proxyUrl?: string) {}

  async loginWithTotp(clientId: string, pin: string, totpCode: string): Promise<{ accessToken: string; clientId: string; expiresAt: Date }> {
    const u = new URL(`${AUTH_ROOT}/app/generateAccessToken`);
    u.searchParams.set('dhanClientId', clientId);
    u.searchParams.set('pin', pin);
    u.searchParams.set('totp', totpCode);
    const { status: http, body } = await brokerFetch<{ accessToken?: string; dhanClientId?: string; expiryTime?: string; message?: string } & DhanError>(u.toString(), {
      method: 'POST',
      headers: { Accept: 'application/json' },
      proxyUrl: this.proxyUrl,
    });
    if (http !== 200 || !body?.accessToken) {
      throw new BrokerApiError(body?.errorMessage || body?.message || `Dhan login failed (HTTP ${http}). Check client ID, PIN and TOTP.`, http, body?.errorCode);
    }
    const exp = body.expiryTime ? new Date(/[+Z]/.test(body.expiryTime.slice(10)) ? body.expiryTime : `${body.expiryTime}+05:30`) : null;
    return {
      accessToken: body.accessToken,
      clientId: String(body.dhanClientId ?? clientId),
      expiresAt: exp && !Number.isNaN(exp.getTime()) ? exp : new Date(Date.now() + 23.5 * 3600_000),
    };
  }

  /** Validates a token by reading the fund limit; returns the Dhan client id. */
  async check(clientId: string, accessToken: string): Promise<void> {
    await new DhanAdapter(clientId, accessToken, this.proxyUrl).funds();
  }
}
