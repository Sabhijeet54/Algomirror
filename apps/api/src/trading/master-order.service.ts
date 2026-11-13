import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';
import type { PrismaClient, Strategy } from '@ctp/database';
import { generateToken } from '@ctp/shared';
import { BrokerApiError } from '../brokers/broker-http';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { dailyHaltKey, istNow, readAutomation } from './automation';
import { MarketFeedService } from '../market-data/market-feed.service';
import { instrumentKey, PriceCacheService } from '../market-data/price-cache.service';
import { ClientRegistryService } from './client-registry.service';
import { CopyEngineService } from './copy-engine.service';
import { MasterPollerService } from './master-poller.service';
import { SignalService } from './signal.service';
import type { MasterOrderDto } from './trading.dto';
import { TradingService } from './trading.service';

/**
 * A master trade (signal) for one strategy: checks, the master's own order (or a signal / paper fill) and the
 * copy to every active follower. Shared by "Place trade" and the TradingView / alert webhook.
 */
@Injectable()
export class MasterOrderService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly trading: TradingService,
    private readonly engine: CopyEngineService,
    private readonly poller: MasterPollerService,
    private readonly prices: PriceCacheService,
    private readonly feed: MarketFeedService,
    private readonly signals: SignalService,
    private readonly registry: ClientRegistryService,
  ) {}

  /** `strategy` must already be checked to belong to `masterUserId`. */
  async place(masterUserId: string, strategy: Strategy, dto: MasterOrderDto, opts: { reentryCount?: number } = {}): Promise<{ tradeId: string; totalMs: number }> {
    const lic = await this.prisma.user.findUnique({ where: { id: masterUserId }, select: { licenceExpiresAt: true } });
    if (lic?.licenceExpiresAt && lic.licenceExpiresAt.getTime() <= Date.now()) {
      throw new ForbiddenException('Your licence has expired. Contact the admin to renew it.');
    }
    if (strategy.status !== 'ACTIVE') throw new BadRequestException('Start (activate) the strategy before trading it.');
    if (strategy.allowedExchanges.length && !strategy.allowedExchanges.includes(dto.exchange)) {
      throw new BadRequestException(`${dto.exchange} is not allowed in this strategy.`);
    }
    if (strategy.allowedInstruments.length) {
      const ok = strategy.allowedInstruments.some((p) => (p.endsWith('*') ? dto.symbol.startsWith(p.slice(0, -1)) : dto.symbol === p));
      if (!ok) throw new BadRequestException(`${dto.symbol} is not allowed in this strategy.`);
    }
    if ((dto.orderType === 'LIMIT' || dto.orderType === 'SL') && !dto.price) throw new BadRequestException('Price is required for LIMIT / SL orders.');
    if ((dto.orderType === 'SL' || dto.orderType === 'SL_M') && !dto.triggerPrice) throw new BadRequestException('Trigger price is required for SL orders.');
    if (dto.targetPrice != null && dto.stopLossPrice != null && (dto.side === 'BUY' ? dto.targetPrice <= dto.stopLossPrice : dto.targetPrice >= dto.stopLossPrice)) {
      throw new BadRequestException(dto.side === 'BUY' ? 'For a BUY, target must be above stop loss' : 'For a SELL, target must be below stop loss');
    }

    // An order against an open position only EXITS it: never sell more than was bought (or buy back more than
    // was sold) — the extra would open an opposite trade for every client.
    const open = this.registry.masterNetOf(strategy.id, dto.exchange, dto.symbol, dto.productType);
    const signedQty = dto.side === 'BUY' ? dto.quantity : -dto.quantity;
    const isExitOrder = open !== 0 && Math.sign(signedQty) !== Math.sign(open);
    if (isExitOrder && dto.quantity > Math.abs(open)) dto.quantity = Math.abs(open);
    // Strategy daily max loss / profit reached: exits only for the rest of the day.
    if (!isExitOrder && (await this.redis.get(dailyHaltKey(strategy.id, istNow().date)))) {
      throw new BadRequestException('Daily max loss / profit of this strategy is reached — no new trades today.');
    }
    const auto = readAutomation(strategy.automation);
    const trailPoints = dto.stopLossPrice != null ? (dto.trailPoints ?? auto.trailPoints ?? null) : null;

    const accounts = await this.prisma.brokerAccount.findMany({ where: { userId: masterUserId }, orderBy: { createdAt: 'asc' } });
    const account = dto.brokerAccountId
      ? accounts.find((a) => a.id === dto.brokerAccountId)
      : (accounts.find((a) => a.broker !== 'MOCK' && a.status === 'CONNECTED') ?? accounts.find((a) => a.broker === 'MOCK') ?? accounts[0]);
    if (!account) throw new BadRequestException('Connect a broker account first.');

    // The master's broker account is DATA_ONLY: the platform NEVER places orders on it. A master order from the
    // platform is a SIGNAL that is mirrored to the followers only.
    const isSignal = account.mode === 'DATA_ONLY' || this.trading.isSimulated(account);
    const price = dto.price ?? this.prices.get(instrumentKey(dto.exchange, dto.symbol)) ?? null;
    this.feed.ensure(dto.exchange, dto.symbol);
    if (this.trading.isSimulated(account) && price == null) throw new BadRequestException('Live price unavailable — enter a price for this paper trade.');

    let brokerOrderId: string;
    if (isSignal) {
      brokerOrderId = `SIG-${generateToken(9)}`;
    } else {
      try {
        this.trading.assertOrderAllowed(account);
        ({ brokerOrderId } = await (await this.trading.adapterFor(account)).placeOrder({ ...dto, tag: 'ctpmaster' }));
        await this.poller.markSeen(account.id, brokerOrderId);
      } catch (err) {
        if (err instanceof BrokerApiError) throw new BadRequestException(await this.trading.handleBrokerError(account, err));
        throw err;
      }
    }
    // Signal book: the master's own (virtual) position, for display.
    if (isSignal && price != null) await this.engine.applyPaperFill(masterUserId, account.id, dto, dto.quantity, price);

    const summary = await this.engine.onMasterTrade(strategy, account, {
      ...dto,
      brokerOrderId,
      filledQuantity: isSignal ? dto.quantity : 0,
      averagePrice: isSignal ? price : null,
      price,
      status: isSignal ? 'FILLED' : 'SUBMITTED',
      timestamp: new Date(),
      lotSize: dto.lotSize,
      targetPrice: dto.targetPrice ?? null,
      stopLossPrice: dto.stopLossPrice ?? null,
      trailPoints,
      reentryCount: opts.reentryCount ?? 0,
      exitReason: 'MASTER_EXIT',
    });
    if (!summary) throw new BadRequestException('Duplicate order ignored.');
    if (dto.targetPrice != null || dto.stopLossPrice != null) this.signals.refreshWatch();
    return summary;
  }
}
