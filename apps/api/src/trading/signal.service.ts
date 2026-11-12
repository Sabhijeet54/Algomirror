import { BadRequestException, Inject, Injectable, Logger, NotFoundException, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import { Prisma } from '@ctp/database';
import type { Exchange, MasterTrade, PrismaClient, ProductType } from '@ctp/database';
import { generateToken } from '@ctp/shared';
import { WsEvent } from '@ctp/types';
import { AuditService } from '../audit/audit.service';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { API_CONFIG, ApiConfig } from '../config/config.module';
import { MarketFeedService } from '../market-data/market-feed.service';
import { instrumentKey, PriceCacheService } from '../market-data/price-cache.service';
import { RealtimeService } from '../realtime/realtime.gateway';
import { ClientRegistryService } from './client-registry.service';
import { CopyEngineService } from './copy-engine.service';

const D = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));
/** signalStatus of a signal removed from trade history by an admin. */
const DELETED = 'DELETED';
export type SignalExitReason = 'TARGET' | 'STOPLOSS' | 'SQUARE_OFF' | 'STRATEGY_EXIT' | 'AUTO_SQUARE_OFF' | 'KILL_SWITCH';

/**
 * Per-signal lifecycle for master signals placed from the platform:
 *   - square off ONE signal → the master's signal position and every follower's copy of it are exited (MARKET);
 *   - target / stop loss per signal, watched every second on the live LTP; the first level hit squares it off;
 *   - strategy exit squares off every open signal of the strategy (and so moves it to history).
 * Exits go through the copy engine as an opposite signal, so followers exit exactly like a master exit:
 * never more than they hold, idempotent, recorded as copy orders.
 */
@Injectable()
export class SignalService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Signals');
  private timer?: NodeJS.Timeout;
  private watch: MasterTrade[] = [];
  private watchLoadedAt = 0;
  private ticking = false;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly engine: CopyEngineService,
    private readonly registry: ClientRegistryService,
    private readonly prices: PriceCacheService,
    private readonly feed: MarketFeedService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Forces the TP/SL watch list to reload on the next tick (after a new signal or a TP/SL edit). */
  refreshWatch(): void {
    this.watchLoadedAt = 0;
  }

  // ------------------------------------------------------------ queries

  /** masterUserId null = all masters (admin). */
  async list(masterUserId: string | null, opts: { status?: 'all' | 'open' | 'closed'; from?: Date; to?: Date; strategyIds?: string[] }) {
    const rows = await this.prisma.masterTrade.findMany({
      where: {
        ...(masterUserId ? { masterUserId } : {}),
        signalStatus: opts.status === 'open' ? 'OPEN' : opts.status === 'closed' ? 'CLOSED' : { in: ['OPEN', 'CLOSED'] },
        ...(opts.from || opts.to ? { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
        ...(opts.strategyIds?.length ? { strategyId: { in: opts.strategyIds } } : {}),
      },
      include: { strategy: { select: { name: true } }, master: { select: { name: true } }, copyOrders: { select: { status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    return rows.map((t) => {
      const counts: Record<string, number> = {};
      for (const c of t.copyOrders) counts[c.status] = (counts[c.status] ?? 0) + 1;
      const size = t.filledQuantity > 0 ? t.filledQuantity : t.quantity;
      if (t.signalStatus === 'OPEN') this.feed.ensure(t.exchange, t.symbol);
      return {
        id: t.id,
        strategyId: t.strategyId,
        strategyName: t.strategy?.name ?? null,
        masterName: t.master?.name ?? null,
        exchange: t.exchange,
        symbol: t.symbol,
        side: t.side,
        productType: t.productType,
        quantity: size,
        openQuantity: size - t.closedQuantity,
        entryPrice: D(t.averagePrice) ?? D(t.price),
        entryAt: t.createdAt.toISOString(),
        exitPrice: D(t.exitPrice),
        exitAt: t.exitedAt?.toISOString() ?? null,
        exitReason: t.exitReason,
        targetPrice: D(t.targetPrice),
        stopLossPrice: D(t.stopLossPrice),
        status: t.signalStatus as 'OPEN' | 'CLOSED',
        realizedPnl: D(t.realizedPnl) ?? 0,
        ltp: this.prices.get(instrumentKey(t.exchange, t.symbol)) ?? null,
        copyStatusCounts: counts,
      };
    });
  }

  private async getOwned(masterUserId: string | null, id: string): Promise<MasterTrade> {
    const sig = await this.prisma.masterTrade.findUnique({ where: { id } });
    if (!sig || !sig.signalStatus || sig.signalStatus === DELETED || (masterUserId && sig.masterUserId !== masterUserId)) throw new NotFoundException('Signal not found');
    return sig;
  }

  // ------------------------------------------------------------ admin corrections (trade history)

  /**
   * Admin correction of one signal in trade history: entry / exit price and quantity. Realized P&L of the
   * exited quantity is recomputed. Client copy orders are NOT changed (they are the real broker fills).
   */
  async edit(id: string, dto: { entryPrice?: number; exitPrice?: number; quantity?: number }, actorUserId: string, masterUserId: string | null = null) {
    const sig = await this.getOwned(masterUserId, id);
    const entry = dto.entryPrice ?? D(sig.averagePrice) ?? D(sig.price);
    const size = dto.quantity ?? (sig.filledQuantity > 0 ? sig.filledQuantity : sig.quantity);
    const closedQty = Math.min(sig.closedQuantity, size);
    if (dto.exitPrice != null && closedQty <= 0) throw new BadRequestException('This signal has no exit yet — square it off first.');
    const exit = dto.exitPrice ?? D(sig.exitPrice);
    const dir = sig.side === 'BUY' ? 1 : -1;
    const pnl = entry != null && exit != null && closedQty > 0 ? (exit - entry) * closedQty * dir : D(sig.realizedPnl);
    await this.prisma.masterTrade.update({
      where: { id },
      data: {
        ...(dto.entryPrice != null ? { averagePrice: dto.entryPrice } : {}),
        ...(dto.exitPrice != null ? { exitPrice: dto.exitPrice } : {}),
        ...(dto.quantity != null ? { quantity: dto.quantity, filledQuantity: dto.quantity, closedQuantity: closedQty } : {}),
        ...(dto.quantity != null && closedQty >= dto.quantity && sig.signalStatus === 'OPEN' ? { signalStatus: 'CLOSED', exitedAt: sig.exitedAt ?? new Date() } : {}),
        realizedPnl: pnl,
      },
    });
    await this.audit.log({
      action: 'STRATEGY_UPDATED',
      actorUserId,
      targetType: 'MasterTrade',
      targetId: id,
      metadata: { signalEdited: true, before: { entry: D(sig.averagePrice), exit: D(sig.exitPrice), qty: sig.quantity }, after: dto },
    });
    this.refreshWatch();
    return { id, realizedPnl: pnl };
  }

  /** Removes one signal from trade history / performance (soft delete). Open signals must be squared off first. */
  async remove(id: string, actorUserId: string, masterUserId: string | null = null) {
    const sig = await this.getOwned(masterUserId, id);
    if (sig.signalStatus === 'OPEN') throw new BadRequestException('Square off this signal before deleting it.');
    await this.prisma.masterTrade.update({ where: { id }, data: { signalStatus: DELETED } });
    await this.audit.log({ action: 'STRATEGY_UPDATED', actorUserId, targetType: 'MasterTrade', targetId: id, metadata: { signalDeleted: true, symbol: sig.symbol } });
    return { id, deleted: true };
  }

  // ------------------------------------------------------------ target / stop loss

  async setTpSl(masterUserId: string | null, id: string, targetPrice: number | null, stopLossPrice: number | null) {
    const sig = await this.getOwned(masterUserId, id);
    if (sig.signalStatus !== 'OPEN') throw new BadRequestException('This signal is already closed');
    const entry = D(sig.averagePrice) ?? D(sig.price);
    const ltp = this.prices.get(instrumentKey(sig.exchange, sig.symbol)) ?? entry;
    const buy = sig.side === 'BUY';
    if (targetPrice != null && stopLossPrice != null && (buy ? targetPrice <= stopLossPrice : targetPrice >= stopLossPrice)) {
      throw new BadRequestException(buy ? 'For a BUY, target must be above stop loss' : 'For a SELL, target must be below stop loss');
    }
    if (ltp != null) {
      if (targetPrice != null && (buy ? targetPrice <= ltp : targetPrice >= ltp)) throw new BadRequestException(`Target is already crossed (LTP ${ltp})`);
      if (stopLossPrice != null && (buy ? stopLossPrice >= ltp : stopLossPrice <= ltp)) throw new BadRequestException(`Stop loss is already crossed (LTP ${ltp})`);
    }
    await this.prisma.masterTrade.update({ where: { id }, data: { targetPrice, stopLossPrice } });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: masterUserId ?? sig.masterUserId, targetType: 'MasterTrade', targetId: id, metadata: { targetPrice, stopLossPrice } });
    this.refreshWatch();
    this.realtime.toUser(sig.masterUserId, WsEvent.MASTER_TRADE_DETECTED, { signalId: id, tpsl: true });
    return { id, targetPrice, stopLossPrice };
  }

  // ------------------------------------------------------------ square off

  /**
   * Exits ONE signal for the master and all followers at MARKET. Safe against double clicks and against the
   * TP/SL watcher firing at the same moment (Redis lock + idempotent exit id).
   */
  async squareOff(masterUserId: string | null, id: string, reason: SignalExitReason, actorUserId?: string) {
    const lock = `ctp:sigexit:${id}`;
    if ((await this.redis.set(lock, '1', 'EX', 30, 'NX')) !== 'OK') throw new BadRequestException('Exit already in progress for this signal');
    try {
      const sig = await this.getOwned(masterUserId, id);
      if (sig.signalStatus !== 'OPEN' || !sig.strategyId) throw new BadRequestException('This signal is already closed');
      const size = sig.filledQuantity > 0 ? sig.filledQuantity : sig.quantity;
      const remaining = size - sig.closedQuantity;
      const key = instrumentKey(sig.exchange, sig.symbol);
      const price = this.prices.get(key) ?? null;
      const entry = D(sig.averagePrice) ?? D(sig.price);
      const exitPx = price ?? entry; // no live price: exit at entry (paper) — real follower orders are MARKET anyway
      const exitSide = sig.side === 'BUY' ? 'SELL' : 'BUY';

      // Master's signal net position: exiting more than it holds would OPEN a reverse position.
      const net = this.registry.masterNetOf(sig.strategyId, sig.exchange, sig.symbol, sig.productType);
      const holds = net !== 0 && Math.sign(net) === (sig.side === 'BUY' ? 1 : -1) ? Math.abs(net) : 0;
      const qty = Math.min(remaining, holds);

      if (qty > 0) {
        const account = await this.prisma.brokerAccount.findUnique({ where: { id: sig.brokerAccountId } });
        if (account && price != null && (account.mode === 'DATA_ONLY' || account.isPaper || account.broker === 'MOCK' || this.config.PAPER_MODE)) {
          // Master's own (virtual) signal book.
          await this.engine.applyPaperFill(sig.masterUserId, sig.brokerAccountId, { ...sig, side: exitSide }, qty, price).catch(() => undefined);
        }
        await this.engine.onMasterTrade(
          { id: sig.strategyId, masterUserId: sig.masterUserId },
          { id: sig.brokerAccountId, broker: sig.broker },
          {
            brokerOrderId: `SQ-${sig.id}-${sig.closedQuantity}-${generateToken(4)}`,
            exchange: sig.exchange,
            symbol: sig.symbol,
            side: exitSide,
            quantity: qty,
            filledQuantity: qty,
            orderType: 'MARKET',
            productType: sig.productType,
            price: exitPx,
            averagePrice: exitPx,
            status: 'FILLED',
            timestamp: new Date(),
            closeSignalId: sig.id,
            exitReason: reason,
          },
        );
      }
      // Anything the engine could not attribute (no master net left) is closed on the record only.
      const after = await this.prisma.masterTrade.findUnique({ where: { id } });
      if (after && after.signalStatus === 'OPEN') {
        const q = size - after.closedQuantity;
        const dir = sig.side === 'BUY' ? 1 : -1;
        await this.prisma.masterTrade.update({
          where: { id },
          data: {
            signalStatus: 'CLOSED',
            closedQuantity: size,
            exitPrice: D(after.exitPrice) ?? exitPx ?? undefined,
            exitedAt: new Date(),
            exitReason: reason,
            realizedPnl: (D(after.realizedPnl) ?? 0) + (exitPx != null && entry != null ? q * (exitPx - entry) * dir : 0),
          },
        });
      }
      await this.audit.log({
        action: 'MASTER_TRADE_DETECTED',
        actorUserId: actorUserId ?? sig.masterUserId,
        targetType: 'MasterTrade',
        targetId: id,
        metadata: { signalExit: reason, symbol: sig.symbol, quantity: remaining, price: exitPx },
      });
      this.refreshWatch();
      this.realtime.toUser(sig.masterUserId, WsEvent.MASTER_TRADE_DETECTED, { signalId: id, closed: true, reason });
      this.logger.log(`Signal ${sig.symbol} ${sig.side} ${remaining} closed (${reason}) @ ${exitPx ?? '—'}`);
      return { id, reason, exitPrice: exitPx, quantity: remaining };
    } finally {
      await this.redis.del(lock).catch(() => undefined);
    }
  }

  /**
   * Strategy exit: squares off every open signal, then exits whatever master position of the strategy is still
   * left (e.g. trades placed before signal tracking existed) — for the master's signal book AND all followers.
   */
  async squareOffStrategy(strategyId: string, actorUserId: string): Promise<{ closed: number; failed: number; errors: string[] }> {
    const out = await this.squareOffWhere({ strategyId, signalStatus: 'OPEN' }, 'STRATEGY_EXIT', actorUserId);
    const strategy = await this.prisma.strategy.findUnique({ where: { id: strategyId } });
    if (!strategy) return out;
    for (const p of this.registry.masterPositions(strategyId)) {
      try {
        if (await this.exitMasterNet(strategy.id, strategy.masterUserId, p, 'STRATEGY_EXIT')) out.closed++;
      } catch (err) {
        out.failed++;
        out.errors.push(`${p.symbol}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Strategy-scoped exit (automation): squares off this strategy's open signals whose instrument matches, then
   * any untracked net position of the strategy that matches. Other strategies of the master are not touched.
   */
  async exitStrategyMatching(
    strategyId: string,
    actorUserId: string,
    match: (p: { exchange: Exchange; symbol: string }) => boolean,
  ): Promise<{ closed: number; failed: number; errors: string[] }> {
    const open = await this.prisma.masterTrade.findMany({ where: { strategyId, signalStatus: 'OPEN' }, select: { id: true, exchange: true, symbol: true } });
    const ids = open.filter((o) => match(o)).map((o) => o.id);
    const out = ids.length ? await this.squareOffWhere({ id: { in: ids } }, 'SQUARE_OFF', actorUserId) : { closed: 0, failed: 0, errors: [] as string[] };
    const strategy = await this.prisma.strategy.findUnique({ where: { id: strategyId } });
    if (!strategy) return out;
    for (const p of this.registry.masterPositions(strategyId)) {
      if (!match(p)) continue;
      try {
        if (await this.exitMasterNet(strategy.id, strategy.masterUserId, p, 'SQUARE_OFF')) out.closed++;
      } catch (err) {
        out.failed++;
        out.errors.push(`${p.symbol}: ${(err as Error).message}`);
      }
    }
    this.refreshWatch();
    return out;
  }

  /**
   * "Exit" on one row of the master's signal book: squares off every open signal of that instrument (each one
   * separately, for master + followers), exits any untracked remainder through the copy engine, and finally
   * closes whatever is still left in the master's virtual book at LTP. Other instruments are not touched.
   */
  async exitBookPosition(masterUserId: string, pos: { exchange: Exchange; symbol: string; productType: ProductType }) {
    const open = await this.prisma.masterTrade.findMany({
      where: { masterUserId, exchange: pos.exchange, symbol: pos.symbol, productType: pos.productType, signalStatus: 'OPEN' },
      orderBy: { createdAt: 'asc' },
    });
    let signals = 0;
    for (const s of open) {
      await this.squareOff(masterUserId, s.id, 'SQUARE_OFF', masterUserId);
      signals++;
    }
    const strategies = await this.prisma.strategy.findMany({ where: { masterUserId }, select: { id: true } });
    for (const st of strategies) {
      const net = this.registry.masterNetOf(st.id, pos.exchange, pos.symbol, pos.productType);
      if (net) await this.exitMasterNet(st.id, masterUserId, { ...pos, qty: net }, 'SQUARE_OFF');
    }
    // Anything still in the virtual book (e.g. from before a restart) is closed on the book only.
    const left = await this.prisma.position.findFirst({
      where: { userId: masterUserId, isPaper: true, exchange: pos.exchange, symbol: pos.symbol, productType: pos.productType, quantity: { not: 0 } },
    });
    if (left) {
      const price = this.prices.get(instrumentKey(pos.exchange, pos.symbol)) ?? Number(left.lastPrice ?? left.averagePrice);
      await this.engine.applyPaperFill(masterUserId, left.brokerAccountId, { ...left, side: left.quantity > 0 ? 'SELL' : 'BUY' }, Math.abs(left.quantity), price);
    }
    this.refreshWatch();
    this.realtime.toUser(masterUserId, WsEvent.MASTER_TRADE_DETECTED, { symbol: pos.symbol, closed: true });
    return { signalsClosed: signals, symbol: pos.symbol };
  }

  /** Exits a master net position of one strategy through the copy engine (followers exit too) and books it in the master's virtual book. */
  private async exitMasterNet(
    strategyId: string,
    masterUserId: string,
    p: { exchange: Exchange; symbol: string; productType: ProductType; qty: number },
    reason: SignalExitReason,
  ): Promise<boolean> {
    if (!p.qty) return false;
    const account =
      (await this.prisma.brokerAccount.findFirst({ where: { userId: masterUserId, mode: 'DATA_ONLY' }, orderBy: { createdAt: 'asc' } })) ??
      (await this.prisma.brokerAccount.findFirst({ where: { userId: masterUserId }, orderBy: { createdAt: 'asc' } }));
    if (!account) return false;
    const price = this.prices.get(instrumentKey(p.exchange, p.symbol));
    const exitSide = p.qty > 0 ? 'SELL' : 'BUY';
    const qty = Math.abs(p.qty);
    if (price != null) {
      await this.engine.applyPaperFill(masterUserId, account.id, { exchange: p.exchange, symbol: p.symbol, productType: p.productType, side: exitSide }, qty, price).catch(() => undefined);
    }
    await this.engine.onMasterTrade(
      { id: strategyId, masterUserId },
      { id: account.id, broker: account.broker },
      {
        brokerOrderId: `SQX-${strategyId.slice(-6)}-${generateToken(6)}`,
        exchange: p.exchange,
        symbol: p.symbol,
        side: exitSide,
        quantity: qty,
        filledQuantity: qty,
        orderType: 'MARKET',
        productType: p.productType,
        price,
        averagePrice: price,
        status: 'FILLED',
        timestamp: new Date(),
        exitReason: reason,
      },
    );
    return true;
  }

  /** Auto square-off / kill switch: closes matching open signals (with the copy engine halted this only books them). */
  async squareOffWhere(where: Prisma.MasterTradeWhereInput, reason: SignalExitReason, actorUserId?: string): Promise<{ closed: number; failed: number; errors: string[] }> {
    const open = await this.prisma.masterTrade.findMany({ where: { ...where, signalStatus: 'OPEN' }, orderBy: { createdAt: 'asc' } });
    const out = { closed: 0, failed: 0, errors: [] as string[] };
    for (const s of open) {
      try {
        await this.squareOff(null, s.id, reason, actorUserId);
        out.closed++;
      } catch (err) {
        out.failed++;
        out.errors.push(`${s.symbol}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  // ------------------------------------------------------------ TP/SL watcher

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      if (Date.now() - this.watchLoadedAt > 5_000) {
        this.watch = await this.prisma.masterTrade.findMany({
          where: { signalStatus: 'OPEN', OR: [{ targetPrice: { not: null } }, { stopLossPrice: { not: null } }] },
        });
        this.watchLoadedAt = Date.now();
        for (const s of this.watch) this.feed.ensure(s.exchange, s.symbol);
      }
      const maxAge = this.config.STALE_PRICE_MAX_AGE_SEC * 1000;
      for (const s of this.watch) {
        const ltp = this.prices.get(instrumentKey(s.exchange, s.symbol), maxAge);
        if (ltp == null) continue; // never act on a stale price
        const tp = D(s.targetPrice);
        const sl = D(s.stopLossPrice);
        const buy = s.side === 'BUY';
        const hit: SignalExitReason | null =
          tp != null && (buy ? ltp >= tp : ltp <= tp) ? 'TARGET' : sl != null && (buy ? ltp <= sl : ltp >= sl) ? 'STOPLOSS' : null;
        if (!hit) continue;
        this.watch = this.watch.filter((w) => w.id !== s.id);
        this.logger.log(`${hit} hit on ${s.symbol} (LTP ${ltp})`);
        void this.squareOff(null, s.id, hit).catch((err) => this.logger.warn(`Auto ${hit} exit of ${s.symbol} failed: ${(err as Error).message}`));
      }
    } catch (err) {
      this.logger.warn(`TP/SL watcher: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }
}
