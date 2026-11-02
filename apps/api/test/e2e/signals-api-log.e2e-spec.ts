/**
 * Software booking vs demat (fake broker, real PostgreSQL + Redis):
 * a LIVE trade the broker rejects is still booked in Signals with its P&L, the dashboard's Today P&L includes
 * it, the executed P&L does not, and the API log shows the broker's error. Paper trades show as paper.
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
import { BrokerApiError } from '../../src/brokers/broker-http';
import { REDIS } from '../../src/common/redis/redis.module';
import { configureApp } from '../../src/main';
import { PriceCacheService } from '../../src/market-data/price-cache.service';
import type { BrokerAdapter } from '../../src/trading/broker-adapter';
import { ClientRegistryService } from '../../src/trading/client-registry.service';
import { CopyEngineService } from '../../src/trading/copy-engine.service';
import { TradingService } from '../../src/trading/trading.service';

loadDotenv(__dirname);
const RUN = randomUUID().slice(0, 8);
const email = (n: string) => `e2e-${RUN}-${n}@example.com`.toLowerCase();
const PASSWORD = 'E2eTestPass123';
const H = { 'X-CTP-Client': 'web' };
const SYMBOL = `NIFTYSG${RUN.toUpperCase()}PE`;

let app: NestExpressApplication;
let prisma: PrismaClient;
let redis: Redis;

const rejecting = {
  broker: 'ANGEL_ONE',
  async placeOrder() {
    throw new BrokerApiError('Static ip server not configured', 400);
  },
  async positions() {
    return [];
  },
  async orders() {
    return [];
  },
} as unknown as BrokerAdapter;

async function login(e: string) {
  const keys = await redis.keys(`${RedisKeys.rateLimitPrefix}*`);
  if (keys.length) await redis.del(...keys);
  const agent = request.agent(app.getHttpServer());
  expect((await agent.post('/auth/login').set(H).send({ email: e, password: PASSWORD })).status).toBe(200);
  return agent;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  prisma = createPrismaClient();
  redis = app.get(REDIS);
  jest.spyOn(ClientRegistryService.prototype as never, 'buildAdapter' as never).mockImplementation((async () => rejecting) as never);
  jest.spyOn(TradingService.prototype, 'adapterFor').mockImplementation(async () => rejecting);
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

it('rejected live trade: booked in Signals + Today P&L, not in executed P&L, error in API log', async () => {
  const hash = await hashPassword(PASSWORD);
  const master: User = await prisma.user.create({ data: { email: email('m'), name: 'M', role: 'MASTER', passwordHash: hash, emailVerifiedAt: new Date() } });
  const mAcc: BrokerAccount = await prisma.brokerAccount.create({
    data: { userId: master.id, broker: 'ANGEL_ONE', brokerClientId: `SGM${RUN}`, status: 'CONNECTED', mode: 'DATA_ONLY', tokenExpiresAt: new Date(Date.now() + 86_400_000) },
  });
  const st: Strategy = await prisma.strategy.create({ data: { masterUserId: master.id, name: `AONE ${RUN}`, status: 'ACTIVE', allowedExchanges: ['NFO'] } });
  const live = await prisma.user.create({ data: { email: email('live'), name: 'Live Client', role: 'FOLLOWER', passwordHash: hash, emailVerifiedAt: new Date(), licenceExpiresAt: new Date(Date.now() + 86_400_000 * 5) } });
  const acc = await prisma.brokerAccount.create({
    data: { userId: live.id, broker: 'ANGEL_ONE', brokerClientId: `SGL${RUN}`, status: 'CONNECTED', mode: 'TRADING', isPaper: false, tokenExpiresAt: new Date(Date.now() + 86_400_000) },
  });
  await prisma.brokerCredential.create({ data: { brokerAccountId: acc.id, encryptedAccessToken: 'v1:k1:x:y:z' } });
  await prisma.strategyFollower.create({ data: { strategyId: st.id, followerUserId: live.id, brokerAccountId: acc.id, allocationMode: 'FIXED_QUANTITY', fixedQuantity: 10, copyStatus: 'ON' } });
  const paper = await prisma.user.create({ data: { email: email('paper'), name: 'Paper Client', role: 'FOLLOWER', passwordHash: hash, emailVerifiedAt: new Date(), licenceExpiresAt: new Date(Date.now() + 86_400_000 * 5) } });
  await prisma.strategyFollower.create({ data: { strategyId: st.id, followerUserId: paper.id, allocationMode: 'FIXED_QUANTITY', fixedQuantity: 10 } });
  const pa = await login(paper.email);
  const ps = (await pa.get('/follow/subscriptions')).body[0];
  expect((await pa.post(`/follow/subscriptions/${ps.id}/start`).set(H)).status).toBe(200);

  await app.get(ClientRegistryService).reload();
  const prices = app.get(PriceCacheService);
  const engine = app.get(CopyEngineService);
  prices.set(`NFO:${SYMBOL}`, 48.1);
  const sig = (side: 'BUY' | 'SELL', px: number, id: string) =>
    engine.onMasterTrade(st, mAcc, { exchange: 'NFO', symbol: SYMBOL, side, quantity: 10, filledQuantity: 10, averagePrice: px, price: px, status: 'FILLED', orderType: 'MARKET', productType: 'INTRADAY', brokerOrderId: `SG-${RUN}-${id}`, timestamp: new Date(), lotSize: 1 });
  await sig('BUY', 48.1, '1');
  prices.set(`NFO:${SYMBOL}`, 47.9);
  await sig('SELL', 47.9, '2');

  const la = await login(live.email);
  const signals = (await la.get('/follow/signals')).body;
  expect(signals.rows).toHaveLength(1);
  expect(signals.rows[0]).toMatchObject({ status: 'CLOSED', entryPrice: 48.1, exitPrice: 47.9, quantity: 10, execution: 'NOT_EXECUTED' });
  expect(signals.totalPnl).toBe(-2);
  const dash = (await la.get('/follow/dashboard')).body;
  expect(dash.todayPnl).toBe(-2); // software P&L includes the rejected trade
  expect(dash.brokerPnl).toBe(0); // nothing executed in the demat
  expect(dash.strategies[0]).toMatchObject({ todayPnl: -2, todayQty: 10 });

  const log = (await la.get('/follow/api-log')).body;
  const entry = log.items.find((r: { type: string }) => r.type === 'ENTRY');
  expect(entry).toMatchObject({ execution: 'error', broker: 'ANGEL_ONE', loginId: `SGL${RUN}`, strategy: `AONE ${RUN}` });
  expect(entry.response.message).toMatch(/Static ip server not configured/);
  expect((await la.get('/follow/api-log').query({ execution: 'success' })).body.total).toBe(0);
  expect((await la.get('/follow/api-log').query({ q: 'static ip' })).body.total).toBeGreaterThanOrEqual(1);

  // Paper client: booked the same way, shown as paper in the API log.
  const psig = (await pa.get('/follow/signals')).body;
  expect(psig.rows[0]).toMatchObject({ status: 'CLOSED', mode: 'PAPER', pnl: -2 });
  const plog = (await pa.get('/follow/api-log')).body;
  expect(plog.items.every((r: { execution: string }) => r.execution === 'paper')).toBe(true);
});
