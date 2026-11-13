import type { Exchange, OrderStatus, OrderType, ProductType } from '@ctp/database';
import { upstoxInstruments } from '../market-data/upstox-instruments';
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
import { normalizeBrokerSymbol } from './symbols';

export const UPSTOX_API_ROOT = 'https://api.upstox.com';
/** Order placement / modify / cancel run on Upstox's low-latency host. */
const HFT_ROOT = 'https://api-hft.upstox.com';

const PRODUCT_OUT: Record<ProductType, string> = { DELIVERY: 'D', INTRADAY: 'I', CARRY_FORWARD: 'D' };
const TYPE_OUT: Record<OrderType, string> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', SL_M: 'SL-M' };
const TYPE_IN: Record<string, OrderType> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'SL', 'SL-M': 'SL_M' };

function productIn(p: string, exchange: string): ProductType {
  if (p === 'I') return 'INTRADAY';
  return FO_EXCHANGES.includes(exchange as Exchange) ? 'CARRY_FORWARD' : 'DELIVERY';
}

function status(s: string): OrderStatus {
  const v = (s ?? '').toLowerCase();
  if (v === 'complete') return 'FILLED';
  if (v === 'rejected') return 'REJECTED';
  if (v === 'cancelled') return 'CANCELLED';
  if (v.includes('open') || v.includes('pending') || v.includes('trigger') || v.includes('received') || v.includes('modif')) return 'OPEN';
  return 'UNKNOWN';
}

/** Upstox "2026-10-16 10:15:30" timestamps (IST) → Date. */
function upTime(s: unknown): Date {
  const d = s ? new Date(`${String(s).replace(' ', 'T')}+05:30`) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

interface Env<T> {
  status?: string;
  data?: T;
  errors?: { errorCode?: string; error_code?: string; message?: string }[];
  message?: string;
}

/**
 * Upstox API v2 adapter. Upstox identifies contracts by `instrument_key` (e.g. "NSE_FO|36708"); the public
 * instrument master (see upstoxInstruments) maps the platform's canonical symbols to keys and back.
 * The access token is a plain Bearer token (valid until ~3:30 AM IST next day).
 */
export class UpstoxAdapter implements BrokerAdapter {
  readonly broker = 'UPSTOX';

  constructor(
    private readonly accessToken: string,
    private readonly proxyUrl?: string,
    private readonly opts?: AdapterOptions,
  ) {}

  private async call<T>(url: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET', payload?: object): Promise<T> {
    const { status: http, body } = await brokerFetch<Env<T>>(url, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.accessToken}`,
        ...(payload ? { 'Content-Type': 'application/json' } : {}),
      },
      body: payload ? JSON.stringify(payload) : undefined,
      proxyUrl: this.proxyUrl,
    });
    if (http !== 200 || body?.status !== 'success') {
      const e = body?.errors?.[0];
      throw new BrokerApiError(e?.message ?? body?.message ?? `Upstox request failed (HTTP ${http}).`, http, e?.errorCode ?? e?.error_code);
    }
    return body.data as T;
  }

  /** Canonical platform symbol → Upstox instrument key. */
  async instrumentKey(exchange: string, symbol: string): Promise<string> {
    await upstoxInstruments.ensure(exchange);
    const hit = upstoxInstruments.get(exchange, canonicalSymbol(symbol));
    if (!hit) throw new BrokerApiError(`Upstox: instrument ${exchange}:${symbol} not found in the Upstox instrument list.`);
    return hit.key;
  }

  /** Upstox row → platform exchange + canonical symbol (instrument key first, trading symbol as fallback). */
  private async decode(r: Record<string, unknown>): Promise<{ exchange: Exchange; symbol: string }> {
    const key = String(r.instrument_token ?? r.instrument_key ?? '');
    const ex = (key && upstoxInstruments.exchangeOfKey(key)) || String(r.exchange ?? 'NSE');
    if (key) {
      await upstoxInstruments.ensure(ex).catch(() => undefined);
      const hit = upstoxInstruments.fromKey(key);
      if (hit) return { exchange: toExchange(hit.exchange), symbol: hit.symbol };
    }
    return { exchange: toExchange(ex), symbol: normalizeBrokerSymbol(String(r.trading_symbol ?? r.tradingsymbol ?? '').replace(/\s+/g, '')) };
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const d = await this.call<{ order_id?: string }>(`${HFT_ROOT}/v2/order/place`, 'POST', {
      quantity: o.quantity,
      product: PRODUCT_OUT[o.productType],
      validity: 'DAY',
      price: o.price != null && o.orderType !== 'MARKET' && o.orderType !== 'SL_M' ? o.price : 0,
      tag: o.tag?.slice(0, 20),
      instrument_token: await this.instrumentKey(o.exchange, o.symbol),
      order_type: TYPE_OUT[o.orderType],
      transaction_type: o.side,
      disclosed_quantity: 0,
      trigger_price: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? o.triggerPrice : 0,
      is_amo: false,
    });
    if (!d?.order_id) throw new BrokerApiError('Upstox did not return an order id.');
    return { brokerOrderId: d.order_id };
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    await this.call(`${HFT_ROOT}/v2/order/modify`, 'PUT', {
      order_id: o.brokerOrderId,
      quantity: o.quantity,
      validity: 'DAY',
      price: o.price != null && o.orderType !== 'MARKET' && o.orderType !== 'SL_M' ? o.price : 0,
      order_type: TYPE_OUT[o.orderType],
      disclosed_quantity: 0,
      trigger_price: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? o.triggerPrice : 0,
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.call(`${HFT_ROOT}/v2/order/cancel?order_id=${encodeURIComponent(brokerOrderId)}`, 'DELETE');
  }

  async orders(): Promise<BrokerOrder[]> {
    const rows = (await this.call<Record<string, unknown>[]>(`${UPSTOX_API_ROOT}/v2/order/retrieve-all`)) ?? [];
    const out: BrokerOrder[] = [];
    for (const r of rows) {
      const { exchange, symbol } = await this.decode(r);
      out.push({
        brokerOrderId: String(r.order_id),
        exchange,
        symbol,
        instrumentToken: r.instrument_token ? String(r.instrument_token) : undefined,
        side: String(r.transaction_type).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        orderType: TYPE_IN[String(r.order_type).toUpperCase()] ?? 'MARKET',
        productType: productIn(String(r.product).toUpperCase(), exchange),
        quantity: Number(r.quantity) || 0,
        filledQuantity: Number(r.filled_quantity) || 0,
        price: num(r.price),
        averagePrice: num(r.average_price),
        triggerPrice: num(r.trigger_price),
        status: status(String(r.status)),
        statusMessage: r.status_message ? String(r.status_message) : undefined,
        tag: r.tag ? String(r.tag) : undefined,
        timestamp: upTime(r.exchange_timestamp || r.order_timestamp),
        raw: r,
      });
    }
    return out;
  }

  async positions(): Promise<BrokerPosition[]> {
    const rows = (await this.call<Record<string, unknown>[]>(`${UPSTOX_API_ROOT}/v2/portfolio/short-term-positions`)) ?? [];
    const out: BrokerPosition[] = [];
    for (const p of rows) {
      const { exchange, symbol } = await this.decode(p);
      out.push({
        exchange,
        symbol,
        productType: productIn(String(p.product).toUpperCase(), exchange),
        quantity: Number(p.quantity) || 0,
        averagePrice: num(p.average_price) ?? 0,
        lastPrice: num(p.last_price),
        pnl: num(p.pnl ?? p.unrealised),
      });
    }
    return out;
  }

  async holdings(): Promise<BrokerHolding[]> {
    const rows = (await this.call<Record<string, unknown>[]>(`${UPSTOX_API_ROOT}/v2/portfolio/long-term-holdings`)) ?? [];
    return rows.map((h) => ({
      exchange: toExchange(String(h.exchange ?? 'NSE')),
      symbol: canonicalSymbol(String(h.trading_symbol ?? h.tradingsymbol ?? '')),
      quantity: (Number(h.quantity) || 0) + (Number(h.t1_quantity) || 0),
      averagePrice: num(h.average_price) ?? 0,
      lastPrice: num(h.last_price),
      pnl: num(h.pnl),
    }));
  }

  async funds(): Promise<BrokerFunds> {
    const d = await this.call<{ equity?: { available_margin?: number; used_margin?: number } }>(`${UPSTOX_API_ROOT}/v2/user/get-funds-and-margin?segment=SEC`);
    const avail = num(d?.equity?.available_margin);
    return { availableCash: avail, net: avail != null ? avail + (num(d?.equity?.used_margin) ?? 0) : null };
  }

  async ltp(exchange: Exchange, symbol: string): Promise<number | null> {
    try {
      const key = await this.instrumentKey(exchange, symbol);
      const d = await this.call<Record<string, { last_price?: number }>>(`${UPSTOX_API_ROOT}/v2/market-quote/ltp?instrument_key=${encodeURIComponent(key)}`);
      const first = d ? Object.values(d)[0] : undefined;
      return num(first?.last_price);
    } catch {
      return null;
    }
  }
}

/** Upstox OAuth (client's own app): login dialog URL, code → token exchange and profile check. */
export class UpstoxClient {
  constructor(private readonly cfg: { apiKey: string; apiSecret?: string; redirectUrl: string; proxyUrl?: string }) {}

  loginUrl(state: string): string {
    const u = new URL(`${UPSTOX_API_ROOT}/v2/login/authorization/dialog`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', this.cfg.apiKey);
    u.searchParams.set('redirect_uri', this.cfg.redirectUrl);
    u.searchParams.set('state', state);
    return u.toString();
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; userId: string }> {
    const { status: http, body } = await brokerFetch<{ access_token?: string; user_id?: string; errors?: { message?: string }[]; message?: string }>(
      `${UPSTOX_API_ROOT}/v2/login/authorization/token`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: this.cfg.apiKey,
          client_secret: this.cfg.apiSecret ?? '',
          redirect_uri: this.cfg.redirectUrl,
          grant_type: 'authorization_code',
        }).toString(),
        proxyUrl: this.cfg.proxyUrl,
      },
    );
    if (http !== 200 || !body?.access_token) throw new BrokerApiError(body?.errors?.[0]?.message ?? body?.message ?? `Upstox login failed (HTTP ${http}).`, http);
    return { accessToken: body.access_token, userId: String(body.user_id ?? '') };
  }

  /** Validates a token (pasted or fresh) and returns the Upstox user id. */
  async profile(accessToken: string): Promise<{ userId: string; name: string | null }> {
    const { status: http, body } = await brokerFetch<Env<{ user_id?: string; user_name?: string }>>(`${UPSTOX_API_ROOT}/v2/user/profile`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
      proxyUrl: this.cfg.proxyUrl,
    });
    if (http !== 200 || body?.status !== 'success' || !body.data?.user_id) {
      throw new BrokerApiError(body?.errors?.[0]?.message ?? `Upstox token is not valid (HTTP ${http}). Generate a new access token.`, http);
    }
    return { userId: body.data.user_id, name: body.data.user_name ?? null };
  }
}

/** Upstox tokens stay valid until 3:30 AM IST the next day. */
export function upstoxTokenExpiry(now = new Date()): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const next = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + (ist.getUTCHours() * 60 + ist.getUTCMinutes() >= 210 ? 1 : 0), 3, 30));
  return new Date(next.getTime() - 330 * 60_000);
}
