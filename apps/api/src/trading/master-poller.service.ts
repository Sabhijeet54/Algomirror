import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import type { BrokerAccount, PrismaClient } from '@ctp/database';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { API_CONFIG, ApiConfig } from '../config/config.module';
import { CopyEngineService } from './copy-engine.service';
import { OrderMirrorService, seenKey } from './order-mirror.service';
import { TradingService } from './trading.service';

/** Hash: master broker order id → quantity already copied (partial-fill tracking). */
const copiedKey = (accountId: string) => `ctp:poll:copied:${accountId}`;
const TERMINAL = new Set(['FILLED', 'REJECTED', 'CANCELLED']);

/**
 * Detects trades a master places directly in the broker's own app (Kite / Angel One app)
 * by polling the order book. On first sight of an account the existing order book is
 * baselined (never copied), so only orders placed afterwards are copied.
 * A master with several ACTIVE strategies must place trades from the platform instead,
 * because an external order cannot be attributed to one strategy.
 */
@Injectable()
export class MasterPollerService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('MasterPoller');
  private timer?: NodeJS.Timeout;
  private running = false;
  private warned = new Set<string>();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly trading: TradingService,
    private readonly engine: CopyEngineService,
    private readonly mirror: OrderMirrorService,
  ) {}

  onApplicationBootstrap(): void {
    const every = this.config.COPY_POLL_INTERVAL_MS;
    if (!every || this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.tick(), every);
    this.logger.log(`Polling master order books every ${every} ms`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Lets the platform mark an order it placed itself so polling never re-copies it. */
  async markSeen(accountId: string, brokerOrderId: string): Promise<void> {
    await this.redis.sadd(seenKey(accountId), brokerOrderId);
    await this.redis.expire(seenKey(accountId), 3 * 86400);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const strategies = await this.prisma.strategy.findMany({ where: { status: 'ACTIVE' } });
      const byMaster = new Map<string, typeof strategies>();
      for (const s of strategies) byMaster.set(s.masterUserId, [...(byMaster.get(s.masterUserId) ?? []), s]);
      for (const [masterId, list] of byMaster) {
        if (list.length !== 1) {
          if (!this.warned.has(masterId)) this.logger.warn(`Master ${masterId} has ${list.length} active strategies — external orders are not auto-copied.`);
          this.warned.add(masterId);
          continue;
        }
        this.warned.delete(masterId);
        const accounts = await this.prisma.brokerAccount.findMany({
          where: { userId: masterId, status: 'CONNECTED', broker: { not: 'MOCK' } },
        });
        for (const a of accounts) await this.pollAccount(list[0]!, a);
      }
    } catch (err) {
      this.logger.error(`Poll failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async pollAccount(strategy: Parameters<CopyEngineService['onMasterTrade']>[0], account: BrokerAccount): Promise<void> {
    let orders;
    try {
      orders = await (await this.trading.adapterFor(account)).orders();
    } catch (err) {
      await this.trading.handleBrokerError(account, err);
      return;
    }
    const key = seenKey(account.id);
    const baselined = await this.redis.exists(key);
    if (!baselined) {
      await this.redis.sadd(key, '__baseline__', ...orders.map((o) => o.brokerOrderId));
      await this.redis.expire(key, 3 * 86400);
      return;
    }
    // Pending master SL/target orders are mirrored to followers; their fills are never copied again.
    const owned = await this.mirror.sync(strategy, account, orders);
    const partial = this.config.COPY_PARTIAL_FILLS;
    for (const o of orders) {
      if (owned.has(o.brokerOrderId)) continue;
      const terminal = TERMINAL.has(o.status);
      // Wait for the order to finish unless partial fills are copied live.
      if (!terminal && !(partial && o.filledQuantity > 0)) continue;
      if (await this.redis.sismember(key, o.brokerOrderId)) continue;
      if (o.statusMessage?.includes('ctpcopy')) {
        await this.markSeen(account.id, o.brokerOrderId);
        continue;
      }
      // Only quantity that actually executed is copied — a cancelled/rejected order may still be partly filled.
      const copied = Number((await this.redis.hget(copiedKey(account.id), o.brokerOrderId)) ?? 0);
      const delta = o.filledQuantity - copied;
      if (terminal) await this.markSeen(account.id, o.brokerOrderId);
      if (delta <= 0) continue;
      await this.redis.hset(copiedKey(account.id), o.brokerOrderId, String(o.filledQuantity));
      await this.redis.expire(copiedKey(account.id), 3 * 86400);
      const isFirstSlice = copied === 0 && o.filledQuantity === o.quantity;
      // Each fill slice gets its own id so the engine's idempotency lock treats it as a separate event.
      const sliceId = isFirstSlice ? o.brokerOrderId : `${o.brokerOrderId}#${o.filledQuantity}`;
      this.logger.log(
        `Master fill on ${account.broker}: ${o.side} ${delta} ${o.exchange}:${o.symbol} (${o.filledQuantity}/${o.quantity}, ${o.status})`,
      );
      await this.engine.onMasterTrade(strategy, account, {
        brokerOrderId: sliceId,
        exchange: o.exchange,
        symbol: o.symbol,
        side: o.side,
        quantity: delta,
        filledQuantity: delta,
        orderType: o.orderType,
        productType: o.productType,
        price: o.price,
        averagePrice: o.averagePrice,
        status: 'FILLED',
        instrumentToken: o.instrumentToken,
        lotSize: o.lotSize,
        timestamp: o.timestamp,
        raw: o.raw,
      });
    }
  }
}
