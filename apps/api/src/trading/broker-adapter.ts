import type { Exchange, OrderSide, OrderStatus, OrderType, ProductType } from '@ctp/database';

/** Broker-neutral order request. `symbol` is the platform's canonical trading symbol (e.g. "INFY", "NIFTY24OCT25000CE"). */
export interface PlaceOrderInput {
  exchange: Exchange;
  symbol: string;
  side: OrderSide;
  quantity: number;
  orderType: OrderType;
  productType: ProductType;
  price?: number | null;
  triggerPrice?: number | null;
  tag?: string;
}

export interface BrokerOrder {
  brokerOrderId: string;
  exchange: Exchange;
  symbol: string;
  instrumentToken?: string;
  side: OrderSide;
  orderType: OrderType;
  productType: ProductType;
  quantity: number;
  filledQuantity: number;
  price: number | null;
  averagePrice: number | null;
  triggerPrice?: number | null;
  status: OrderStatus;
  statusMessage?: string;
  /** Order tag set when placing (e.g. "ctpcopy"). */
  tag?: string;
  lotSize?: number;
  timestamp: Date;
  raw: unknown;
}

export interface BrokerPosition {
  exchange: Exchange;
  symbol: string;
  productType: ProductType;
  quantity: number;
  averagePrice: number;
  lastPrice: number | null;
  pnl: number | null;
}

export interface BrokerHolding {
  exchange: Exchange;
  symbol: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number | null;
  pnl: number | null;
}

export interface BrokerFunds {
  availableCash: number | null;
  net: number | null;
}

export interface AdapterOptions {
  /** DATA_ONLY (master feed) accounts: placeOrder is hard-blocked. */
  dataOnly?: boolean;
}

/** Thrown when an order is attempted on a DATA_ONLY (master) account. Never retried. */
export class OrderBlockedError extends Error {
  constructor(message = 'Order blocked: this is a DATA_ONLY master account (live market data only).') {
    super(message);
    this.name = 'OrderBlockedError';
  }
}

export function assertCanTrade(opts: AdapterOptions | undefined): void {
  if (opts?.dataOnly) throw new OrderBlockedError();
}

/** Fields of an open order that can be modified. */
export interface ModifyOrderInput extends PlaceOrderInput {
  brokerOrderId: string;
}

export interface BrokerAdapter {
  readonly broker: string;
  placeOrder(input: PlaceOrderInput): Promise<{ brokerOrderId: string }>;
  modifyOrder(input: ModifyOrderInput): Promise<void>;
  cancelOrder(brokerOrderId: string, orderType: OrderType): Promise<void>;
  orders(): Promise<BrokerOrder[]>;
  positions(): Promise<BrokerPosition[]>;
  holdings(): Promise<BrokerHolding[]>;
  funds(): Promise<BrokerFunds>;
  /** Last traded price, when the broker API allows it (Kite Personal does not). */
  ltp(exchange: Exchange, symbol: string): Promise<number | null>;
}

export const EXCHANGES: Exchange[] = ['NSE', 'BSE', 'NFO', 'BFO', 'MCX', 'CDS', 'BCD'];

export function toExchange(v: string): Exchange {
  const e = v?.toUpperCase() as Exchange;
  if (!EXCHANGES.includes(e)) throw new Error(`Unsupported exchange "${v}"`);
  return e;
}

/** Canonical symbol: Angel equity symbols carry a "-EQ"/"-BE" series suffix that Zerodha does not. */
export function canonicalSymbol(symbol: string): string {
  return symbol.toUpperCase().replace(/-(EQ|BE|BZ|SM|ST)$/, '');
}

export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** F&O exchanges (segment "FO"); everything else counts as "EQ" for allowed-segment checks. */
export const FO_EXCHANGES: Exchange[] = ['NFO', 'BFO', 'MCX', 'CDS', 'BCD'];
export const segmentOf = (exchange: Exchange): 'EQ' | 'FO' => (FO_EXCHANGES.includes(exchange) ? 'FO' : 'EQ');
