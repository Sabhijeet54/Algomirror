import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { BrokerAccount, CopyOrder, OrderStatus, PrismaClient } from '@ctp/database';
import type Redis from 'ioredis';
import { RedisKeys, WsEvent } from '@ctp/types';
import { startOfTradingDayIST } from '../admin/admin.service';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { API_CONFIG, ApiConfig } from '../config/config.module';
import { RealtimeService } from '../realtime/realtime.gateway';
import type { BrokerAdapter, BrokerOrder } from './broker-adapter';
import { ClientRegistryService } from './client-registry.service';
import { TradingService } from './trading.service';

const PENDING: OrderStatus[] = ['SUBMITTED', 'OPEN', 'PARTIALLY_FILLED'];
const DONE = new Set<OrderStatus>(['FILLED', 'CANCELLED', 'REJECTED']);
/** Failures where the order most likely never reached the exchange — worth one more try. */
const TRANSIENT = /timeout|did not respond|could not reach|rate limit|exceeding access rate|too many|HTTP 5\d\d|non-JSON|ECONNRESET|socket/i;

/**
 * Broker execution status is the source of truth. Per follower account, one order-book read per run:
 *  1. Reconcile: record what the broker did with each pending copy order (fills, partial fills, average price,
 *     rejections, cancellations) and keep the in-memory net copy position exact:
 *       - normal copy orders are counted in full when sent → the unfilled part is removed when they finish;
 *       - mirrored SL/target orders count only when they fill → each new fill is added.
 *  2. Stale entries: a LIMIT/SL entry order still not (fully) filled after COPY_CANCEL_PENDING_ENTRY_SEC is cancelled.
 *  3. Retry queue: a copy order that FAILED with a transient error is retried (up to COPY_MAX_RETRIES, within
 *     COPY_RETRY_WINDOW_SEC). Before every retry the follower's order book is checked for an order that did reach
 *     the broker (same tag, symbol, side, qty, placed after the failed attempt) — if found it is adopted instead
 *     of placing a duplicate.
 */
@Injectable()
export class CopyReconcilerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CopyReconciler');
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly trading: TradingService,
    private readonly registry: ClientRegistryService,
    private readonly realtime: RealtimeService,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.config.COPY_RECONCILE_INTERVAL_MS;
    if (!every || this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.run(), every);
    this.logger.log(`Reconciling copy orders every ${every} ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass over today's live copy orders that are pending or retryable. Safe to call manually. */
  async run(): Promise<{ checked: number; updated: number; retried: number }> {
    const out = { checked: 0, updated: 0, retried: 0 };
    if (this.running) return out;
    this.running = true;
    try {
      const retryAfter = new Date(Date.now() - this.config.COPY_RETRY_WINDOW_SEC * 1000);
      const rows = await this.prisma.copyOrder.findMany({
        where: {
          isPaper: false,
          createdAt: { gte: startOfTradingDayIST() },
          OR: [
            { status: { in: PENDING }, brokerOrderId: { not: null } },
            { status: 'FAILED', errorCode: 'BROKER_ERROR', attempts: { lt: this.config.COPY_MAX_RETRIES }, createdAt: { gte: retryAfter } },
          ],
        },
        include: { brokerAccount: true },
        orderBy: { createdAt: 'asc' },
      });
      const byAccount = new Map<string, { account: BrokerAccount; orders: CopyOrder[] }>();
      for (const o of rows) {
        if (o.status === 'FAILED' && !TRANSIENT.test(o.errorMessage ?? '')) continue;
        const g = byAccount.get(o.brokerAccountId) ?? { account: o.brokerAccount, orders: [] };
        g.orders.push(o);
        byAccount.set(o.brokerAccountId, g);
      }
      for (const { account, orders } of byAccount.values()) {
        out.checked += orders.length;
        const r = await this.reconcileAccount(account, orders);
        out.updated += r.updated;
        out.retried += r.retried;
      }
    } catch (err) {
      this.logger.error(`Reconcile failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
    return out;
  }

  private async reconcileAccount(account: BrokerAccount, orders: CopyOrder[]): Promise<{ updated: number; retried: number }> {
    if (account.status !== 'CONNECTED') return { updated: 0, retried: 0 };
    let adapter: BrokerAdapter;
    let book: BrokerOrder[];
    try {
      adapter = await this.trading.adapterFor(account);
      book = await adapter.orders();
    } catch (err) {
      await this.trading.handleBrokerError(account, err);
      return { updated: 0, retried: 0 };
    }
    const byId = new Map(book.map((b) => [b.brokerOrderId, b]));
    const linked = new Set(orders.map((o) => o.brokerOrderId).filter(Boolean) as string[]);
    let updated = 0;
    let retried = 0;
    for (const o of orders) {
      try {
        if (o.status === 'FAILED') {
          if (await this.retry(account, adapter, o, book, linked)) retried++;
          continue;
        }
        const b = byId.get(o.brokerOrderId!);
        if (!b) continue; // not visible yet — next run
        if (await this.apply(o, b)) updated++;
        await this.cancelIfStale(adapter, o, b);
      } catch (err) {
        this.logger.warn(`Copy order ${o.id}: ${(err as Error).message}`);
      }
    }
    return { updated, retried };
  }

  // ------------------------------------------------------------ 1. reconcile

  private async apply(o: CopyOrder, b: BrokerOrder): Promise<boolean> {
    const status: OrderStatus = b.status === 'OPEN' && b.filledQuantity > 0 ? 'PARTIALLY_FILLED' : b.status === 'UNKNOWN' ? o.status : b.status;
    if (status === o.status && b.filledQuantity === o.filledQuantity) return false;
    const done = DONE.has(status);
    await this.prisma.copyOrder.update({
      where: { id: o.id },
      data: {
        status,
        filledQuantity: b.filledQuantity,
        averagePrice: b.averagePrice ?? undefined,
        filledAt: status === 'FILLED' ? new Date() : undefined,
        errorCode: status === 'REJECTED' ? 'BROKER_REJECTED' : status === 'CANCELLED' ? 'CANCELLED' : o.errorCode,
        errorMessage: status === 'REJECTED' || status === 'CANCELLED' ? (b.statusMessage ?? status).slice(0, 500) : o.errorMessage,
      },
    });
    const sign = o.side === 'BUY' ? 1 : -1;
    if (o.mirrored) {
      // Mirrored SL/target: add only what newly filled.
      const delta = b.filledQuantity - o.filledQuantity;
      if (delta > 0) this.registry.applyClientFill(o.strategyFollowerId, o.exchange, o.symbol, o.productType, sign * delta);
    } else if (done) {
      // Normal copy order: was counted in full when sent — remove the part that never executed.
      const unfilled = o.quantity - b.filledQuantity;
      if (unfilled > 0) this.registry.applyClientFill(o.strategyFollowerId, o.exchange, o.symbol, o.productType, -sign * unfilled);
    }
    if (done && status !== 'FILLED') this.logger.warn(`Copy order ${o.brokerOrderId} ${status}: ${b.filledQuantity}/${o.quantity} — ${b.statusMessage ?? ''}`);
    const event = status === 'FILLED' ? WsEvent.COPY_ORDER_FILLED : done ? WsEvent.COPY_ORDER_FAILED : WsEvent.POSITION_UPDATED;
    this.realtime.toUser(o.followerUserId, event, {
      copyOrderId: o.id,
      symbol: o.symbol,
      side: o.side,
      qty: o.quantity,
      filledQty: b.filledQuantity,
      averagePrice: b.averagePrice,
      status,
      error: done && status !== 'FILLED' ? (b.statusMessage ?? null) : null,
    });
    return true;
  }

  // ------------------------------------------------------------ 2. stale pending entries

  private async cancelIfStale(adapter: BrokerAdapter, o: CopyOrder, b: BrokerOrder): Promise<void> {
    const maxAge = this.config.COPY_CANCEL_PENDING_ENTRY_SEC;
    if (!maxAge || o.isExit || o.mirrored || o.orderType === 'MARKET') return;
    if (b.status !== 'OPEN') return;
    const since = (o.submittedAt ?? o.createdAt).getTime();
    if (Date.now() - since < maxAge * 1000) return;
    await adapter.cancelOrder(o.brokerOrderId!, o.orderType);
    this.logger.log(`Cancelled stale entry ${o.brokerOrderId} (${b.filledQuantity}/${o.quantity} filled after ${maxAge}s)`);
    // The next run records CANCELLED and removes the unfilled part from the net position.
  }

  // ------------------------------------------------------------ 3. retry queue

  private async retry(account: BrokerAccount, adapter: BrokerAdapter, o: CopyOrder, book: BrokerOrder[], linked: Set<string>): Promise<boolean> {
    if (this.trading.isSimulated(account)) return false;
    if (await this.redis.get(RedisKeys.copyHalted)) return false; // kill switch
    const sign = o.side === 'BUY' ? 1 : -1;
    if (o.isExit) {
      // Never exit more than the follower still holds.
      const net = this.registry.clientNet(o.strategyFollowerId, o.exchange, o.symbol, o.productType);
      if (net === 0 || Math.sign(net) === sign) {
        await this.prisma.copyOrder.update({ where: { id: o.id }, data: { attempts: this.config.COPY_MAX_RETRIES, errorMessage: 'Retry skipped: no open copy position left' } });
        return false;
      }
    }
    // Duplicate check: did the "failed" attempt actually reach the broker?
    const after = (o.lastAttemptAt ?? o.createdAt).getTime() - 5_000;
    const dup = book.find(
      (b) =>
        !linked.has(b.brokerOrderId) &&
        (b.tag ?? '').startsWith('ctp') &&
        b.symbol === o.symbol &&
        b.exchange === o.exchange &&
        b.side === o.side &&
        b.quantity === o.quantity &&
        b.timestamp.getTime() >= after,
    );
    if (dup) {
      linked.add(dup.brokerOrderId);
      await this.prisma.copyOrder.update({
        where: { id: o.id },
        data: { status: 'SUBMITTED', brokerOrderId: dup.brokerOrderId, errorCode: null, errorMessage: 'Recovered: order had reached the broker', submittedAt: new Date() },
      });
      this.registry.applyClientFill(o.strategyFollowerId, o.exchange, o.symbol, o.productType, sign * o.quantity);
      this.logger.log(`Copy order ${o.id}: found at broker as ${dup.brokerOrderId} — no retry needed`);
      return true;
    }
    const attempts = o.attempts + 1;
    try {
      const { brokerOrderId } = await adapter.placeOrder({
        exchange: o.exchange,
        symbol: o.symbol,
        side: o.side,
        quantity: o.quantity,
        orderType: o.orderType,
        productType: o.productType,
        price: o.price == null ? null : Number(o.price),
        triggerPrice: o.triggerPrice == null ? null : Number(o.triggerPrice),
        tag: 'ctpcopy',
      });
      linked.add(brokerOrderId);
      await this.prisma.copyOrder.update({
        where: { id: o.id },
        data: { status: 'SUBMITTED', brokerOrderId, attempts, lastAttemptAt: new Date(), submittedAt: new Date(), errorCode: null, errorMessage: `Placed on retry ${attempts}` },
      });
      this.registry.applyClientFill(o.strategyFollowerId, o.exchange, o.symbol, o.productType, sign * o.quantity);
      this.realtime.toUser(o.followerUserId, WsEvent.COPY_ORDER_SUBMITTED, { copyOrderId: o.id, symbol: o.symbol, side: o.side, qty: o.quantity, status: 'SUBMITTED', retry: attempts });
      this.logger.log(`Copy order ${o.id} placed on retry ${attempts}: ${brokerOrderId}`);
      return true;
    } catch (err) {
      const msg = (err as Error).message.slice(0, 500);
      await this.prisma.copyOrder.update({
        where: { id: o.id },
        // A non-transient error ends the retries.
        data: { attempts: TRANSIENT.test(msg) ? attempts : this.config.COPY_MAX_RETRIES, lastAttemptAt: new Date(), errorMessage: msg },
      });
      if (this.trading.isSessionError(err)) await this.trading.handleBrokerError(account, err).catch(() => undefined);
      return false;
    }
  }
}
