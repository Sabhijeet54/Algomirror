import { createHash } from 'node:crypto';
import type { Exchange, OrderStatus, OrderType, ProductType } from '@ctp/database';
import { fetch as undiciFetch } from 'undici';
import { BrokerInstrumentStore, headerIndex, istDateOfEpoch, parseCsv, type BrokerInstrument } from '../market-data/broker-instruments';
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

export const MOTILAL_API_ROOT = 'https://openapi.motilaloswal.com';

/** Platform exchange ↔ Motilal exchange name (also the scrip-master file name). */
const EX_OUT: Record<string, string> = { NSE: 'NSE', BSE: 'BSE', NFO: 'NSEFO', BFO: 'BSEFO', MCX: 'MCX', CDS: 'NSECD', BCD: 'BSECD' };
const EX_IN: Record<string, string> = Object.fromEntries(Object.entries(EX_OUT).map(([k, v]) => [v, k]));
/** Exchange epochs (expiry dates) count seconds from 1 Jan 1980. */
const EPOCH_1980 = 315_532_800;

const TYPE_OUT: Record<OrderType, string | undefined> = { MARKET: 'MARKET', LIMIT: 'LIMIT', SL: 'STOPLOSS', SL_M: undefined };

/** Motilal NORMAL = intraday for cash and both intraday / carry-forward for F&O; DELIVERY = CNC. */
function productOut(p: ProductType): string {
  return p === 'DELIVERY' ? 'DELIVERY' : 'NORMAL';
}
function productIn(p: unknown, exchange: Exchange): ProductType {
  const v = String(p ?? '').toUpperCase();
  if (v === 'DELIVERY' || v === 'MTF' || v === 'SELLFROMDP' || v === 'BTST') return 'DELIVERY';
  if (v === 'VALUEPLUS') return 'INTRADAY';
  return FO_EXCHANGES.includes(exchange) ? 'CARRY_FORWARD' : 'INTRADAY';
}

export function motilalStatus(s: string): OrderStatus {
  const v = (s ?? '').toLowerCase();
  if (v === 'traded') return 'FILLED';
  if (v === 'rejected' || v === 'error') return 'REJECTED';
  if (v.startsWith('cancel')) return 'CANCELLED';
  if (v === 'confirm' || v === 'sent' || v === 'partial') return 'OPEN';
  return 'UNKNOWN';
}

/** Expiry from the scrip master: exchange epoch (seconds since 1980) or "23-Nov-2026" → "2026-11-23". */
export function motilalExpiry(v: string): string {
  const s = (v ?? '').trim();
  if (/^\d{8,10}$/.test(s) && Number(s) > 0) return istDateOfEpoch(Number(s) + EPOCH_1980);
  const d = istTime(s, false);
  return d ? new Date(d.getTime() + 330 * 60_000).toISOString().slice(0, 10) : '';
}

/** "10-Nov-2026 10:15:30" / "2026-11-10 10:15:30" (IST) → Date. */
function istTime(s: unknown, fallback = true): Date {
  const v = String(s ?? '').trim();
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}:\d{2}:\d{2}))?/.exec(v);
  const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  let d: Date;
  if (m) {
    const mo = MON.indexOf(m[2]!.toUpperCase()) + 1;
    d = new Date(`${m[3]}-${String(mo).padStart(2, '0')}-${m[1]!.padStart(2, '0')}T${m[4] ?? '00:00:00'}+05:30`);
  } else d = new Date(v ? `${v.replace(' ', 'T')}+05:30` : NaN);
  if (Number.isNaN(d.getTime())) return fallback ? new Date() : (null as unknown as Date);
  return d;
}

/** sha256(password + apiKey), as Motilal expects at login. */
export const motilalPasswordHash = (password: string, apiKey: string) => createHash('sha256').update(`${password}${apiKey}`).digest('hex');

/** Motilal scrip master: public CSV per exchange. Key = scripcode (symboltoken). */
export const motilalInstruments = new BrokerInstrumentStore(
  'Motilal',
  (ex) => EX_OUT[ex],
  async (file) => {
    const res = await undiciFetch(`${MOTILAL_API_ROOT}/getscripmastercsv?name=${file}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = parseCsv(await res.text());
    const col = headerIndex(rows[0] ?? []);
    const iCode = col('scripcode'), iShort = col('scripshortname'), iName = col('scripname'), iLot = col('marketlot'), iInst = col('instrumentname');
    const iExp = col('expirydate'), iStrike = col('strikeprice'), iOpt = col('optiontype'), iSusp = col('issuspended');
    if (iCode < 0 || iShort < 0) throw new Error('unexpected Motilal scrip master header');
    const exchange = EX_IN[file]!;
    const deriv = FO_EXCHANGES.includes(exchange as Exchange);
    const out: BrokerInstrument[] = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]!;
      const code = (r[iCode] ?? '').trim();
      const short = (r[iShort] ?? '').trim().toUpperCase();
      if (!code || !short || (r[iSusp] ?? '').trim().toUpperCase() === 'Y') continue;
      const opt = (r[iOpt] ?? '').trim().toUpperCase();
      let symbol: string | null;
      if (deriv) {
        const inst = (r[iInst] ?? '').trim().toUpperCase();
        const type = opt === 'CE' || opt === 'PE' ? opt : inst.startsWith('FUT') ? 'FUT' : null;
        if (!type) continue;
        symbol = canonicalFromParts(short, motilalExpiry(r[iExp] ?? ''), type === 'FUT' ? null : Number(r[iStrike]), type);
      } else {
        // Cash: optiontype carries the series (EQ, BE, …) on NSE.
        if (exchange === 'NSE' && opt !== 'EQ' && opt !== 'BE') continue;
        symbol = short;
      }
      if (!symbol) continue;
      out.push({ exchange, symbol, key: code, lotSize: Number(r[iLot]) || 1, tradingSymbol: (r[iName] ?? '').trim() });
    }
    return out;
  },
);

export interface MotilalSession {
  apiKey: string;
  apiSecret?: string;
  clientCode: string;
  /** Second token from getaccesstoken (sent as the `accesstoken` header when present). */
  accessToken?: string;
  publicIp?: string;
  localIp?: string;
  macAddress?: string;
  proxyUrl?: string;
}

interface MotilalEnvelope {
  status?: string;
  message?: string;
  errorcode?: string;
}

/** Headers every Motilal call carries (login sends an empty Authorization). */
function headers(s: MotilalSession, authToken: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'MOSL/V.1.1.0',
    Authorization: authToken,
    ApiKey: s.apiKey,
    ...(s.apiSecret ? { apisecretkey: s.apiSecret } : {}),
    ...(s.accessToken ? { accesstoken: s.accessToken } : {}),
    ClientLocalIp: s.localIp || s.publicIp || '127.0.0.1',
    ClientPublicIp: s.publicIp || '127.0.0.1',
    MacAddress: s.macAddress || '00:00:00:00:00:00',
    SourceId: 'WEB',
    vendorinfo: s.clientCode,
    osname: 'Linux',
    osversion: '6.0',
    devicemodel: 'Server',
    manufacturer: 'Generic',
    productname: 'CopyTrading',
    productversion: '1.0',
    browsername: 'Chrome',
    browserversion: '120.0',
  };
}

async function post<T>(s: MotilalSession, authToken: string, path: string, payload: object): Promise<T & MotilalEnvelope & { http: number }> {
  const { status: http, body } = await brokerFetch<T & MotilalEnvelope>(`${MOTILAL_API_ROOT}${path}`, {
    method: 'POST',
    headers: headers(s, authToken),
    body: JSON.stringify(payload),
    proxyUrl: s.proxyUrl,
  });
  return { ...(body ?? ({} as T & MotilalEnvelope)), http };
}

const SESSION_CODES = /^MO(8001|8002|8003|8052|1011)$/i;

/**
 * Motilal Oswal OpenAPI adapter. Contracts are (exchange name, scripcode) from Motilal's public scrip master;
 * F&O quantities go out in lots (quantityinlot). Orders need the client's static IP registered with Motilal.
 */
export class MotilalAdapter implements BrokerAdapter {
  readonly broker = 'MOTILAL_OSWAL';

  constructor(
    private readonly session: MotilalSession,
    private readonly authToken: string,
    private readonly opts?: AdapterOptions,
  ) {}

  private async call<T>(path: string, payload: object = {}): Promise<T> {
    const r = await post<{ data?: T }>(this.session, this.authToken, path, payload);
    const ok = r.http >= 200 && r.http < 300 && (!r.status || r.status.toUpperCase() === 'SUCCESS');
    if (!ok) {
      if (r.http === 401 || (r.errorcode && SESSION_CODES.test(r.errorcode))) {
        throw new BrokerApiError(`Motilal Oswal session expired (${r.message || r.errorcode || 'HTTP 401'}) — reconnect.`, r.http, 'TOKEN_EXPIRED');
      }
      // "No data found" on empty books is not an error.
      if (/no (data|record)/i.test(r.message ?? '')) return [] as unknown as T;
      throw new BrokerApiError(r.message || `Motilal Oswal request failed (HTTP ${r.http}).`, r.http, r.errorcode);
    }
    return r.data as T;
  }

  private async instrument(exchange: string, symbol: string): Promise<BrokerInstrument> {
    await motilalInstruments.ensure(exchange);
    const hit = motilalInstruments.get(exchange, canonicalSymbol(symbol));
    if (!hit) throw new BrokerApiError(`Motilal Oswal: instrument ${exchange}:${symbol} not found in the scrip master.`);
    return hit;
  }

  private async decode(exName: unknown, token: unknown, sym: unknown): Promise<{ exchange: Exchange; symbol: string }> {
    const ex = EX_IN[String(exName ?? '').toUpperCase().replace(/\s+CASH$/, '')] ?? 'NSE';
    await motilalInstruments.ensure(ex).catch(() => undefined);
    const hit = motilalInstruments.fromKey(ex, String(token ?? ''));
    return { exchange: toExchange(ex), symbol: hit?.symbol ?? normalizeBrokerSymbol(String(sym ?? '').split(' ')[0] ?? '') };
  }

  /** Motilal takes F&O quantity in lots. */
  private lots(exchange: Exchange, quantity: number, lotSize: number): number {
    if (!FO_EXCHANGES.includes(exchange) || lotSize <= 1) return quantity;
    const n = quantity / lotSize;
    if (!Number.isInteger(n)) throw new BrokerApiError(`Motilal Oswal: quantity ${quantity} is not a multiple of the lot size ${lotSize}.`);
    return n;
  }

  private orderType(t: OrderType): string {
    const v = TYPE_OUT[t];
    if (!v) throw new BrokerApiError('Motilal Oswal does not support SL-M orders — use SL (stop-loss limit).');
    return v;
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const inst = await this.instrument(o.exchange, o.symbol);
    const r = await post<{ uniqueorderid?: string }>(this.session, this.authToken, '/rest/trans/v2/placeorder', {
      exchange: EX_OUT[o.exchange],
      symboltoken: Number(inst.key),
      buyorsell: o.side,
      ordertype: this.orderType(o.orderType),
      producttype: productOut(o.productType),
      orderduration: 'DAY',
      price: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? o.price : 0,
      triggerprice: o.triggerPrice != null && o.orderType === 'SL' ? o.triggerPrice : 0,
      quantityinlot: this.lots(o.exchange, o.quantity, inst.lotSize),
      disclosedquantity: 0,
      amoorder: 'N',
      algoid: '',
      goodtilldate: '',
      tag: (o.tag ?? 'ctp').replace(/[^A-Za-z0-9]/g, '').slice(0, 10),
    });
    if (r.http === 401 || (r.errorcode && SESSION_CODES.test(r.errorcode))) {
      throw new BrokerApiError(`Motilal Oswal session expired (${r.message || r.errorcode || 'HTTP 401'}) — reconnect.`, r.http, 'TOKEN_EXPIRED');
    }
    if (!r.uniqueorderid || (r.status && r.status.toUpperCase() !== 'SUCCESS')) {
      throw new BrokerApiError(r.message || `Motilal Oswal did not return an order id (HTTP ${r.http}).`, r.http, r.errorcode);
    }
    return { brokerOrderId: String(r.uniqueorderid) };
  }

  private async rawOrders(): Promise<Record<string, unknown>[]> {
    const rows = await this.call<Record<string, unknown>[] | null>('/rest/book/v5/getorderbook', { clientcode: '' });
    return Array.isArray(rows) ? rows : [];
  }

  private async findOrder(id: string): Promise<Record<string, unknown>> {
    const row = (await this.rawOrders()).find((r) => String(r.uniqueorderid) === id);
    if (!row) throw new BrokerApiError('Motilal Oswal: order not found in today’s order book.');
    return row;
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    const [row, inst] = await Promise.all([this.findOrder(o.brokerOrderId), this.instrument(o.exchange, o.symbol)]);
    await this.call('/rest/trans/v5/modifyorder', {
      uniqueorderid: o.brokerOrderId,
      newordertype: this.orderType(o.orderType),
      neworderduration: 'DAY',
      newprice: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? o.price : 0,
      newtriggerprice: o.triggerPrice != null && o.orderType === 'SL' ? o.triggerPrice : 0,
      newquantityinlot: this.lots(o.exchange, o.quantity, Number(row.lotsize) || inst.lotSize),
      newdisclosedquantity: 0,
      newgoodtilldate: '',
      lastmodifiedtime: String(row.lastmodifiedtime ?? ''),
      qtytradedtoday: Number(row.qtytradedtoday) || 0,
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.call('/rest/trans/v2/cancelorder', { uniqueorderid: brokerOrderId });
  }

  async orders(): Promise<BrokerOrder[]> {
    const out: BrokerOrder[] = [];
    for (const r of await this.rawOrders()) {
      const { exchange, symbol } = await this.decode(r.exchange, r.symboltoken, r.symbol);
      const ot = String(r.ordertype ?? '').toUpperCase();
      out.push({
        brokerOrderId: String(r.uniqueorderid),
        exchange,
        symbol,
        instrumentToken: r.symboltoken ? String(r.symboltoken) : undefined,
        side: String(r.buyorsell).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
        orderType: ot === 'MARKET' ? 'MARKET' : ot.startsWith('STOP') ? 'SL' : 'LIMIT',
        productType: productIn(r.producttype, exchange),
        quantity: Number(r.orderqty) || 0,
        filledQuantity: Number(r.qtytradedtoday ?? r.totalqtytraded) || 0,
        price: num(r.price),
        averagePrice: num(r.averageprice) || null,
        triggerPrice: num(r.triggerprice),
        status: motilalStatus(String(r.orderstatus)),
        statusMessage: r.error ? String(r.error) : undefined,
        tag: r.tag ? String(r.tag) : undefined,
        lotSize: Number(r.lotsize) || undefined,
        timestamp: istTime(r.recordinserttime || r.entrydatetime),
        raw: r,
      });
    }
    return out;
  }

  async positions(): Promise<BrokerPosition[]> {
    const rows = await this.call<Record<string, unknown>[] | null>('/rest/book/v4/getposition', { clientcode: '' });
    const out: BrokerPosition[] = [];
    for (const p of Array.isArray(rows) ? rows : []) {
      const { exchange, symbol } = await this.decode(p.exchange, p.symboltoken, p.symbol);
      const buyQ = Number(p.buyquantity) || 0;
      const sellQ = Number(p.sellquantity) || 0;
      const net = buyQ - sellQ;
      const avg = net >= 0 ? (buyQ ? (num(p.buyamount) ?? 0) / buyQ : 0) : sellQ ? (num(p.sellamount) ?? 0) / sellQ : 0;
      out.push({
        exchange,
        symbol,
        productType: productIn(p.productname, exchange),
        quantity: net,
        averagePrice: Math.round(avg * 100) / 100,
        lastPrice: num(p.LTP),
        pnl: (num(p.marktomarket) ?? 0) + (num(p.bookedprofitloss) ?? 0),
      });
    }
    return out;
  }

  async holdings(): Promise<BrokerHolding[]> {
    const rows = await this.call<Record<string, unknown>[] | null>('/rest/report/v3/getdpholding', { clientcode: '' });
    const out: BrokerHolding[] = [];
    for (const h of Array.isArray(rows) ? rows : []) {
      await motilalInstruments.ensure('NSE').catch(() => undefined);
      const hit = h.nsesymboltoken ? motilalInstruments.fromKey('NSE', String(h.nsesymboltoken)) : undefined;
      out.push({
        exchange: 'NSE',
        symbol: hit?.symbol ?? canonicalSymbol(String(h.scripname ?? '').split(' ')[0] ?? ''),
        quantity: Number(h.dpquantity) || 0,
        averagePrice: num(h.buyavgprice) ?? 0,
        lastPrice: null,
        pnl: null,
      });
    }
    return out;
  }

  async funds(): Promise<BrokerFunds> {
    const rows = await this.call<{ particulars?: string; amount?: number }[] | null>('/rest/report/v3/getreportmarginsummary', { clientcode: '' });
    const list = Array.isArray(rows) ? rows : [];
    const pick = (re: RegExp) => num(list.find((r) => re.test(String(r.particulars ?? '')))?.amount);
    const cash = pick(/total available margin for cash/i) ?? pick(/available margin/i);
    return { availableCash: cash, net: pick(/total available margin for (fo|f&o)/i) ?? cash };
  }

  async ltp(exchange: Exchange, symbol: string): Promise<number | null> {
    try {
      const inst = await this.instrument(exchange, symbol);
      const d = await this.call<{ ltp?: number }>('/rest/report/v3/getltpdata', { clientcode: '', exchange: EX_OUT[exchange], scripcode: Number(inst.key) });
      const v = num(d?.ltp);
      return v == null ? null : v / 100; // Motilal quotes LTP in paise
    } catch {
      return null;
    }
  }
}

/** Motilal login: user ID + sha256(password + API key) + 2FA (DOB / PAN) + TOTP → AuthToken (till 6:00 AM). */
export class MotilalClient {
  constructor(private readonly session: MotilalSession) {}

  async login(password: string, twoFa: string, totpCode: string): Promise<{ authToken: string; accessToken?: string }> {
    const body = { userid: this.session.clientCode, password: motilalPasswordHash(password, this.session.apiKey), '2FA': twoFa.trim().toUpperCase(), totp: totpCode };
    let r = await post<{ AuthToken?: string }>(this.session, '', '/rest/login/v7/authdirectapi', body);
    if (r.http === 404) r = await post<{ AuthToken?: string }>(this.session, '', '/rest/login/v3/authdirectapi', body);
    if (!r.AuthToken || (r.status && r.status.toUpperCase() !== 'SUCCESS')) {
      throw new BrokerApiError(r.message || `Motilal Oswal login failed (HTTP ${r.http}). Check user ID, password, DOB/PAN and TOTP.`, r.http, r.errorcode);
    }
    // Newer API keys also need an access token on every call; older ones do not have this endpoint.
    let accessToken: string | undefined;
    try {
      const a = await post<{ accesstoken?: string }>(this.session, r.AuthToken, '/rest/login/v1/getaccesstoken', { clientcode: '' });
      accessToken = a.accesstoken || undefined;
    } catch {
      /* optional */
    }
    return { authToken: r.AuthToken, accessToken };
  }
}
