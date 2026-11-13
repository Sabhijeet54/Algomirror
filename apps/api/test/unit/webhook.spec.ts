/** TradingView / alert webhook: parsing, contract selection and the service flow (all external parts mocked). */
import { BadRequestException, HttpException, NotFoundException } from '@nestjs/common';
import { AlertError, exitLevels, parseAlert, pickExpiry, pickStrike, readAlertBody, symbolOfUnderlying } from '../../src/trading/webhook-alert';
import { WebhookService } from '../../src/trading/webhook.service';

const EXPIRIES = [
  { date: '2026-11-17', lotSize: 65, monthly: false, strikes: [25100, 25150, 25200, 25250, 25300, 25350] },
  { date: '2026-11-24', lotSize: 65, monthly: true, strikes: [25000, 25100, 25200, 25300] },
];

describe('parseAlert', () => {
  it('reads a TradingView strategy alert with placeholders filled in', () => {
    const a = parseAlert(readAlertBody('{"action":"buy","underlying":"nifty","option":"CE","strike":"ATM+1","lots":"2","spot":"25212.4"}'));
    expect(a).toMatchObject({ action: 'BUY', exchange: 'NFO', underlying: 'NIFTY', option: 'CE', strike: { atmOffset: 1 }, lots: 2, spot: 25212.4, product: 'INTRADAY', orderType: 'MARKET', expiry: 'nearest' });
  });

  it('defaults the exchange: SENSEX → BFO, MCX names → MCX, plain stock → NSE', () => {
    expect(parseAlert({ action: 'SELL', underlying: 'SENSEX', option: 'PE', strike: 'ATM' }).exchange).toBe('BFO');
    expect(parseAlert({ action: 'BUY', underlying: 'CRUDEOIL', option: 'FUT' }).exchange).toBe('MCX');
    expect(parseAlert({ action: 'BUY', symbol: 'RELIANCE', qty: 10 }).exchange).toBe('NSE');
    expect(parseAlert({ action: 'BUY', symbol: 'NIFTY17NOV2625250CE' }).exchange).toBe('NFO');
  });

  it('maps product aliases and rejects junk', () => {
    expect(parseAlert({ action: 'BUY', symbol: 'SBIN', product: 'CNC', qty: 1 }).product).toBe('DELIVERY');
    expect(parseAlert({ action: 'EXIT_ALL' }).action).toBe('EXIT_ALL');
    expect(() => parseAlert({ action: 'HOLD', symbol: 'SBIN' })).toThrow(AlertError);
    expect(() => parseAlert({ action: 'BUY' })).toThrow(/symbol/);
    expect(() => parseAlert({ action: 'BUY', underlying: 'NIFTY', strike: 'ITM' })).toThrow(/strike/);
    expect(() => parseAlert({ action: 'BUY', symbol: 'SBIN', orderType: 'LIMIT' })).toThrow(/price/);
    expect(() => readAlertBody('BUY NIFTY now')).toThrow(/JSON/);
  });
});

describe('signal → option (AUTO) and ITM / OTM', () => {
  it('BUY → buy a call, SELL → buy a put, flat → exit', () => {
    expect(parseAlert({ action: 'long', underlying: 'NIFTY', option: 'AUTO', strike: 'ATM' })).toMatchObject({ action: 'BUY', option: 'CE', flipExit: 'PE', exchange: 'NFO' });
    expect(parseAlert({ action: 'sell', underlying: 'BANKNIFTY', option: 'auto', strike: 'ITM2' })).toMatchObject({ action: 'BUY', option: 'PE', flipExit: 'CE', strike: { atmOffset: 2 } });
    const flat = parseAlert({ action: 'flat', underlying: 'NIFTY', option: 'AUTO' });
    expect(flat.action).toBe('EXIT');
    expect(flat.option).toBeUndefined();
    expect(() => parseAlert({ action: 'BUY', option: 'AUTO', symbol: 'SBIN' })).toThrow(/underlying/);
  });

  it('ITM is below ATM for calls and above for puts', () => {
    expect(parseAlert({ action: 'BUY', underlying: 'NIFTY', option: 'CE', strike: 'ITM1' }).strike).toEqual({ atmOffset: -1 });
    expect(parseAlert({ action: 'BUY', underlying: 'NIFTY', option: 'CE', strike: 'OTM2' }).strike).toEqual({ atmOffset: 2 });
    expect(parseAlert({ action: 'BUY', underlying: 'NIFTY', option: 'PE', strike: 'ITM' }).strike).toEqual({ atmOffset: 1 });
    expect(parseAlert({ action: 'BUY', underlying: 'NIFTY', option: 'PE', strike: 'OTM3' }).strike).toEqual({ atmOffset: -3 });
    expect(() => parseAlert({ action: 'BUY', underlying: 'NIFTY', option: 'FUT', strike: 'ITM1' })).toThrow(/ITM/);
  });
});

describe('contract selection', () => {
  it('picks nearest / next / monthly / exact expiry', () => {
    expect(pickExpiry(EXPIRIES, 'nearest').date).toBe('2026-11-17');
    expect(pickExpiry(EXPIRIES, 'next').date).toBe('2026-11-24');
    expect(pickExpiry(EXPIRIES, 'monthly').date).toBe('2026-11-24');
    expect(() => pickExpiry(EXPIRIES, '2026-12-01')).toThrow(/not available/);
  });

  it('picks ATM ± n around the spot, or an exact listed strike', () => {
    const s = EXPIRIES[0]!.strikes;
    expect(pickStrike(s, { atmOffset: 0 }, 25212)).toBe(25200);
    expect(pickStrike(s, { atmOffset: 1 }, 25212)).toBe(25250);
    expect(pickStrike(s, { atmOffset: -2 }, 25212)).toBe(25100);
    expect(pickStrike(s, 25300)).toBe(25300);
    expect(() => pickStrike(s, 25275)).toThrow(/not listed/);
    expect(() => pickStrike(s, { atmOffset: 0 })).toThrow(/spot/);
    expect(() => pickStrike(s, { atmOffset: 9 }, 25212)).toThrow(/outside/);
  });

  it('sets target / stop loss from points in the trade direction', () => {
    expect(exitLevels({ targetPoints: 20, stoplossPoints: 10 }, 'BUY', 100)).toEqual({ targetPrice: 120, stopLossPrice: 90 });
    expect(exitLevels({ targetPoints: 20, stoplossPoints: 10 }, 'SELL', 100)).toEqual({ targetPrice: 80, stopLossPrice: 110 });
    expect(exitLevels({ target: 150, stoploss: 95 }, 'BUY', null)).toEqual({ targetPrice: 150, stopLossPrice: 95 });
    expect(() => exitLevels({ targetPoints: 20 }, 'BUY', null)).toThrow(/Live price/);
  });

  it('matches an underlying without catching look-alike names', () => {
    expect(symbolOfUnderlying('NIFTY17NOV2625250CE', 'NIFTY')).toBe(true);
    expect(symbolOfUnderlying('NIFTYNXT5017NOV2670000CE', 'NIFTY')).toBe(false);
    expect(symbolOfUnderlying('BANKNIFTY17NOV2655000CE', 'NIFTY')).toBe(false);
    expect(symbolOfUnderlying('NIFTY17NOV2625250PE', 'NIFTY', 'CE')).toBe(false);
  });
});

describe('WebhookService', () => {
  const STRATEGY = { id: 'st1', masterUserId: 'm1', webhookToken: 'tok_abcdefghijklmnop', status: 'ACTIVE' };
  const make = () => {
    const store = new Map<string, string>();
    const counters = new Map<string, number>();
    const redis = {
      incr: jest.fn(async (k: string) => {
        const n = (counters.get(k) ?? 0) + 1;
        counters.set(k, n);
        return n;
      }),
      expire: jest.fn(async () => 1),
      set: jest.fn(async (k: string) => (store.has(k) ? null : (store.set(k, '1'), 'OK'))),
      lrange: jest.fn(async () => []),
      multi: jest.fn(() => {
        const m = { lpush: () => m, ltrim: () => m, expire: () => m, exec: async () => [] };
        return m;
      }),
    };
    const prisma = { strategy: { findUnique: jest.fn(async ({ where }: { where: { webhookToken: string } }) => (where.webhookToken === STRATEGY.webhookToken ? STRATEGY : null)) } };
    const orders = { place: jest.fn(async () => ({ tradeId: 't1', totalMs: 5 })) };
    const signals = {
      squareOffStrategy: jest.fn(async () => ({ closed: 2, failed: 0, errors: [] })),
      exitStrategyMatching: jest.fn(async (_s: string, _a: string, match: (p: { exchange: string; symbol: string }) => boolean) => ({
        closed: ['NIFTY17NOV2625200CE', 'BANKNIFTY17NOV2655000CE'].filter((symbol) => match({ exchange: 'NFO', symbol })).length,
        failed: 0,
        errors: [],
      })),
    };
    const fno = { chain: jest.fn(async () => ({ name: 'NIFTY', lotSize: 65, expiries: EXPIRIES })) };
    const feed = { ensure: jest.fn() };
    const prices = { get: jest.fn(() => 150) };
    const svc = new WebhookService(prisma as never, redis as never, orders as never, signals as never, fno as never, feed as never, prices as never, { API_PUBLIC_URL: 'https://x.in/api/' } as never);
    return { svc, orders, signals, redis, counters };
  };

  it('places an ATM option trade with lots × lot size, SL / target from points', async () => {
    const { svc, orders } = make();
    const r = await svc.handle(STRATEGY.webhookToken, { action: 'BUY', underlying: 'NIFTY', option: 'CE', strike: 'ATM', lots: 2, spot: 25212, targetPoints: 30, stoplossPoints: 15 });
    expect(r.ok).toBe(true);
    expect(orders.place).toHaveBeenCalledWith(
      'm1',
      STRATEGY,
      expect.objectContaining({ strategyId: 'st1', exchange: 'NFO', symbol: 'NIFTY17NOV2625200CE', side: 'BUY', quantity: 130, lotSize: 65, orderType: 'MARKET', productType: 'INTRADAY', targetPrice: 180, stopLossPrice: 135 }),
      {},
    );
  });

  it('AUTO: a SELL signal exits the open call and buys an in-the-money put', async () => {
    const { svc, orders, signals } = make();
    const r = await svc.handle(STRATEGY.webhookToken, { action: 'SELL', underlying: 'NIFTY', option: 'AUTO', strike: 'ITM1', lots: 1, spot: 25212 });
    expect(signals.exitStrategyMatching).toHaveBeenCalledTimes(1);
    const match = signals.exitStrategyMatching.mock.calls[0]![2];
    expect(match({ exchange: 'NFO', symbol: 'NIFTY17NOV2625200CE' })).toBe(true);
    expect(match({ exchange: 'NFO', symbol: 'NIFTY17NOV2625200PE' })).toBe(false);
    expect(orders.place).toHaveBeenCalledWith('m1', STRATEGY, expect.objectContaining({ symbol: 'NIFTY17NOV2625250PE', side: 'BUY', quantity: 65 }), {});
    expect(r.message).toMatch(/closed 1 CE first/);
  });

  it('exits only this underlying, and EXIT_ALL squares off the strategy', async () => {
    const { svc, signals } = make();
    const r = await svc.handle(STRATEGY.webhookToken, { action: 'EXIT', underlying: 'NIFTY' });
    expect(r.message).toMatch(/1 closed/);
    await svc.handle(STRATEGY.webhookToken, '{"action":"EXIT_ALL"}');
    expect(signals.squareOffStrategy).toHaveBeenCalledWith('st1', 'm1');
  });

  it('ignores the same alert twice within seconds', async () => {
    const { svc, orders } = make();
    const body = { action: 'BUY', symbol: 'SBIN', qty: 10 };
    await svc.handle(STRATEGY.webhookToken, body);
    const r = await svc.handle(STRATEGY.webhookToken, body);
    expect(r.message).toMatch(/Duplicate/);
    expect(orders.place).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown token, a bad alert, and too many alerts a minute', async () => {
    const { svc } = make();
    await expect(svc.handle('nope_nope_nope_nope', { action: 'BUY', symbol: 'SBIN' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.handle(STRATEGY.webhookToken, { action: 'HOLD' })).rejects.toBeInstanceOf(BadRequestException);
    const { svc: busy, counters } = make();
    counters.set(`ctp:webhook:rate:st1:${Math.floor(Date.now() / 60_000)}`, 30);
    await expect(busy.handle(STRATEGY.webhookToken, { action: 'BUY', symbol: 'SBIN', qty: 1 })).rejects.toBeInstanceOf(HttpException);
  });

  it('turns an order rejection into a clear 400', async () => {
    const { svc, orders } = make();
    orders.place.mockRejectedValueOnce(new BadRequestException('Start (activate) the strategy before trading it.'));
    await expect(svc.handle(STRATEGY.webhookToken, { action: 'BUY', symbol: 'SBIN', qty: 1 })).rejects.toThrow(/activate/);
  });

  it('builds the public URL', () => {
    expect(make().svc.url('abc')).toBe('https://x.in/api/hooks/tv/abc');
  });
});
