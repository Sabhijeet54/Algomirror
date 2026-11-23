import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { Prisma } from '@ctp/database';
import type { Exchange, PrismaClient, Strategy } from '@ctp/database';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { API_CONFIG, type ApiConfig } from '../config/config.module';
import { FnoCatalogService, type FnoExchange } from '../market-data/fno-catalog.service';
import { MarketFeedService } from '../market-data/market-feed.service';
import { instrumentKey, PriceCacheService } from '../market-data/price-cache.service';
import { dailyHaltKey, isDue, istNow, readAutomation } from './automation';
import { newOrbState, orbAlert, orbOnPrice, type OrbSettings, type OrbState } from './orb';
import { derivativeSymbol } from './webhook-alert';
import { SignalService } from './signal.service';
import { WebhookService } from './webhook.service';

const TICK_MS = 1_000;
const TTL = 36 * 3600;
const BSE = new Set(['SENSEX', 'BANKEX', 'SENSEX50']);

/**
 * Runs ORB for every active strategy that has it on: builds the opening range from the
 * underlying's nearest-future price (sampled every second), buys the ATM CALL / PUT the moment price breaks it and squares
 * off at the exit time. Day state lives in Redis, so a restart neither loses the range nor repeats an entry.
 */
@Injectable()
export class OrbService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ORB');
  private timer?: NodeJS.Timeout;
  private busy = false;
  private list: Strategy[] = [];
  private listAt = 0;
  private readonly states = new Map<string, OrbState>();
  private readonly futs = new Map<string, { exchange: string; symbol: string } | null>();
  private readonly retryAt = new Map<string, number>();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly prices: PriceCacheService,
    private readonly feed: MarketFeedService,
    private readonly fno: FnoCatalogService,
    private readonly hooks: WebhookService,
    private readonly signals: SignalService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Today's ORB state of a strategy (range, entries) for the UI; null when ORB is off or nothing yet. */
  async today(strategy: Strategy): Promise<(OrbState & { future: string | null }) | null> {
    const cfg = readAutomation(strategy.automation).orb;
    if (!cfg.enabled) return null;
    const t = istNow();
    const raw = await this.redis.get(this.stateKey(strategy.id, t.date, cfg));
    const fut = this.futs.get(`${t.date}:${cfg.underlying}`);
    return raw ? { ...(JSON.parse(raw) as OrbState), future: fut ? `${fut.exchange}:${fut.symbol}` : null } : null;
  }

  async tick(now = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (Date.now() - this.listAt > 30_000) {
        const all = await this.prisma.strategy.findMany({ where: { status: 'ACTIVE', automation: { not: Prisma.AnyNull } } });
        this.list = all.filter((st) => readAutomation(st.automation).orb.enabled);
        this.listAt = Date.now();
      }
      const t = istNow(now);
      if (t.weekday < 1 || t.weekday > 5 || t.hhmm < '09:14') return;
      const sec = Math.floor((now.getTime() - t.dayStart.getTime()) / 1000);
      for (const st of this.list) {
        try {
          await this.run(st, readAutomation(st.automation).orb, t, sec);
        } catch (err) {
          this.logger.warn(`${st.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`Tick: ${(err as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  private stateKey(strategyId: string, date: string, cfg: OrbSettings): string {
    return `ctp:auto:orb:${strategyId}:${date}:${cfg.underlying}:${cfg.rangeMinutes}`;
  }

  private async run(st: Strategy, cfg: OrbSettings, t: ReturnType<typeof istNow>, sec: number): Promise<void> {
    const key = this.stateKey(st.id, t.date, cfg);

    // Time exit: squares off what ORB entered today.
    if (isDue(cfg.exitTime, t.hhmm)) {
      if ((await this.redis.set(`${key}:out`, '1', 'EX', TTL, 'NX')) === 'OK') await this.exitOwn(st, key, `ORB ${cfg.exitTime}`, 'Time exit');
      return;
    }
    if (t.hhmm > cfg.exitTime) return;

    const fut = await this.future(cfg.underlying, t.date);
    if (!fut) return;
    const price = this.prices.get(instrumentKey(fut.exchange, fut.symbol), 5_000);
    if (price == null) return;

    let state = this.states.get(key);
    if (!state) {
      const raw = await this.redis.get(key);
      state = raw ? (JSON.parse(raw) as OrbState) : newOrbState();
    }
    const { state: next, events } = orbOnPrice(state, cfg, sec, price);
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      // Saved before acting on an entry, so a crash after this line never repeats it.
      await this.redis.set(key, JSON.stringify(next), 'EX', TTL);
    }
    this.states.set(key, next);

    for (const e of events) {
      if (e.type === 'RANGE') {
        await this.hooks.logEvent(st.id, {
          ok: true,
          action: 'ORB RANGE',
          symbol: `${fut.exchange}:${fut.symbol}`,
          message: `${cfg.underlying} range 09:15 + ${cfg.rangeMinutes} min: high ${e.high}, low ${e.low}`,
        });
      } else if (e.type === 'SKIP') {
        await this.hooks.logEvent(st.id, { ok: false, action: 'ORB', symbol: null, message: `No ORB today: ${e.reason}` });
      } else {
        const label = `ORB ${e.option === 'CE' ? 'CALL' : 'PUT'}`;
        if (await this.redis.get(dailyHaltKey(st.id, t.date))) {
          await this.hooks.logEvent(st.id, { ok: false, action: label, symbol: null, message: 'Breakout skipped: daily limit already reached' });
          continue;
        }
        // A breakout to the other side closes the ORB's open position first.
        if (next.entries > 1) await this.exitOwn(st, key, label, 'Reversal');
        const tradeIds: string[] = [];
        const sym = await this.hooks.runAlert(st, orbAlert(cfg, e.option, e.close), `${label} (price ${e.close} ${e.option === 'CE' ? 'above high' : 'below low'} ${e.level})`, { tradeIds });
        if (sym) await this.redis.multi().sadd(`${key}:syms`, sym).expire(`${key}:syms`, TTL).exec();
      }
    }
  }

  private async exitOwn(st: Strategy, key: string, action: string, what: string): Promise<void> {
    const syms = new Set(await this.redis.smembers(`${key}:syms`));
    if (!syms.size) return;
    const r = await this.signals.exitStrategyMatching(st.id, st.masterUserId, (p) => syms.has(`${p.exchange}:${p.symbol}`));
    await this.hooks.logEvent(st.id, {
      ok: !r.failed,
      action,
      symbol: null,
      message: `${what}: ${r.closed} closed${r.failed ? `, ${r.failed} failed (${r.errors.slice(0, 2).join('; ')})` : ''}`,
    });
  }

  /** Nearest future of the underlying (cached per day), subscribed on the live feed. */
  private async future(underlying: string, date: string): Promise<{ exchange: string; symbol: string } | null> {
    const k = `${date}:${underlying}`;
    if (!this.futs.get(k) && (this.retryAt.get(k) ?? 0) <= Date.now()) {
      const ex: FnoExchange = BSE.has(underlying) ? 'BFO' : 'NFO';
      const chain = await this.fno.chain(ex, underlying, 'FUT').catch(() => null);
      const near = chain?.expiries[0];
      this.futs.set(k, near ? { exchange: ex, symbol: derivativeSymbol(underlying, near.date, 'FUT', null) } : null);
      if (!near) this.retryAt.set(k, Date.now() + 30_000);
    }
    const f = this.futs.get(k) ?? null;
    if (f) this.feed.ensure(f.exchange as Exchange, f.symbol);
    return f;
  }
}
