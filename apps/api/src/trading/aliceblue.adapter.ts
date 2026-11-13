import { createHash } from 'node:crypto';
import type { Exchange, OrderStatus } from '@ctp/database';
import { fetch as undiciFetch } from 'undici';
import { BrokerInstrumentStore, headerIndex, csvRows, jsonArrayObjects, type BrokerInstrument } from '../market-data/broker-instruments';
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

export const ALICEBLUE_API_ROOT = 'https://ant.aliceblueonline.com/rest/AliceBlueAPIService/api';
const CONTRACT_ROOT = 'https://v2api.aliceblueonline.com/restpy/contract_master';
const EXCHANGES = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS'];

const PRODUCT_OUT: Record<string, (ex: string) => string> = {
  INTRADAY: () => 'MIS',
  DELIVERY: () => 'CNC',
  CARRY_FORWARD: () => 'NRML',
};
const ORDER_OUT: Record<string, string> = { MARKET: 'MKT', LIMIT: 'L', SL: 'SL', SL_M: 'SL-M' };

export function aliceStatus(s: string): OrderStatus {
  const v = (s ?? '').toLowerCase();
  if (v === 'complete' || v === 'completed' || v === 'filled') return 'FILLED';
  if (v.includes('reject')) return 'REJECTED';
  if (v.includes('cancel')) return 'CANCELLED';
  if (v.includes('open') || v.includes('pending') || v.includes('trigger') || v.includes('modif') || v.includes('received') || v.includes('partial')) return 'OPEN';
  return 'UNKNOWN';
}

/** userData checksum Alice Blue expects at getUserSID: sha256(userId + apiKey + encKey). */
export const aliceChecksum = (userId: string, apiKey: string, encKey: string) => createHash('sha256').update(`${userId}${apiKey}${encKey}`).digest('hex');

/** "28-Nov-2026" / "2026-11-28" / epoch ms → "2026-11-28". */
export function aliceExpiry(v: string): string {
  const s = (v ?? '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  if (/^\d{10,13}$/.test(s)) return new Date(Number(s.length === 10 ? Number(s) * 1000 : s)).toISOString().slice(0, 10);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Alice Blue contract master (public CSV per exchange). Key = Token; tradingSymbol = "Trading Symbol". */
export const aliceInstruments = new BrokerInstrumentStore(
  'AliceBlue',
  (ex) => (EXCHANGES.includes(ex) ? ex : undefined),
  async (ex) => {
    const res = await undiciFetch(`${CONTRACT_ROOT}?exch=${ex}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // The contract master is JSON ({"NFO":[{token, trading_symbol, symbol, expiry_date(ms), …}]}); the old CSV
    // layout ("Token", "Trading Symbol"…) is still read if Alice Blue ever serves it again.
    type Row = { token?: string; trading_symbol?: string; symbol?: string; lot_size?: string; expiry_date?: number | string; option_type?: string; strike_price?: string; instrument_type?: string };
    let rows: Iterable<Row>;
    const json = text.trimStart().startsWith('{') || text.trimStart().startsWith('[');
    if (json) {
      const at = text.indexOf('[');
      rows = at < 0 ? [] : jsonArrayObjects<Row>(text.slice(at));
    } else {
      const csv = csvRows(text);
      const col = headerIndex(csv.next().value ?? []);
      const iTok = col('Token'), iTs = col('Trading Symbol'), iSym = col('Symbol'), iLot = col('Lot Size');
      const iExp = col('Expiry Date'), iOpt = col('Option Type'), iStrike = col('Strike Price'), iInst = col('Instrument Type');
      if (iTok < 0 || iTs < 0) throw new Error('unexpected Alice Blue contract master header');
      rows = (function* () {
        for (const r of csv) yield { token: r[iTok], trading_symbol: r[iTs], symbol: r[iSym], lot_size: r[iLot], expiry_date: r[iExp], option_type: r[iOpt], strike_price: r[iStrike], instrument_type: r[iInst] };
      })();
    }
    const deriv = FO_EXCHANGES.includes(ex as Exchange);
    const out: BrokerInstrument[] = [];
    for (const r of rows) {
      const token = String(r.token ?? '').trim();
      const ts = String(r.trading_symbol ?? '').trim().toUpperCase();
      if (!token || !ts) continue;
      let symbol: string | null;
      if (deriv) {
        const opt = String(r.option_type ?? '').trim().toUpperCase();
        const inst = String(r.instrument_type ?? '').toUpperCase();
        const type = opt === 'CE' || opt === 'PE' ? opt : inst.startsWith('FUT') || inst === 'IF' || inst === 'SF' || opt === 'XX' || !opt ? 'FUT' : null;
        if (!type) continue;
        symbol = canonicalFromParts(String(r.symbol ?? '').trim(), aliceExpiry(String(r.expiry_date ?? '')), type === 'FUT' ? null : Number(r.strike_price), type);
      } else {
        const m = /^(.+)-(EQ|BE)$/.exec(ts);
        if (ex === 'NSE' && !m) continue;
        symbol = m ? m[1]! : String(r.symbol ?? ts).trim().toUpperCase();
      }
      if (!symbol) continue;
      out.push({ exchange: ex, symbol, key: token, lotSize: Number(r.lot_size) || 1, tradingSymbol: ts });
    }
    return out;
  },
);

/** Alice Blue ANT REST adapter. Auth header: "Bearer <userId> <sessionId>". */
export class AliceBlueAdapter implements BrokerAdapter {
  readonly broker = 'ALICE_BLUE';

  constructor(
    private readonly userId: string,
    private readonly sessionId: string,
    private readonly proxyUrl?: string,
    private readonly opts?: AdapterOptions,
  ) {}

  private async call<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
    const { status, body: res } = await brokerFetch<unknown>(`${ALICEBLUE_API_ROOT}/${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${this.userId.toUpperCase()} ${this.sessionId}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      proxyUrl: this.proxyUrl,
    });
    const obj = (Array.isArray(res) ? res[0] : res) as { stat?: string; emsg?: string } | undefined;
    if (status === 401) throw new BrokerApiError('Alice Blue session expired — reconnect.', 401, 'TOKEN_EXPIRED');
    if (status !== 200 || (obj?.stat && obj.stat.toLowerCase() === 'not_ok' && !/no data/i.test(obj.emsg ?? ''))) {
      throw new BrokerApiError(obj?.emsg || `Alice Blue request failed (HTTP ${status}).`, status);
    }
    return res as T;
  }

  private list(res: unknown): Record<string, unknown>[] {
    if (Array.isArray(res)) return (res as Record<string, unknown>[]).filter((r) => r && (r as { stat?: string }).stat?.toLowerCase() !== 'not_ok');
    return [];
  }

  private async instrument(exchange: string, symbol: string): Promise<BrokerInstrument> {
    await aliceInstruments.ensure(exchange);
    const hit = aliceInstruments.get(exchange, canonicalSymbol(symbol));
    if (!hit) throw new BrokerApiError(`Alice Blue: instrument ${exchange}:${symbol} not found in the contract master.`);
    return hit;
  }

  private async decode(exch: unknown, token: unknown, ts: unknown): Promise<{ exchange: Exchange; symbol: string }> {
    const ex = String(exch ?? 'NSE').toUpperCase();
    await aliceInstruments.ensure(ex).catch(() => undefined);
    const hit = aliceInstruments.fromKey(ex, String(token ?? ''));
    return { exchange: toExchange(ex), symbol: hit?.symbol ?? normalizeBrokerSymbol(String(ts ?? '').replace(/-(EQ|BE)$/i, '')) };
  }

  private product(p: unknown, exchange: Exchange): 'INTRADAY' | 'DELIVERY' | 'CARRY_FORWARD' {
    const v = String(p ?? '').toUpperCase();
    if (v === 'MIS' || v === 'CO' || v === 'BO') return 'INTRADAY';
    if (v === 'NRML') return 'CARRY_FORWARD';
    return FO_EXCHANGES.includes(exchange) ? 'CARRY_FORWARD' : 'DELIVERY';
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const inst = await this.instrument(o.exchange, o.symbol);
    const res = await this.call<{ NOrdNo?: string; stat?: string; emsg?: string }[]>('placeOrder/executePlaceOrder', 'POST', [
      {
        complexty: 'regular',
        discqty: '0',
        exch: o.exchange,
        pCode: PRODUCT_OUT[o.productType]?.(o.exchange) ?? 'MIS',
        prctyp: ORDER_OUT[o.orderType] ?? 'MKT',
        price: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? String(o.price) : '0',
        qty: String(o.quantity),
        ret: 'DAY',
        symbol_id: inst.key,
        trading_symbol: inst.tradingSymbol,
        transtype: o.side,
        trigPrice: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? String(o.triggerPrice) : '',
        orderTag: (o.tag ?? 'ctp').replace(/[^A-Za-z0-9]/g, '').slice(0, 20),
      },
    ]);
    const r = Array.isArray(res) ? res[0] : (res as { NOrdNo?: string; emsg?: string });
    if (!r?.NOrdNo) throw new BrokerApiError(r?.emsg || 'Alice Blue did not return an order number.');
    return { brokerOrderId: String(r.NOrdNo) };
  }

  private async findOrder(id: string): Promise<Record<string, unknown>> {
    const row = this.list(await this.call('placeOrder/fetchOrderBook', 'GET')).find((r) => String(r.Nstordno) === id);
    if (!row) throw new BrokerApiError('Alice Blue: order not found in the order book.');
    return row;
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    const r = await this.findOrder(o.brokerOrderId);
    await this.call('placeOrder/modifyOrder', 'POST', {
      discqty: 0,
      exch: r.Exchange,
      filledQuantity: Number(r.Fillshares) || 0,
      nestOrderNumber: o.brokerOrderId,
      prctyp: ORDER_OUT[o.orderType ?? 'LIMIT'] ?? String(r.Prctype),
      price: o.price != null ? String(o.price) : '0',
      qty: o.quantity ?? Number(r.Qty),
      trading_symbol: r.Trsym,
      trigPrice: o.triggerPrice != null ? String(o.triggerPrice) : '',
      transtype: r.Trantype === 'S' ? 'SELL' : 'BUY',
      pCode: r.Pcode,
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    const r = await this.findOrder(brokerOrderId);
    await this.call('placeOrder/cancelOrder', 'POST', { exch: r.Exchange, nestOrderNumber: brokerOrderId, trading_symbol: r.Trsym });
  }

  async orders(): Promise<BrokerOrder[]> {
    const out: BrokerOrder[] = [];
    for (const r of this.list(await this.call('placeOrder/fetchOrderBook', 'GET'))) {
      const { exchange, symbol } = await this.decode(r.Exchange, r.token, r.Trsym);
      const pt = String(r.Prctype ?? '').toUpperCase();
      out.push({
        brokerOrderId: String(r.Nstordno),
        exchange,
        symbol,
        instrumentToken: r.token ? String(r.token) : undefined,
        side: String(r.Trantype).toUpperCase().startsWith('S') ? 'SELL' : 'BUY',
        orderType: pt === 'MKT' ? 'MARKET' : pt === 'SL-M' ? 'SL_M' : pt === 'SL' ? 'SL' : 'LIMIT',
        productType: this.product(r.Pcode, exchange),
        quantity: Number(r.Qty) || 0,
        filledQuantity: Number(r.Fillshares) || 0,
        price: num(r.Prc),
        averagePrice: num(r.Avgprc),
        triggerPrice: num(r.Trgprc),
        status: aliceStatus(String(r.Status)),
        statusMessage: r.RejReason ? String(r.RejReason) : undefined,
        tag: r.remarks ? String(r.remarks) : undefined,
        timestamp: r.OrderedTime ? new Date(String(r.OrderedTime).replace(/(\d{2})\/(\d{2})\/(\d{4})/, '$3-$2-$1') + '+05:30') : new Date(),
        raw: r,
      });
    }
    return out;
  }

  async positions(): Promise<BrokerPosition[]> {
    const out: BrokerPosition[] = [];
    for (const p of this.list(await this.call('positionAndHoldings/positionBook', 'POST', { ret: 'DAY' }))) {
      const { exchange, symbol } = await this.decode(p.Exchange, p.Token, p.Tsym);
      const net = Number(p.Netqty) || 0;
      out.push({
        exchange,
        symbol,
        productType: this.product(p.Pcode, exchange),
        quantity: net,
        averagePrice: num(p.NetBuyavgprc && net >= 0 ? p.NetBuyavgprc : p.NetSellavgprc) ?? num(p.netavgprc) ?? 0,
        lastPrice: num(p.LTP),
        pnl: (num(p.MtoM) ?? num(p.unrealisedprofitloss) ?? 0) + (num(p.realisedprofitloss) ?? 0),
      });
    }
    return out;
  }

  async holdings(): Promise<BrokerHolding[]> {
    const res = await this.call<{ HoldingVal?: Record<string, unknown>[] }>('positionAndHoldings/holdings', 'GET');
    return (res?.HoldingVal ?? []).map((h) => {
      const qty = Number(h.HUqty ?? h.Holdqty) || 0;
      const avg = num(h.Price) ?? 0;
      const ltp = num(h.Ltp ?? h.LTnse);
      return {
        exchange: toExchange(h.Bsetsym && !h.Nsetsym ? 'BSE' : 'NSE'),
        symbol: canonicalSymbol(String(h.Nsetsym ?? h.Bsetsym ?? '').replace(/-(EQ|BE)$/i, '')),
        quantity: qty,
        averagePrice: avg,
        lastPrice: ltp,
        pnl: ltp != null ? Math.round((ltp - avg) * qty * 100) / 100 : null,
      };
    });
  }

  async funds(): Promise<BrokerFunds> {
    const r = this.list(await this.call('limits/getRmsLimits', 'GET'))[0] ?? {};
    return { availableCash: num(r.net ?? r.cashmarginavailable), net: num(r.net) };
  }

  async ltp(exchange: Exchange, symbol: string): Promise<number | null> {
    try {
      const inst = await this.instrument(exchange, symbol);
      const r = await this.call<{ LTP?: string; Ltp?: string }>('ScripDetails/getScripQuoteDetails', 'POST', { exch: exchange, symbol: inst.key });
      return num(r?.LTP ?? r?.Ltp);
    } catch {
      return null;
    }
  }
}

/** Alice Blue API login: getAPIEncpkey(userId) → getUserSID(userId, sha256(userId + apiKey + encKey)). */
export class AliceBlueClient {
  constructor(private readonly cfg: { proxyUrl?: string }) {}

  private async post<T>(path: string, body: object): Promise<T> {
    const { status, body: res } = await brokerFetch<T & { emsg?: string; stat?: string }>(`${ALICEBLUE_API_ROOT}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      proxyUrl: this.cfg.proxyUrl,
    });
    if (status !== 200 || !res) throw new BrokerApiError(`Alice Blue login failed (HTTP ${status}).`, status);
    return res;
  }

  async login(userId: string, apiKey: string): Promise<{ sessionId: string }> {
    const uid = userId.trim().toUpperCase();
    const enc = await this.post<{ encKey?: string; emsg?: string }>('customer/getAPIEncpkey', { userId: uid });
    if (!enc.encKey) throw new BrokerApiError(enc.emsg || 'Alice Blue: could not get the encryption key — check the User ID, and log in once on the Alice Blue web / app today.');
    const sid = await this.post<{ sessionID?: string; emsg?: string }>('customer/getUserSID', { userId: uid, userData: aliceChecksum(uid, apiKey.trim(), enc.encKey) });
    if (!sid.sessionID) throw new BrokerApiError(sid.emsg || 'Alice Blue did not return a session — check the API key.');
    return { sessionId: sid.sessionID };
  }
}
