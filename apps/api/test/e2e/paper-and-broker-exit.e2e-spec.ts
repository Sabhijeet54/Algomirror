/**
 * E2E (real PostgreSQL + Redis, fake broker adapters — no real broker is contacted):
 *  1. A client with NO demat connected can paper trade (follow, start, paper fills, P&L).
 *  2. A position the client squared off himself in his broker app (Kite / Angel …) still shows OPEN until the
 *     master exits; then the platform sends only what the broker still holds and closes the rest at the client's
 *     own exit price (full, partial, and the master's "Exit" button on the client page).
 */
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type Redis from 'ioredis';
import { loadDotenv } from '@ctp/config';
import type { BrokerAccount, Strategy, User } from '@ctp/database';
import { createPrismaClient, PrismaClient } from '@ctp/database';
import { hashPassword } from '@ctp/shared';
import { RedisKeys } from '@ctp/types';
import { AppModule } from '../../src/app.module';
import { REDIS } from '../../src/common/redis/redis.module';
import { configureApp } from '../../src/main';
import { PriceCacheService } from '../../src/market-data/price-cache.service';
import type { BrokerAdapter, BrokerOrder, BrokerPosition, PlaceOrderInput } from '../../src/trading/broker-adapter';
import { ClientRegistryService } from '../../src/trading/client-registry.service';
import { CopyEngineService } from '../../src/trading/copy-engine.service';
import { CopyReconcilerService } from '../../src/trading/copy-reconciler.service';
import { RiskService } from '../../src/trading/risk.service';
import { TradingService } from '../../src/trading/trading.service';

loadDotenv(__dirname);

const RUN = randomUUID().slice(0, 8);
const email = (n: string) => `e2e-${RUN}-${n}@example.com`.toLowerCase();
const PASSWORD = 'E2eTestPass123';
const H = { 'X-CTP-Client': 'web' };
const SYMBOL = `NIFTYPX${RUN.toUpperCase()}FUT`;

let app: NestExpressApplication;
let prisma: PrismaClient;
let redis: Redis;
let registry: ClientRegistryService;
let engine: CopyEngineService;
let reconciler: CopyReconcilerService;
let risk: RiskService;
let prices: PriceCacheService;

/** Fake broker per account. */
const placed: { accountId: string; input: PlaceOrderInput; id: string }[] = [];
const orderBook = new Map<string, BrokerOrder[]>();
const positionBook = new Map<string, BrokerPosition[]>();
let seq = 0;
const fake = (accountId: string): BrokerAdapter =>
  ({
    broker: 'ZERODHA',
    async placeOrder(input: PlaceOrderInput) {
      const id = `FK${++seq}`;
      placed.push({ accountId, input, id });
      return { brokerOrderId: id };
    },
    async modifyOrder() {},
    async cancelOrder() {},
    async orders() {
      return orderBook.get(accountId) ?? [];
    },
    async positions() {
      return positionBook.get(accountId) ?? [];
    },
    async holdings() {
      return [];
    },
    async funds() {
      return { availableCash: 0, net: 0 };
    },
  }) as unknown as BrokerAdapter;

const bo = (o: Partial<BrokerOrder> & Pick<BrokerOrder, 'brokerOrderId' | 'side' | 'quantity' | 'filledQuantity' | 'averagePrice' | 'status'>): BrokerOrder => ({
  exchange: 'NFO',
  symbol: SYMBOL,
  orderType: 'MARKET',
  productType: 'INTRADAY',
  price: null,
  timestamp: new Date(),
  raw: {},
  ...o,
});

async function login(e: string) {
  const keys = await redis.keys(`${RedisKeys.rateLimitPrefix}*`);
  if (keys.length) await redis.del(...keys);
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/auth/login').set(H).send({ email: e, password: PASSWORD });
  expect(res.status).toBe(200);
  return agent;
}

let masterAccount: BrokerAccount;
let strategy: Strategy;
const C: Record<string, { user: User; account: BrokerAccount | null; subId: string; agent: ReturnType<typeof request.agent> }> = {};

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  prisma = createPrismaClient();
  redis = app.get(REDIS);
  registry = app.get(ClientRegistryService);
  engine = app.get(CopyEngineService);
  reconciler = app.get(CopyReconcilerService);
  risk = app.get(RiskService);
  prices = app.get(PriceCacheService);
  jest.spyOn(ClientRegistryService.prototype as never, 'buildAdapter' as never).mockImplementation((async (a: BrokerAccount) => fake(a.id)) as never);
  jest.spyOn(TradingService.prototype, 'adapterFor').mockImplementation(async (a: BrokerAccount) => fake(a.id));

  const hash = await hashPassword(PASSWORD);
  const master = await prisma.user.create({ data: { email: email('master'), name: 'E2E Master', role: 'MASTER', passwordHash: hash, emailVerifiedAt: new Date() } });
  masterAccount = await prisma.brokerAccount.create({
    data: { userId: master.id, broker: 'ANGEL_ONE', brokerClientId: `PXM${RUN}`, status: 'CONNECTED', mode: 'DATA_ONLY', tokenExpiresAt: new Date(Date.now() + 86_400_000) },
  });
  strategy = await prisma.strategy.create({ data: { masterUserId: master.id, name: `E2E PX ${RUN}`, status: 'ACTIVE', allowedExchanges: ['NFO'] } });
  // P = paper, no demat · L = live, exits fully in broker app · Q = live, exits half · R = live, master uses "Exit"
  for (const k of ['P', 'L', 'Q', 'R']) {
    const user = await prisma.user.create({
      data: { email: email(k), name: `E2E ${k}`, role: 'FOLLOWER', passwordHash: hash, emailVerifiedAt: new Date(), licenceExpiresAt: new Date(Date.now() + 5 * 86_400_000) },
    });
    const account =
      k === 'P'
        ? null
        : await prisma.brokerAccount.create({
            data: { userId: user.id, broker: 'ZERODHA', brokerClientId: `PX${k}${RUN}`, status: 'CONNECTED', mode: 'TRADING', isPaper: false, tokenExpiresAt: new Date(Date.now() + 86_400_000) },
          });
    if (account) await prisma.brokerCredential.create({ data: { brokerAccountId: account.id, encryptedAccessToken: 'v1:k1:x:y:z' } });
    const sub = await prisma.strategyFollower.create({ data: { strategyId: strategy.id, followerUserId: user.id, allocationMode: 'CAPITAL_PERCENTAGE', allocationPercent: 100 } });
    C[k] = { user, account, subId: sub.id, agent: await login(user.email) };
  }
});

afterAll(async () => {
  const ids = (await prisma.user.findMany({ where: { email: { startsWith: `e2e-${RUN}-` } }, select: { id: true } })).map((u) => u.id);
  await prisma.copyOrder.deleteMany({ where: { followerUserId: { in: ids } } });
  await prisma.masterTrade.deleteMany({ where: { masterUserId: { in: ids } } });
  await prisma.strategy.deleteMany({ where: { masterUserId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  jest.restoreAllMocks();
  await prisma.$disconnect();
  await app.close();
});

const master = (side: 'BUY' | 'SELL', price: number, id: string) =>
  engine.onMasterTrade(strategy, masterAccount, {
    exchange: 'NFO',
    symbol: SYMBOL,
    side,
    quantity: 50,
    filledQuantity: 50,
    averagePrice: price,
    price,
    status: 'FILLED',
    orderType: 'MARKET',
    productType: 'INTRADAY',
    brokerOrderId: `SIG-${RUN}-${id}`,
    timestamp: new Date(),
    lotSize: 25,
  });

describe('paper trading without a demat', () => {
  it('client with no broker can follow, start and switch to Paper; Live needs a demat', async () => {
    const p = C.P!;
    expect((await p.agent.post(`/follow/strategies/${strategy.id}`).set(H).send({ allocationMode: 'CAPITAL_PERCENTAGE', allocationPercent: 100 })).status).toBe(201);
    const st = await p.agent.post(`/follow/subscriptions/${p.subId}/start`).set(H);
    expect(st.status).toBe(200);
    expect(st.body.copyStatus).toBe('ON');
    expect((await p.agent.post('/follow/trading-mode').set(H).send({ mode: 'PAPER' })).status).toBe(200);
    const live = await p.agent.post('/follow/trading-mode').set(H).send({ mode: 'LIVE' });
    expect(live.status).toBe(400);
    expect((await p.agent.get('/brokers/accounts')).body).toEqual([]); // paper account is not a broker connection
    expect((await p.agent.get('/follow/dashboard')).body).toMatchObject({ broker: null, tradingMode: 'PAPER' });
  });

  it('live clients start normally', async () => {
    for (const k of ['L', 'Q', 'R']) {
      const c = C[k]!;
      expect((await c.agent.post(`/follow/strategies/${strategy.id}`).set(H).send({ allocationMode: 'CAPITAL_PERCENTAGE', allocationPercent: 100, brokerAccountId: c.account!.id })).status).toBe(201);
      expect((await c.agent.post(`/follow/subscriptions/${c.subId}/start`).set(H)).status).toBe(200);
    }
  });

  it('a strategy trade is paper-filled for the client without demat and shows in the trade book', async () => {
    await registry.reload();
    prices.set(`NFO:${SYMBOL}`, 100);
    expect(await master('BUY', 100, 'B1')).not.toBeNull();
    const po = await prisma.copyOrder.findFirst({ where: { followerUserId: C.P!.user.id } });
    expect(po).toMatchObject({ status: 'FILLED', isPaper: true, quantity: 50 });
    expect(placed.some((x) => x.accountId === C.P!.account?.id)).toBe(false);
    const tb = (await C.P!.agent.get('/follow/trades')).body;
    expect(tb.rows).toHaveLength(1);
    expect(tb.rows[0]).toMatchObject({ status: 'OPEN', quantity: 50, entryPrice: 100 });
    // live clients got real (fake) broker orders; broker fills them
    for (const k of ['L', 'Q', 'R']) {
      const o = placed.find((x) => x.accountId === C[k]!.account!.id)!;
      orderBook.set(C[k]!.account!.id, [bo({ brokerOrderId: o.id, side: 'BUY', quantity: 50, filledQuantity: 50, averagePrice: 100, status: 'FILLED', tag: 'ctpcopy' })]);
      positionBook.set(C[k]!.account!.id, [{ exchange: 'NFO', symbol: SYMBOL, productType: 'INTRADAY', quantity: 50, averagePrice: 100, lastPrice: 100, pnl: 0 }]);
    }
    await reconciler.run();
  });
});

describe('position closed in the broker app', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('client sells in Kite: still OPEN here until the master exits (nothing polled)', async () => {
    const l = C.L!.account!.id;
    const q = C.Q!.account!.id;
    const r = C.R!.account!.id;
    // L sold everything at 105, Q sold 25 at 103, R sold everything at 104 — all outside the platform.
    positionBook.set(l, [{ exchange: 'NFO', symbol: SYMBOL, productType: 'INTRADAY', quantity: 0, averagePrice: 100, lastPrice: 106, pnl: 250 }]);
    orderBook.set(l, [...(orderBook.get(l) ?? []), bo({ brokerOrderId: 'KITE1', side: 'SELL', quantity: 50, filledQuantity: 50, averagePrice: 105, status: 'FILLED' })]);
    positionBook.set(q, [{ exchange: 'NFO', symbol: SYMBOL, productType: 'INTRADAY', quantity: 25, averagePrice: 100, lastPrice: 104, pnl: 75 }]);
    orderBook.set(q, [...(orderBook.get(q) ?? []), bo({ brokerOrderId: 'KITE2', side: 'SELL', quantity: 25, filledQuantity: 25, averagePrice: 103, status: 'FILLED' })]);
    positionBook.set(r, []);
    orderBook.set(r, [...(orderBook.get(r) ?? []), bo({ brokerOrderId: 'KITE3', side: 'SELL', quantity: 50, filledQuantity: 50, averagePrice: 104, status: 'FILLED' })]);
    expect((await C.L!.agent.get('/follow/trades')).body.rows[0]).toMatchObject({ status: 'OPEN' });
  });

  it('master "Exit" on a client position the broker no longer has → closed here, no order', async () => {
    const before = placed.length;
    const res = await risk.exitPosition(C.R!.account!, { exchange: 'NFO', symbol: SYMBOL, productType: 'INTRADAY' }, C.R!.user.id);
    expect(res).toEqual({ orderId: null, quantity: 50 });
    expect(placed.length).toBe(before);
    await sleep(500);
    expect((await C.R!.agent.get('/follow/trades')).body.rows[0]).toMatchObject({ status: 'CLOSED', exitPrice: 104, pnl: 200 });
  });

  it('master exit: no order for L, only the remaining 25 for Q; trades close at the client\'s own prices', async () => {
    const before = placed.length;
    prices.set(`NFO:${SYMBOL}`, 108);
    expect(await master('SELL', 108, 'S1')).not.toBeNull();
    const sells = placed.slice(before);
    expect(sells.map((s) => s.accountId)).toEqual([C.Q!.account!.id]);
    expect(sells[0]!.input.quantity).toBe(25);
    orderBook.set(C.Q!.account!.id, [...(orderBook.get(C.Q!.account!.id) ?? []), bo({ brokerOrderId: sells[0]!.id, side: 'SELL', quantity: 25, filledQuantity: 25, averagePrice: 108, status: 'FILLED', tag: 'ctpcopy' })]);
    await reconciler.run();
    await sleep(500);

    const lo = await prisma.copyOrder.findFirst({ where: { followerUserId: C.L!.user.id, isExit: true } });
    expect(lo).toMatchObject({ status: 'CANCELLED', errorCode: 'CLOSED_AT_BROKER', brokerOrderId: null });
    expect((await C.L!.agent.get('/follow/trades')).body.rows[0]).toMatchObject({ status: 'CLOSED', exitPrice: 105, pnl: 250 });
    const qb = (await C.Q!.agent.get('/follow/trades')).body.rows[0];
    expect(qb).toMatchObject({ status: 'CLOSED', openQuantity: 0 });
    expect(qb.pnl).toBe(275); // 25 × (103 − 100) in Kite + 25 × (108 − 100) via the platform
    for (const k of ['L', 'Q', 'R']) expect(registry.clientNet(C[k]!.subId, 'NFO', SYMBOL, 'INTRADAY')).toBe(0);

    // Paper client closes normally.
    expect((await C.P!.agent.get('/follow/trades')).body.rows[0]).toMatchObject({ status: 'CLOSED', exitPrice: 108, pnl: 400 });
  });
});
