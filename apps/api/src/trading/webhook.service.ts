import { BadRequestException, ForbiddenException, HttpException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import type { Exchange, PrismaClient, Strategy } from '@ctp/database';
import { generateToken } from '@ctp/shared';
import { PRISMA } from '../common/prisma/prisma.service';
import { API_CONFIG, type ApiConfig } from '../config/config.module';
import { REDIS } from '../common/redis/redis.module';
import { FNO_EXCHANGES, FnoCatalogService, type FnoExchange } from '../market-data/fno-catalog.service';
import { MarketFeedService } from '../market-data/market-feed.service';
import { instrumentKey, PriceCacheService } from '../market-data/price-cache.service';
import { AutomationError, parseChartink, pctPoints, readAutomation } from './automation';
import { MasterOrderService } from './master-order.service';
import { SignalService } from './signal.service';
import type { MasterOrderDto } from './trading.dto';
import {
  AlertError,
  derivativeSymbol,
  exitLevels,
  parseAlert,
  pickExpiry,
  pickStrike,
  readAlertBody,
  symbolOfUnderlying,
  type ParsedAlert,
} from './webhook-alert';

const LOG_KEY = (strategyId: string) => `ctp:webhook:log:${strategyId}`;
const RATE_PER_MIN = 30;
const PRICE_WAIT_MS = 3_000;

export interface WebhookLogEntry {
  at: string;
  ok: boolean;
  action: string;
  symbol: string | null;
  message: string;
  tradeId?: string;
}

/**
 * TradingView / alert webhook: each strategy can have one secret URL. An alert places the trade exactly like
 * "Place trade" (paper / live, copy to every active client, target / stop loss) or squares positions off.
 */
@Injectable()
export class WebhookService {
  private readonly logger = new Logger('Webhook');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly orders: MasterOrderService,
    private readonly signals: SignalService,
    private readonly fno: FnoCatalogService,
    private readonly feed: MarketFeedService,
    private readonly prices: PriceCacheService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  // ------------------------------------------------------------ token management (master)

  /** Public URL TradingView posts to (through the web app's /api proxy). */
  url(token: string): string {
    return `${this.config.API_PUBLIC_URL.replace(/\/$/, '')}/hooks/tv/${token}`;
  }

  async rotate(strategyId: string): Promise<string> {
    const token = generateToken(24);
    await this.prisma.strategy.update({ where: { id: strategyId }, data: { webhookToken: token } });
    return token;
  }

  async disable(strategyId: string): Promise<void> {
    await this.prisma.strategy.update({ where: { id: strategyId }, data: { webhookToken: null } });
  }

  async recent(strategyId: string): Promise<WebhookLogEntry[]> {
    const rows = await this.redis.lrange(LOG_KEY(strategyId), 0, 19).catch(() => [] as string[]);
    return rows.map((r) => JSON.parse(r) as WebhookLogEntry);
  }

  // ------------------------------------------------------------ incoming alert

  async handle(token: string, body: unknown): Promise<{ ok: true; action: string; symbol: string | null; message: string; tradeId?: string }> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new NotFoundException('Unknown webhook');
    const strategy = await this.prisma.strategy.findUnique({ where: { webhookToken: token } });
    if (!strategy) throw new NotFoundException('Unknown webhook');

    // Per-strategy rate limit (TradingView sends from a few shared IPs, so an IP limit would hit every master).
    const rateKey = `ctp:webhook:rate:${strategy.id}:${Math.floor(Date.now() / 60_000)}`;
    const n = await this.redis.incr(rateKey);
    if (n === 1) await this.redis.expire(rateKey, 90);
    if (n > RATE_PER_MIN) throw new HttpException(`More than ${RATE_PER_MIN} alerts a minute — slow down.`, 429);

    let alert: ParsedAlert;
    try {
      alert = parseAlert(readAlertBody(body));
    } catch (err) {
      await this.log(strategy.id, { ok: false, action: '?', symbol: null, message: (err as Error).message });
      throw new BadRequestException((err as Error).message);
    }

    // TradingView can deliver the same alert twice: ignore an identical body within 10 s.
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const dedupe = `ctp:webhook:dup:${createHash('sha256').update(`${strategy.id}|${raw}`).digest('hex')}`;
    if ((await this.redis.set(dedupe, '1', 'EX', 10, 'NX')) !== 'OK') {
      return { ok: true, action: alert.action, symbol: alert.symbol ?? null, message: 'Duplicate alert ignored' };
    }

    try {
      const res: { symbol: string | null; message: string; tradeId?: string } =
        alert.action === 'EXIT' || alert.action === 'EXIT_ALL' ? await this.exit(strategy, alert) : await this.enter(strategy, alert);
      await this.log(strategy.id, { ok: true, action: alert.action, symbol: res.symbol, message: res.message, tradeId: res.tradeId });
      return { ok: true, action: alert.action, ...res };
    } catch (err) {
      const message = this.errorText(err, strategy.id);
      await this.log(strategy.id, { ok: false, action: alert.action, symbol: alert.symbol ?? alert.underlying ?? null, message });
      if (err instanceof HttpException) throw err;
      throw new BadRequestException(message);
    }
  }

  private errorText(err: unknown, strategyId: string): string {
    if (err instanceof AlertError || err instanceof AutomationError || err instanceof HttpException) return err.message;
    this.logger.error(`Automation ${strategyId}: ${(err as Error).stack ?? err}`);
    return 'Could not place the trade';
  }

  /**
   * Places one alert-shaped trade for automation (schedule legs, re-entry, Chartink) and logs the result in the
   * strategy's alert log under `source`. Never throws.
   */
  async runAlert(strategy: Strategy, body: Record<string, unknown>, source: string, opts: { reentryCount?: number } = {}): Promise<boolean> {
    let what: string | null = null;
    try {
      const a = parseAlert(body);
      what = a.symbol ?? a.underlying ?? null;
      const res: { symbol: string | null; message: string; tradeId?: string } =
        a.action === 'EXIT' || a.action === 'EXIT_ALL' ? await this.exit(strategy, a) : await this.enter(strategy, a, opts);
      await this.log(strategy.id, { ok: true, action: source, symbol: res.symbol, message: res.message, tradeId: res.tradeId });
      return true;
    } catch (err) {
      await this.log(strategy.id, { ok: false, action: source, symbol: what, message: this.errorText(err, strategy.id) });
      return false;
    }
  }

  /** Adds a line to the strategy's alert log (automation events). */
  logEvent(strategyId: string, e: Omit<WebhookLogEntry, 'at'>): Promise<void> {
    return this.log(strategyId, e);
  }

  /** Chartink public URL (same secret token as TradingView). */
  chartinkUrl(token: string): string {
    return `${this.config.API_PUBLIC_URL.replace(/\/$/, '')}/hooks/chartink/${token}`;
  }

  /** Chartink scanner alert: one trade per stock with the strategy's Chartink settings. */
  async handleChartink(token: string, body: unknown): Promise<{ ok: true; placed: number; failed: number; message: string }> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new NotFoundException('Unknown webhook');
    const strategy = await this.prisma.strategy.findUnique({ where: { webhookToken: token } });
    if (!strategy) throw new NotFoundException('Unknown webhook');
    const ck = readAutomation(strategy.automation).chartink;
    if (!ck.enabled) {
      await this.log(strategy.id, { ok: false, action: 'CHARTINK', symbol: null, message: 'Chartink is off for this strategy' });
      throw new BadRequestException('Chartink is off for this strategy');
    }
    const rateKey = `ctp:webhook:rate:${strategy.id}:${Math.floor(Date.now() / 60_000)}`;
    const n = await this.redis.incr(rateKey);
    if (n === 1) await this.redis.expire(rateKey, 90);
    if (n > RATE_PER_MIN) throw new HttpException(`More than ${RATE_PER_MIN} alerts a minute — slow down.`, 429);

    let scan: ReturnType<typeof parseChartink>;
    try {
      scan = parseChartink(body);
    } catch (err) {
      await this.log(strategy.id, { ok: false, action: 'CHARTINK', symbol: null, message: (err as Error).message });
      throw new BadRequestException((err as Error).message);
    }
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    const dedupe = `ctp:webhook:dup:${createHash('sha256').update(`${strategy.id}|ck|${raw}`).digest('hex')}`;
    if ((await this.redis.set(dedupe, '1', 'EX', 10, 'NX')) !== 'OK') return { ok: true, placed: 0, failed: 0, message: 'Duplicate alert ignored' };

    let placed = 0;
    let failed = 0;
    for (const st of scan.stocks.slice(0, ck.maxStocks)) {
      const ok = await this.runAlert(
        strategy,
        {
          action: ck.side,
          exchange: 'NSE',
          symbol: st.symbol,
          qty: ck.qty,
          product: ck.product,
          ...(ck.targetPct && st.price ? { targetPoints: pctPoints(st.price, ck.targetPct) } : {}),
          ...(ck.stoplossPct && st.price ? { stoplossPoints: pctPoints(st.price, ck.stoplossPct) } : {}),
        },
        `CHARTINK · ${scan.scan}`,
      );
      if (ok) placed++;
      else failed++;
    }
    const skipped = Math.max(0, scan.stocks.length - ck.maxStocks);
    return { ok: true, placed, failed, message: `${placed} placed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped (max ${ck.maxStocks} stocks)` : ''}` };
  }

  private async enter(strategy: Strategy, a: ParsedAlert, opts: { reentryCount?: number } = {}) {
    const side = a.action as 'BUY' | 'SELL';
    // Signal → option: close the opposite option of this underlying first (BUY exits puts, SELL exits calls).
    let flipped = '';
    if (a.flipExit && a.underlying) {
      const u = a.underlying;
      const opp = a.flipExit;
      const r = await this.signals.exitStrategyMatching(strategy.id, strategy.masterUserId, (p) => symbolOfUnderlying(p.symbol, u, opp));
      if (r.closed || r.failed) flipped = ` (closed ${r.closed} ${opp}${r.failed ? `, ${r.failed} failed` : ''} first)`;
    }
    const { exchange, symbol, lotSize } = await this.resolve(a);
    const quantity = a.qty ?? (a.lots ?? 1) * lotSize;
    const price = a.orderType === 'LIMIT' ? a.price! : await this.livePrice(exchange, symbol);
    const { targetPrice, stopLossPrice } = exitLevels(a, side, price ?? null);
    const dto: MasterOrderDto = {
      strategyId: strategy.id,
      exchange: exchange as MasterOrderDto['exchange'],
      symbol,
      side,
      quantity,
      orderType: a.orderType,
      productType: a.product,
      ...(a.orderType === 'LIMIT' ? { price: a.price } : {}),
      ...(lotSize > 1 ? { lotSize } : {}),
      ...(targetPrice != null ? { targetPrice } : {}),
      ...(stopLossPrice != null ? { stopLossPrice } : {}),
      ...(a.trailPoints ? { trailPoints: a.trailPoints } : {}),
    };
    try {
      const r = await this.orders.place(strategy.masterUserId, strategy, dto, opts);
      const lots = lotSize > 1 ? ` (${quantity / lotSize} lot${quantity / lotSize === 1 ? '' : 's'})` : '';
      return { symbol: `${exchange}:${symbol}`, message: `${side} ${quantity}${lots} ${exchange}:${symbol} placed and copied${flipped}`, tradeId: r.tradeId };
    } catch (err) {
      if (err instanceof BadRequestException || err instanceof ForbiddenException) throw new AlertError(err.message);
      throw err;
    }
  }

  private async exit(strategy: Strategy, a: ParsedAlert) {
    if (a.action === 'EXIT_ALL') {
      const r = await this.signals.squareOffStrategy(strategy.id, strategy.masterUserId);
      return { symbol: null, message: `Exit all: ${r.closed} closed${r.failed ? `, ${r.failed} failed (${r.errors.slice(0, 2).join('; ')})` : ''}` };
    }
    // Exact contract (symbol, or underlying + fixed strike / FUT); otherwise every open trade of the underlying.
    let exact: { exchange: string; symbol: string } | null = null;
    if (a.symbol) exact = { exchange: a.exchange, symbol: a.symbol };
    else if (a.underlying && a.option && (a.option === 'FUT' || typeof a.strike === 'number')) {
      const r = await this.resolve(a);
      exact = { exchange: r.exchange, symbol: r.symbol };
    }
    const match = exact
      ? (p: { exchange: Exchange; symbol: string }) => p.exchange === exact!.exchange && p.symbol === exact!.symbol
      : (p: { exchange: Exchange; symbol: string }) => symbolOfUnderlying(p.symbol, a.underlying!, a.option);
    const r = await this.signals.exitStrategyMatching(strategy.id, strategy.masterUserId, match);
    const what = exact ? `${exact.exchange}:${exact.symbol}` : `${a.underlying}${a.option ? ` ${a.option}` : ''}`;
    if (!r.closed && !r.failed) return { symbol: what, message: `Exit ${what}: no open position in this strategy` };
    return { symbol: what, message: `Exit ${what}: ${r.closed} closed${r.failed ? `, ${r.failed} failed (${r.errors.slice(0, 2).join('; ')})` : ''}` };
  }

  /** Alert → exchange, platform symbol and lot size. */
  private async resolve(a: ParsedAlert): Promise<{ exchange: string; symbol: string; lotSize: number }> {
    const fnoEx = (FNO_EXCHANGES as readonly string[]).includes(a.exchange) ? (a.exchange as FnoExchange) : null;
    if (a.symbol) {
      // Exact symbol: lot size from the catalog when it is a derivative of a known underlying.
      let lotSize = 1;
      if (fnoEx) {
        const name = a.symbol.replace(/\d.*$/, '');
        const chain = await this.fno.chain(fnoEx, name, a.symbol.endsWith('FUT') ? 'FUT' : 'OPT').catch(() => null);
        lotSize = chain?.lotSize ?? 1;
        if (!a.qty && !chain?.lotSize) throw new AlertError(`Lot size of ${a.symbol} unknown — send "qty" instead of "lots".`);
      }
      return { exchange: a.exchange, symbol: a.symbol, lotSize };
    }
    const u = a.underlying!;
    if (!fnoEx) return { exchange: a.exchange, symbol: u, lotSize: 1 }; // equity by name
    const option = a.option ?? (a.strike != null ? null : 'FUT');
    if (!option) throw new AlertError('"option" (CE / PE / FUT) is required with a strike.');
    const chain = await this.fno.chain(fnoEx, u, option === 'FUT' ? 'FUT' : 'OPT');
    if (!chain.expiries.length) throw new AlertError(`${u} has no live ${option === 'FUT' ? 'futures' : 'options'} on ${fnoEx}.`);
    const exp = pickExpiry(chain.expiries, a.expiry);
    if (option === 'FUT') return { exchange: fnoEx, symbol: derivativeSymbol(u, exp.date, 'FUT', null), lotSize: exp.lotSize };
    const spot = a.spot ?? (typeof a.strike === 'object' ? await this.underlyingPrice(fnoEx, u) : undefined);
    const strike = pickStrike(exp.strikes, a.strike ?? { atmOffset: 0 }, spot);
    return { exchange: fnoEx, symbol: derivativeSymbol(u, exp.date, option, strike), lotSize: exp.lotSize };
  }

  /** ATM without "spot" in the alert: the nearest future's live price. */
  private async underlyingPrice(ex: FnoExchange, u: string): Promise<number | undefined> {
    const fut = await this.fno.chain(ex, u, 'FUT').catch(() => null);
    const near = fut?.expiries[0];
    if (!near) return undefined;
    return (await this.livePrice(ex, derivativeSymbol(u, near.date, 'FUT', null))) ?? undefined;
  }

  /** Live price, subscribing the instrument and waiting briefly for its first tick. */
  private async livePrice(exchange: string, symbol: string): Promise<number | null> {
    const key = instrumentKey(exchange, symbol);
    let p = this.prices.get(key);
    if (p != null) return p;
    this.feed.ensure(exchange as Exchange, symbol);
    const until = Date.now() + PRICE_WAIT_MS;
    while (p == null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      p = this.prices.get(key);
    }
    return p ?? null;
  }

  private async log(strategyId: string, e: Omit<WebhookLogEntry, 'at'>): Promise<void> {
    const key = LOG_KEY(strategyId);
    await this.redis
      .multi()
      .lpush(key, JSON.stringify({ at: new Date().toISOString(), ...e }))
      .ltrim(key, 0, 19)
      .expire(key, 7 * 86_400)
      .exec()
      .catch(() => undefined);
  }
}
