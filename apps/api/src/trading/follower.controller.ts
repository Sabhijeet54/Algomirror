import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { PrismaClient } from '@ctp/database';
import { AuditService } from '../audit/audit.service';
import { clientInfo } from '../common/client-info';
import { CurrentUser, RequestUser, Roles } from '../common/decorators/auth.decorators';
import { toCopyOrderView, toStrategyFollowerView, toStrategyView } from '../common/mappers';
import { PRISMA } from '../common/prisma/prisma.service';
import { FollowDto, TradingModeDto } from './trading.dto';
import { allocationLabel, ClientSummaryService, isRemoved, REMOVED_REASON } from './client-summary.service';
import { PositionResizeService } from './position-resize.service';
import { MarketFeedService } from '../market-data/market-feed.service';
import { PriceCacheService } from '../market-data/price-cache.service';
import { startOfTradingDayIST } from '../admin/admin.service';
import { overlayLivePrices, paperPositionView } from './price-overlay';
import { SignalService } from './signal.service';
import { TradingService } from './trading.service';
import { RiskService } from './risk.service';
import { AccountEvents } from '../realtime/account-events';

/** Client (follower) side: discover strategies, subscribe, start/stop copying, and see own portfolio. */
@Roles('FOLLOWER')
@Controller('follow')
export class FollowerController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly trading: TradingService,
    private readonly audit: AuditService,
    private readonly risk: RiskService,
    private readonly accountEvents: AccountEvents,
    private readonly prices: PriceCacheService,
    private readonly feed: MarketFeedService,
    private readonly summary: ClientSummaryService,
    private readonly resizer: PositionResizeService,
    private readonly signals: SignalService,
  ) {}

  /**
   * Client dashboard: today's P&L (overall and per strategy), connected broker, subscriptions and licence.
   * P&L is computed from today's executed copy orders (sells − buys) plus the open quantity at the live LTP.
   */
  @Get('dashboard')
  async dashboard(@CurrentUser() user: RequestUser) {
    const [me, accounts, day] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: user.id }, select: { licenceExpiresAt: true, licenceDays: true, licenceAssignedAt: true, demo: true } }),
      this.prisma.brokerAccount.findMany({ where: { userId: user.id, broker: { not: 'MOCK' }, mode: 'TRADING' }, orderBy: { updatedAt: 'desc' } }),
      this.summary.today(user.id),
    ]);
    const subs = day.strategies;
    const now = Date.now();
    const exp = me?.licenceExpiresAt?.getTime() ?? null;
    const primary = accounts.find((a) => a.status === 'CONNECTED') ?? accounts[0] ?? null;
    return {
      todayPnl: day.todayPnl,
      /** No demat connected: the client paper-trades on the internal paper account. */
      tradingMode: primary ? (this.trading.isSimulated(primary) ? 'PAPER' : 'LIVE') : 'PAPER',
      broker: primary
        ? {
            accountId: primary.id,
            broker: primary.broker,
            brokerClientId: primary.brokerClientId,
            status: primary.status,
            connected: primary.status === 'CONNECTED' && (!primary.tokenExpiresAt || primary.tokenExpiresAt.getTime() > now),
            tradingMode: this.trading.isSimulated(primary) ? 'PAPER' : 'LIVE',
            /** Kept for older web builds: the client can always switch now. */
            paperForced: false,
          }
        : null,
      subscriptions: {
        total: subs.length,
        on: subs.filter((s) => s.copyStatus === 'ON').length,
        off: subs.filter((s) => s.copyStatus === 'OFF').length,
        paused: subs.filter((s) => s.copyStatus === 'PAUSED').length,
      },
      licence: {
        expiresAt: me?.licenceExpiresAt?.toISOString() ?? null,
        assignedAt: me?.licenceAssignedAt?.toISOString() ?? null,
        days: me?.licenceDays ?? null,
        remainingDays: exp == null ? null : Math.max(0, Math.ceil((exp - now) / 86_400_000)),
        active: exp == null ? null : exp > now,
        demo: me?.demo ?? false,
      },
      strategies: subs,
    };
  }

  /**
   * Paper / live switch for my trading account (isPaper = true / false), chosen by the client himself.
   * Paper = copied trades are simulated, no real broker orders. Live = real orders in my broker account.
   */
  @HttpCode(HttpStatus.OK)
  @Post('trading-mode')
  async tradingMode(@CurrentUser() user: RequestUser, @Body() dto: TradingModeDto, @Req() req: Request) {
    const accounts = await this.prisma.brokerAccount.findMany({ where: { userId: user.id, broker: { not: 'MOCK' }, mode: 'TRADING' } });
    // Paper trading needs no demat: without a broker the client trades on the internal paper account.
    if (!accounts.length) {
      if (dto.mode === 'LIVE') throw new BadRequestException('Live trading needs a connected demat — connect your broker in Broker connection. Paper trading works without it.');
      await this.trading.ensureLedgerAccount(user.id);
      return { mode: 'PAPER' as const, paperClosed: 0 };
    }
    if (dto.mode === 'LIVE') {
      const me = await this.prisma.user.findUnique({ where: { id: user.id }, select: { demo: true } });
      if (me?.demo) throw new ForbiddenException('Demo licence: only paper trading is allowed. Ask your master for a full licence to trade live.');
    }
    // PAPER → LIVE: paper trades opened before the switch are closed now (at LTP). Otherwise the master's later
    // exit would go to the live broker (where nothing is held) and the old paper trade would never be cut.
    let paperClosed = 0;
    if (dto.mode === 'LIVE') {
      // Includes the internal paper account (paper trades taken before a demat was connected).
      const ledger = await this.prisma.brokerAccount.findUnique({ where: { userId_broker: { userId: user.id, broker: 'MOCK' } } });
      for (const a of ledger ? [...accounts, ledger] : accounts) {
        if (!this.trading.isSimulated(a)) continue;
        const r = await this.risk.squareOffAccount(a, { intradayOnly: false }).catch((e: Error) => {
          throw new BadRequestException(`Could not close your open paper trades (${e.message}) — try again.`);
        });
        paperClosed += r.orders;
      }
    }
    await this.prisma.brokerAccount.updateMany({ where: { id: { in: accounts.map((a) => a.id) } }, data: { isPaper: dto.mode === 'PAPER' } });
    // Subscriptions still on the internal paper account move to the demat, so the switch really applies to them.
    const real = accounts.find((a) => a.status === 'CONNECTED') ?? accounts[0]!;
    await this.prisma.strategyFollower.updateMany({ where: { followerUserId: user.id, OR: [{ brokerAccountId: null }, { brokerAccount: { broker: 'MOCK' } }] }, data: { brokerAccountId: real.id } });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.id, targetType: 'BrokerAccount', targetId: accounts[0]!.id, metadata: { tradingMode: dto.mode, paperClosed }, client: clientInfo(req) });
    for (const a of accounts) this.accountEvents.emit({ type: 'settings', brokerAccountId: a.id, userId: user.id });
    return { mode: dto.mode, paperClosed };
  }

  /** Marketplace: last 7 days of trades of one live strategy (lot size / quantity shown as the master traded). */
  @Get('strategies/:id/history')
  async strategyHistory(@Param('id') id: string) {
    const st = await this.prisma.strategy.findUnique({ where: { id }, select: { status: true } });
    if (!st || (st.status !== 'ACTIVE' && st.status !== 'PAUSED')) throw new NotFoundException('Strategy not found');
    const rows = await this.signals.list(null, { status: 'all', from: new Date(Date.now() - 7 * 86_400_000), strategyIds: [id] });
    return rows.map(({ copyStatusCounts: _c, masterName: _m, ...r }) => r);
  }

  /** Activity log: every change on my account, who made it (me / admin / master / system), and my logins. */
  @Get('activity')
  async activity(@CurrentUser() user: RequestUser, @Query('page') pageQ?: string) {
    const page = Math.max(1, Number(pageQ) || 1);
    const pageSize = 50;
    const [subs, accounts, apiCfgs] = await Promise.all([
      this.prisma.strategyFollower.findMany({ where: { followerUserId: user.id }, select: { id: true, strategy: { select: { name: true } } } }),
      this.prisma.brokerAccount.findMany({ where: { userId: user.id }, select: { id: true, broker: true } }),
      this.prisma.brokerApiConfig.findMany({ where: { userId: user.id }, select: { id: true, broker: true } }),
    ]);
    const where = {
      createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) },
      action: { notIn: ['COPY_ORDER_CREATED', 'COPY_ORDER_SUBMITTED', 'COPY_ORDER_FILLED', 'MASTER_TRADE_DETECTED'] as never[] },
      OR: [
        { actorUserId: user.id },
        { targetType: 'User', targetId: user.id },
        ...(subs.length ? [{ targetType: 'StrategyFollower', targetId: { in: subs.map((x) => x.id) } }] : []),
        ...(accounts.length ? [{ targetType: 'BrokerAccount', targetId: { in: accounts.map((x) => x.id) } }] : []),
        ...(apiCfgs.length ? [{ targetType: 'BrokerApiConfig', targetId: { in: apiCfgs.map((x) => x.id) } }] : []),
      ],
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    ]);
    const subName = new Map(subs.map((x) => [x.id, x.strategy.name]));
    const accName = new Map([...accounts.map((x) => [x.id, x.broker] as const), ...apiCfgs.map((x) => [x.id, x.broker] as const)]);
    return {
      total,
      page,
      pageSize,
      items: rows.map((r) => {
        return {
          id: r.id,
          at: r.createdAt.toISOString(),
          action: r.action,
          on: r.targetType === 'StrategyFollower' ? (subName.get(r.targetId ?? '') ?? 'Strategy') : r.targetType === 'BrokerAccount' || r.targetType === 'BrokerApiConfig' ? (accName.get(r.targetId ?? '') ?? 'Broker') : null,
          metadata: (r.metadata ?? null) as Record<string, unknown> | null,
          ip: r.ip,
          userAgent: r.userAgent,
        };
      }),
    };
  }

  /** Marketplace: every live strategy, with my connection (if any). */
  @Get('marketplace')
  async marketplace(@CurrentUser() user: RequestUser) {
    const [rows, mine] = await Promise.all([
      this.prisma.strategy.findMany({
        where: { status: { in: ['ACTIVE', 'PAUSED', 'DRAFT'] } },
        include: { master: { select: { name: true } }, _count: { select: { followers: true } } },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.strategyFollower.findMany({ where: { followerUserId: user.id } }),
    ]);
    const byStrategy = new Map(mine.filter((m) => !isRemoved(m)).map((m) => [m.strategyId, m]));
    // Only strategies given to me by the master / admin are listed (plus ones I disconnected myself, to reconnect).
    const allowed = new Set(mine.filter((m) => !isRemoved(m) || m.stoppedByUserId === user.id).map((m) => m.strategyId));
    return rows.filter((st) => allowed.has(st.id)).map((st) => {
      const sub = byStrategy.get(st.id);
      return { ...toStrategyView(st), connected: !!sub, subscription: sub ? toStrategyFollowerView(sub) : null, allocationLabel: sub ? allocationLabel(sub) : null };
    });
  }

  /**
   * Disconnect a strategy: copying stops and the strategy with its trades disappears from my screens.
   * Positions already in my broker account are NOT closed (exit them first if needed).
   */
  @HttpCode(HttpStatus.OK)
  @Post('strategies/:id/disconnect')
  async disconnect(@CurrentUser() user: RequestUser, @Param('id') id: string, @Req() req: Request) {
    const sub = await this.prisma.strategyFollower.findUnique({ where: { strategyId_followerUserId: { strategyId: id, followerUserId: user.id } } });
    if (!sub || isRemoved(sub)) throw new NotFoundException('You are not connected to this strategy');
    await this.prisma.strategyFollower.update({
      where: { id: sub.id },
      data: { copyStatus: 'OFF', stoppedAt: new Date(), stoppedReason: REMOVED_REASON, stoppedByUserId: user.id },
    });
    await this.audit.log({ action: 'COPY_STOPPED', actorUserId: user.id, targetType: 'StrategyFollower', targetId: sub.id, metadata: { disconnected: true }, client: clientInfo(req) });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: sub.brokerAccountId ?? '', userId: user.id });
    return { disconnected: true };
  }

  /** My connected strategies (connected by me from the marketplace, or by admin / master). */
  @Get('strategies')
  async strategies(@CurrentUser() user: RequestUser) {
    const mine = (await this.prisma.strategyFollower.findMany({ where: { followerUserId: user.id } })).filter((m) => !isRemoved(m));
    if (!mine.length) return [];
    const rows = await this.prisma.strategy.findMany({
      where: { id: { in: mine.map((m) => m.strategyId) }, status: { in: ['ACTIVE', 'PAUSED', 'DRAFT'] } },
      include: { master: { select: { name: true } }, _count: { select: { followers: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const byStrategy = new Map(mine.map((m) => [m.strategyId, m]));
    return rows.map((s) => {
      const sub = byStrategy.get(s.id);
      return { ...toStrategyView(s), subscription: sub ? toStrategyFollowerView(sub) : null, allocationLabel: sub ? allocationLabel(sub) : null };
    });
  }

  @Get('subscriptions')
  async subscriptions(@CurrentUser() user: RequestUser) {
    const rows = await this.prisma.strategyFollower.findMany({
      where: { followerUserId: user.id },
      include: { strategy: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.filter((r) => !isRemoved(r)).map(toStrategyFollowerView);
  }

  /** Subscribe to a strategy or update the allocation. Copying stays OFF until started explicitly. */
  @Post('strategies/:id')
  async follow(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: FollowDto, @Req() req: Request) {
    const s = await this.prisma.strategy.findUnique({ where: { id }, include: { _count: { select: { followers: true } } } });
    if (!s || s.status === 'ARCHIVED' || s.status === 'DRAFT') throw new NotFoundException('Strategy not available');
    // Broker account is optional: without a demat the strategy runs on paper (internal paper account).
    const account = dto.brokerAccountId
      ? await this.prisma.brokerAccount.findFirst({ where: { id: dto.brokerAccountId, userId: user.id } })
      : await this.prisma.brokerAccount
          .findMany({ where: { userId: user.id, mode: 'TRADING', broker: { not: 'MOCK' } }, orderBy: { createdAt: 'asc' } })
          .then(async (list) => list.find((a) => a.status === 'CONNECTED') ?? list[0] ?? (await this.trading.ensureLedgerAccount(user.id)));
    if (!account) throw new BadRequestException('Choose one of your broker accounts');
    if (account.mode === 'DATA_ONLY') throw new BadRequestException('This account is a data-only (master) account and cannot receive orders.');
    if (dto.allocationMode === 'FIXED_QUANTITY' && !dto.fixedQuantity && !dto.fixedLots) throw new BadRequestException('Fixed quantity or fixed lots is required');
    if (dto.allocationMode === 'CAPITAL_PERCENTAGE' && !dto.allocationPercent) throw new BadRequestException('Allocation % is required');
    if (dto.allocationMode === 'PROPORTIONAL' && !dto.allocationAmount) throw new BadRequestException('Capital amount is required');
    const existing = await this.prisma.strategyFollower.findUnique({ where: { strategyId_followerUserId: { strategyId: id, followerUserId: user.id } } });
    if (!existing || (isRemoved(existing) && existing.stoppedByUserId !== user.id)) {
      throw new ForbiddenException('This strategy is not assigned to you — ask your master to assign it.');
    }
    // Connecting from the marketplace: a new (or previously disconnected) subscription takes a free seat.
    if ((!existing || isRemoved(existing)) && s.maxFollowers) {
      const taken = await this.prisma.strategyFollower.count({ where: { strategyId: id, NOT: { copyStatus: 'OFF', stoppedReason: REMOVED_REASON } } });
      if (taken >= s.maxFollowers) throw new BadRequestException('This strategy is full');
    }
    const data = {
      brokerAccountId: account.id,
      allocationMode: dto.allocationMode,
      allocationAmount: dto.allocationAmount ?? null,
      allocationPercent: dto.allocationPercent ?? null,
      fixedQuantity: dto.fixedQuantity ?? null,
      fixedLots: dto.fixedLots ?? null,
      maxLots: dto.maxLots ?? null,
      maxQuantity: dto.maxQuantity ?? null,
      maxTradeValue: dto.maxTradeValue ?? null,
      maxDailyLoss: dto.maxDailyLoss ?? null,
      maxTradesPerDay: dto.maxTradesPerDay ?? null,
      allowedSegments: dto.allowedSegments ?? [],
      // Re-connecting a disconnected strategy makes it visible again.
      ...(existing && isRemoved(existing) ? { stoppedReason: null } : {}),
    };
    const row = await this.prisma.strategyFollower.upsert({
      where: { strategyId_followerUserId: { strategyId: id, followerUserId: user.id } },
      create: { strategyId: id, followerUserId: user.id, ...data },
      update: data,
      include: { strategy: { select: { name: true } } },
    });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.id, targetType: 'StrategyFollower', targetId: row.id, metadata: { strategyId: id, ...dto }, client: clientInfo(req) });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: account.id, userId: user.id });
    // New lot multiplier also applies to trades already booked (still open) in this strategy.
    let resized: Awaited<ReturnType<PositionResizeService['resizeOpen']>> = [];
    // Test mode: a lot change only RE-STATES trades on the website (trade book / P&L) — no orders are placed.
    if (dto.applyToOpenTrades === true && process.env.ALLOW_LIVE_RESIZE === 'true') {
      try {
        resized = await this.resizer.resizeOpen(row.id, user.id);
      } catch (err) {
        resized = [{ symbol: '—', from: 0, to: 0, side: 'BUY', quantity: 0, ok: false, error: (err as Error).message }];
      }
    }
    return { ...toStrategyFollowerView(row), resized };
  }

  @HttpCode(HttpStatus.OK)
  @Post('subscriptions/:id/:action')
  async toggle(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('action') action: string, @Req() req: Request) {
    if (action !== 'start' && action !== 'stop') throw new NotFoundException();
    const sub = await this.prisma.strategyFollower.findFirst({ where: { id, followerUserId: user.id }, include: { brokerAccount: true } });
    if (!sub) throw new NotFoundException('Subscription not found');
    if (action === 'start' && isRemoved(sub)) throw new BadRequestException('This strategy is no longer assigned to you.');
    let accountId = sub.brokerAccountId;
    if (action === 'start') {
      const a = sub.brokerAccount;
      // No demat yet → paper trading on the internal paper account. A demat is needed only for LIVE orders.
      if (!a) accountId = (await this.trading.ensureLedgerAccount(user.id)).id;
      else if (!this.trading.isSimulated(a) && a.status !== 'CONNECTED') {
        throw new BadRequestException('Live trading needs your demat connected — log in to your broker, or switch to Paper on the dashboard.');
      }
      if (a?.mode === 'DATA_ONLY') throw new BadRequestException('A data-only (master) account cannot be used for copy trading.');
    }
    const row = await this.prisma.strategyFollower.update({
      where: { id },
      data:
        action === 'start'
          ? { copyStatus: 'ON', startedAt: new Date(), stoppedAt: null, stoppedReason: null, brokerAccountId: accountId }
          : { copyStatus: 'OFF', stoppedAt: new Date(), stoppedReason: 'Stopped by client', stoppedByUserId: user.id },
      include: { strategy: { select: { name: true } } },
    });
    await this.audit.log({ action: action === 'start' ? 'COPY_STARTED' : 'COPY_STOPPED', actorUserId: user.id, targetType: 'StrategyFollower', targetId: id, client: clientInfo(req) });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: accountId ?? '', userId: user.id });
    return toStrategyFollowerView(row);
  }

  /** Personal kill switch: stop all my copying and exit all my open positions (MARKET). */
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('exit-all')
  async exitAll(@CurrentUser() user: RequestUser) {
    const results = await this.risk.exitAllForUser(user.id);
    return { orders: results.reduce((s, r) => s + r.orders, 0), failed: results.reduce((s, r) => s + r.failed, 0), results };
  }

  /** Clients may not exit single positions — exits come from the master (or "Exit all & stop copy"). */
  @HttpCode(HttpStatus.FORBIDDEN)
  @Post('positions/exit')
  exitPosition() {
    throw new ForbiddenException('Position exit is managed by your master trader.');
  }

  // ------------------------------------------------------------- portfolio

  /** Today's trade book: which strategy (algo) each trade came from, entry / exit, lots and P&L. */
  @Get('trades')
  tradeBook(@CurrentUser() user: RequestUser) {
    return this.summary.tradeBook(user.id);
  }

  /**
   * My positions, holdings and orders. Platform history (copied trades, closed paper positions) is shown for
   * TODAY only (IST trading day) — it starts empty every morning. Holdings come straight from the broker.
   */
  @Get('portfolio')
  async portfolio(@CurrentUser() user: RequestUser) {
    const since = startOfTradingDayIST();
    const [live, paper, copyOrders, day] = await Promise.all([
      this.trading.liveData(user.id),
      this.prisma.position.findMany({
        where: { userId: user.id, isPaper: true, OR: [{ quantity: { not: 0 } }, { updatedAt: { gte: since } }] },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.copyOrder.findMany({
        where: { followerUserId: user.id, createdAt: { gte: since }, NOT: { strategyFollower: { copyStatus: 'OFF', stoppedReason: REMOVED_REASON } } },
        include: { strategyFollower: { select: { strategy: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      }),
      this.summary.today(user.id),
    ]);
    const myAccounts = await this.prisma.brokerAccount.findMany({ where: { userId: user.id, broker: { not: 'MOCK' }, mode: 'TRADING' } });
    return {
      /** true = my trading account is on Paper (my own switch). */
      paperMode: myAccounts.length === 0 || myAccounts.every((a) => this.trading.isSimulated(a)),
      todayPnl: day.todayPnl,
      live: overlayLivePrices(live, this.prices, this.feed),
      paperPositions: paper.map((p) => paperPositionView(p, this.prices, this.feed)),
      copyOrders: copyOrders.map((c) => ({ ...toCopyOrderView(c), strategyName: c.strategyFollower.strategy.name })),
    };
  }
}
