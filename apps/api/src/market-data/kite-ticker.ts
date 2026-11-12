import { EventEmitter } from 'node:events';

/**
 * Minimal Zerodha KiteTicker client (wss://ws.kite.trade) on Node's built-in WebSocket.
 * Uses "ltp" mode; every binary packet starts with [int32 instrument_token][int32 last_price] (big-endian),
 * so the first 8 bytes of any mode are enough. Prices are in paise (÷100), CDS ÷1e7, BCD ÷1e4.
 * Events: 'open', 'close' (reason), 'error' (Error), 'tick' (token, ltp), 'message' (any frame — liveness).
 */
export class KiteTicker extends EventEmitter {
  private ws?: WebSocket;
  private readonly tokens = new Set<number>();

  constructor(
    private readonly apiKey: string,
    private readonly accessToken: string,
  ) {
    super();
  }

  connect(): void {
    const url = `wss://ws.kite.trade?api_key=${encodeURIComponent(this.apiKey)}&access_token=${encodeURIComponent(this.accessToken)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.emit('open');
      if (this.tokens.size) this.sendSubscribe([...this.tokens]);
    };
    ws.onclose = (e) => this.emit('close', `${e.code} ${e.reason || ''}`.trim());
    ws.onerror = () => this.safeError(new Error('KiteTicker socket error'));
    ws.onmessage = (e) => {
      this.emit('message');
      if (typeof e.data === 'string') {
        try {
          const m = JSON.parse(e.data) as { type?: string; data?: unknown };
          if (m.type === 'error') this.safeError(new Error(String(m.data)));
        } catch {
          /* ignore */
        }
        return;
      }
      this.parse(e.data as ArrayBuffer);
    };
  }

  private parse(buf: ArrayBuffer): void {
    if (buf.byteLength < 2) return; // 1-byte heartbeat
    const v = new DataView(buf);
    const count = v.getInt16(0);
    let off = 2;
    for (let i = 0; i < count && off + 2 <= buf.byteLength; i++) {
      const len = v.getInt16(off);
      off += 2;
      if (len >= 8 && off + len <= buf.byteLength) {
        const token = v.getInt32(off);
        const raw = v.getInt32(off + 4);
        const seg = token & 0xff;
        const div = seg === 3 ? 10_000_000 : seg === 6 ? 10_000 : 100;
        this.emit('tick', token, raw / div);
      }
      off += len;
    }
  }

  subscribe(tokens: number[]): void {
    const fresh = tokens.filter((t) => !this.tokens.has(t));
    fresh.forEach((t) => this.tokens.add(t));
    if (fresh.length && this.ws?.readyState === WebSocket.OPEN) this.sendSubscribe(fresh);
  }

  unsubscribe(tokens: number[]): void {
    tokens.forEach((t) => this.tokens.delete(t));
    if (tokens.length && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ a: 'unsubscribe', v: tokens }));
  }

  private sendSubscribe(tokens: number[]): void {
    this.ws!.send(JSON.stringify({ a: 'subscribe', v: tokens }));
    this.ws!.send(JSON.stringify({ a: 'mode', v: ['ltp', tokens] }));
  }

  /**
   * An EventEmitter 'error' with no listener throws, and from a socket callback that kills the whole API
   * process. close() drops our listeners, and the socket still fires onerror while closing, so guard it.
   */
  private safeError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  close(): void {
    this.removeAllListeners();
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  }
}
