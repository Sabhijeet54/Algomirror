import { createHash } from "node:crypto";
import type {
  Exchange,
  OrderStatus,
  OrderType,
  ProductType,
} from "@ctp/database";
import { fetch as undiciFetch } from "undici";
import {
  BrokerInstrumentStore,
  istDateOfEpoch,
  csvRows,
  type BrokerInstrument,
} from "../market-data/broker-instruments";
import { BrokerApiError, brokerFetch } from "../brokers/broker-http";
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
} from "./broker-adapter";
import { canonicalFromParts, normalizeBrokerSymbol } from "./symbols";

export const FYERS_API_ROOT = "https://api-t1.fyers.in/api/v3";
const DATA_ROOT = "https://api-t1.fyers.in/data";

/** Platform exchange → Fyers symbol-master file. */
const FILE_OF: Record<string, string> = {
  NSE: "NSE_CM",
  NFO: "NSE_FO",
  BSE: "BSE_CM",
  BFO: "BSE_FO",
  MCX: "MCX_COM",
  CDS: "NSE_CD",
};
const FILE_EX: Record<string, string> = Object.fromEntries(
  Object.entries(FILE_OF).map(([k, v]) => [v, k]),
);

const PRODUCT_OUT: Record<ProductType, string> = {
  DELIVERY: "CNC",
  INTRADAY: "INTRADAY",
  CARRY_FORWARD: "MARGIN",
};
const PRODUCT_IN: Record<string, ProductType> = {
  CNC: "DELIVERY",
  INTRADAY: "INTRADAY",
  MARGIN: "CARRY_FORWARD",
  MTF: "DELIVERY",
  CO: "INTRADAY",
  BO: "INTRADAY",
};
const TYPE_OUT: Record<OrderType, number> = {
  LIMIT: 1,
  MARKET: 2,
  SL_M: 3,
  SL: 4,
};
const TYPE_IN: Record<number, OrderType> = {
  1: "LIMIT",
  2: "MARKET",
  3: "SL_M",
  4: "SL",
};

function status(s: unknown): OrderStatus {
  switch (Number(s)) {
    case 2:
      return "FILLED";
    case 5:
      return "REJECTED";
    case 1:
    case 7:
      return "CANCELLED";
    case 4:
    case 6:
      return "OPEN";
    default:
      return "UNKNOWN";
  }
}

/** "05-Jul-2026 11:08:22" (IST) → Date. */
function fyTime(s: unknown): Date {
  const d = s
    ? new Date(`${String(s).replace(/-/g, " ")} GMT+0530`)
    : new Date();
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/** Fyers symbol masters (public CSV per segment, no header). Key = Fyers ticker, e.g. "NSE:NIFTY26O2025000CE". */
export const fyersInstruments = new BrokerInstrumentStore(
  "Fyers",
  (ex) => FILE_OF[ex],
  async (file) => {
    const res = await undiciFetch(
      `https://public.fyers.in/sym_details/${file}.csv`,
      { signal: AbortSignal.timeout(120_000) },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const exchange = FILE_EX[file]!;
    const out: BrokerInstrument[] = [];
    for (const r of csvRows(await res.text())) {
      // 0 fyToken · 3 lot · 8 expiry (epoch s) · 9 ticker · 13 underlying · 15 strike · 16 option type
      const ticker = (r[9] ?? "").trim().toUpperCase();
      if (!ticker.includes(":")) continue; // header / junk
      const name = ticker.split(":")[1]!;
      let symbol: string | null = null;
      const opt = (r[16] ?? "").trim().toUpperCase();
      if (exchange === "NSE" || exchange === "BSE") {
        if (name.endsWith("-INDEX")) continue;
        const m = /^(.+)-([A-Z0-9]{1,3})$/.exec(name);
        if (!m) continue;
        if (exchange === "NSE" && m[2] !== "EQ" && m[2] !== "BE") continue;
        symbol = m[1]!;
      } else {
        const type =
          opt === "CE" || opt === "PE"
            ? opt
            : name.endsWith("FUT")
              ? "FUT"
              : null;
        const exp = Number(r[8]);
        if (!type || !exp) continue;
        symbol = canonicalFromParts(
          (r[13] ?? "").trim(),
          istDateOfEpoch(exp),
          type === "FUT" ? null : Number(r[15]),
          type,
        );
      }
      if (!symbol) continue;
      out.push({
        exchange,
        symbol,
        key: ticker,
        lotSize: Number(r[3]) || 1,
        tradingSymbol: ticker,
      });
    }
    return out;
  },
);

/** Fyers ticker → platform exchange + canonical symbol (master first, then by naming rules). */
async function decodeTicker(
  ticker: string,
): Promise<{ exchange: Exchange; symbol: string }> {
  const t = ticker.toUpperCase();
  const hit = fyersInstruments.fromAnyKey(t);
  if (hit) return { exchange: toExchange(hit.exchange), symbol: hit.symbol };
  const [pre, name = ""] = t.split(":");
  const deriv = /(CE|PE|FUT)$/.test(name);
  const ex =
    pre === "BSE"
      ? deriv
        ? "BFO"
        : "BSE"
      : pre === "MCX"
        ? "MCX"
        : deriv
          ? "NFO"
          : "NSE";
  await fyersInstruments.ensure(ex).catch(() => undefined);
  const again = fyersInstruments.fromAnyKey(t);
  if (again)
    return { exchange: toExchange(again.exchange), symbol: again.symbol };
  return {
    exchange: toExchange(ex),
    symbol: deriv
      ? normalizeBrokerSymbol(name)
      : canonicalSymbol(name.replace(/-[A-Z0-9]{1,3}$/, "")),
  };
}

interface Env {
  s?: string;
  code?: number;
  message?: string;
}

/** Fyers API v3 adapter. Auth header is "APP_ID:ACCESS_TOKEN"; contracts are Fyers tickers from the symbol master. */
export class FyersAdapter implements BrokerAdapter {
  readonly broker = "FYERS";

  constructor(
    private readonly appId: string,
    private readonly accessToken: string,
    private readonly proxyUrl?: string,
    private readonly opts?: AdapterOptions,
  ) {}

  private async call<T>(
    url: string,
    method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
    payload?: object,
  ): Promise<T & Env> {
    const { status: http, body } = await brokerFetch<T & Env>(url, {
      method,
      headers: {
        Authorization: `${this.appId}:${this.accessToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        version: "3",
      },
      body: payload ? JSON.stringify(payload) : undefined,
      proxyUrl: this.proxyUrl,
    });
    if (http < 200 || http >= 300 || body?.s !== "ok") {
      throw new BrokerApiError(
        body?.message || `Fyers request failed (HTTP ${http}).`,
        http,
        body?.code != null ? String(body.code) : undefined,
      );
    }
    return body;
  }

  private async ticker(exchange: string, symbol: string): Promise<string> {
    await fyersInstruments.ensure(exchange);
    const hit = fyersInstruments.get(exchange, canonicalSymbol(symbol));
    if (!hit)
      throw new BrokerApiError(
        `Fyers: instrument ${exchange}:${symbol} not found in the Fyers symbol master.`,
      );
    return hit.key;
  }

  async placeOrder(o: PlaceOrderInput): Promise<{ brokerOrderId: string }> {
    assertCanTrade(this.opts);
    const d = await this.call<{ id?: string }>(
      `${FYERS_API_ROOT}/orders/sync`,
      "POST",
      {
        symbol: await this.ticker(o.exchange, o.symbol),
        qty: o.quantity,
        type: TYPE_OUT[o.orderType],
        side: o.side === "BUY" ? 1 : -1,
        productType: PRODUCT_OUT[o.productType],
        limitPrice:
          o.price != null && (o.orderType === "LIMIT" || o.orderType === "SL")
            ? o.price
            : 0,
        stopPrice:
          o.triggerPrice != null &&
          (o.orderType === "SL" || o.orderType === "SL_M")
            ? o.triggerPrice
            : 0,
        validity: "DAY",
        disclosedQty: 0,
        offlineOrder: false,
        stopLoss: 0,
        takeProfit: 0,
        ...(o.tag
          ? {
              orderTag:
                o.tag.replace(/[^A-Za-z0-9]/g, "").slice(0, 30) || undefined,
            }
          : {}),
      },
    );
    if (!d.id) throw new BrokerApiError("Fyers did not return an order id.");
    return { brokerOrderId: String(d.id) };
  }

  async modifyOrder(o: ModifyOrderInput): Promise<void> {
    assertCanTrade(this.opts);
    await this.call(`${FYERS_API_ROOT}/orders/sync`, "PATCH", {
      id: o.brokerOrderId,
      type: TYPE_OUT[o.orderType],
      qty: o.quantity,
      limitPrice:
        o.price != null && (o.orderType === "LIMIT" || o.orderType === "SL")
          ? o.price
          : 0,
      stopPrice:
        o.triggerPrice != null &&
        (o.orderType === "SL" || o.orderType === "SL_M")
          ? o.triggerPrice
          : 0,
    });
  }

  async cancelOrder(brokerOrderId: string): Promise<void> {
    await this.call(`${FYERS_API_ROOT}/orders/sync`, "DELETE", {
      id: brokerOrderId,
    });
  }

  async orders(): Promise<BrokerOrder[]> {
    const d = await this.call<{ orderBook?: Record<string, unknown>[] }>(
      `${FYERS_API_ROOT}/orders`,
    );
    const out: BrokerOrder[] = [];
    for (const r of d.orderBook ?? []) {
      const { exchange, symbol } = await decodeTicker(String(r.symbol ?? ""));
      out.push({
        brokerOrderId: String(r.id),
        exchange,
        symbol,
        instrumentToken: r.fyToken ? String(r.fyToken) : undefined,
        side: Number(r.side) === -1 ? "SELL" : "BUY",
        orderType: TYPE_IN[Number(r.type)] ?? "MARKET",
        productType: PRODUCT_IN[String(r.productType)] ?? "INTRADAY",
        quantity: Number(r.qty) || 0,
        filledQuantity: Number(r.filledQty) || 0,
        price: num(r.limitPrice),
        averagePrice: num(r.tradedPrice),
        triggerPrice: num(r.stopPrice),
        status: status(r.status),
        statusMessage: r.message ? String(r.message) : undefined,
        tag: r.orderTag ? String(r.orderTag) : undefined,
        timestamp: fyTime(r.orderDateTime),
        raw: r,
      });
    }
    return out;
  }

  async positions(): Promise<BrokerPosition[]> {
    const d = await this.call<{ netPositions?: Record<string, unknown>[] }>(
      `${FYERS_API_ROOT}/positions`,
    );
    const out: BrokerPosition[] = [];
    for (const p of d.netPositions ?? []) {
      const { exchange, symbol } = await decodeTicker(String(p.symbol ?? ""));
      out.push({
        exchange,
        symbol,
        productType: PRODUCT_IN[String(p.productType)] ?? "INTRADAY",
        quantity: Number(p.netQty) || 0,
        averagePrice: num(p.netAvg ?? p.avgPrice) ?? 0,
        lastPrice: num(p.ltp),
        pnl: num(p.pl),
      });
    }
    return out;
  }

  async holdings(): Promise<BrokerHolding[]> {
    const d = await this.call<{ holdings?: Record<string, unknown>[] }>(
      `${FYERS_API_ROOT}/holdings`,
    );
    const out: BrokerHolding[] = [];
    for (const h of d.holdings ?? []) {
      const { exchange, symbol } = await decodeTicker(String(h.symbol ?? ""));
      out.push({
        exchange,
        symbol,
        quantity: Number(h.quantity) || 0,
        averagePrice: num(h.costPrice) ?? 0,
        lastPrice: num(h.ltp),
        pnl: num(h.pl),
      });
    }
    return out;
  }

  async funds(): Promise<BrokerFunds> {
    const d = await this.call<{
      fund_limit?: { title?: string; equityAmount?: number }[];
    }>(`${FYERS_API_ROOT}/funds`);
    const row = (t: string) =>
      d.fund_limit?.find((x) => (x.title ?? "").toLowerCase() === t)
        ?.equityAmount;
    return {
      availableCash: num(row("available balance")),
      net: num(row("total balance")),
    };
  }

  async ltp(exchange: Exchange, symbol: string): Promise<number | null> {
    try {
      const t = await this.ticker(exchange, symbol);
      const d = await this.call<{ d?: { n?: string; v?: { lp?: number } }[] }>(
        `${DATA_ROOT}/quotes?symbols=${encodeURIComponent(t)}`,
      );
      return num(d.d?.[0]?.v?.lp);
    } catch {
      return null;
    }
  }
}

/** Fyers OAuth (client's own app): login URL, auth-code exchange, refresh with PIN, profile. */
export class FyersClient {
  constructor(
    private readonly cfg: {
      appId: string;
      secret?: string;
      redirectUrl: string;
      proxyUrl?: string;
    },
  ) {}

  private get appIdHash(): string {
    return createHash("sha256")
      .update(`${this.cfg.appId}:${this.cfg.secret ?? ""}`)
      .digest("hex");
  }

  loginUrl(state: string): string {
    const u = new URL(`${FYERS_API_ROOT}/generate-authcode`);
    u.searchParams.set("client_id", this.cfg.appId);
    u.searchParams.set("redirect_uri", this.cfg.redirectUrl);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("state", state);
    return u.toString();
  }

  private async token(
    path: string,
    payload: object,
  ): Promise<{ accessToken: string; refreshToken: string | null }> {
    const { status: http, body } = await brokerFetch<
      Env & { access_token?: string; refresh_token?: string }
    >(`${FYERS_API_ROOT}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      proxyUrl: this.cfg.proxyUrl,
    });
    if (http !== 200 || body?.s !== "ok" || !body.access_token) {
      throw new BrokerApiError(
        body?.message || `Fyers login failed (HTTP ${http}).`,
        http,
        body?.code != null ? String(body.code) : undefined,
      );
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
    };
  }

  exchangeCode(code: string) {
    return this.token("/validate-authcode", {
      grant_type: "authorization_code",
      appIdHash: this.appIdHash,
      code,
    });
  }

  /** New access token from the refresh token (valid ~15 days) + the client's Fyers PIN — no browser login. */
  refresh(refreshToken: string, pin: string) {
    return this.token("/validate-refresh-token", {
      grant_type: "refresh_token",
      appIdHash: this.appIdHash,
      refresh_token: refreshToken,
      pin,
    });
  }

  async profile(accessToken: string): Promise<{ userId: string }> {
    const { status: http, body } = await brokerFetch<
      Env & { data?: { fy_id?: string } }
    >(`${FYERS_API_ROOT}/profile`, {
      headers: {
        Authorization: `${this.cfg.appId}:${accessToken}`,
        Accept: "application/json",
      },
      proxyUrl: this.cfg.proxyUrl,
    });
    if (http !== 200 || body?.s !== "ok" || !body.data?.fy_id)
      throw new BrokerApiError(
        body?.message || `Fyers token is not valid (HTTP ${http}).`,
        http,
      );
    return { userId: body.data.fy_id };
  }
}
