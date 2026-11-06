/** Licence expiry (end of last IST day), extend, revoke and licence history (admin, master, client). */
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
const istClock = (iso: string) => new Date(new Date(iso).getTime() + 330 * 60_000).toISOString().slice(11, 19);

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
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
  await app.close();
});

it('assign / extend / revoke: end-of-day expiry and full history for admin, master and client', async () => {
  const hash = await hashPassword(PASSWORD);
  const admin = await prisma.user.create({ data: { email: email('admin'), name: 'E2E Admin', role: 'ADMIN', passwordHash: hash, emailVerifiedAt: new Date() } });
  const master = await prisma.user.create({ data: { email: email('master'), name: 'E2E Master', role: 'MASTER', passwordHash: hash, emailVerifiedAt: new Date(), licenceQuota: 5 } });
  const client = await prisma.user.create({ data: { email: email('client'), name: 'E2E Client', role: 'FOLLOWER', passwordHash: hash, emailVerifiedAt: new Date(), parentUserId: master.id } });
  const a = await login(admin.email);
  const m = await login(master.email);
  const c = await login(client.email);

  const r1 = await a.post(`/admin/users/${client.id}/licence`).set(H).send({ days: 2 });
  expect(r1.status).toBe(201);
  expect(istClock(r1.body.licenceExpiresAt)).toBe('23:59:59');
  const first = new Date(r1.body.licenceExpiresAt).getTime();
  expect(first).toBeGreaterThanOrEqual(Date.now() + 2 * 86_400_000 - 5_000);

  const r2 = await m.post(`/master/clients/${client.id}/licence`).set(H).send({ days: 30, extend: true });
  expect(r2.status).toBe(200);
  expect(new Date(r2.body.licenceExpiresAt).getTime()).toBe(first + 30 * 86_400_000);

  expect((await m.post(`/master/clients/${client.id}/licence/revoke`).set(H)).status).toBe(200);

  const ah = (await a.get(`/admin/users/${client.id}/licence-history`)).body;
  expect(ah.map((h: { kind: string }) => h.kind)).toEqual(['REVOKED', 'EXTENDED', 'ASSIGNED']);
  expect(ah[2]).toMatchObject({ days: 2, by: { name: 'E2E Admin', role: 'ADMIN' } });
  expect(ah[1]).toMatchObject({ days: 30, by: { name: 'E2E Master' } });
  const mh = (await m.get(`/master/clients/${client.id}/licence-history`)).body;
  expect(mh).toHaveLength(3);
  const ch = (await c.get('/follow/licence-history')).body;
  expect(ch).toHaveLength(3);
  expect(ch.every((h: { by: unknown }) => h.by === null)).toBe(true); // who changed it is not shown to clients
});

it('master limit: demo and 2-day licences are free, 30-day uses one', async () => {
  const hash = await hashPassword(PASSWORD);
  const master = await prisma.user.create({ data: { email: email('m2'), name: 'E2E Master 2', role: 'MASTER', passwordHash: hash, emailVerifiedAt: new Date(), licenceQuota: 1 } });
  const client = await prisma.user.create({ data: { email: email('c2'), name: 'E2E Client 2', role: 'FOLLOWER', passwordHash: hash, emailVerifiedAt: new Date(), parentUserId: master.id } });
  const m = await login(master.email);
  const left = async () => (await m.get('/master/licence-quota')).body.remaining;
  expect((await m.post(`/master/clients/${client.id}/licence`).set(H).send({ days: 2 })).status).toBe(200);
  expect(await left()).toBe(1);
  const demoClient = await prisma.user.create({ data: { email: email('c2demo'), name: 'E2E Client demo', role: 'FOLLOWER', passwordHash: hash, emailVerifiedAt: new Date(), parentUserId: master.id } });
  expect((await m.post(`/master/clients/${demoClient.id}/licence`).set(H).send({ days: 7, demo: true })).status).toBe(200);
  expect(await left()).toBe(1);
  expect((await m.post('/master/clients').set(H).send({ name: 'Trial', email: email('c3'), password: PASSWORD, licenceDays: 2 })).status).toBe(201);
  expect(await left()).toBe(1);
  expect((await m.post(`/master/clients/${client.id}/licence`).set(H).send({ days: 30 })).status).toBe(200);
  expect(await left()).toBe(0);
  expect((await m.post(`/master/clients/${client.id}/licence`).set(H).send({ days: 30 })).status).toBe(400);
  const freeClient = await prisma.user.create({ data: { email: email('c2free'), name: 'E2E Client free', role: 'FOLLOWER', passwordHash: hash, emailVerifiedAt: new Date(), parentUserId: master.id } });
  expect((await m.post(`/master/clients/${freeClient.id}/licence`).set(H).send({ days: 2 })).status).toBe(200); // still free at 0
});

it('free trial (demo / 2 days) is given only once per client, even after delete + re-create', async () => {
  const hash = await hashPassword(PASSWORD);
  const master = await prisma.user.create({ data: { email: email('trial-master'), name: 'E2E trial master', role: 'MASTER', passwordHash: hash, emailVerifiedAt: new Date(), licenceQuota: 5 } });
  const client = await prisma.user.create({ data: { email: email('trial-client'), name: 'E2E trial client', role: 'FOLLOWER', passwordHash: hash, emailVerifiedAt: new Date(), parentUserId: master.id } });
  const m = await login(master.email);
  const give = (body: object) => m.post(`/master/clients/${client.id}/licence`).set(H).send(body);

  expect((await give({ days: 2 })).status).toBe(200);
  const again = await give({ days: 2 });
  expect(again.status).toBe(400);
  expect(again.body.message).toMatch(/free trial/i);
  expect((await give({ days: 5, demo: true })).status).toBe(400);
  expect((await give({ days: 30 })).status).toBe(200); // paid licence still allowed

  // Delete and create again with the same email: still no second trial.
  expect((await m.post(`/master/clients/${client.id}/delete`).set(H)).status).toBe(200);
  const re = await m.post('/master/clients').set(H).send({ name: 'E2E trial again', email: client.email, password: PASSWORD, licenceDays: 2 });
  expect(re.status).toBe(400);
  expect((await m.post('/master/clients').set(H).send({ name: 'E2E trial again', email: client.email, password: PASSWORD })).status).toBe(201);
  await prisma.user.delete({ where: { id: client.id } });
});
