import type { Exchange, OrderStatus } from '@ctp/database';
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

export const FIVEPAISA_API_ROOT = 'https://Openapi.5paisa.com/VendorsAPI/Service1.svc';
/** Public API uid the official 5paisa SDK sends with every call. */
const API_UID = 'ka7SFqAU6SC';

/** Platform exchange ↔ 5paisa Exch + ExchType + scrip-master segment. */
const OUT: Record<string, { exch: string; type: string; seg: string }> = {
  NSE: { exch: 'N', type: 'C', seg: 'nse_eq' },
  BSE: { exch: 'B', type: 'C', seg: 'bse_eq' },
  NFO: { exch: 'N', type: 'D', seg: 'nse_fo' },
  BFO: { exch: 'B', type: 'D', seg: 'bse_fo' },
  MCX: { exch: 'M', type: 'D', seg: 'mcx_fo' },
  CDS: { exch: 'N', type: 'U', seg: 'ncd_fo' },
};
const SEG_EX: Record<string, string> = Object.fromEntries(Object.entries(OUT).map(([k, v]) => [v.seg, k]));
function exchangeOf(exch: unknown, type: unknown): string {
  const e = String(exch ?? 'N').toUpperCase();
  const t = String(type ?? 'C').toUpperCase();
  if (e === 'M') return 'MCX';
  if (t === 'D') return e === 'B' ? 'BFO' : 'NFO';
  if (t === 'U') return e === 'B' ? 'BCD' : 'CDS';
  return e === 'B' ? 'BSE' : 'NSE';
}

function status(s: string): OrderStatus {
  const v = (s ?? '').toLowerCase();
  if (v.includes('fully executed')) return 'FILLED';
  if (v.includes('rejected')) return 'REJECTED';
  if (v.includes('cancel')) return 'CANCELLED';
  if (v.includes('pending') || v.includes('modified') || v.includes('xmitted') || v.includes('placed') || v.includes('partial')) return 'OPEN';
  return 'UNKNOWN';
}

/** "/Date(1707279047230+0530)/" → Date. */
function msDate(s: unknown): Date {
  const m = /Date\((\d+)/.exec(String(s ?? ''));
  return m ? new Date(Number(m[1])) : new Date();
}

/** 5paisa scrip master (public CSV per segment). Key = ScripCode; ScripData is sent with orders too. */
export const fivePaisaInstruments = new BrokerInstrumentStore(
  'FivePaisa',
  (ex) => OUT[ex]?.seg,
  async (seg) => {
    const res = await undiciFetch(`${FIVEPAISA_API_ROOT}/ScripMaster/segment/${seg}`, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rows = csvRows(await res.text());
    const col = headerIndex(rows.next().value ?? []);
    const iCode = col('ScripCode'), iData = col('ScripData'), iType = col('ScripType'), iStrike = col('StrikeRate'), iLot = col('LotSize');
    const iRoot = col('SymbolRoot'), iExp = col('Expiry'), iSeries = col('Series'), iName = col('Name');
    if (iCode < 0 || iData < 0) throw new Error('unexpected 5paisa scrip master header');
    const exchange = SEG_EX[seg]!;
    const deriv = FO_EXCHANGES.includes(exchange as Exchange);
    const out: BrokerInstrument[] = [];
    for (const r of rows) {
      const data = (r[iData] ?? '').trim();
      if (!r[iCode] || !data) continue;
      let symbol: string | null = null;
      if (deriv) {
        // Option "BANKNIFTY 24 Nov 2026 CE 41600.00_20261124_CE_41600" · Future "NIFTY 30 Oct 2026_20261030"
        const parts = data.split('_');
        const ymd = parts.find((p) => /^\d{8}$/.test(p));
        const expiry = ymd ? `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}` : (r[iExp] ?? '').slice(0, 10);
        const st = (r[iType] ?? '').toUpperCase();
        const type = st === 'CE' || st === 'PE' ? st : 'FUT';
        const root = (r[iRoot] ?? r[iName] ?? '').trim();
        symbol = canonicalFromParts(root, expiry, type === 'FUT' ? null : Number(r[iStrike]), type);
      } else {
        const m = /^(.+)_([A-Z0-9]{1,3})$/.exec(data.toUpperCase());
        const series = (iSeries >= 0 ? r[iSeries] : m?.[2]) ?? '';
        if (exchange === 'NSE' && !/^(EQ|BE)$/i.test(series.trim()) && m?.[2] !== 'EQ' && m?.[2] !== 'BE') continue;
        symbol = m ? m[1]! : null;
      }
      if (!symbol) continue;
      out.push({ exchange, symbol, key: r[iCode]!.trim(), lotSize: Number(r[iLot]) || 1, tradingSymbol: data });
    }
    return out;
  },
);

interface FEnv<T> {
  head?: { status?: string; statusDescription?: string };
  body?: (T & { Status?: number; Message?: string }) | null;
}

export interface FivePaisaSession {
  token: string;
  userKey: string;
  clientCode: string;
}

/** 5paisa Xtream API adapter (JSON head/body envelope, bearer JWT valid until 11:59 PM). */
export class FivePaisaAdapter implements BrokerAdapter {
  readonly broker = 'FIVE_PAISA';

  constructor(
    private readonly s: FivePaisaSession,
    private readonly proxyUrl?: string,
    private readonly opts?: AdapterOptions,
  ) {}

  private async call<T>(path: string, body: object = {}, okStatuses: number[] = [0]): Promise<T & { Status?: number; Message?: string }> {
    const { status: http, body: res } = await brokerFetch<FEnv<T>>(`${FIVEPAISA_API_ROOT}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `bearer ${this.s.token}`, '5Paisa-API-Uid': API_UID },
      body: JSON.stringify({ head: { key: this.s.userKey }, body: { ClientCode: this.s.clientCode, ...body } }),
      proxyUrl: this.proxyUrl,
    });
    const b = res?.body;
    if (http !== 200 || !b || (b.Status != null && !okStatuses.includes(Number(b.Status)))) {
      throw new BrokerApiError(b?.Message || res?.head?.statusDescription || `5paisa request failed (HTTP ${http}).`, http, b?.Status != null ? String(b.Status) : undefined);
    }
    return b;
  }

  private async instrument(exchange: string, symbol: string): Promise<BrokerInstrument> {
    await fivePaisaInstruments.ensure(exchange);
    const hit = fivePaisaInstruments.get(exchange, canonicalSymbol(symbol));
    if (!hit) throw new BrokerApiError(`5paisa: instrument ${exchange}:${symbol} not found in the scrip master.`);
    return hit;
  }

  private async decode(exch: unknown, type: unknown, code: unknown, name: unknown): Promise<{ exchange: Exchange; symbol: string }> {
    const ex = exchangeOf(exch, type);
    await fivePaisaInstruments.ensure(ex).catch(() => undefined);
    const hit = fivePaisaInstruments.fromKey(ex, String(code ?? ''));
    return { exchange: toExchange(ex), symbol: hit?.symbol ?? normalizeBrokerSymbol(String(name ?? '').replace(/\s+/g, '')) };
  }

  /** 5paisa cancels / modifies by the exchange order id; the platform keeps the broker order id. */
  private async exchOrderId(brokerOrderId: string): Promise<string> {
    const d = await this.call<{ OrderBookDetail?: Record<string, unknown>[] }>('V4/OrderBook', {}, [0, 1]);
    const row = (d.OrderBookDetail ?? []).find((r) => String(r.BrokerOrderId) === brokerOrderId || String(r.ExchOrderID) === brokerOrderId);
    const id = row?.ExchOrderID ? String(row.ExchOrderID) : '';
    if (!id || id === '0') throw new BrokerApiError('5paisa: order is not on the exchange yet — try again in a moment.');
    return id;
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const inst = await this.instrument(o.exchange, o.symbol);
    const x = OUT[o.exchange]!;
    const d = await this.call<{ BrokerOrderID?: number | string }>('V1/PlaceOrderRequest', {
      Exchange: x.exch,
      ExchangeType: x.type,
      ScripCode: Number(inst.key),
      ScripData: inst.tradingSymbol,
      Price: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? o.price : 0,
      StopLossPrice: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? o.triggerPrice : 0,
      OrderType: o.side === 'BUY' ? 'B' : 'S',
      Qty: o.quantity,
      DisQty: 0,
      IsIntraday: o.productType === 'INTRADAY',
      AHPlaced: 'N',
      iOrderValidity: 0,
      RemoteOrderID: (o.tag ?? 'ctp').replace(/[^A-Za-z0-9]/g, '').slice(0, 20) + Date.now().toString(36),
    });
    if (!d.BrokerOrderID || String(d.BrokerOrderID) === '0') throw new BrokerApiError(d.Message || '5paisa did not return an order id.');
    return { brokerOrderId: String(d.BrokerOrderID) };
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    await this.call('V1/ModifyOrderRequest', {
      ExchOrderID: await this.exchOrderId(o.brokerOrderId),
      Price: o.price != null && (o.orderType === 'LIMIT' || o.orderType === 'SL') ? o.price : 0,
      StopLossPrice: o.triggerPrice != null && (o.orderType === 'SL' || o.orderType === 'SL_M') ? o.triggerPrice : 0,
      Qty: o.quantity,
      DisQty: 0,
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.call('V1/CancelOrderRequest', { ExchOrderID: await this.exchOrderId(brokerOrderId) });
  }

  async orders(): Promise<BrokerOrder[]> {
    const d = await this.call<{ OrderBookDetail?: Record<string, unknown>[] }>('V4/OrderBook', {}, [0, 1]);
    const out: BrokerOrder[] = [];
    for (const r of d.OrderBookDetail ?? []) {
      const { exchange, symbol } = await this.decode(r.Exch, r.ExchType, r.ScripCode, r.ScripName);
      const atMarket = String(r.AtMarket) === 'Y';
      const withSl = String(r.WithSL) === 'Y';
      const di = String(r.DelvIntra ?? 'D');
      out.push({
        brokerOrderId: String(r.BrokerOrderId),
        exchange,
        symbol,
        instrumentToken: r.ScripCode ? String(r.ScripCode) : undefined,
        side: String(r.BuySell) === 'S' ? 'SELL' : 'BUY',
        orderType: withSl ? (atMarket ? 'SL_M' : 'SL') : atMarket ? 'MARKET' : 'LIMIT',
        productType: di === 'I' || di === 'S' || di === 'C' ? 'INTRADAY' : FO_EXCHANGES.includes(exchange) ? 'CARRY_FORWARD' : 'DELIVERY',
        quantity: Number(r.Qty) || 0,
        filledQuantity: Number(r.TradedQty) || 0,
        price: num(r.Rate),
        averagePrice: num(r.AveragePrice),
        triggerPrice: num(r.SLTriggerRate),
        status: status(String(r.OrderStatus)),
        statusMessage: r.Reason ? String(r.Reason) : undefined,
        tag: r.RemoteOrderID ? String(r.RemoteOrderID) : undefined,
        timestamp: msDate(r.ExchOrderTime || r.BrokerOrderTime),
        raw: r,
      });
    }
    return out;
  }

  async positions(): Promise<BrokerPosition[]> {
    const d = await this.call<{ NetPositionDetail?: Record<string, unknown>[] }>('V3/NetPositionNetWise', {}, [0, 1]);
    const out: BrokerPosition[] = [];
    for (const p of d.NetPositionDetail ?? []) {
      const { exchange, symbol } = await this.decode(p.Exch, p.ExchType, p.ScripCode, p.ScripName);
      const net = Number(p.NetQty) || 0;
      const of = String(p.OrderFor ?? 'D');
      out.push({
        exchange,
        symbol,
        productType: of === 'I' || of === 'S' || of === 'C' ? 'INTRADAY' : FO_EXCHANGES.includes(exchange) ? 'CARRY_FORWARD' : 'DELIVERY',
        quantity: net,
        averagePrice: num(net >= 0 ? p.BuyAvgRate : p.SellAvgRate) ?? 0,
        lastPrice: num(p.LTP),
        pnl: (num(p.MTOM) ?? 0) + (num(p.BookedPL) ?? 0),
      });
    }
    return out;
  }

  async holdings(): Promise<BrokerHolding[]> {
    const d = await this.call<{ Data?: Record<string, unknown>[] }>('V3/Holding', {}, [0, 1]);
    return (d.Data ?? []).map((h) => {
      const qty = Number(h.Quantity) || 0;
      const avg = num(h.AvgRate) ?? 0;
      const ltp = num(h.CurrentPrice);
      return {
        exchange: toExchange(String(h.Exch) === 'B' ? 'BSE' : 'NSE'),
        symbol: canonicalSymbol(String(h.Symbol ?? '')),
        quantity: qty,
        averagePrice: avg,
        lastPrice: ltp,
        pnl: ltp != null ? Math.round((ltp - avg) * qty * 100) / 100 : null,
      };
    });
  }

  async funds(): Promise<BrokerFunds> {
    const d = await this.call<{ EquityMargin?: Record<string, unknown>[] }>('V4/Margin');
    const m = d.EquityMargin?.[0] ?? {};
    return { availableCash: num(m.NetAvailableMargin ?? m.AvailableMargin ?? m.ALB), net: num(m.Ledgerbalance ?? m.LedgerBalance) };
  }

  async ltp(exchange: Exchange, symbol: string): Promise<number | null> {
    try {
      const inst = await this.instrument(exchange, symbol);
      const x = OUT[exchange]!;
      const d = await this.call<{ Data?: { LastRate?: number }[] }>('V1/MarketFeed', {
        MarketFeedData: [{ Exch: x.exch, ExchType: x.type, ScripCode: Number(inst.key) }],
        LastRequestTime: '/Date(0)/',
        RefreshRate: 'H',
      });
      return num(d.Data?.[0]?.LastRate);
    } catch {
      return null;
    }
  }
}

/** 5paisa TOTP login: TOTPLogin (client code + TOTP + PIN) → request token → GetAccessToken (encryption key + user id). */
export class FivePaisaClient {
  constructor(private readonly cfg: { userKey: string; encryptionKey: string; userId: string; proxyUrl?: string }) {}

  private async post<T>(path: string, body: object): Promise<T & { Status?: number; Message?: string }> {
    const { status: http, body: res } = await brokerFetch<FEnv<T>>(`${FIVEPAISA_API_ROOT}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', '5Paisa-API-Uid': API_UID },
      body: JSON.stringify({ head: { Key: this.cfg.userKey }, body }),
      proxyUrl: this.cfg.proxyUrl,
    });
    if (http !== 200 || !res?.body) throw new BrokerApiError(res?.head?.statusDescription || `5paisa login failed (HTTP ${http}).`, http);
    return res.body;
  }

  async login(clientCode: string, totpCode: string, pin: string): Promise<{ accessToken: string; clientCode: string }> {
    const rt = await this.post<{ RequestToken?: string }>('TOTPLogin', { Email_ID: clientCode, TOTP: totpCode, PIN: pin });
    if (Number(rt.Status) !== 0 || !rt.RequestToken) throw new BrokerApiError(rt.Message || '5paisa TOTP login failed — check client code, PIN and TOTP.');
    const at = await this.post<{ AccessToken?: string; ClientCode?: string }>('GetAccessToken', {
      RequestToken: rt.RequestToken,
      EncryKey: this.cfg.encryptionKey,
      UserId: this.cfg.userId,
    });
    if (!at.AccessToken) throw new BrokerApiError(at.Message || '5paisa did not return an access token — check User Key, Encryption Key and User ID.');
    return { accessToken: at.AccessToken, clientCode: String(at.ClientCode || clientCode) };
  }
}
