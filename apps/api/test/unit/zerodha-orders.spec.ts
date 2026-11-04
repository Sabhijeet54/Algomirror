import { brokerFetch } from '../../src/brokers/broker-http';
import { protectedLimitPrice, withMarketProtection, ZerodhaAdapter } from '../../src/trading/zerodha.adapter';

jest.mock('../../src/brokers/broker-http', () => {
  const actual = jest.requireActual('../../src/brokers/broker-http');
  return { ...actual, brokerFetch: jest.fn() };
});

const fetchMock = brokerFetch as jest.MockedFunction<typeof brokerFetch>;
const MP_ERROR = 'Market orders without market protection are not allowed via API. Please set market protection or use a Limit order.';
const ok = (data: unknown) => ({ status: 200, body: { status: 'success', data } });
const fail = (message: string) => ({ status: 400, body: { status: 'error', message, error_type: 'InputException' } });
const formOf = (i: number) => Object.fromEntries(new URLSearchParams(String(fetchMock.mock.calls[i]![1]!.body)));

const order = { exchange: 'BFO' as const, symbol: 'SENSEX05NOV2676900PE', side: 'SELL' as const, quantity: 40, productType: 'INTRADAY' as const };

describe('Zerodha order types', () => {
  beforeEach(() => fetchMock.mockReset());

  it('market protection only on MARKET / SL-M', () => {
    expect(withMarketProtection({}, 'MARKET').market_protection).toBe('-1');
    expect(withMarketProtection({}, 'SL_M').market_protection).toBe('-1');
    expect(withMarketProtection({}, 'LIMIT').market_protection).toBeUndefined();
  });

  it('marketable limit price: BUY above, SELL below LTP, on the 0.05 tick', () => {
    expect(protectedLimitPrice(100, 'BUY')).toBe(103);
    expect(protectedLimitPrice(100, 'SELL')).toBe(97);
    expect(protectedLimitPrice(1.2, 'SELL')).toBe(1.1);
    expect(protectedLimitPrice(0.05, 'SELL')).toBe(0.05);
  });

  it('MARKET order is sent with market_protection=-1', async () => {
    fetchMock.mockResolvedValueOnce(ok({ order_id: 'A1' }) as never);
    const r = await new ZerodhaAdapter('k', 't').placeOrder({ ...order, orderType: 'MARKET' });
    expect(r.brokerOrderId).toBe('A1');
    expect(formOf(0)).toMatchObject({ order_type: 'MARKET', market_protection: '-1' });
    expect(formOf(0).price).toBeUndefined();
  });

  it('LIMIT order keeps its price and has no market protection', async () => {
    fetchMock.mockResolvedValueOnce(ok({ order_id: 'L1' }) as never);
    await new ZerodhaAdapter('k', 't').placeOrder({ ...order, orderType: 'LIMIT', price: 125.5 });
    expect(formOf(0)).toMatchObject({ order_type: 'LIMIT', price: '125.5' });
    expect(formOf(0).market_protection).toBeUndefined();
  });

  it('LIMIT with price 0 is sent as a protected MARKET order, never with price 0', async () => {
    fetchMock.mockResolvedValueOnce(ok({ order_id: 'Z1' }) as never);
    await new ZerodhaAdapter('k', 't').placeOrder({ ...order, orderType: 'LIMIT', price: 0 });
    expect(formOf(0)).toMatchObject({ order_type: 'MARKET', market_protection: '-1' });
    expect(formOf(0).price).toBeUndefined();
  });

  it('if Kite still refuses the MARKET order, falls back to a LIMIT order around the LTP', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(MP_ERROR) as never)
      .mockResolvedValueOnce(ok({ 'BFO:SENSEX05NOV2676900PE': { last_price: 200 } }) as never)
      .mockResolvedValueOnce(ok({ order_id: 'F1' }) as never);
    const r = await new ZerodhaAdapter('k', 't').placeOrder({ ...order, orderType: 'MARKET' });
    expect(r.brokerOrderId).toBe('F1');
    expect(String(fetchMock.mock.calls[1]![0])).toContain('/quote/ltp?i=BFO%3ASENSEX05NOV2676900PE');
    expect(formOf(2)).toMatchObject({ order_type: 'LIMIT', price: '194', transaction_type: 'SELL', quantity: '40' });
    expect(formOf(2).market_protection).toBeUndefined();
  });

  it('other rejections are not retried', async () => {
    fetchMock.mockResolvedValueOnce(fail('Insufficient funds') as never);
    await expect(new ZerodhaAdapter('k', 't').placeOrder({ ...order, orderType: 'MARKET' })).rejects.toThrow('Insufficient funds');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('Zerodha fallback without quote access', () => {
  beforeEach(() => fetchMock.mockReset());
  it('uses the reference price sent with the order when Kite LTP is unavailable', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(MP_ERROR) as never)
      .mockResolvedValueOnce(fail('Insufficient permission for that call.') as never)
      .mockResolvedValueOnce(ok({ order_id: 'F2' }) as never);
    await new ZerodhaAdapter('k', 't').placeOrder({ ...order, side: 'BUY', orderType: 'MARKET', price: 100 });
    expect(formOf(2)).toMatchObject({ order_type: 'LIMIT', price: '103', transaction_type: 'BUY' });
  });
});
