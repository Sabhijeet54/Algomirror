import { BrokerApiError, isRetryable } from '../../src/brokers/broker-http';
import { Throttle } from '../../src/brokers/throttle';
import { KiteTicker } from '../../src/market-data/kite-ticker';
import { assertCanTrade, OrderBlockedError, segmentOf } from '../../src/trading/broker-adapter';
import { computeCopyQuantity } from '../../src/trading/copy-quantity';
import { withMarketProtection, ZerodhaAdapter } from '../../src/trading/zerodha.adapter';

const strat = { masterCapital: 1_000_000, maxOrderValue: null, maxQuantityPerOrder: null };
const base = { allocationMode: 'CAPITAL_PERCENTAGE' as const, allocationPercent: null, allocationAmount: null, fixedQuantity: null, maxQuantity: null, maxTradeValue: null };

describe('copy quantity (lots / multiplier)', () => {
  it('fixed lots × lot size', () => expect(computeCopyQuantity(strat, { ...base, allocationMode: 'FIXED_QUANTITY', fixedLots: 2 }, 1, 100, 75).qty).toBe(150));
  it('multiplier 2× (200%)', () => expect(computeCopyQuantity(strat, { ...base, allocationPercent: 200 }, 75, 100, 75).qty).toBe(150));
  it('max lots cap', () => expect(computeCopyQuantity(strat, { ...base, allocationPercent: 1000, maxLots: 3 }, 75, 100, 75).qty).toBe(225));
});

describe('data-only guard', () => {
  it('assertCanTrade throws for DATA_ONLY', () => expect(() => assertCanTrade({ dataOnly: true })).toThrow(OrderBlockedError));
  it('Zerodha adapter refuses orders on a DATA_ONLY account without any HTTP call', async () => {
    const a = new ZerodhaAdapter('k', 't', undefined, { dataOnly: true });
    await expect(a.placeOrder({ exchange: 'NSE', symbol: 'INFY', side: 'BUY', quantity: 1, orderType: 'MARKET', productType: 'INTRADAY' })).rejects.toThrow(OrderBlockedError);
  });
});

describe('Zerodha market protection', () => {
  it('sets automatic market protection (-1) on MARKET and SL-M orders', () => {
    expect(withMarketProtection({}, 'MARKET').market_protection).toBe('-1');
    expect(withMarketProtection({}, 'SL_M').market_protection).toBe('-1');
  });
  it('leaves LIMIT and SL orders unchanged', () => {
    expect(withMarketProtection({}, 'LIMIT').market_protection).toBeUndefined();
    expect(withMarketProtection({}, 'SL').market_protection).toBeUndefined();
  });
});

describe('retry policy', () => {
  it('retries 429 / 503 and connection refused', () => {
    expect(isRetryable(new BrokerApiError('x', 429))).toBe(true);
    expect(isRetryable(new BrokerApiError('Could not reach broker (ECONNREFUSED).'))).toBe(true);
  });
  it('never retries rejections or timeouts', () => {
    expect(isRetryable(new BrokerApiError('Insufficient funds', 400))).toBe(false);
    expect(isRetryable(new BrokerApiError('Broker did not respond in time (timeout).'))).toBe(false);
  });
});

describe('throttle', () => {
  it('allows a burst then spaces the rest', async () => {
    const t = new Throttle(5);
    const start = Date.now();
    await Promise.all(Array.from({ length: 10 }, () => t.take()));
    expect(Date.now() - start).toBeGreaterThanOrEqual(800);
  });
});

describe('KiteTicker packet parsing', () => {
  it('decodes ltp packets (paise → ₹)', () => {
    const k = new KiteTicker('k', 't');
    const ticks: [number, number][] = [];
    k.on('tick', (tok: number, ltp: number) => ticks.push([tok, ltp]));
    const buf = new ArrayBuffer(2 + 2 + 8);
    const v = new DataView(buf);
    v.setInt16(0, 1);
    v.setInt16(2, 8);
    v.setInt32(4, 408065); // NSE token (segment 1)
    v.setInt32(8, 150025); // 1500.25
    (k as unknown as { parse: (b: ArrayBuffer) => void }).parse(buf);
    expect(ticks).toEqual([[408065, 1500.25]]);
  });
});

describe('segments', () => {
  it('maps exchanges', () => {
    expect(segmentOf('NSE')).toBe('EQ');
    expect(segmentOf('NFO')).toBe('FO');
  });
});
