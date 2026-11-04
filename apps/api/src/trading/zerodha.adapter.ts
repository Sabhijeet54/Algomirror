import type { OrderStatus, OrderType, ProductType } from '@ctp/database';
import { DERIVATIVE_EXCHANGES, kiteSymbols, normalizeBrokerSymbol } from './symbols';
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
  ModifyOrderInput,
  num,
  PlaceOrderInput,
  toExchange,
} from './broker-adapter';

export const KITE_API_ROOT = 'https://api.kite.trade';
const API_ROOT = KITE_API_ROOT;

const PRODUCT_OUT: Record<ProductType, string> = { DELIVERY: 'CNC', INTRADAY: 'MIS', CARRY_FORWARD: 'NRML' };
const PRODUCT_IN: Record<string, ProductType> = { CNC: 'DELIVERY', MIS: 'INTRADAY', NRML: 'CARRY_FORWARD', MTF: 'DELIVERY' };
const TYPE_OUT: Record<OrderType, string> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', SL_M: 'SL-M' };
const TYPE_IN: Record<string, OrderType> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', 'SL-M': 'SL_M' };

function status(s: string): OrderStatus {
  const v = (s ?? '').toUpperCase();
  if (v === 'COMPLETE') return 'FILLED';
  if (v === 'REJECTED') return 'REJECTED';
  if (v === 'CANCELLED') return 'CANCELLED';
  if (v === 'OPEN' || v === 'TRIGGER PENDING' || v.includes('PENDING') || v.includes('REQ')) return 'OPEN';
  return 'UNKNOWN';
}

interface Env<T> {
  status: string;
  data?: T;
  message?: string;
  error_type?: string;
}

/** Kite Connect v3 REST adapter. */
/**
 * Kite rejects MARKET and SL-M orders placed via the API unless `market_protection` is set
 * ("Market orders without market protection are not allowed via API").
 * `-1` asks Kite to apply its automatic market protection (see Kite Connect docs, /orders).
 */
export function withMarketProtection(form: Record<string, string>, orderType: string): Record<string, string> {
  if (orderType === 'MARKET' || orderType === 'SL_M') form.market_protection = '-1';
  return form;
}

export class ZerodhaAdapter implements BrokerAdapter {
  readonly broker = 'ZERODHA';
  constructor(
    private readonly apiKey: string,
    private readonly accessToken: string,
    private readonly proxyUrl?: string,
    private readonly opts?: AdapterOptions,
  ) {}

  private async call<T>(path: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', form?: Record<string, string>): Promise<T> {
    const { status: http, body } = await brokerFetch<Env<T>>(`${API_ROOT}${path}`, {
      method,
      headers: {
        'X-Kite-Version': '3',
        Authorization: `token ${this.apiKey}:${this.accessToken}`,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
      proxyUrl: this.proxyUrl,
    });
    if (http !== 200 || body?.status !== 'success') {
      throw new BrokerApiError(body?.message ?? `Zerodha request failed (HTTP ${http}).`, http, body?.error_type);
    }
    return body.data as T;
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const form: Record<string, string> = {
      tradingsymbol: await this.kiteSymbol(o.exchange, o.symbol),
      exchange: o.exchange,
      transaction_type: o.side,
      order_type: TYPE_OUT[o.orderType],
      quantity: String(o.quantity),
      product: PRODUCT_OUT[o.productType],
      validity: 'DAY',
    };
    if (o.price != null && o.orderType !== 'MARKET' && o.orderType !== 'SL_M') form.price = String(o.price);
    if (o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M')) form.trigger_price = String(o.triggerPrice);
    if (o.tag) form.tag = o.tag.slice(0, 20);
    withMarketProtection(form, o.orderType);
    const d = await this.call<{ order_id: string }>('/orders/regular', 'POST', form);
    return { brokerOrderId: d.order_id };
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    const form: Record<string, string> = { order_type: TYPE_OUT[o.orderType], quantity: String(o.quantity), validity: 'DAY' };
    if (o.price != null && o.orderType !== 'MARKET' && o.orderType !== 'SL_M') form.price = String(o.price);
    if (o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M')) form.trigger_price = String(o.triggerPrice);
    withMarketProtection(form, o.orderType);
    await this.call(`/orders/regular/${encodeURIComponent(o.brokerOrderId)}`, 'PUT', form);
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.call(`/orders/regular/${encodeURIComponent(brokerOrderId)}`, 'DELETE');
  }

  /** Canonical platform symbol → Kite tradingsymbol (BSE / weekly contracts are named differently at Kite). */
  private async kiteSymbol(exchange: string, symbol: string): Promise<string> {
    const r = kiteSymbols.resolver;
    if (r && DERIVATIVE_EXCHANGES.has(exchange)) {
      await r.ensure(exchange).catch(() => undefined);
      const k = r.toKite(exchange, symbol);
      if (k) return k;
    }
    return canonicalSymbol(symbol);
  }

  /** Kite tradingsymbol → canonical platform symbol. Call `prepare` first for the exchanges involved. */
  private fromKite(exchange: string, symbol: string): string {
    return kiteSymbols.resolver?.fromKite(exchange, canonicalSymbol(symbol)) ?? normalizeBrokerSymbol(symbol);
  }

  private async prepare(rows: Record<string, unknown>[]): Promise<void> {
    const r = kiteSymbols.resolver;
    if (!r) return;
    const exs = [...new Set(rows.map((x) => String(x.exchange)).filter((e) => DERIVATIVE_EXCHANGES.has(e)))];
    await Promise.all(exs.map((e) => r.ensure(e).catch(() => undefined)));
  }

  async orders(): Promise<BrokerOrder[]> {
    const rows = (await this.call<Record<string, unknown>[]>('/orders')) ?? [];
    await this.prepare(rows);
    return rows.map((r) => ({
      brokerOrderId: String(r.order_id),
      exchange: toExchange(String(r.exchange)),
      symbol: this.fromKite(String(r.exchange), String(r.tradingsymbol)),
      instrumentToken: r.instrument_token ? String(r.instrument_token) : undefined,
      side: String(r.transaction_type) === 'SELL' ? 'SELL' : 'BUY',
      orderType: TYPE_IN[String(r.order_type)] ?? 'MARKET',
      productType: PRODUCT_IN[String(r.product)] ?? 'INTRADAY',
      quantity: Number(r.quantity) || 0,
      filledQuantity: Number(r.filled_quantity) || 0,
      price: num(r.price),
      averagePrice: num(r.average_price),
      status: status(String(r.status)),
      statusMessage: r.status_message ? String(r.status_message) : undefined,
      tag: r.tag ? String(r.tag) : undefined,
      triggerPrice: num(r.trigger_price),
      timestamp: new Date(String(r.exchange_timestamp ?? r.order_timestamp ?? Date.now()).replace(' ', 'T') + '+05:30'),
      raw: r,
    }));
  }

  async positions(): Promise<BrokerPosition[]> {
    const d = await this.call<{ net: Record<string, unknown>[] }>('/portfolio/positions');
    await this.prepare(d?.net ?? []);
    return (d?.net ?? []).map((p) => ({
      exchange: toExchange(String(p.exchange)),
      symbol: this.fromKite(String(p.exchange), String(p.tradingsymbol)),
      productType: PRODUCT_IN[String(p.product)] ?? 'INTRADAY',
      quantity: Number(p.quantity) || 0,
      averagePrice: num(p.average_price) ?? 0,
      lastPrice: num(p.last_price),
      pnl: num(p.pnl),
    }));
  }

  async holdings(): Promise<BrokerHolding[]> {
    const rows = (await this.call<Record<string, unknown>[]>('/portfolio/holdings')) ?? [];
    return rows.map((h) => ({
      exchange: toExchange(String(h.exchange)),
      symbol: canonicalSymbol(String(h.tradingsymbol)),
      quantity: (Number(h.quantity) || 0) + (Number(h.t1_quantity) || 0),
      averagePrice: num(h.average_price) ?? 0,
      lastPrice: num(h.last_price),
      pnl: num(h.pnl),
    }));
  }

  async funds(): Promise<BrokerFunds> {
    const d = await this.call<{ equity?: { net?: number; available?: { cash?: number; live_balance?: number } } }>('/user/margins');
    return { availableCash: num(d?.equity?.available?.live_balance ?? d?.equity?.available?.cash), net: num(d?.equity?.net) };
  }

  async ltp(exchange: string, symbol: string): Promise<number | null> {
    try {
      const key = `${exchange}:${await this.kiteSymbol(exchange, symbol)}`;
      const d = await this.call<Record<string, { last_price: number }>>(`/quote/ltp?i=${encodeURIComponent(key)}`);
      return num(d?.[key]?.last_price);
    } catch {
      return null; // Kite Personal apps have no quote access.
    }
  }
}
