import { BadRequestException, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { Prisma } from '@ctp/database';
import type { MasterTrade, PrismaClient, Strategy } from '@ctp/database';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { API_CONFIG, type ApiConfig } from '../config/config.module';
import { instrumentKey, PriceCacheService } from '../market-data/price-cache.service';
import {
  AutomationError,
  dailyHaltKey,
  dailyLimitHit,
  dayPnl,
  isDue,
  istNow,
  legAlert,
  normalizeAutomation,
  normalizeSchedules,
  readAutomation,
  type AutomationSettings,
  type Schedule,
} from './automation';
import { SignalService, type SignalExitReason } from './signal.service';
import { WebhookService } from './webhook.service';

const D = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));
const TICK_MS = 5_000;

/**
 * Runs the strategy automation: timed entry / exit (IST), the strategy daily max loss / profit and re-entry
 * after a stop loss. Trailing stop loss runs in the signal watcher; Chartink in the webhook service.
 */
@Injectable()
export class AutomationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Automation');
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private cache: Strategy[] = [];
  private cacheAt = 0;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly signals: SignalService,
    private readonly hooks: WebhookService,
    private readonly prices: PriceCacheService,
  ) {}

  onApplicationBootstrap(): void {
    this.signals.onExit((sig, reason) => void this.onSignalExit(sig, reason));
    if (this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------ settings

  get(strategy: Strategy): AutomationSettings {
    return readAutomation(strategy.automation);
  }

  /** Saves the strategy's settings. Schedules are kept as they are unless the body sends "schedules". */
  async save(strategy: Strategy, input: unknown): Promise<AutomationSettings> {
    let s: AutomationSettings;
    try {
      const body = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const keep = !('schedules' in body) ? { schedules: readAutomation(strategy.automation).schedules } : {};
      s = normalizeAutomation({ ...body, schedule: undefined, ...keep });
    } catch (err) {
      if (err instanceof AutomationError) throw new BadRequestException(err.message);
      throw err;
    }
    await this.prisma.strategy.update({
      where: { id: strategy.id },
      data: { automation: s as unknown as Prisma.InputJsonValue },
    });
    this.cacheAt = 0;
    return s;
  }

  /** Every schedule of the master's strategies, flat, with the strategy each one trades in. */
  async listSchedules(masterUserId: string): Promise<(Schedule & { strategyId: string; strategyName: string; strategyStatus: string })[]> {
    const strategies = await this.prisma.strategy.findMany({ where: { masterUserId }, orderBy: { createdAt: 'asc' } });
    return strategies.flatMap((st) => readAutomation(st.automation).schedules.map((s) => ({ ...s, strategyId: st.id, strategyName: st.name, strategyStatus: st.status })));
  }

  /**
   * Saves the master's whole schedule list: each schedule goes into the strategy it names (moving a schedule to
   * another strategy moves it); strategies left without schedules get none. Other automation settings are kept.
   */
  async saveSchedules(masterUserId: string, input: unknown) {
    const list = Array.isArray((input as { schedules?: unknown })?.schedules) ? ((input as { schedules: unknown[] }).schedules as unknown[]) : null;
    if (!list) throw new BadRequestException('Send { schedules: [...] }');
    const strategies = await this.prisma.strategy.findMany({ where: { masterUserId } });
    const own = new Map(strategies.map((st) => [st.id, st]));
    const groups = new Map<string, unknown[]>();
    for (const raw of list) {
      const id = String((raw as { strategyId?: unknown })?.strategyId ?? '');
      if (!own.has(id)) throw new BadRequestException('Pick a strategy for every schedule');
      groups.set(id, [...(groups.get(id) ?? []), raw]);
    }
    const next = new Map<string, AutomationSettings>();
    try {
      for (const st of strategies) {
        const cur = readAutomation(st.automation);
        const schedules = normalizeSchedules(groups.get(st.id) ?? []);
        if (!cur.schedules.length && !schedules.length) continue;
        next.set(st.id, { ...cur, schedules });
      }
    } catch (err) {
      if (err instanceof AutomationError) throw new BadRequestException(err.message);
      throw err;
    }
    await this.prisma.$transaction([...next].map(([id, a]) => this.prisma.strategy.update({ where: { id }, data: { automation: a as unknown as Prisma.InputJsonValue } })));
    this.cacheAt = 0;
    return this.listSchedules(masterUserId);
  }

  /** Today's P&L of the strategy and whether new entries are stopped for the day. */
  async today(strategyId: string): Promise<{ pnl: number; halted: boolean }> {
    const t = istNow();
    return {
      pnl: await this.strategyPnl(strategyId, t.dayStart),
      halted: !!(await this.redis.get(dailyHaltKey(strategyId, t.date))),
    };
  }

  // ------------------------------------------------------------ loop

  async tick(now = new Date()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (Date.now() - this.cacheAt > 30_000) {
        this.cache = await this.prisma.strategy.findMany({
          where: { status: 'ACTIVE', automation: { not: Prisma.AnyNull } },
        });
        this.cacheAt = Date.now();
      }
      const t = istNow(now);
      for (const st of this.cache) {
        const a = readAutomation(st.automation);
        try {
          await this.runSchedule(st, a, t);
          await this.checkDailyLimit(st, a, t);
        } catch (err) {
          this.logger.warn(`${st.name}: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.logger.warn(`Tick: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  private async runSchedule(st: Strategy, a: AutomationSettings, t: ReturnType<typeof istNow>): Promise<void> {
    for (const s of a.schedules) {
      if (s.enabled && s.days.includes(t.weekday)) await this.runOneSchedule(st, s, t);
    }
  }

  /**
   * One schedule: at the entry time its legs are traded (the contracts are remembered for the day); at the exit
   * time only those contracts are squared off — other schedules and alerts of the strategy are not touched.
   */
  private async runOneSchedule(st: Strategy, s: Schedule, t: ReturnType<typeof istNow>): Promise<void> {
    const base = `ctp:auto:sched:${st.id}:${t.date}:${s.id}`;
    const label = `${s.name} ${s.entryTime}`;
    if (isDue(s.entryTime, t.hhmm) && (await this.once(`${base}:in`))) {
      if (await this.redis.get(dailyHaltKey(st.id, t.date))) {
        await this.hooks.logEvent(st.id, { ok: false, action: label, symbol: null, message: 'Timed entry skipped — daily limit already reached' });
      } else {
        this.logger.log(`${st.name}: ${label} (${s.legs.length} legs)`);
        const placed: string[] = [];
        for (const leg of s.legs) {
          const sym = await this.hooks.runAlert(st, legAlert(leg, s), label);
          if (sym) placed.push(sym);
        }
        if (placed.length) await this.redis.multi().sadd(`${base}:syms`, ...placed).expire(`${base}:syms`, 36 * 3600).exec();
      }
    }
    if (s.exitTime && isDue(s.exitTime, t.hhmm) && (await this.once(`${base}:out`))) {
      const syms = new Set(await this.redis.smembers(`${base}:syms`));
      const action = `${s.name} ${s.exitTime}`;
      if (!syms.size) {
        await this.hooks.logEvent(st.id, { ok: true, action, symbol: null, message: 'Timed exit: nothing was entered by this schedule today' });
        return;
      }
      const r = await this.signals.exitStrategyMatching(st.id, st.masterUserId, (p) => syms.has(`${p.exchange}:${p.symbol}`));
      await this.hooks.logEvent(st.id, {
        ok: !r.failed,
        action,
        symbol: null,
        message: `Timed exit: ${r.closed} closed${r.failed ? `, ${r.failed} failed (${r.errors.slice(0, 2).join('; ')})` : ''}`,
      });
    }
  }

  private async checkDailyLimit(st: Strategy, a: AutomationSettings, t: ReturnType<typeof istNow>): Promise<void> {
    if (a.daily.maxLoss == null && a.daily.maxProfit == null) return;
    const key = dailyHaltKey(st.id, t.date);
    if (await this.redis.get(key)) return;
    const pnl = await this.strategyPnl(st.id, t.dayStart);
    const hit = dailyLimitHit(pnl, a.daily);
    if (!hit) return;
    if ((await this.redis.set(key, hit, 'EX', 36 * 3600, 'NX')) !== 'OK') return;
    this.logger.warn(`${st.name}: daily max ${hit.toLowerCase()} hit (P&L ${pnl}) — exiting all`);
    const r = await this.signals.squareOffStrategy(st.id, st.masterUserId);
    await this.hooks.logEvent(st.id, {
      ok: !r.failed,
      action: 'DAILY LIMIT',
      symbol: null,
      message: `Daily max ${hit === 'LOSS' ? 'loss' : 'profit'} reached (P&L ${pnl}): ${r.closed} closed, no new trades today${r.failed ? `; ${r.failed} failed` : ''}`,
    });
  }

  /** Realized + open P&L (master quantity) of the strategy's signals of the IST day. */
  private async strategyPnl(strategyId: string, dayStart: Date): Promise<number> {
    const rows = await this.prisma.masterTrade.findMany({
      where: {
        strategyId,
        OR: [{ signalStatus: 'OPEN' }, { signalStatus: 'CLOSED', exitedAt: { gte: dayStart } }],
      },
      select: {
        side: true,
        exchange: true,
        symbol: true,
        price: true,
        averagePrice: true,
        quantity: true,
        filledQuantity: true,
        closedQuantity: true,
        realizedPnl: true,
      },
    });
    return dayPnl(
      rows.map((r) => {
        const size = r.filledQuantity > 0 ? r.filledQuantity : r.quantity;
        return {
          side: r.side,
          entry: D(r.averagePrice) ?? D(r.price),
          openQty: size - r.closedQuantity,
          realizedPnl: D(r.realizedPnl) ?? 0,
          ltp: this.prices.get(instrumentKey(r.exchange, r.symbol)) ?? null,
        };
      }),
    );
  }

  // ------------------------------------------------------------ re-entry

  private async onSignalExit(sig: MasterTrade, reason: SignalExitReason): Promise<void> {
    if (reason !== 'STOPLOSS' || !sig.strategyId) return;
    try {
      const st = await this.prisma.strategy.findUnique({
        where: { id: sig.strategyId },
      });
      if (!st || st.status !== 'ACTIVE') return;
      const a = readAutomation(st.automation);
      if (!a.reentry.enabled || sig.reentryCount >= a.reentry.max) return;
      const t = istNow();
      // No re-entry once the last timed exit of the strategy for today has passed.
      const exits = a.schedules.filter((x) => x.enabled && x.exitTime && x.days.includes(t.weekday)).map((x) => x.exitTime!);
      if (exits.length && t.hhmm >= exits.sort().at(-1)!) return;
      if (await this.redis.get(dailyHaltKey(st.id, t.date))) return;
      if (!(await this.once(`ctp:auto:reentry:${sig.id}`))) return;
      // Same trade again at MARKET, with the same target / stop loss distance from the new entry.
      const entry = D(sig.averagePrice) ?? D(sig.price);
      const tp = D(sig.targetPrice);
      const sl = D(sig.stopLossPrice);
      const trail = D(sig.trailPoints);
      // A trailed stop loss moved together with its anchor, so anchor − stop loss is still the original distance.
      const from = (trail ? D(sig.trailAnchor) : null) ?? entry;
      const slDist = from != null && sl != null ? Math.abs(from - sl) : null;
      const tpDist = entry != null && tp != null ? Math.abs(tp - entry) : null;
      const n = sig.reentryCount + 1;
      await this.hooks.runAlert(
        st,
        {
          action: sig.side,
          exchange: sig.exchange,
          symbol: sig.symbol,
          qty: sig.filledQuantity > 0 ? sig.filledQuantity : sig.quantity,
          product: sig.productType,
          ...(tpDist ? { targetPoints: tpDist } : {}),
          ...(slDist ? { stoplossPoints: slDist } : {}),
          ...(trail ? { trailPoints: trail } : {}),
        },
        `RE-ENTRY ${n}/${a.reentry.max}`,
        { reentryCount: n },
      );
    } catch (err) {
      this.logger.warn(`Re-entry of ${sig.symbol}: ${(err as Error).message}`);
    }
  }

  /** true the first time a key is claimed (across restarts / instances). */
  private async once(key: string): Promise<boolean> {
    return (await this.redis.set(key, '1', 'EX', 36 * 3600, 'NX')) === 'OK';
  }
}
