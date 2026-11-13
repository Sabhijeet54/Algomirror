import type { Exchange, OrderStatus, OrderType, ProductType } from '@ctp/database';
import { DERIVATIVE_EXCHANGES, normalizeBrokerSymbol, symbolVariants } from './symbols';
import { angelScripMaster } from '../market-data/angel-scrip-master';
import { BrokerApiError, brokerFetch } from '../brokers/broker-http';
import { Throttle } from '../brokers/throttle';
import {
  AdapterOptions,
  assertCanTrade,
  BrokerAdapter,
  BrokerFunds,
  BrokerHolding,
  BrokerOrder,
  BrokerPosition,
  canonicalSymbol,
  ModifyOrderInput,
  num,
  PlaceOrderInput,
  toExchange,
} from './broker-adapter';

export const ANGEL_API_ROOT = 'https://apiconnect.angelone.in';
const API_ROOT = ANGEL_API_ROOT;

const PRODUCT_OUT: Record<ProductType, string> = { DELIVERY: 'DELIVERY', INTRADAY: 'INTRADAY', CARRY_FORWARD: 'CARRYFORWARD' };
const PRODUCT_IN: Record<string, ProductType> = { DELIVERY: 'DELIVERY', INTRADAY: 'INTRADAY', CARRYFORWARD: 'CARRY_FORWARD', MARGIN: 'CARRY_FORWARD' };
const TYPE_OUT: Record<OrderType, string> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'STOPLOSS_LIMIT', SL_M: 'STOPLOSS_MARKET' };
const TYPE_IN: Record<string, OrderType> = { MARKET: 'MARKET', LIMIT: 'LIMIT', STOPLOSS_LIMIT: 'SL', STOPLOSS_MARKET: 'SL_M' };

function status(s: string): OrderStatus {
  const v = (s ?? '').toLowerCase();
  if (v === 'complete') return 'FILLED';
  if (v === 'rejected') return 'REJECTED';
  if (v === 'cancelled') return 'CANCELLED';
  if (v.includes('open') || v.includes('pending') || v.includes('trigger')) return 'OPEN';
  return 'UNKNOWN';
}

/** Angel's "25-Oct-2026 10:15:30" style timestamps → Date (IST). */
function angelTime(s: unknown): Date {
  const d = s ? new Date(`${String(s)} GMT+0530`) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * SmartAPI per-endpoint rate limits (requests/second, per client) from Angel One's published limits table:
 * https://smartapi.angelone.in/smartapi/forum/post/16438 — breaching them returns a plain-text HTTP 403.
 */
const ANGEL_RATE_PER_SEC: Record<string, number> = {
  '/rest/secure/angelbroking/order/v1/getOrderBook': 1,
  '/rest/secure/angelbroking/order/v1/getPosition': 1,
  '/rest/secure/angelbroking/portfolio/v1/getHolding': 1,
  '/rest/secure/angelbroking/user/v1/getRMS': 2,
  '/rest/secure/angelbroking/user/v1/getProfile': 3,
  '/rest/secure/angelbroking/order/v1/getLtpData': 10,
  '/rest/secure/angelbroking/order/v1/searchScrip': 1,
  '/rest/secure/angelbroking/order/v1/modifyOrder': 10,
  '/rest/secure/angelbroking/order/v1/cancelOrder': 10,
};

export interface AngelHeaders {
  apiKey: string;
  publicIp?: string;
  localIp?: string;
  macAddress?: string;
  proxyUrl?: string;
}

/** SmartAPI REST adapter. Symbol tokens are resolved with searchScrip and cached in memory. */
export class AngelOneAdapter implements BrokerAdapter {
  readonly broker = 'ANGEL_ONE';
  private static tokenCache = new Map<string, { symbol: string; token: string }>();
  /** In-flight lookups, so N clients copying the same new symbol trigger one searchScrip call. */
  private static inflight = new Map<string, Promise<{ symbol: string; token: string }>>();

  constructor(
    private readonly cfg: AngelHeaders,
    private readonly jwt: string,
    private readonly opts?: AdapterOptions,
  ) {}

  /** Cached symbol token (no network), or undefined. */
  static cached(exchange: Exchange, symbol: string): { symbol: string; token: string } | undefined {
    return AngelOneAdapter.tokenCache.get(`${exchange}:${symbol.toUpperCase()}`);
  }

  /** One throttle per (session, endpoint), shared by every adapter instance built for the same session. */
  private static throttles = new Map<string, Throttle>();
  /** Concurrent identical GETs (e.g. master poller + UI refresh) share one request. */
  private static inflightGet = new Map<string, Promise<unknown>>();

  private async call<T>(path: string, method: 'GET' | 'POST', payload?: object): Promise<T | null> {
    const key = `${this.jwt.slice(-24)}|${path}`;
    if (method === 'GET') {
      const shared = AngelOneAdapter.inflightGet.get(key);
      if (shared) return shared as Promise<T | null>;
      const p = this.callThrottled<T>(key, path, method, payload).finally(() => AngelOneAdapter.inflightGet.delete(key));
      AngelOneAdapter.inflightGet.set(key, p);
      return p;
    }
    return this.callThrottled<T>(key, path, method, payload);
  }

  private async callThrottled<T>(key: string, path: string, method: 'GET' | 'POST', payload?: object): Promise<T | null> {
    const rate = ANGEL_RATE_PER_SEC[path];
    if (rate) {
      let t = AngelOneAdapter.throttles.get(key);
      if (!t) AngelOneAdapter.throttles.set(key, (t = new Throttle(rate)));
      await t.take();
    }
    try {
      return await this.rawCall<T>(path, method, payload);
    } catch (err) {
      // Read-only calls: one retry after the 1 s window when Angel still says we exceeded the rate.
      if (method === 'GET' && err instanceof BrokerApiError && err.brokerCode === 'RATE_LIMIT') {
        await new Promise((r) => setTimeout(r, 1100));
        return this.rawCall<T>(path, method, payload);
      }
      throw err;
    }
  }

  private async rawCall<T>(path: string, method: 'GET' | 'POST', payload?: object): Promise<T | null> {
    const { status: http, body } = await brokerFetch<{ status: boolean; message?: string; errorcode?: string; data?: T | null }>(
      `${API_ROOT}${path}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-UserType': 'USER',
          'X-SourceID': 'WEB',
          'X-ClientLocalIP': this.cfg.localIp ?? '127.0.0.1',
          'X-ClientPublicIP': this.cfg.publicIp ?? '127.0.0.1',
          'X-MACAddress': this.cfg.macAddress ?? '00:00:00:00:00:00',
          'X-PrivateKey': this.cfg.apiKey,
          Authorization: `Bearer ${this.jwt}`,
        },
        body: payload ? JSON.stringify(payload) : undefined,
        proxyUrl: this.cfg.proxyUrl,
      },
    );
    if (http !== 200 || !body?.status) {
      throw new BrokerApiError(body?.message || `Angel One request failed (HTTP ${http}).`, http, body?.errorcode);
    }
    return body.data ?? null;
  }

  /** Maps a canonical symbol to Angel's tradingsymbol + symboltoken. */
  async resolve(exchange: Exchange, symbol: string): Promise<{ symbol: string; token: string }> {
    const key = `${exchange}:${symbol.toUpperCase()}`;
    const hit = AngelOneAdapter.tokenCache.get(key);
    if (hit) return hit;
    let p = AngelOneAdapter.inflight.get(key);
    if (!p) {
      p = this.lookup(exchange, symbol).finally(() => AngelOneAdapter.inflight.delete(key));
      AngelOneAdapter.inflight.set(key, p);
    }
    return p;
  }

  private async lookup(exchange: Exchange, symbol: string): Promise<{ symbol: string; token: string }> {
    const sym = symbol.toUpperCase();
    const key = `${exchange}:${sym}`;
    // F&O: exact contract from Angel's own scrip master (BSE / weekly names differ from the platform's).
    if (DERIVATIVE_EXCHANGES.has(exchange)) {
      await angelScripMaster.ensure().catch(() => undefined);
      const c = angelScripMaster.get(exchange, sym);
      if (c) {
        const out = { symbol: c.symbol, token: c.token };
        AngelOneAdapter.tokenCache.set(key, out);
        return out;
      }
    }
    // Fallback: searchScrip with every naming variant.
    let pick: { tradingsymbol: string; symboltoken: string } | undefined;
    for (const v of symbolVariants(sym)) {
      const base = canonicalSymbol(v);
      const rows = (await this.call<{ tradingsymbol: string; symboltoken: string }[]>('/rest/secure/angelbroking/order/v1/searchScrip', 'POST', {
        exchange,
        searchscrip: base,
      })) ?? [];
      pick =
        rows.find((r) => r.tradingsymbol.toUpperCase() === v) ??
        rows.find((r) => r.tradingsymbol.toUpperCase() === `${base}-EQ`) ??
        rows.find((r) => canonicalSymbol(r.tradingsymbol) === base);
      if (pick) break;
    }
    if (!pick) throw new BrokerApiError(`Angel One: symbol ${exchange}:${symbol} not found.`);
    const out = { symbol: pick.tradingsymbol, token: pick.symboltoken };
    AngelOneAdapter.tokenCache.set(key, out);
    return out;
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const inst = await this.resolve(o.exchange, o.symbol);
    const d = await this.call<{ orderid: string }>('/rest/secure/angelbroking/order/v1/placeOrder', 'POST', {
      variety: o.orderType === 'SL' || o.orderType === 'SL_M' ? 'STOPLOSS' : 'NORMAL',
      tradingsymbol: inst.symbol,
      symboltoken: inst.token,
      transactiontype: o.side,
      exchange: o.exchange,
      ordertype: TYPE_OUT[o.orderType],
      producttype: PRODUCT_OUT[o.productType],
      duration: 'DAY',
      price: o.price != null && o.orderType !== 'MARKET' ? String(o.price) : '0',
      triggerprice: o.triggerPrice != null ? String(o.triggerPrice) : '0',
      quantity: String(o.quantity),
      ordertag: o.tag?.slice(0, 20),
    });
    if (!d?.orderid) throw new BrokerApiError('Angel One did not return an order id.');
    return { brokerOrderId: d.orderid };
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    const inst = await this.resolve(o.exchange, o.symbol);
    await this.call('/rest/secure/angelbroking/order/v1/modifyOrder', 'POST', {
      variety: o.orderType === 'SL' || o.orderType === 'SL_M' ? 'STOPLOSS' : 'NORMAL',
      orderid: o.brokerOrderId,
      tradingsymbol: inst.symbol,
      symboltoken: inst.token,
      exchange: o.exchange,
      ordertype: TYPE_OUT[o.orderType],
      producttype: PRODUCT_OUT[o.productType],
      duration: 'DAY',
      price: o.price != null && o.orderType !== 'MARKET' ? String(o.price) : '0',
      triggerprice: o.triggerPrice != null ? String(o.triggerPrice) : '0',
      quantity: String(o.quantity),
    });
  }

  async cancelOrder(brokerOrderId: string, orderType: OrderType): Promise<void> {
    await this.call('/rest/secure/angelbroking/order/v1/cancelOrder', 'POST', {
      variety: orderType === 'SL' || orderType === 'SL_M' ? 'STOPLOSS' : 'NORMAL',
      orderid: brokerOrderId,
    });
  }

  async orders(): Promise<BrokerOrder[]> {
    const rows = (await this.call<Record<string, unknown>[]>('/rest/secure/angelbroking/order/v1/getOrderBook', 'GET')) ?? [];
    return rows.map((r) => ({
      brokerOrderId: String(r.orderid),
      exchange: toExchange(String(r.exchange)),
      symbol: normalizeBrokerSymbol(String(r.tradingsymbol)),
      instrumentToken: r.symboltoken ? String(r.symboltoken) : undefined,
      side: String(r.transactiontype) === 'SELL' ? 'SELL' : 'BUY',
      orderType: TYPE_IN[String(r.ordertype)] ?? 'MARKET',
      productType: PRODUCT_IN[String(r.producttype)] ?? 'INTRADAY',
      quantity: Number(r.quantity) || 0,
      filledQuantity: Number(r.filledshares) || 0,
      price: num(r.price),
      averagePrice: num(r.averageprice),
      status: status(String(r.status ?? r.orderstatus)),
      statusMessage: r.text ? String(r.text) : undefined,
      tag: r.ordertag ? String(r.ordertag) : undefined,
      triggerPrice: num(r.triggerprice),
      lotSize: num(r.lotsize) ?? undefined,
      timestamp: angelTime(r.exchtime || r.updatetime),
      raw: r,
    }));
  }

  async positions(): Promise<BrokerPosition[]> {
    const rows = (await this.call<Record<string, unknown>[]>('/rest/secure/angelbroking/order/v1/getPosition', 'GET')) ?? [];
    return rows.map((p) => ({
      exchange: toExchange(String(p.exchange)),
      symbol: normalizeBrokerSymbol(String(p.tradingsymbol)),
      productType: PRODUCT_IN[String(p.producttype)] ?? 'INTRADAY',
      quantity: Number(p.netqty) || 0,
      averagePrice: num(p.avgnetprice ?? p.netprice) ?? 0,
      lastPrice: num(p.ltp),
      pnl: num(p.pnl ?? p.unrealised),
    }));
  }

  async holdings(): Promise<BrokerHolding[]> {
    const rows = (await this.call<Record<string, unknown>[]>('/rest/secure/angelbroking/portfolio/v1/getHolding', 'GET')) ?? [];
    return rows.map((h) => ({
      exchange: toExchange(String(h.exchange)),
      symbol: canonicalSymbol(String(h.tradingsymbol)),
      quantity: Number(h.quantity) || 0,
      averagePrice: num(h.averageprice) ?? 0,
      lastPrice: num(h.ltp),
      pnl: num(h.profitandloss),
    }));
  }

  async funds(): Promise<BrokerFunds> {
    const d = await this.call<Record<string, unknown>>('/rest/secure/angelbroking/user/v1/getRMS', 'GET');
    return { availableCash: num(d?.availablecash), net: num(d?.net) };
  }

  async ltp(exchange: Exchange, symbol: string): Promise<number | null> {
    try {
      const inst = await this.resolve(exchange, symbol);
      const d = await this.call<{ ltp: number }>('/rest/secure/angelbroking/order/v1/getLtpData', 'POST', {
        exchange,
        tradingsymbol: inst.symbol,
        symboltoken: inst.token,
      });
      return num(d?.ltp);
    } catch {
      return null;
    }
  }
}
