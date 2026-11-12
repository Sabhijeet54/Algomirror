import { EventEmitter } from 'node:events';
import { request } from 'node:https';

const FEED_URL = 'wss://smartapisocket.angelone.in/smart-stream';
const CONNECT_TIMEOUT_MS = 20_000;

/**
 * HTTP status of a refused SmartStream handshake. The WebSocket API hides it (just "error"), and a 401 means
 * the feed token / API key is wrong or this server's IP is not whitelisted for the account.
 */
export function probeHandshake(url: string, timeoutMs = 10_000): Promise<number | null> {
  return new Promise((resolve) => {
    const req = request(url.replace(/^wss:/, 'https:'), {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' },
      timeout: timeoutMs,
    });
    req.on('upgrade', (_res, socket) => {
      socket.destroy();
      resolve(101);
    });
    req.on('response', (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/** SmartAPI exchangeType codes. */
export const ANGEL_EXCHANGE_TYPE: Record<string, number> = { NSE: 1, NFO: 2, BSE: 3, BFO: 4, MCX: 5, CDS: 13 };

/**
 * Minimal Angel One SmartAPI WebSocket 2.0 (SmartStream) client on Node's built-in WebSocket.
 * Auth via query params (clientCode, feedToken, apiKey). LTP mode (1). Binary frames are little-endian:
 *   [0] mode, [1] exchangeType, [2..27) token (ASCII, NUL padded), [27..35) seq, [35..43) exch ts, [43..51) LTP (paise).
 * A text "ping" is sent every 25 s (server answers "pong").
 * Events: 'open', 'close', 'error', 'tick' (exchangeType, token, ltp), 'message'.
 */
export class AngelFeed extends EventEmitter {
  private ws?: WebSocket;
  private ping?: NodeJS.Timeout;
  private connectTimer?: NodeJS.Timeout;
  private opened = false;
  private ended = false;
  private readonly subs = new Map<number, Set<string>>();

  constructor(
    private readonly apiKey: string,
    private readonly clientCode: string,
    private readonly feedToken: string,
  ) {
    super();
  }

  connect(): void {
    const qs = new URLSearchParams({ clientCode: this.clientCode, feedToken: this.feedToken, apiKey: this.apiKey });
    const url = `${FEED_URL}?${qs.toString()}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.opened = false;
    this.ended = false;
    // A refused handshake fires only 'error' — never 'close' — so the socket sat in CONNECTING forever and the
    // feed never retried. Treat an error before open (or no open within 20 s) as a failed connect.
    this.connectTimer = setTimeout(() => void this.failConnect(url, 'no answer in 20 s'), CONNECT_TIMEOUT_MS);
    ws.onopen = () => {
      this.opened = true;
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.emit('open');
      this.ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('ping'), 25_000);
      for (const [ex, toks] of this.subs) if (toks.size) this.send(1, ex, [...toks]);
    };
    ws.onclose = (e) => {
      if (this.ping) clearInterval(this.ping);
      this.end(`${e.code} ${e.reason || ''}`.trim());
    };
    ws.onerror = () => {
      this.safeError(new Error('SmartStream socket error'));
      if (!this.opened) void this.failConnect(url, 'handshake failed');
    };
    ws.onmessage = (e) => {
      this.emit('message');
      if (typeof e.data === 'string') return; // "pong" / errors
      const buf = e.data as ArrayBuffer;
      if (buf.byteLength < 51) return;
      const v = new DataView(buf);
      const exType = v.getUint8(1);
      let token = '';
      for (let i = 2; i < 27; i++) {
        const c = v.getUint8(i);
        if (c === 0) break;
        token += String.fromCharCode(c);
      }
      const ltp = Number(v.getBigInt64(43, true)) / (exType === 13 ? 10_000_000 : 100);
      this.emit('tick', exType, token, ltp);
    };
  }

  subscribe(exchangeType: number, tokens: string[]): void {
    const set = this.subs.get(exchangeType) ?? new Set<string>();
    const fresh = tokens.filter((t) => !set.has(t));
    fresh.forEach((t) => set.add(t));
    this.subs.set(exchangeType, set);
    if (fresh.length && this.ws?.readyState === WebSocket.OPEN) this.send(1, exchangeType, fresh);
  }

  private send(action: 0 | 1, exchangeType: number, tokens: string[]): void {
    this.ws!.send(JSON.stringify({ correlationID: 'ctpfeed', action, params: { mode: 1, tokenList: [{ exchangeType, tokens }] } }));
  }

  /**
   * An EventEmitter 'error' with no listener throws, and from a socket callback that kills the whole API
   * process. close() drops our listeners, and the socket still fires onerror while closing, so guard it.
   */
  private end(reason: string): void {
    if (this.ended) return;
    this.ended = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.emit('close', reason);
  }

  private async failConnect(url: string, what: string): Promise<void> {
    if (this.ended || this.opened) return;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    const ws = this.ws;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    const status = await probeHandshake(url).catch(() => null);
    const hint = status === 401 || status === 403 ? ' — feed token/API key rejected or server IP not whitelisted on Angel' : '';
    this.end(`${what}${status ? ` (HTTP ${status})` : ''}${hint}`);
  }

  private safeError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  close(): void {
    if (this.ping) clearInterval(this.ping);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.ended = true;
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
