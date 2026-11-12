/**
 * Regression (2026-11-12, Render): when the feed account disconnected, MarketFeed tore the socket down
 * (removeAllListeners + ws.close()), the WebSocket then fired onerror, and AngelFeed emitted an 'error'
 * nobody listened to — Node throws on that, so the whole API process exited.
 */
jest.mock('node:https', () => {
  const { EventEmitter } = jest.requireActual('node:events');
  return {
    request: jest.fn(() => {
      const req = new EventEmitter() as import('node:events').EventEmitter & { end: () => void; destroy: () => void };
      req.end = () => setImmediate(() => req.emit('response', { statusCode: 401, resume: () => undefined }));
      req.destroy = () => undefined;
      return req;
    }),
  };
});

import { AngelFeed } from '../../src/market-data/angel-feed';
import { KiteTicker } from '../../src/market-data/kite-ticker';

class FakeWs {
  static last?: FakeWs;
  static OPEN = 1;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWs.last = this;
  }
  send(): void {}
  close(): void {
    this.closed = true;
  }
}

const realWs = (globalThis as { WebSocket?: unknown }).WebSocket;
beforeAll(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = FakeWs;
});
afterAll(() => {
  (globalThis as { WebSocket?: unknown }).WebSocket = realWs;
});

describe.each([
  ['AngelFeed', () => new AngelFeed('key', 'C1', 'feed')],
  ['KiteTicker', () => new KiteTicker('key', 'tok')],
])('%s', (_name, make) => {
  it('does not throw on a socket error with no error listener', () => {
    const feed = make();
    feed.connect();
    expect(() => FakeWs.last!.onerror?.()).not.toThrow();
  });

  it('detaches socket handlers on close, so a late onerror cannot reach the emitter', () => {
    const feed = make();
    const onError = jest.fn();
    feed.on('error', onError);
    feed.connect();
    const ws = FakeWs.last!;
    feed.close();
    expect(ws.closed).toBe(true);
    expect(ws.onerror).toBeNull();
    expect(ws.onclose).toBeNull();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('AngelFeed connect failures', () => {
  it('turns a refused handshake (error, no close) into a close with the HTTP status', async () => {
    const feed = new AngelFeed('key', 'C1', 'feed');
    const closed = new Promise<string>((ok) => feed.on('close', ok));
    feed.on('error', () => undefined);
    feed.connect();
    FakeWs.last!.onerror?.();
    await expect(closed).resolves.toMatch(/handshake failed \(HTTP 401\).*not whitelisted/);
    expect(FakeWs.last!.closed).toBe(true);
  });

  it('gives up when the socket never opens', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const feed = new AngelFeed('key', 'C1', 'feed');
      const onClose = jest.fn();
      feed.on('close', onClose);
      feed.connect();
      jest.advanceTimersByTime(20_000);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(onClose).toHaveBeenCalledWith(expect.stringMatching(/no answer in 20 s/));
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes only once', async () => {
    const feed = new AngelFeed('key', 'C1', 'feed');
    const onClose = jest.fn();
    feed.on('close', onClose);
    feed.connect();
    const ws = FakeWs.last!;
    ws.onopen?.();
    ws.onclose?.({ code: 1006, reason: '' });
    ws.onclose?.({ code: 1006, reason: '' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
