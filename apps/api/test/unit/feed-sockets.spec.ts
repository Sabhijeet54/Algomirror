/**
 * Regression (2026-11-12, Render): when the feed account disconnected, MarketFeed tore the socket down
 * (removeAllListeners + ws.close()), the WebSocket then fired onerror, and AngelFeed emitted an 'error'
 * nobody listened to — Node throws on that, so the whole API process exited.
 */
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
