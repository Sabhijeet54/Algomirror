/** Multi-master isolation: one master never sees, takes or opens another master's clients or feed list. */
import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type Redis from 'ioredis';
import { loadDotenv } from '@ctp/config';
import { createPrismaClient, PrismaClient } from '@ctp/database';
import { hashPassword } from '@ctp/shared';
import { RedisKeys } from '@ctp/types';
import { AppModule } from '../../src/app.module';
import { REDIS } from '../../src/common/redis/redis.module';
import { configureApp } from '../../src/main';

loadDotenv(__dirname);
const RUN = randomUUID().slice(0, 8);
const email = (n: string) => `e2e-${RUN}-${n}@example.com`.toLowerCase();
const PASSWORD = 'E2eTestPass123';
const H = { 'X-CTP-Client': 'web' };

let app: NestExpressApplication;
let prisma: PrismaClient;
let redis: Redis;

async function login(e: string) {
  const keys = await redis.keys(`${RedisKeys.rateLimitPrefix}*`);
  if (keys.length) await redis.del(...keys);
  const agent = request.agent(app.getHttpServer());
  let res = await agent.post('/auth/login').set(H).send({ email: e, password: PASSWORD });
  if (res.status === 403) res = await agent.post('/auth/login').set(H).send({ email: e, password: PASSWORD, portal: 'staff' });
  expect(res.status).toBe(200);
  return agent;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  configureApp(app);
  await app.init();
  prisma = createPrismaClient();
  redis = app.get(REDIS);
});

afterAll(async () => {
  const ids = (await prisma.user.findMany({ where: { email: { startsWith: `e2e-${RUN}-` } }, select: { id: true } })).map((u) => u.id);
  await prisma.strategyFollower.deleteMany({ where: { followerUserId: { in: ids } } });
  await prisma.brokerAccount.deleteMany({ where: { userId: { in: ids } } });
  await prisma.strategy.deleteMany({ where: { masterUserId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
  await app.close();
});

it('masters only see and manage their own clients', async () => {
  const hash = await hashPassword(PASSWORD);
  const mk = (n: string, role: 'ADMIN' | 'MASTER' | 'FOLLOWER', parentUserId?: string) =>
    prisma.user.create({ data: { email: email(n), name: `E2E ${n}`, role, passwordHash: hash, emailVerifiedAt: new Date(), parentUserId, licenceQuota: role === 'MASTER' ? 5 : 0 } });
  const admin = await mk('admin', 'ADMIN');
  const mA = await mk('master-a', 'MASTER');
  const mB = await mk('master-b', 'MASTER');
  const cA = await mk('client-a', 'FOLLOWER', mA.id);
  const cB = await mk('client-b', 'FOLLOWER', mB.id);
  const free = await mk('free', 'FOLLOWER');
  const sA = await prisma.strategy.create({ data: { masterUserId: mA.id, name: `E2E A ${RUN}`, masterCapital: 100000, status: 'ACTIVE' } });
  const sB = await prisma.strategy.create({ data: { masterUserId: mB.id, name: `E2E B ${RUN}`, masterCapital: 100000, status: 'ACTIVE' } });
  const a = await login(mA.email);
  const b = await login(mB.email);
  const ad = await login(admin.email);
  const ids = (r: request.Response) => (r.body as { id: string }[]).map((x) => x.id);

  // Directory: own + not-yet-owned clients only.
  const dirA = ids(await a.get('/master/client-directory').query({ search: `e2e-${RUN}` }));
  expect(dirA).toEqual(expect.arrayContaining([cA.id, free.id]));
  expect(dirA).not.toContain(cB.id);
  expect(ids(await ad.get('/admin/client-directory').query({ search: `e2e-${RUN}` }))).toEqual(expect.arrayContaining([cA.id, cB.id, free.id]));

  // Another master's client cannot be assigned (not even revealed), nor its licence / panel touched.
  const assign = (agent: typeof a, sid: string, e: string) => agent.post(`/master/strategies/${sid}/assign`).set(H).send({ email: e, allocationMode: 'FIXED_QUANTITY', fixedLots: 1 });
  expect((await assign(a, sA.id, cB.email)).status).toBe(404);
  expect((await a.post(`/master/clients/${cB.id}/licence`).set(H).send({ days: 30 })).status).toBe(403);
  expect((await a.get(`/master/clients/${cB.id}/licence-history`)).status).toBe(403);
  expect((await a.post(`/auth/impersonate/${cB.id}`).set(H)).status).toBe(403);

  // A free client becomes the master's own once assigned — then hidden from the other master.
  expect((await assign(a, sA.id, free.email)).status).toBe(200);
  expect((await prisma.user.findUnique({ where: { id: free.id } }))?.parentUserId).toBe(mA.id);
  expect(ids(await b.get('/master/client-directory').query({ search: `e2e-${RUN}` }))).not.toContain(free.id);
  expect((await assign(b, sB.id, free.email)).status).toBe(404);
  expect((await a.post(`/auth/impersonate/${free.id}`).set(H)).status).toBe(200);

  // Shared live feed: masters see health only; instrument controls are admin-only.
  const st = (await b.get('/market/feed/status')).body;
  expect(st.subscribed).toEqual([]);
  expect(st.brokerAccountId).toBeNull();
  expect((await b.post('/market/feed/unsubscribe').set(H).send({ instruments: ['NSE:INFY'] })).status).toBe(403);
  expect((await ad.post('/market/feed/unsubscribe').set(H).send({ instruments: ['NSE:INFY'] })).status).toBe(200);

  await prisma.strategy.deleteMany({ where: { id: { in: [sA.id, sB.id] } } });
});

it('master deletes his own client: hidden, cannot log in, email reusable; other masters cannot delete it', async () => {
  const hash = await hashPassword(PASSWORD);
  const m1 = await prisma.user.create({ data: { email: email('del-m1'), name: 'E2E del m1', role: 'MASTER', passwordHash: hash, emailVerifiedAt: new Date(), licenceQuota: 5 } });
  const m2 = await prisma.user.create({ data: { email: email('del-m2'), name: 'E2E del m2', role: 'MASTER', passwordHash: hash, emailVerifiedAt: new Date() } });
  const cl = await prisma.user.create({ data: { email: email('del-client'), name: 'E2E del client', role: 'FOLLOWER', passwordHash: hash, emailVerifiedAt: new Date(), parentUserId: m1.id } });
  const s1 = await prisma.strategy.create({ data: { masterUserId: m1.id, name: `E2E del ${RUN}`, masterCapital: 100000, status: 'ACTIVE' } });
  const a1 = await login(m1.email);
  const a2 = await login(m2.email);
  expect((await a1.post(`/master/strategies/${s1.id}/assign`).set(H).send({ email: cl.email, allocationMode: 'FIXED_QUANTITY', fixedLots: 1 })).status).toBe(200);
  const c = await login(cl.email);

  expect((await a2.post(`/master/clients/${cl.id}/delete`).set(H)).status).toBe(403);
  expect((await a1.post(`/master/clients/${cl.id}/delete`).set(H)).status).toBe(200);

  const row = await prisma.user.findUnique({ where: { id: cl.id } });
  expect(row?.deletedAt).toBeTruthy();
  expect(row?.status).toBe('DISABLED');
  expect((await prisma.strategyFollower.findFirst({ where: { followerUserId: cl.id } }))?.copyStatus).toBe('OFF');
  expect(((await a1.get('/master/clients')).body as { userId: string }[]).map((x) => x.userId)).not.toContain(cl.id);
  expect((await a1.get(`/master/clients/${cl.id}/licence-history`)).status).toBe(404);
  expect((await c.get('/auth/me')).status).toBe(401); // old session revoked
  expect((await request(app.getHttpServer()).post('/auth/login').set(H).send({ email: cl.email, password: PASSWORD })).status).not.toBe(200);

  // The email is free again for a new client.
  const re = await a1.post('/master/clients').set(H).send({ name: 'E2E del again', email: cl.email, password: PASSWORD });
  expect(re.status).toBe(201);
  await prisma.strategyFollower.deleteMany({ where: { strategyId: s1.id } });
  await prisma.strategy.delete({ where: { id: s1.id } });
  await prisma.user.delete({ where: { id: cl.id } });
});
