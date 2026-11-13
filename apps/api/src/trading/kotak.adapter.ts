import { randomBytes } from 'node:crypto';
import type { Exchange, OrderStatus, OrderType, ProductType } from '@ctp/database';
import { fetch as undiciFetch } from 'undici';
import { BrokerInstrumentStore, headerIndex, istDateOfEpoch, csvRows, type BrokerInstrument } from '../market-data/broker-instruments';
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

/** Login host (TOTP + MPIN). Every other call goes to the `baseUrl` returned by tradeApiValidate. */
export const KOTAK_LOGIN_ROOT = 'https://mis.kotaksecurities.com';
const NEO_FIN_KEY = 'neotradeapi';
const ORDER_SOURCE = 'NEOTRADEAPI';

/** Platform exchange ↔ Kotak exchange segment. */
const SEG_OUT: Record<string, string> = { NSE: 'nse_cm', BSE: 'bse_cm', NFO: 'nse_fo', BFO: 'bse_fo', MCX: 'mcx_fo', CDS: 'cde_fo', BCD: 'bcs-fo' };
const SEG_IN: Record<string, string> = Object.fromEntries(Object.entries(SEG_OUT).map(([k, v]) => [v, k]));

const PRODUCT_OUT: Record<ProductType, string> = { DELIVERY: 'CNC', INTRADAY: 'MIS', CARRY_FORWARD: 'NRML' };
const TYPE_OUT: Record<OrderType, string> = { MARKET: 'MKT', LIMIT: 'L', SL: 'SL', SL_M: 'SL-M' };
const TYPE_IN: Record<string, OrderType> = { MKT: 'MARKET', L: 'LIMIT', SL: 'SL', 'SL-M': 'SL_M' };

function productIn(p: string, exchange: Exchange): ProductType {
  const v = p.toUpperCase();
  if (v === 'MIS' || v === 'INTRADAY' || v === 'CO' || v === 'BO') return 'INTRADAY';
  if (v === 'CNC' || v === 'MTF') return 'DELIVERY';
  return FO_EXCHANGES.includes(exchange) ? 'CARRY_FORWARD' : 'DELIVERY';
}

function status(s: string): OrderStatus {
  const v = (s ?? '').toLowerCase();
  if (v === 'complete' || v === 'traded' || v === 'filled') return 'FILLED';
  if (v === 'rejected') return 'REJECTED';
  if (v === 'cancelled') return 'CANCELLED';
  if (v.includes('open') || v.includes('pending') || v.includes('trigger') || v.includes('received') || v.includes('modif') || v.includes('partial')) return 'OPEN';
  return 'UNKNOWN';
}

/** "22-Jan-2026 14:28:01" (IST) → Date. */
function kTime(s: unknown): Date {
  const d = s ? new Date(`${String(s).replace(/-/g, ' ')} GMT+0530`) : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Kotak F&O expiries are seconds since 1980-01-01 for some segments; anything that lands before 2020 is shifted. */
const OFFSET_1980 = 315_511_200;
function kotakExpiry(v: number): string {
  let s = v > 1e12 ? v / 1000 : v;
  if (new Date(s * 1000).getUTCFullYear() < 2020) s += OFFSET_1980;
  // MCX rows carry the IST wall clock as if it were UTC (…23:59:59); NSE/BSE carry real epochs (18:29:59 UTC).
  if (Math.floor(s) % 86_400 === 86_399) return new Date(s * 1000).toISOString().slice(0, 10);
  return istDateOfEpoch(s);
}

/**
 * Kotak Neo scrip master: per-segment CSV files whose paths come from the session's base URL. The strike
 * column may be in paise — the value that appears in the trading symbol wins.
 */
const KOTAK_SCRIP_ROOT = 'https://lapi.kotaksecurities.com/wso2-scripmaster/v1/prod';

export const kotakInstruments = new BrokerInstrumentStore(
  'KotakNeo',
  (ex) => SEG_OUT[ex],
  async (seg, ctx) => {
    // The file-paths call (through the static-IP proxy) sometimes takes >15 s; the files themselves are public
    // and dated, so fall back to that URL rather than failing the order that triggered the load.
    let url: string | undefined;
    if (ctx?.baseUrl && ctx.consumerKey) {
      try {
        const { status: http, body } = await brokerFetch<{ data?: { filesPaths?: string[] } }>(`${ctx.baseUrl.replace(/\/$/, '')}/script-details/1.0/masterscrip/file-paths`, {
          headers: { Authorization: ctx.consumerKey, Accept: 'application/json' },
          proxyUrl: ctx.proxyUrl,
          timeoutMs: 20_000,
        });
        if (http === 200) url = body?.data?.filesPaths?.find((p) => p.toLowerCase().includes(`/${seg}.csv`)) ?? body?.data?.filesPaths?.find((p) => p.toLowerCase().includes(seg));
      } catch {
        /* fall through to the public URL */
      }
    }
    url ??= `${KOTAK_SCRIP_ROOT}/${new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10)}/transformed/${seg}.csv`;
    const res = await undiciFetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = csvRows(await res.text());
    const col = headerIndex(rows.next().value ?? []);
    const iTok = col('pSymbol'), iSeg = col('pExchSeg'), iInst = col('pInstType'), iName = col('pSymbolName'), iTs = col('pTrdSymbol');
    const iOpt = col('pOptionType'), iLot = col('lLotSize'), iExp = col('lExpiryDate', 'pExpiryDate'), iStrike = col('dStrikePrice'), iGroup = col('pGroup');
    if (iTok < 0 || iTs < 0) throw new Error('unexpected Kotak scrip master header');
    const exchange = SEG_IN[seg]!;
    const out: BrokerInstrument[] = [];
    for (const r of rows) {
      if (iSeg >= 0 && r[iSeg] && r[iSeg]!.toLowerCase() !== seg) continue;
      const ts = (r[iTs] ?? '').trim().toUpperCase();
      const inst = (r[iInst] ?? '').toUpperCase();
      let symbol: string | null = null;
      // NSE/MCX files use OPTIDX/OPTSTK/FUTIDX…; the BSE F&O file uses IO/SO (options) and IF/SF (futures).
      const isFut = inst.startsWith('FUT') || inst === 'IF' || inst === 'SF';
      const isOpt = inst.startsWith('OPT') || inst === 'IO' || inst === 'SO';
      if (isOpt || isFut) {
        const opt = (r[iOpt] ?? '').trim().toUpperCase();
        const type = isFut ? 'FUT' : opt === 'CE' || opt === 'PE' ? opt : null;
        const exp = Number(r[iExp]);
        if (!type || !exp) continue;
        let strike = Number(r[iStrike]) || 0;
        if (type !== 'FUT' && strike && !ts.includes(String(strike)) && ts.includes(String(strike / 100))) strike /= 100;
        else if (type !== 'FUT' && strike >= 100 && !ts.includes(String(strike))) strike /= 100;
        symbol = canonicalFromParts((r[iName] ?? '').trim(), kotakExpiry(exp), type === 'FUT' ? null : strike, type);
      } else if (seg === 'nse_cm' || seg === 'bse_cm') {
        const group = iGroup >= 0 ? (r[iGroup] ?? '').toUpperCase() : '';
        if (seg === 'nse_cm' && group && group !== 'EQ' && group !== 'BE' && !ts.endsWith('-EQ') && !ts.endsWith('-BE')) continue;
        symbol = canonicalSymbol(ts) || null;
      }
      if (!symbol) continue;
      out.push({ exchange, symbol, key: (r[iTok] ?? '').trim(), lotSize: Number(r[iLot]) || 1, tradingSymbol: ts });
    }
    return out;
  },
);

/**
 * Kotak treats `ig` (echoed as GuiOrdId) as a client order id that must be unique: a repeated value is
 * rejected with "error from core" (Client OrderID already exists), so a fixed "ctpcopy" let only the day's
 * first order through. Keep the platform prefix (reconciler matches tags starting with "ctp") + random suffix.
 */
export function kotakOrderTag(tag?: string): string {
  const prefix = (tag ?? 'ctp').replace(/[^A-Za-z0-9]/g, '').slice(0, 9) || 'ctp';
  return `${prefix}${randomBytes(10).toString('hex')}`.slice(0, 20);
}

export interface KotakSession {
  token: string; // trade (edit) token
  sid: string;
  serverId: string;
  baseUrl: string;
  consumerKey: string;
}

interface KEnv {
  stat?: string;
  stCode?: number;
  errMsg?: string;
  emsg?: string;
  message?: string;
  data?: unknown;
}

/** Kotak Neo Trade API (v2, 2025+) adapter: form posts with `jData`, headers Auth + Sid, query sId. */
export class KotakNeoAdapter implements BrokerAdapter {
  readonly broker = 'KOTAK_NEO';

  constructor(
    private readonly s: KotakSession,
    private readonly proxyUrl?: string,
    private readonly opts?: AdapterOptions,
  ) {}

  private get base(): string {
    return this.s.baseUrl.replace(/\/$/, '');
  }

  private async call<T>(path: string, method: 'GET' | 'POST', jData?: object): Promise<T & KEnv> {
    const url = `${this.base}/${path}?sId=${encodeURIComponent(this.s.serverId)}`;
    const { status: http, body } = await brokerFetch<T & KEnv>(url, {
      method,
      headers: {
        Sid: this.s.sid,
        Auth: this.s.token,
        Accept: 'application/json',
        ...(jData ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: jData ? new URLSearchParams({ jData: JSON.stringify(jData) }).toString() : undefined,
      proxyUrl: this.proxyUrl,
    });
    const stat = (body?.stat ?? '').toLowerCase();
    if (http < 200 || http >= 300 || (stat && stat !== 'ok')) {
      throw new BrokerApiError(body?.errMsg || body?.emsg || body?.message || `Kotak Neo request failed (HTTP ${http}).`, http, body?.stCode != null ? String(body.stCode) : undefined);
    }
    return body;
  }

  private async instrument(exchange: string, symbol: string): Promise<BrokerInstrument> {
    await kotakInstruments.ensure(exchange, { baseUrl: this.s.baseUrl, consumerKey: this.s.consumerKey, proxyUrl: this.proxyUrl });
    const hit = kotakInstruments.get(exchange, canonicalSymbol(symbol));
    if (!hit) throw new BrokerApiError(`Kotak Neo: instrument ${exchange}:${symbol} not found in the scrip master.`);
    return hit;
  }

  private async decode(seg: unknown, tok: unknown, ts: unknown): Promise<{ exchange: Exchange; symbol: string }> {
    const ex = SEG_IN[String(seg ?? '').toLowerCase()] ?? 'NSE';
    await kotakInstruments.ensure(ex, { baseUrl: this.s.baseUrl, consumerKey: this.s.consumerKey, proxyUrl: this.proxyUrl }).catch(() => undefined);
    const hit = tok ? kotakInstruments.fromKey(ex, String(tok)) : undefined;
    const raw = String(ts ?? '').toUpperCase();
    return { exchange: toExchange(ex), symbol: hit?.symbol ?? (FO_EXCHANGES.includes(ex as Exchange) ? normalizeBrokerSymbol(raw) : canonicalSymbol(raw)) };
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const inst = await this.instrument(o.exchange, o.symbol);
    const d = await this.call<{ nOrdNo?: string }>('quick/order/rule/ms/place', 'POST', {
      am: 'NO',
      dq: '0',
      es: SEG_OUT[o.exchange],
      mp: '0',
      pc: PRODUCT_OUT[o.productType],
      pf: 'N',
      pr: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? String(o.price) : '0',
      pt: TYPE_OUT[o.orderType],
      qt: String(o.quantity),
      rt: 'DAY',
      tp: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? String(o.triggerPrice) : '0',
      ts: inst.tradingSymbol,
      tt: o.side === 'BUY' ? 'B' : 'S',
      tk: inst.key,
      ig: kotakOrderTag(o.tag),
      os: ORDER_SOURCE,
    });
    if (!d.nOrdNo) throw new BrokerApiError('Kotak Neo did not return an order number.');
    return { brokerOrderId: String(d.nOrdNo) };
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    const inst = await this.instrument(o.exchange, o.symbol);
    await this.call('quick/order/vr/modify', 'POST', {
      tk: inst.key,
      mp: '0',
      pc: PRODUCT_OUT[o.productType],
      dd: 'NA',
      dq: '0',
      vd: 'DAY',
      ts: inst.tradingSymbol,
      tt: o.side === 'BUY' ? 'B' : 'S',
      pr: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? String(o.price) : '0',
      pt: TYPE_OUT[o.orderType],
      fq: '0',
      am: 'NO',
      tp: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? String(o.triggerPrice) : '0',
      qt: String(o.quantity),
      no: o.brokerOrderId,
      es: SEG_OUT[o.exchange],
      os: ORDER_SOURCE,
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.call('quick/order/cancel', 'POST', { on: brokerOrderId, am: 'NO' });
  }

  async orders(): Promise<BrokerOrder[]> {
    let d: { data?: Record<string, unknown>[] } & KEnv;
    try {
      d = await this.call<{ data?: Record<string, unknown>[] }>('quick/user/orders', 'GET');
    } catch (err) {
      if (err instanceof BrokerApiError && /no data|not found/i.test(err.message)) return [];
      throw err;
    }
    const out: BrokerOrder[] = [];
    for (const r of Array.isArray(d.data) ? d.data : []) {
      const { exchange, symbol } = await this.decode(r.exSeg, r.tok, r.trdSym);
      const rej = r.rejRsn && r.rejRsn !== '--' ? String(r.rejRsn) : undefined;
      out.push({
        brokerOrderId: String(r.nOrdNo),
        exchange,
        symbol,
        instrumentToken: r.tok ? String(r.tok) : undefined,
        side: String(r.trnsTp).toUpperCase() === 'S' ? 'SELL' : 'BUY',
        orderType: TYPE_IN[String(r.prcTp).toUpperCase()] ?? 'MARKET',
        productType: productIn(String(r.prod ?? ''), exchange),
        quantity: Number(r.qty) || 0,
        filledQuantity: Number(r.fldQty) || 0,
        price: num(r.prc),
        averagePrice: num(r.avgPrc),
        triggerPrice: num(r.trgPrc),
        status: status(String(r.ordSt ?? r.stat)),
        statusMessage: rej,
        tag: r.GuiOrdId ? String(r.GuiOrdId) : undefined,
        timestamp: kTime(r.ordDtTm ?? r.exCfmTm),
        raw: r,
      });
    }
    return out;
  }

  async positions(): Promise<BrokerPosition[]> {
    let d: { data?: Record<string, unknown>[] } & KEnv;
    try {
      d = await this.call<{ data?: Record<string, unknown>[] }>('quick/user/positions', 'GET');
    } catch (err) {
      if (err instanceof BrokerApiError && /no data|not found/i.test(err.message)) return [];
      throw err;
    }
    const out: BrokerPosition[] = [];
    for (const p of Array.isArray(d.data) ? d.data : []) {
      const { exchange, symbol } = await this.decode(p.exSeg, p.tok, p.trdSym);
      const n = (k: string) => Number(p[k]) || 0;
      const buyQty = n('cfBuyQty') + n('flBuyQty');
      const sellQty = n('cfSellQty') + n('flSellQty');
      const net = buyQty - sellQty;
      const scale = (n('multiplier') || 1) * ((n('genNum') || 1) / (n('genDen') || 1)) * ((n('prcNum') || 1) / (n('prcDen') || 1));
      const buyAmt = n('cfBuyAmt') + n('buyAmt');
      const sellAmt = n('cfSellAmt') + n('sellAmt');
      const avg = net > 0 && buyQty ? buyAmt / (buyQty * scale) : net < 0 && sellQty ? sellAmt / (sellQty * scale) : 0;
      out.push({
        exchange,
        symbol,
        productType: productIn(String(p.prod ?? ''), exchange),
        quantity: net,
        averagePrice: Math.round(avg * 100) / 100,
        lastPrice: null,
        pnl: net === 0 ? Math.round((sellAmt - buyAmt) * 100) / 100 : null,
      });
    }
    return out;
  }

  async holdings(): Promise<BrokerHolding[]> {
    const { status: http, body } = await brokerFetch<{ data?: Record<string, unknown>[] } & KEnv>(`${this.base}/portfolio/v1/holdings`, {
      headers: { Sid: this.s.sid, Auth: this.s.token, Accept: 'application/json' },
      proxyUrl: this.proxyUrl,
    });
    if (http !== 200) throw new BrokerApiError(body?.message || body?.errMsg || `Kotak Neo holdings failed (HTTP ${http}).`, http);
    return (Array.isArray(body?.data) ? body!.data! : []).map((h) => {
      const qty = Number(h.quantity) || 0;
      const avg = num(h.averagePrice) ?? 0;
      const ltp = num(h.closingPrice);
      return {
        exchange: toExchange(SEG_IN[String(h.exchangeSegment ?? 'nse_cm')] === 'BSE' ? 'BSE' : 'NSE'),
        symbol: canonicalSymbol(String(h.displaySymbol ?? h.symbol ?? '')),
        quantity: qty,
        averagePrice: avg,
        lastPrice: ltp,
        pnl: ltp != null ? Math.round((ltp - avg) * qty * 100) / 100 : null,
      };
    });
  }

  async funds(): Promise<BrokerFunds> {
    const d = await this.call<Record<string, unknown>>('quick/user/limits', 'POST', { seg: 'ALL', exch: 'ALL', prod: 'ALL' });
    return { availableCash: num(d.Net), net: num(d.CollateralValue) };
  }

  async ltp(exchange: Exchange, symbol: string): Promise<number | null> {
    try {
      const inst = await this.instrument(exchange, symbol);
      const neo = encodeURIComponent(`${SEG_OUT[exchange]}|${inst.key}`);
      const { body } = await brokerFetch<unknown>(`${this.base}/script-details/1.0/quotes/neosymbol/${neo}/ltp`, {
        headers: { Authorization: this.s.consumerKey, Accept: 'application/json' },
        proxyUrl: this.proxyUrl,
      });
      const first = (Array.isArray(body) ? body[0] : (body as { data?: unknown[] } | null)?.data?.[0]) as Record<string, unknown> | undefined;
      return num(first?.ltp ?? first?.last_traded_price);
    } catch {
      return null;
    }
  }
}

/** Kotak Neo v2 login: TOTP (view token) → MPIN (trade token + base URL), all with the client's consumer key. */
export class KotakNeoClient {
  constructor(private readonly cfg: { consumerKey: string; proxyUrl?: string }) {}

  private async post(path: string, headers: Record<string, string>, payload: object) {
    const { status: http, body } = await brokerFetch<{ data?: Record<string, string>; message?: string; errMsg?: string; emsg?: string; error?: { message?: string }[] }>(
      `${KOTAK_LOGIN_ROOT}/${path}`,
      {
        method: 'POST',
        headers: { Authorization: this.cfg.consumerKey, 'neo-fin-key': NEO_FIN_KEY, 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(payload),
        proxyUrl: this.cfg.proxyUrl,
      },
    );
    if (http < 200 || http >= 300 || !body?.data?.token) {
      throw new BrokerApiError(body?.errMsg || body?.emsg || body?.message || body?.error?.[0]?.message || `Kotak Neo login failed (HTTP ${http}).`, http);
    }
    return body.data;
  }

  async login(mobile: string, ucc: string, totpCode: string, mpin: string): Promise<KotakSession & { ucc: string }> {
    const mob = mobile.startsWith('+') ? mobile : `+91${mobile.replace(/^0+/, '').replace(/^91(?=\d{10}$)/, '')}`;
    const view = await this.post('login/1.0/tradeApiLogin', {}, { mobileNumber: mob, ucc, totp: totpCode });
    const trade = await this.post('login/1.0/tradeApiValidate', { sid: view.sid ?? '', Auth: view.token! }, { mpin });
    if (!trade.baseUrl || !trade.sid) throw new BrokerApiError('Kotak Neo login did not return a session (baseUrl / sid).');
    return {
      token: trade.token!,
      sid: trade.sid,
      serverId: trade.hsServerId ?? '',
      baseUrl: trade.baseUrl,
      consumerKey: this.cfg.consumerKey,
      ucc: (trade.ucc || view.ucc || ucc).toUpperCase(),
    };
  }
}
