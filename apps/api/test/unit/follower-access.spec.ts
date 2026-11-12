/**
 * Marketplace access after a strategy is removed (2026-11-12): a strategy the master removed — also from inside
 * the client's panel — must leave the client's marketplace and not be re-connectable by the client.
 */
import { FollowerController } from '../../src/trading/follower.controller';
import { canReconnect, REMOVED_REASON } from '../../src/trading/follower-access';

const CLIENT = 'client-1';
const MASTER = 'master-1';
const sub = (over: Record<string, unknown> = {}) => ({ id: 'sf-1', strategyId: 's-1', followerUserId: CLIENT, brokerAccountId: 'acc', copyStatus: 'ON', stoppedReason: null, stoppedByUserId: null, ...over }) as never;

describe('canReconnect', () => {
  it('allows an assigned strategy', () => expect(canReconnect(sub(), CLIENT)).toBe(true));
  it('allows a strategy the client disconnected himself', () =>
    expect(canReconnect(sub({ copyStatus: 'OFF', stoppedReason: REMOVED_REASON, stoppedByUserId: CLIENT }), CLIENT)).toBe(true));
  it('blocks a strategy the master removed', () =>
    expect(canReconnect(sub({ copyStatus: 'OFF', stoppedReason: REMOVED_REASON, stoppedByUserId: MASTER }), CLIENT)).toBe(false));
  it('keeps a paused (copy OFF, not removed) strategy', () => expect(canReconnect(sub({ copyStatus: 'OFF', stoppedReason: 'paused' }), CLIENT)).toBe(true));
});

describe('disconnect from inside the client panel', () => {
  const make = () => {
    const update = jest.fn().mockResolvedValue({});
    const prisma = { strategyFollower: { findUnique: jest.fn().mockResolvedValue(sub()), update } };
    const audit = { log: jest.fn().mockResolvedValue(undefined) };
    const events = { emit: jest.fn() };
    const ctrl = new FollowerController(prisma as never, {} as never, audit as never, {} as never, events as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    return { ctrl, update, audit };
  };
  const req = { ip: '127.0.0.1', header: () => 'jest' } as never;

  it('records the master as the remover, so the client cannot reconnect it', async () => {
    const { ctrl, update, audit } = make();
    await ctrl.disconnect({ id: CLIENT, email: 'c@x', role: 'FOLLOWER', sessionId: 's', impersonatorId: MASTER } as never, 's-1', req);
    const data = update.mock.calls[0][0].data;
    expect(data.stoppedByUserId).toBe(MASTER);
    expect(canReconnect(sub(data), CLIENT)).toBe(false);
    expect(audit.log.mock.calls[0][0].actorUserId).toBe(MASTER);
  });

  it("a client's own disconnect stays re-connectable", async () => {
    const { ctrl, update } = make();
    await ctrl.disconnect({ id: CLIENT, email: 'c@x', role: 'FOLLOWER', sessionId: 's' } as never, 's-1', req);
    const data = update.mock.calls[0][0].data;
    expect(data.stoppedByUserId).toBe(CLIENT);
    expect(canReconnect(sub(data), CLIENT)).toBe(true);
  });
});
