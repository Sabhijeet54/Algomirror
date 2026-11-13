import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import type { BrokerAccount, CopyOrder, OrderType, Prisma, PrismaClient, Strategy } from '@ctp/database';
import { WsEvent } from '@ctp/types';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { API_CONFIG, ApiConfig } from '../config/config.module';
import { InstrumentsService } from '../market-data/instruments.service';
import { RealtimeService } from '../realtime/realtime.gateway';
import type { BrokerAdapter, BrokerOrder } from './broker-adapter';
import { ClientRegistryService, type ClientEntry } from './client-registry.service';
import { computeCopyQuantity } from './copy-quantity';
import { TradingService } from './trading.service';

/** Set of master broker order ids that were already handled (baseline / copied). Shared with the poller. */
export const seenKey = (accountId: string) => `ctp:poll:seen:${accountId}`;
/** Hash: master broker order id → MirrorState JSON, for pending master exit orders that are mirrored. */
const mirrorKey = (accountId: string) => `ctp:mirror:${accountId}`;

interface MirrorState {
  tradeId: string;
  qty: number;
  price: number | null;
  trigger: number | null;
  orderType: OrderType;
  /** Master quantity already applied to the master net position. */
  filled: number;
  /** epoch ms when the master order finished filled (fallback timer). */
  filledAt?: number;
}

const MIRROR_TYPES: OrderType[] = ['SL', 'SL_M', 'LIMIT'];
const PENDING = ['SUBMITTED', 'OPEN', 'PARTIALLY_FILLED'] as const;
const sameNum = (a: number | null | undefined, b: number | null | undefined) => (a ?? null) === (b ?? null);

/**
 * Stop-loss / target synchronisation.
 *
 * When the master places a PENDING exit order (SL, SL-M or LIMIT target that reduces an open master position),
 * the same pending order is placed on every follower that holds the copy position — so the follower's broker
 * triggers it at the same level, even if our server is slow or down. Then:
 *   - master modifies price / trigger / qty → follower orders are modified;
 *   - master cancels → follower pending orders are cancelled;
 *   - master order fills → follower orders fill at their broker by themselves (never copied twice); a follower
 *     order still pending COPY_MIRROR_FALLBACK_SEC after the master filled is cancelled and exited at MARKET,
 *     so no follower is left holding a position the master has closed.
 * Mirrored follower orders count in the follower's net copy position only when they fill (see the reconciler).
 */
@Injectable()
export class OrderMirrorService {
  private readonly logger = new Logger('OrderMirror');

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly registry: ClientRegistryService,
    private readonly trading: TradingService,
    private readonly realtime: RealtimeService,
    private readonly instruments: InstrumentsService,
  ) {}

  /**
   * Handles mirrored orders of one master account for one poll. Returns the master order ids it owns,
   * which the poller must NOT copy as fills.
   */
  async sync(strategy: Pick<Strategy, 'id' | 'masterUserId'>, account: BrokerAccount, orders: BrokerOrder[]): Promise<Set<string>> {
    const owned = new Set<string>();
    if (!this.config.COPY_MIRROR_EXIT_ORDERS) return owned;
    const raw = await this.redis.hgetall(mirrorKey(account.id));
    for (const id of Object.keys(raw)) owned.add(id);
    for (const o of orders) {
      try {
        const stRaw = raw[o.brokerOrderId];
        if (stRaw) {
          await this.update(strategy, account, o, JSON.parse(stRaw) as MirrorState);
          continue;
        }
        if (o.status !== 'OPEN' || o.filledQuantity > 0 || !MIRROR_TYPES.includes(o.orderType)) continue;
        if (await this.redis.sismember(seenKey(account.id), o.brokerOrderId)) continue; // baseline / already handled
        const net = this.registry.masterNetOf(strategy.id, o.exchange, o.symbol, o.productType);
        const signed = o.side === 'BUY' ? 1 : -1;
        if (net === 0 || Math.sign(net) === signed) continue; // not an exit of an open master position
        await this.mirrorNew(strategy, account, o, Math.abs(net));
        owned.add(o.brokerOrderId);
      } catch (err) {
        this.logger.error(`Mirror sync of ${o.brokerOrderId} failed: ${(err as Error).message}`);
      }
    }
    return owned;
  }

  // ------------------------------------------------------------ new pending master exit

  private followerQty(strategyId: string, c: ClientEntry, masterQty: number, masterNetAbs: number, clientNetAbs: number, lotSize: number): number {
    if (masterQty >= masterNetAbs) return clientNetAbs; // master exits everything → follower exits everything
    const strat = this.registry.strategy(strategyId) ?? { masterCapital: 0, maxOrderValue: null, maxQuantityPerOrder: null };
    const calc = computeCopyQuantity(strat, { ...c.settings, maxLots: null, maxQuantity: null, maxTradeValue: null }, masterQty, null, lotSize).qty;
    return Math.min(calc || clientNetAbs, clientNetAbs);
  }

  private async mirrorNew(strategy: Pick<Strategy, 'id' | 'masterUserId'>, account: BrokerAccount, o: BrokerOrder, masterNetAbs: number): Promise<void> {
    const tradeId = randomUUID();
    const lotSize = this.instruments.lotSize(o.exchange, o.symbol) ?? o.lotSize ?? 1;
    const state: MirrorState = { tradeId, qty: o.quantity, price: o.price, trigger: o.triggerPrice ?? null, orderType: o.orderType, filled: 0 };
    // Claim first so a concurrent poll never mirrors the same order twice.
    const claimed = await this.redis.hsetnx(mirrorKey(account.id), o.brokerOrderId, JSON.stringify(state));
    if (!claimed) return;
    await this.redis.expire(mirrorKey(account.id), 3 * 86400);

    await this.prisma.masterTrade.create({
      data: {
        id: tradeId,
        masterUserId: strategy.masterUserId,
        strategyId: strategy.id,
        brokerAccountId: account.id,
        broker: account.broker,
        brokerOrderId: o.brokerOrderId,
        exchange: o.exchange,
        symbol: o.symbol,
        instrumentToken: o.instrumentToken,
        side: o.side,
        orderType: o.orderType,
        productType: o.productType,
        quantity: o.quantity,
        filledQuantity: 0,
        price: o.price ?? undefined,
        averagePrice: undefined,
        status: 'OPEN',
        eventTimestamp: o.timestamp,
        rawPayload: { mirrored: true, triggerPrice: o.triggerPrice ?? null },
      },
    });

    const now = new Date();
    const rows: Prisma.CopyOrderCreateManyInput[] = [];
    for (const c of this.registry.forStrategy(strategy.id)) {
      if (c.simulated || !c.adapter) continue; // paper accounts have no broker to hold a pending order
      const net = this.registry.clientNet(c.followerId, o.exchange, o.symbol, o.productType);
      if (net === 0 || Math.sign(net) === (o.side === 'BUY' ? 1 : -1)) continue;
      const qty = this.followerQty(strategy.id, c, o.quantity, masterNetAbs, Math.abs(net), lotSize);
      if (qty <= 0) continue;
      let brokerOrderId: string | null = null;
      let error: string | null = null;
      try {
        ({ brokerOrderId } = await c.adapter.placeOrder({
          exchange: o.exchange,
          symbol: o.symbol,
          side: o.side,
          quantity: qty,
          orderType: o.orderType,
          productType: o.productType,
          price: o.price,
          triggerPrice: o.triggerPrice ?? null,
          tag: 'ctpmirror',
        }));
      } catch (err) {
        error = (err as Error).message.slice(0, 500);
        if (this.trading.isSessionError(err)) this.registry.evictAccount(c.accountId, 'Broker session rejected');
      }
      rows.push({
        masterTradeId: tradeId,
        strategyFollowerId: c.followerId,
        followerUserId: c.userId,
        brokerAccountId: c.accountId,
        broker: c.broker,
        idempotencyKey: `${tradeId}:${c.userId}`,
        exchange: o.exchange,
        symbol: o.symbol,
        instrumentToken: o.instrumentToken,
        side: o.side,
        orderType: o.orderType,
        productType: o.productType,
        quantity: qty,
        price: o.price ?? undefined,
        triggerPrice: o.triggerPrice ?? undefined,
        status: brokerOrderId ? 'SUBMITTED' : 'FAILED',
        brokerOrderId,
        errorCode: error ? 'BROKER_ERROR' : null,
        errorMessage: error,
        attempts: 1,
        lastAttemptAt: now,
        submittedAt: brokerOrderId ? now : null,
        mirrored: true,
        isExit: true,
      });
      this.realtime.toUser(c.userId, error ? WsEvent.COPY_ORDER_FAILED : WsEvent.COPY_ORDER_SUBMITTED, {
        tradeId,
        symbol: o.symbol,
        side: o.side,
        qty,
        status: error ? 'FAILED' : 'SUBMITTED',
        orderType: o.orderType,
        error,
      });
    }
    if (rows.length) await this.prisma.copyOrder.createMany({ data: rows, skipDuplicates: true });
    this.logger.log(`Mirrored master ${o.orderType} ${o.side} ${o.quantity} ${o.exchange}:${o.symbol} → ${rows.length} follower order(s)`);
  }

  // ------------------------------------------------------------ changes to a mirrored master order

  private async adapterFor(accountId: string): Promise<BrokerAdapter | null> {
    const e = this.registry.allEntries().find((x) => x.accountId === accountId && x.adapter);
    if (e?.adapter) return e.adapter;
    const acc = await this.prisma.brokerAccount.findUnique({ where: { id: accountId } });
    if (!acc) return null;
    return this.trading.adapterFor(acc).catch(() => null);
  }

  private async pendingRows(tradeId: string): Promise<CopyOrder[]> {
    return this.prisma.copyOrder.findMany({ where: { masterTradeId: tradeId, mirrored: true, status: { in: [...PENDING] }, brokerOrderId: { not: null } } });
  }

  private async save(accountId: string, masterOrderId: string, st: MirrorState): Promise<void> {
    await this.redis.hset(mirrorKey(accountId), masterOrderId, JSON.stringify(st));
  }

  /** Mark handled for the poller, then forget the mirror state. */
  private async finish(accountId: string, masterOrderId: string): Promise<void> {
    await this.redis.sadd(seenKey(accountId), masterOrderId);
    await this.redis.expire(seenKey(accountId), 3 * 86400);
    await this.redis.hdel(mirrorKey(accountId), masterOrderId);
  }

  private async update(strategy: Pick<Strategy, 'id' | 'masterUserId'>, account: BrokerAccount, o: BrokerOrder, st: MirrorState): Promise<void> {
    // 1) Master fills: keep the master net position in step (followers fill at their own broker).
    const delta = o.filledQuantity - st.filled;
    if (delta > 0) {
      this.registry.applyMasterFill(strategy.id, o.exchange, o.symbol, o.productType, o.side === 'BUY' ? delta : -delta);
      st.filled = o.filledQuantity;
      await this.prisma.masterTrade
        .update({ where: { id: st.tradeId }, data: { filledQuantity: o.filledQuantity, averagePrice: o.averagePrice ?? undefined, status: o.status === 'OPEN' ? 'PARTIALLY_FILLED' : o.status } })
        .catch(() => undefined);
      await this.save(account.id, o.brokerOrderId, st);
    }

    if (o.status === 'OPEN') {
      // 2) Master modified the order → modify follower orders.
      const changed = !sameNum(st.price, o.price) || !sameNum(st.trigger, o.triggerPrice) || st.qty !== o.quantity || st.orderType !== o.orderType;
      if (changed) await this.modifyFollowers(o, st);
      if (changed) {
        Object.assign(st, { price: o.price, trigger: o.triggerPrice ?? null, qty: o.quantity, orderType: o.orderType });
        await this.save(account.id, o.brokerOrderId, st);
      }
      return;
    }

    if (o.status === 'CANCELLED' || o.status === 'REJECTED') {
      // 3) Master cancelled → cancel what is still pending at followers.
      await this.cancelFollowers(st.tradeId);
      await this.prisma.masterTrade.update({ where: { id: st.tradeId }, data: { status: o.status } }).catch(() => undefined);
      await this.finish(account.id, o.brokerOrderId);
      this.logger.log(`Master ${o.brokerOrderId} ${o.status} → follower SL/target orders cancelled`);
      return;
    }

    if (o.status === 'FILLED') {
      // 4) Master filled → followers should have filled too. Fallback after a grace period.
      if (!st.filledAt) {
        st.filledAt = Date.now();
        await this.save(account.id, o.brokerOrderId, st);
      }
      const pending = await this.pendingRows(st.tradeId);
      if (!pending.length) return this.finish(account.id, o.brokerOrderId);
      if (Date.now() - st.filledAt < this.config.COPY_MIRROR_FALLBACK_SEC * 1000) return;
      await this.fallbackExit(strategy, account, o, st, pending);
      await this.finish(account.id, o.brokerOrderId);
    }
  }

  private async modifyFollowers(o: BrokerOrder, st: MirrorState): Promise<void> {
    const lotSize = this.instruments.lotSize(o.exchange, o.symbol) ?? o.lotSize ?? 1;
    for (const r of await this.pendingRows(st.tradeId)) {
      const ad = await this.adapterFor(r.brokerAccountId);
      if (!ad) continue;
      let qty = r.quantity;
      if (st.qty !== o.quantity && st.qty > 0) {
        // Scale the follower quantity like the master's, in whole lots, never above the open copy position.
        const net = Math.abs(this.registry.clientNet(r.strategyFollowerId, r.exchange, r.symbol, r.productType));
        qty = Math.max(lotSize, Math.round((r.quantity * o.quantity) / st.qty / lotSize) * lotSize);
        if (net > 0) qty = Math.min(qty, net);
      }
      try {
        await ad.modifyOrder({
          brokerOrderId: r.brokerOrderId!,
          exchange: r.exchange,
          symbol: r.symbol,
          side: r.side,
          quantity: qty,
          orderType: o.orderType,
          productType: r.productType,
          price: o.price,
          triggerPrice: o.triggerPrice ?? null,
        });
        await this.prisma.copyOrder.update({
          where: { id: r.id },
          data: { quantity: qty, orderType: o.orderType, price: o.price ?? undefined, triggerPrice: o.triggerPrice ?? undefined },
        });
        this.realtime.toUser(r.followerUserId, WsEvent.POSITION_UPDATED, { copyOrderId: r.id, symbol: r.symbol, status: 'MODIFIED', price: o.price, triggerPrice: o.triggerPrice ?? null, qty });
      } catch (err) {
        this.logger.warn(`Modify of follower order ${r.brokerOrderId} failed: ${(err as Error).message}`);
        await this.prisma.copyOrder.update({ where: { id: r.id }, data: { errorMessage: `Modify failed: ${(err as Error).message}`.slice(0, 500) } }).catch(() => undefined);
      }
    }
  }

  private async cancelFollowers(tradeId: string): Promise<void> {
    for (const r of await this.pendingRows(tradeId)) {
      const ad = await this.adapterFor(r.brokerAccountId);
      if (!ad) continue;
      // The reconciler records the final CANCELLED status (and any part that filled before the cancel).
      await ad.cancelOrder(r.brokerOrderId!, r.orderType).catch((err) => this.logger.warn(`Cancel of ${r.brokerOrderId} failed: ${(err as Error).message}`));
    }
  }

  /**
   * Master's SL/target filled but a follower's mirrored order did not (different trigger fill, gap, rejection):
   * cancel it and exit what the follower still holds at MARKET, recorded as a normal exit copy order.
   */
  private async fallbackExit(
    strategy: Pick<Strategy, 'id' | 'masterUserId'>,
    account: BrokerAccount,
    o: BrokerOrder,
    st: MirrorState,
    pending: CopyOrder[],
  ): Promise<void> {
    const fbTradeId = randomUUID();
    await this.prisma.masterTrade.create({
      data: {
        id: fbTradeId,
        masterUserId: strategy.masterUserId,
        strategyId: strategy.id,
        brokerAccountId: account.id,
        broker: account.broker,
        brokerOrderId: `${o.brokerOrderId}#fallback`,
        exchange: o.exchange,
        symbol: o.symbol,
        side: o.side,
        orderType: 'MARKET',
        productType: o.productType,
        quantity: o.quantity,
        filledQuantity: 0, // record only — the master fill was already counted on the mirrored trade
        averagePrice: o.averagePrice ?? undefined,
        status: 'FILLED',
        eventTimestamp: new Date(),
        rawPayload: { fallbackFor: st.tradeId },
      },
    });
    for (const r of pending) {
      const ad = await this.adapterFor(r.brokerAccountId);
      if (!ad) continue;
      // Exact state from the follower's own order book (the reconciler may be a few seconds behind).
      const book = await ad.orders().catch(() => [] as BrokerOrder[]);
      const live = book.find((b) => b.brokerOrderId === r.brokerOrderId);
      if (live && live.status === 'FILLED') continue;
      await ad.cancelOrder(r.brokerOrderId!, r.orderType).catch(() => undefined);
      const filled = live?.filledQuantity ?? r.filledQuantity;
      const already = Math.max(0, filled - r.filledQuantity); // fills the reconciler has not applied yet
      const net = Math.abs(this.registry.clientNet(r.strategyFollowerId, r.exchange, r.symbol, r.productType)) - already;
      const qty = Math.min(r.quantity - filled, net);
      if (qty <= 0) continue;
      let brokerOrderId: string | null = null;
      let error: string | null = null;
      try {
        ({ brokerOrderId } = await ad.placeOrder({ exchange: r.exchange, symbol: r.symbol, side: r.side, quantity: qty, orderType: 'MARKET', productType: r.productType, tag: 'ctpcopy' }));
        // Normal (non-mirrored) copy order: counted in the net position at submit, corrected by the reconciler.
        this.registry.applyClientFill(r.strategyFollowerId, r.exchange, r.symbol, r.productType, r.side === 'BUY' ? qty : -qty);
      } catch (err) {
        error = (err as Error).message.slice(0, 500);
      }
      await this.prisma.copyOrder.create({
        data: {
          masterTradeId: fbTradeId,
          strategyFollowerId: r.strategyFollowerId,
          followerUserId: r.followerUserId,
          brokerAccountId: r.brokerAccountId,
          broker: r.broker,
          idempotencyKey: `${fbTradeId}:${r.followerUserId}`,
          exchange: r.exchange,
          symbol: r.symbol,
          side: r.side,
          orderType: 'MARKET',
          productType: r.productType,
          quantity: qty,
          status: brokerOrderId ? 'SUBMITTED' : 'FAILED',
          brokerOrderId,
          errorCode: error ? 'BROKER_ERROR' : null,
          errorMessage: error ?? 'Fallback MARKET exit: follower SL/target did not fill when the master\'s did',
          attempts: 1,
          lastAttemptAt: new Date(),
          submittedAt: brokerOrderId ? new Date() : null,
          isExit: true,
        },
      });
      this.logger.warn(`Fallback MARKET exit ${r.side} ${qty} ${r.symbol} for follower ${r.followerUserId}${error ? ` failed: ${error}` : ''}`);
      this.realtime.toUser(r.followerUserId, error ? WsEvent.COPY_ORDER_FAILED : WsEvent.COPY_ORDER_SUBMITTED, {
        tradeId: fbTradeId,
        symbol: r.symbol,
        side: r.side,
        qty,
        status: error ? 'FAILED' : 'SUBMITTED',
        error,
      });
    }
  }
}
