import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type Redis from 'ioredis';
import type { PrismaClient, Strategy } from '@ctp/database';
import { hashPassword } from '@ctp/shared';
import { AssignLicenceDto, MasterClientCreateDto, MasterSubAdminDto, UpdateUserStatusDto } from '../admin/dto/admin.dto';
import { AssignStrategyDto } from './trading.dto';
import { AuditService } from '../audit/audit.service';
import { clientInfo } from '../common/client-info';
import { CurrentUser, RequestUser, Roles } from '../common/decorators/auth.decorators';
import { toBrokerAccountView, toCopyOrderView, toMasterTradeView, toStrategyFollowerView, toStrategyView } from '../common/mappers';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { BrokerApiError } from '../brokers/broker-http';
import { CopyEngineService } from './copy-engine.service';
import { RiskService } from './risk.service';
import { AccountEvents } from '../realtime/account-events';
import { MarketFeedService } from '../market-data/market-feed.service';
import { instrumentKey, PriceCacheService } from '../market-data/price-cache.service';
import { AssignClientDto, ClientHistoryQueryDto, EditSignalDto, ExitPositionDto, MasterOrderDto, SignalBookExitDto, SignalTpSlDto, StrategyDto, StrategyStatusDto } from './trading.dto';
import { SignalService } from './signal.service';
import { startOfTradingDayIST } from '../admin/admin.service';
import { ClientAssignService } from './client-assign.service';
import { ClientRegistryService } from './client-registry.service';
import { FNO_EXCHANGES, FnoCatalogService, type FnoExchange } from '../market-data/fno-catalog.service';
import { clientDirectory, clientOwner } from './client-directory';
import { BrokerSessionService } from '../brokers/broker-session.service';
import { allocationLabel, ClientSummaryService, isRemoved } from './client-summary.service';
import { REMOVED_REASON } from './follower-access';
import { licenceStatus } from '../common/mappers';
import { overlayLivePrices, paperPositionView } from './price-overlay';
import { TradingService } from './trading.service';
import { MasterOrderService } from './master-order.service';
import { WebhookService } from './webhook.service';
import { AutomationService } from './automation.service';
import { emailTrialUsed, isTrialLicence, licenceExpiry, licenceHistory, trialUsed } from '../common/licence';

/** Everything a master trader needs: strategies, followers, live account data and trade placement. */
@Roles('MASTER')
@Controller('master')
export class MasterController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly trading: TradingService,
    private readonly engine: CopyEngineService,
    private readonly audit: AuditService,
    private readonly risk: RiskService,
    private readonly accountEvents: AccountEvents,
    private readonly prices: PriceCacheService,
    private readonly feed: MarketFeedService,
    private readonly assigner: ClientAssignService,
    private readonly signals: SignalService,
    private readonly summary: ClientSummaryService,
    private readonly fno: FnoCatalogService,
    private readonly registry: ClientRegistryService,
    private readonly sessions: BrokerSessionService,
    private readonly orders: MasterOrderService,
    private readonly hooks: WebhookService,
    private readonly automation: AutomationService,
  ) {}

  private async own(user: RequestUser, id: string): Promise<Strategy> {
    const s = await this.prisma.strategy.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Strategy not found');
    if (s.masterUserId !== user.id) throw new ForbiddenException('Not your strategy');
    return s;
  }

  // ------------------------------------------------------------ strategies

  @Get('strategies')
  async strategies(@CurrentUser() user: RequestUser) {
    const rows = await this.prisma.strategy.findMany({
      where: { masterUserId: user.id, status: { not: 'ARCHIVED' } },
      include: { _count: { select: { followers: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const active = await this.prisma.strategyFollower.groupBy({
      by: ['strategyId'],
      where: { strategyId: { in: rows.map((r) => r.id) }, copyStatus: 'ON' },
      _count: true,
    });
    const activeMap = new Map(active.map((a) => [a.strategyId, a._count]));
    return rows.map((r) => toStrategyView(r, activeMap.get(r.id) ?? 0));
  }

  @Post('strategies')
  async create(@CurrentUser() user: RequestUser, @Body() dto: StrategyDto, @Req() req: Request) {
    const s = await this.prisma.strategy.create({
      data: {
        masterUserId: user.id,
        name: dto.name,
        description: dto.description,
        riskLevel: dto.riskLevel ?? 'MEDIUM',
        allowedExchanges: dto.allowedExchanges ?? [],
        allowedInstruments: (dto.allowedInstruments ?? []).map((x) => x.toUpperCase()),
        maxFollowers: dto.maxFollowers,
        masterCapital: dto.masterCapital,
        maxOrderValue: dto.maxOrderValue,
        maxQuantityPerOrder: dto.maxQuantityPerOrder,
      },
    });
    await this.audit.log({ action: 'STRATEGY_CREATED', actorUserId: user.id, targetType: 'Strategy', targetId: s.id, client: clientInfo(req) });
    return toStrategyView(s);
  }

  @Patch('strategies/:id')
  async update(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: StrategyDto, @Req() req: Request) {
    await this.own(user, id);
    const s = await this.prisma.strategy.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description ?? null,
        riskLevel: dto.riskLevel,
        allowedExchanges: dto.allowedExchanges,
        allowedInstruments: dto.allowedInstruments?.map((x) => x.toUpperCase()),
        maxFollowers: dto.maxFollowers ?? null,
        masterCapital: dto.masterCapital,
        maxOrderValue: dto.maxOrderValue ?? null,
        maxQuantityPerOrder: dto.maxQuantityPerOrder ?? null,
      },
    });
    await this.audit.log({ action: 'STRATEGY_UPDATED', actorUserId: user.id, targetType: 'Strategy', targetId: id, client: clientInfo(req) });
    return toStrategyView(s);
  }

  @HttpCode(HttpStatus.OK)
  @Post('strategies/:id/status')
  async setStatus(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: StrategyStatusDto, @Req() req: Request) {
    await this.own(user, id);
    const s = await this.prisma.strategy.update({ where: { id }, data: { status: dto.status } });
    if (dto.status === 'ACTIVE') {
      // Re-baseline the master's order books so orders placed before activation are never copied.
      const accounts = await this.prisma.brokerAccount.findMany({ where: { userId: user.id }, select: { id: true } });
      if (accounts.length) await this.redis.del(...accounts.map((a) => `ctp:poll:seen:${a.id}`));
    }
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId: user.id });
    await this.audit.log({
      action: dto.status === 'ACTIVE' ? 'STRATEGY_STARTED' : dto.status === 'PAUSED' ? 'STRATEGY_STOPPED' : 'STRATEGY_UPDATED',
      actorUserId: user.id,
      targetType: 'Strategy',
      targetId: id,
      metadata: { status: dto.status },
      client: clientInfo(req),
    });
    return toStrategyView(s);
  }

  // ------------------------------------------------------------- followers

  @Get('strategies/:id/followers')
  async followers(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.own(user, id);
    const rows = await this.prisma.strategyFollower.findMany({
      where: { strategyId: id },
      include: { follower: { select: { name: true, email: true, mobile: true } }, brokerAccount: true },
      orderBy: { createdAt: 'desc' },
    }).then((r) => r.filter((x) => !isRemoved(x)));
    const pnl = await this.prisma.position.groupBy({
      by: ['userId'],
      where: { userId: { in: rows.map((r) => r.followerUserId) } },
      _sum: { realizedPnl: true, unrealizedPnl: true },
    });
    const pnlMap = new Map(pnl.map((p) => [p.userId, p._sum]));
    return rows.map((r) => ({
      ...toStrategyFollowerView(r),
      followerEmail: r.follower.email,
      followerMobile: r.follower.mobile,
      brokerAccount: r.brokerAccount ? toBrokerAccountView(r.brokerAccount) : null,
      paperRealizedPnl: pnlMap.get(r.followerUserId)?.realizedPnl?.toString() ?? '0',
      paperUnrealizedPnl: pnlMap.get(r.followerUserId)?.unrealizedPnl?.toString() ?? '0',
    }));
  }

  /** Assign a client (by email) to one of my strategies, with allocation; optionally start copying right away. */
  @HttpCode(HttpStatus.OK)
  @Post('strategies/:id/assign')
  async assign(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: AssignClientDto) {
    const s = await this.own(user, id);
    const { follower, warning, resized } = await this.assigner.assign(s, dto, user.id, { byMaster: true });
    return { follower: toStrategyFollowerView(follower), warning, resized };
  }

  /** Remove a client from one of my strategies (copying stops; open positions are left as they are). */
  @HttpCode(HttpStatus.OK)
  @Post('strategies/:id/followers/:followerId/remove')
  async unassign(@CurrentUser() user: RequestUser, @Param('id') id: string, @Param('followerId') followerId: string) {
    await this.own(user, id);
    return toStrategyFollowerView(await this.assigner.unassign(id, followerId, user.id));
  }

  /** Exit one running position of one of my clients (MARKET, full broker quantity). */
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('clients/:userId/positions/exit')
  async exitClientPosition(@CurrentUser() user: RequestUser, @Param('userId') userId: string, @Body() dto: ExitPositionDto) {
    const link = await this.prisma.strategyFollower.findFirst({ where: { followerUserId: userId, strategy: { masterUserId: user.id } } });
    if (!link) throw new ForbiddenException('This client does not follow any of your strategies');
    const account = await this.prisma.brokerAccount.findFirst({ where: { id: dto.accountId, userId } });
    if (!account) throw new NotFoundException('Broker account not found for this client');
    try {
      return await this.risk.exitPosition(account, dto, user.id);
    } catch (err) {
      if (err instanceof BrokerApiError) throw new BadRequestException(await this.trading.handleBrokerError(account, err));
      throw err;
    }
  }

  /** F&O underlyings for the order form (index + stock options / futures, MCX) — from the broker instrument list. */
  @Get('fno/scripts')
  fnoScripts(@Query('exchange') exchange?: string, @Query('q') q?: string) {
    const ex = (exchange ?? 'NFO').toUpperCase();
    if (!(FNO_EXCHANGES as readonly string[]).includes(ex)) throw new BadRequestException('exchange must be NFO, BFO or MCX');
    return this.fno.scripts(ex as FnoExchange, (q ?? '').slice(0, 40));
  }

  /** Live expiries (nearest first) with lot size and strikes for one underlying. */
  @Get('fno/chain')
  fnoChain(@Query('exchange') exchange?: string, @Query('name') name?: string, @Query('kind') kind?: string) {
    const ex = (exchange ?? 'NFO').toUpperCase();
    if (!(FNO_EXCHANGES as readonly string[]).includes(ex)) throw new BadRequestException('exchange must be NFO, BFO or MCX');
    if (!name?.trim()) throw new BadRequestException('name is required');
    return this.fno.chain(ex as FnoExchange, name.slice(0, 40), kind === 'FUT' ? 'FUT' : 'OPT');
  }

  /** Client picker for "Assign client": active client accounts (search by name / email / mobile). */
  @Get('client-directory')
  clientDirectory(@CurrentUser() user: RequestUser, @Query('search') search?: string, @Query('strategyId') strategyId?: string) {
    return clientDirectory(this.prisma, search, strategyId, user.id);
  }

  // ------------------------------------------------------------ client licence & strategy access (by master)

  /** The client must be mine: created by me, or (no creator) first put on one of my strategies. */
  private async myClient(user: RequestUser, userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.role !== 'FOLLOWER' || u.deletedAt) throw new NotFoundException('Client not found');
    if ((await clientOwner(this.prisma, u)) !== user.id) throw new ForbiddenException('This client is not one of your clients');
    return u;
  }

  /** Assign / extend (extend=true) or set fresh (extend=false) a client's licence. */
  @HttpCode(HttpStatus.OK)
  @Post('clients/:userId/licence')
  async clientLicence(@CurrentUser() user: RequestUser, @Param('userId') userId: string, @Body() dto: AssignLicenceDto, @Req() req: Request) {
    const u = await this.myClient(user, userId);
    // The free trial (demo / 2 days) is given only once per client.
    if (isTrialLicence(dto.days, dto.demo) && (await trialUsed(this.prisma, userId))) throw new BadRequestException('This client already had the free trial (demo / 2 days) once — give a 1-month or custom licence.');
    await this.useLicence(user, dto.days, !!dto.demo);
    const now = new Date();
    const running = u.licenceExpiresAt && u.licenceExpiresAt > now;
    const extend = dto.extend !== false && running;
    // Runs to the end of the last day (IST) — never stops in the middle of a trading day.
    const expires = licenceExpiry(extend ? u.licenceExpiresAt! : now, dto.days);
    await this.prisma.user.update({ where: { id: userId }, data: { licenceDays: (extend ? (u.licenceDays ?? 0) : 0) + dto.days, licenceAssignedAt: now, licenceExpiresAt: expires, demo: !!dto.demo } });
    if (dto.demo) await this.prisma.brokerAccount.updateMany({ where: { userId, mode: 'TRADING' }, data: { isPaper: true } });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.actorId ?? user.id, targetType: 'User', targetId: userId, metadata: { licenceDays: dto.days, demo: !!dto.demo, extend: !!extend, expiresAt: expires.toISOString(), byMaster: true }, client: clientInfo(req) });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId });
    return { licenceExpiresAt: expires.toISOString() };
  }

  /** Licence history of one of my clients, newest first. */
  @Get('clients/:userId/licence-history')
  async clientLicenceHistory(@CurrentUser() user: RequestUser, @Param('userId') userId: string) {
    await this.myClient(user, userId);
    return licenceHistory(this.prisma, userId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/:userId/licence/revoke')
  async clientLicenceRevoke(@CurrentUser() user: RequestUser, @Param('userId') userId: string, @Req() req: Request) {
    await this.myClient(user, userId);
    await this.prisma.user.update({ where: { id: userId }, data: { licenceExpiresAt: new Date() } });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.actorId ?? user.id, targetType: 'User', targetId: userId, metadata: { licenceRevoked: true, byMaster: true }, client: clientInfo(req) });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId });
    return { revoked: true };
  }

  /**
   * Licence limit set by the admin: a 30-day / custom licence uses one licence from the master's quota.
   * Demo and 2-day (trial) licences are free — they never count against the limit. Custom periods need the
   * admin's permission.
   */
  private async useLicence(user: RequestUser, days: number, demo: boolean): Promise<void> {
    const m = await this.prisma.user.findUnique({ where: { id: user.id }, select: { licenceQuota: true, licenceCustomAllowed: true } });
    if (!m) throw new NotFoundException('Master not found');
    if (!demo && days !== 2 && days !== 30 && !m.licenceCustomAllowed) throw new ForbiddenException('Custom licence period is not enabled for you — ask the admin.');
    if (demo || days === 2) return; // demo and 2-day trial licences are free
    const r = await this.prisma.user.updateMany({ where: { id: user.id, licenceQuota: { gt: 0 } }, data: { licenceQuota: { decrement: 1 } } });
    if (!r.count) throw new BadRequestException('No licences left in your limit — ask the admin to add more.');
  }

  /** My licence limit (remaining) and whether custom periods are allowed. */
  @Get('licence-quota')
  async licenceQuota(@CurrentUser() user: RequestUser) {
    const m = await this.prisma.user.findUnique({ where: { id: user.id }, select: { licenceQuota: true, licenceCustomAllowed: true } });
    return { remaining: m?.licenceQuota ?? 0, customAllowed: m?.licenceCustomAllowed ?? false };
  }

  /** Create a new client (logs in on the client login page). Optional licence right away. */
  @Post('clients')
  async createClient(@CurrentUser() user: RequestUser, @Body() dto: MasterClientCreateDto, @Req() req: Request) {
    if (await this.prisma.user.findUnique({ where: { email: dto.email } })) throw new BadRequestException('A user with this email already exists');
    if (dto.licenceDays && isTrialLicence(dto.licenceDays, dto.demo) && (await emailTrialUsed(this.prisma, dto.email))) throw new BadRequestException('This client already had the free trial (demo / 2 days) once — give a 1-month or custom licence.');
    if (dto.licenceDays) await this.useLicence(user, dto.licenceDays, !!dto.demo);
    const now = new Date();
    const u = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        mobile: dto.mobile ?? null,
        role: 'FOLLOWER',
        parentUserId: user.id,
        demo: !!dto.demo,
        passwordHash: await hashPassword(dto.password),
        emailVerifiedAt: now,
        ...(dto.licenceDays ? { licenceDays: dto.licenceDays, licenceAssignedAt: now, licenceExpiresAt: licenceExpiry(now, dto.licenceDays) } : {}),
      },
    });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.actorId ?? user.id, targetType: 'User', targetId: u.id, metadata: { createdByMaster: true, licenceDays: dto.licenceDays ?? null, demo: !!dto.demo, ...(dto.licenceDays ? { expiresAt: u.licenceExpiresAt?.toISOString() } : {}) }, client: clientInfo(req) });
    return { id: u.id, name: u.name, email: u.email };
  }

  /** My strategies with this client's assignment (null = not assigned). */
  @Get('clients/:userId/strategies')
  async clientStrategies(@CurrentUser() user: RequestUser, @Param('userId') userId: string) {
    await this.myClient(user, userId);
    const [strategies, subs] = await Promise.all([
      this.prisma.strategy.findMany({ where: { masterUserId: user.id, status: { not: 'ARCHIVED' } }, include: { master: { select: { name: true } } }, orderBy: { name: 'asc' } }),
      this.prisma.strategyFollower.findMany({ where: { followerUserId: userId, strategy: { masterUserId: user.id } } }),
    ]);
    const bySid = new Map(subs.map((x) => [x.strategyId, x]));
    return strategies.map((st) => {
      const sub = bySid.get(st.id);
      const assigned = !!sub && !isRemoved(sub);
      return { strategyId: st.id, name: st.name, masterName: st.master.name, status: st.status, assigned, subscription: assigned && sub ? { ...toStrategyFollowerView(sub), allocation: allocationLabel(sub) } : null };
    });
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/:userId/strategies/:strategyId')
  async clientAssign(@CurrentUser() user: RequestUser, @Param('userId') userId: string, @Param('strategyId') strategyId: string, @Body() dto: AssignStrategyDto) {
    const u = await this.myClient(user, userId);
    const s = await this.own(user, strategyId);
    const { follower, warning, resized } = await this.assigner.assign(s, { ...dto, email: u.email }, user.actorId ?? user.id, { byMaster: true });
    return { follower: toStrategyFollowerView(follower), warning, resized };
  }

  @HttpCode(HttpStatus.OK)
  @Post('clients/:userId/strategies/:strategyId/remove')
  async clientUnassign(@CurrentUser() user: RequestUser, @Param('userId') userId: string, @Param('strategyId') strategyId: string) {
    await this.own(user, strategyId);
    const sub = await this.prisma.strategyFollower.findUnique({ where: { strategyId_followerUserId: { strategyId, followerUserId: userId } } });
    if (!sub) throw new NotFoundException('This strategy is not assigned to the client');
    return toStrategyFollowerView(await this.assigner.unassign(strategyId, sub.id, user.actorId ?? user.id));
  }

  /**
   * Delete one of my clients: removed from all my strategies (copying stops), logged out everywhere, broker
   * disconnected and its saved broker keys wiped, login blocked and the email freed for reuse. Past trades stay
   * in trade history. Open positions in the client's broker are NOT closed — exit them first.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('clients/:userId/delete')
  async deleteClient(@CurrentUser() user: RequestUser, @Param('userId') userId: string, @Req() req: Request) {
    if (user.actorId) throw new ForbiddenException('Only the master can delete a client');
    const u = await this.myClient(user, userId);
    const now = new Date();
    const reason = 'Client deleted by master';
    const accounts = await this.prisma.brokerAccount.findMany({ where: { userId, broker: { not: 'MOCK' }, status: { not: 'DISCONNECTED' } } });
    for (const a of accounts) {
      await this.sessions.disconnectAccount(a, { by: 'admin', reason, actorUserId: user.id, stopCopy: true }, clientInfo(req)).catch(() => undefined);
    }
    await this.prisma.$transaction([
      this.prisma.strategyFollower.updateMany({
        where: { followerUserId: userId },
        data: { copyStatus: 'OFF', stoppedAt: now, stoppedReason: REMOVED_REASON, stoppedByUserId: user.id },
      }),
      this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } }),
      this.prisma.brokerApiConfig.deleteMany({ where: { userId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: { deletedAt: now, status: 'DISABLED', disabledAt: now, disabledReason: reason, email: `deleted.${userId}@deleted.invalid`, mobile: null, telegramChatId: null },
      }),
    ]);
    this.registry.scheduleReload(0);
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.id, targetType: 'User', targetId: userId, metadata: { clientDeleted: true, name: u.name, email: u.email }, client: clientInfo(req) });
    return { deleted: true };
  }

  // ------------------------------------------------------------ sub-admins (staff working for this master)

  private noSubAdmin(user: RequestUser) {
    if (user.actorId) throw new ForbiddenException('Only the master can manage sub-admins');
  }

  @Get('sub-admins')
  async subAdmins(@CurrentUser() user: RequestUser) {
    this.noSubAdmin(user);
    const rows = await this.prisma.user.findMany({
      where: { parentUserId: user.id, role: 'SUB_ADMIN' },
      select: { id: true, name: true, email: true, mobile: true, status: true, createdAt: true, lastLoginAt: true },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), lastLoginAt: r.lastLoginAt?.toISOString() ?? null }));
  }

  @Post('sub-admins')
  async createSubAdmin(@CurrentUser() user: RequestUser, @Body() dto: MasterSubAdminDto, @Req() req: Request) {
    this.noSubAdmin(user);
    if (await this.prisma.user.findUnique({ where: { email: dto.email } })) throw new BadRequestException('A user with this email already exists');
    const u = await this.prisma.user.create({
      data: { name: dto.name, email: dto.email, mobile: dto.mobile ?? null, role: 'SUB_ADMIN', parentUserId: user.id, passwordHash: await hashPassword(dto.password), emailVerifiedAt: new Date() },
    });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.id, targetType: 'User', targetId: u.id, metadata: { subAdminCreated: true }, client: clientInfo(req) });
    return { id: u.id, name: u.name, email: u.email };
  }

  @HttpCode(HttpStatus.OK)
  @Post('sub-admins/:id/status')
  async subAdminStatus(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: UpdateUserStatusDto, @Req() req: Request) {
    this.noSubAdmin(user);
    const u = await this.prisma.user.findFirst({ where: { id, parentUserId: user.id, role: 'SUB_ADMIN' } });
    if (!u) throw new NotFoundException('Sub-admin not found');
    await this.prisma.user.update({ where: { id }, data: { status: dto.status } });
    if (dto.status !== 'ACTIVE') await this.prisma.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ action: dto.status === 'ACTIVE' ? 'ADMIN_ENABLED_USER' : 'ADMIN_DISABLED_USER', actorUserId: user.id, targetType: 'User', targetId: id, client: clientInfo(req) });
    return { id, status: dto.status };
  }

  /** Every client of my strategies (one row per client) with broker status, today's P&L and subscriptions. */
  @Get('clients')
  async clients(@CurrentUser() user: RequestUser) {
    const subs = await this.prisma.strategyFollower.findMany({
      where: { strategy: { masterUserId: user.id }, follower: { deletedAt: null } },
      include: {
        strategy: { select: { name: true } },
        follower: { select: { id: true, name: true, email: true, mobile: true, status: true, licenceExpiresAt: true, licenceDays: true } },
        brokerAccount: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    const byUser = new Map<string, typeof subs>();
    // A client stays in my list even after all strategies are removed (so they can be re-assigned),
    // and clients I created show up before any strategy is given to them.
    for (const s of subs) byUser.set(s.followerUserId, [...(byUser.get(s.followerUserId) ?? []), s]);
    const own = await this.prisma.user.findMany({ where: { parentUserId: user.id, role: 'FOLLOWER', deletedAt: null }, select: { id: true } });
    for (const o of own) if (!byUser.has(o.id)) byUser.set(o.id, []);
    const ids = [...byUser.keys()];
    const [users, accounts] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, email: true, mobile: true, status: true, licenceExpiresAt: true, licenceDays: true, demo: true } }),
      this.prisma.brokerAccount.findMany({ where: { userId: { in: ids }, broker: { not: 'MOCK' }, mode: 'TRADING' }, orderBy: { createdAt: 'asc' } }),
    ]);
    const userById = new Map(users.map((u) => [u.id, u]));
    const out = await Promise.all(
      [...byUser.entries()].map(async ([userId, list]) => {
        const f = userById.get(userId)!;
        // Real demat first (the internal paper account is not a broker).
        const account = list.find((x) => x.brokerAccount && x.brokerAccount.broker !== 'MOCK')?.brokerAccount ?? accounts.find((a) => a.userId === userId) ?? null;
        const day = await this.summary.today(userId, user.id);
        return {
          userId,
          name: f.name,
          email: f.email,
          mobile: f.mobile,
          status: f.status,
          licenceExpiresAt: f.licenceExpiresAt?.toISOString() ?? null,
          licenceDays: f.licenceDays,
          demo: f.demo,
          licenceStatus: licenceStatus(f.licenceExpiresAt),
          broker: account ? { ...toBrokerAccountView(account), simulated: this.trading.isSimulated(account) } : null,
          todayPnl: day.todayPnl,
          todayTrades: day.strategies.reduce((a, x) => a + x.todayTrades, 0),
          subscriptions: list.filter((x) => !isRemoved(x)).map((x) => ({ followerId: x.id, strategyId: x.strategyId, strategyName: x.strategy.name, copyStatus: x.copyStatus, allocation: allocationLabel(x) })),
        };
      }),
    );
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Full detail of one client for the master: profile, licence, broker, subscriptions to my strategies with
   * today's P&L, and the copied-trade history of my strategies (`range` = today | 7d | 30d | all).
   */
  @Get('clients/:userId')
  async client(@CurrentUser() user: RequestUser, @Param('userId') userId: string, @Query() q: ClientHistoryQueryDto) {
    const subsAll = await this.prisma.strategyFollower.findMany({
      where: { followerUserId: userId, strategy: { masterUserId: user.id } },
      include: { strategy: { select: { name: true } }, brokerAccount: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!subsAll.length && !(await this.prisma.user.count({ where: { id: userId, parentUserId: user.id } }))) {
      throw new ForbiddenException('This client does not follow any of your strategies');
    }
    const range = q.range ?? 'today';
    const since =
      range === 'today' ? startOfTradingDayIST() : range === '7d' ? new Date(Date.now() - 7 * 86_400_000) : range === '30d' ? new Date(Date.now() - 30 * 86_400_000) : undefined;
    const [u, accounts, day, orders] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, email: true, mobile: true, status: true, createdAt: true, lastLoginAt: true, licenceDays: true, licenceAssignedAt: true, licenceExpiresAt: true },
      }),
      this.prisma.brokerAccount.findMany({ where: { userId, broker: { not: 'MOCK' } }, orderBy: { createdAt: 'asc' } }),
      this.summary.today(userId, user.id),
      this.prisma.copyOrder.findMany({
        where: { followerUserId: userId, strategyFollowerId: { in: subsAll.map((s) => s.id) }, ...(since ? { createdAt: { gte: since } } : {}) },
        include: { strategyFollower: { select: { strategy: { select: { name: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 1000,
      }),
    ]);
    if (!u) throw new NotFoundException('Client not found');
    return {
      profile: {
        ...u,
        createdAt: u.createdAt.toISOString(),
        lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
        licenceAssignedAt: u.licenceAssignedAt?.toISOString() ?? null,
        licenceExpiresAt: u.licenceExpiresAt?.toISOString() ?? null,
        licenceStatus: licenceStatus(u.licenceExpiresAt),
      },
      brokerAccounts: accounts.map((a) => ({ ...toBrokerAccountView(a), simulated: this.trading.isSimulated(a) })),
      todayPnl: day.todayPnl,
      strategies: subsAll
        .filter((s) => !isRemoved(s))
        .map((s) => ({ ...toStrategyFollowerView(s), allocation: allocationLabel(s), today: day.strategies.find((d) => d.followerId === s.id) ?? null })),
      range,
      orders: orders.map((c) => ({ ...toCopyOrderView(c), strategyName: c.strategyFollower.strategy.name })),
    };
  }

  /** Live broker data of one of this master's followers (positions, holdings, orders, funds). */
  @Get('clients/:userId/live')
  async clientLive(@CurrentUser() user: RequestUser, @Param('userId') userId: string) {
    const link = await this.prisma.strategyFollower.findFirst({ where: { followerUserId: userId, strategy: { masterUserId: user.id } } });
    if (!link) throw new ForbiddenException('This client does not follow any of your strategies');
    const [live, paper] = await Promise.all([
      this.trading.liveData(userId),
      this.prisma.position.findMany({ where: { userId, isPaper: true, OR: [{ quantity: { not: 0 } }, { updatedAt: { gte: startOfTradingDayIST() } }] }, orderBy: { updatedAt: 'desc' } }),
    ]);
    return { live: overlayLivePrices(live, this.prices, this.feed), paperPositions: paper.map((p) => paperPositionView(p, this.prices, this.feed)) };
  }

  // ---------------------------------------------------------------- trades

  @Get('trades')
  async trades(@CurrentUser() user: RequestUser, @Query('strategyId') strategyId?: string) {
    const rows = await this.prisma.masterTrade.findMany({
      where: { masterUserId: user.id, ...(strategyId ? { strategyId } : {}) },
      include: { _count: { select: { copyOrders: true } }, copyOrders: { select: { status: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return rows.map((t) => {
      const counts: Record<string, number> = {};
      for (const c of t.copyOrders) counts[c.status] = (counts[c.status] ?? 0) + 1;
      return { ...toMasterTradeView(t), copyStatusCounts: counts };
    });
  }

  @Get('trades/:id')
  async trade(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    const t = await this.prisma.masterTrade.findFirst({
      where: { id, masterUserId: user.id },
      include: { copyOrders: { include: { follower: { select: { name: true } } }, orderBy: { createdAt: 'asc' } } },
    });
    if (!t) throw new NotFoundException('Trade not found');
    return { ...toMasterTradeView(t), copyOrders: t.copyOrders.map(toCopyOrderView) };
  }

  /** Places an order on the master's account (or simulates it in paper mode) and copies it to all active followers. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('orders')
  async placeOrder(@CurrentUser() user: RequestUser, @Body() dto: MasterOrderDto) {
    const strategy = await this.own(user, dto.strategyId);
    const summary = await this.orders.place(user.id, strategy, dto);
    return { ...(await this.trade(user, summary.tradeId)), fanOutMs: summary.totalMs };
  }

  // --------------------------------------------------------------- TradingView / alert webhook

  /** Webhook of one of my strategies: URL (when on) and the last alerts with their result. Master only (the URL is a secret). */
  @Get('strategies/:id/webhook')
  async webhook(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    if (user.actorId) throw new ForbiddenException('Only the master can see the webhook');
    const s = await this.own(user, id);
    return this.webhookInfo(s.id, s.webhookToken);
  }

  private async webhookInfo(id: string, token: string | null) {
    return {
      enabled: !!token,
      url: token ? this.hooks.url(token) : null,
      chartinkUrl: token ? this.hooks.chartinkUrl(token) : null,
      recent: await this.hooks.recent(id),
    };
  }

  // --------------------------------------------------------------- automation (schedule, trailing SL, daily limit, re-entry, Chartink)

  @Get('strategies/:id/automation')
  async automationGet(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    if (user.actorId) throw new ForbiddenException('Only the master can see automation');
    const s = await this.own(user, id);
    return { settings: this.automation.get(s), today: await this.automation.today(s.id) };
  }

  /** Timed entries / exits of all my strategies (each names the strategy it trades in). */
  @Get('automation/schedules')
  async schedulesList(@CurrentUser() user: RequestUser) {
    if (user.actorId) throw new ForbiddenException('Only the master can see automation');
    return this.automation.listSchedules(user.id);
  }

  @Put('automation/schedules')
  async schedulesSave(@CurrentUser() user: RequestUser, @Body() body: unknown, @Req() req: Request) {
    if (user.actorId) throw new ForbiddenException('Only the master can change automation');
    const out = await this.automation.saveSchedules(user.id, body);
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.id, targetType: 'Strategy', metadata: { schedules: out.map((s) => ({ strategyId: s.strategyId, name: s.name, entry: s.entryTime, exit: s.exitTime, enabled: s.enabled })) }, client: clientInfo(req) });
    return out;
  }

  @Put('strategies/:id/automation')
  async automationSave(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    if (user.actorId) throw new ForbiddenException('Only the master can change automation');
    const s = await this.own(user, id);
    const settings = await this.automation.save(s, body);
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.id, targetType: 'Strategy', targetId: s.id, metadata: { automation: settings as unknown as Record<string, unknown> }, client: clientInfo(req) });
    return { settings, today: await this.automation.today(s.id) };
  }

  /** Turns the webhook on, or gives it a new secret URL (the old URL stops working). */
  @HttpCode(HttpStatus.OK)
  @Post('strategies/:id/webhook')
  async webhookRotate(@CurrentUser() user: RequestUser, @Param('id') id: string, @Req() req: Request) {
    if (user.actorId) throw new ForbiddenException('Only the master can change the webhook');
    const s = await this.own(user, id);
    const token = await this.hooks.rotate(s.id);
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.id, targetType: 'Strategy', targetId: s.id, metadata: { webhook: s.webhookToken ? 'rotated' : 'enabled' }, client: clientInfo(req) });
    return this.webhookInfo(s.id, token);
  }

  @Delete('strategies/:id/webhook')
  async webhookDisable(@CurrentUser() user: RequestUser, @Param('id') id: string, @Req() req: Request) {
    if (user.actorId) throw new ForbiddenException('Only the master can change the webhook');
    const s = await this.own(user, id);
    await this.hooks.disable(s.id);
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: user.id, targetType: 'Strategy', targetId: s.id, metadata: { webhook: 'disabled' }, client: clientInfo(req) });
    return this.webhookInfo(s.id, null);
  }

  /**
   * Strategy exit: squares off every OPEN signal of the strategy (master + followers, moved to history), then
   * exits any copy position still left at followers (MARKET).
   */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('strategies/:id/exit-all')
  async exitAll(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    await this.own(user, id);
    const sig = await this.signals.squareOffStrategy(id, user.id);
    const results = await this.risk.exitStrategy(id);
    return {
      signalsClosed: sig.closed,
      orders: results.reduce((s, r) => s + r.orders, 0),
      failed: sig.failed + results.reduce((s, r) => s + r.failed, 0),
      errors: [...sig.errors, ...results.flatMap((r) => r.errors)],
      results,
    };
  }

  // --------------------------------------------------------------- signals

  /** Executed signals with entry / exit / TP-SL / P&L. `scope=today` (default) or `all`. */
  @Get('signals')
  async signalList(
    @CurrentUser() user: RequestUser,
    @Query('status') status?: string,
    @Query('scope') scope?: string,
    @Query('from') fromQ?: string,
    @Query('to') toQ?: string,
    @Query('strategyIds') ids?: string,
  ) {
    const st = status === 'open' || status === 'closed' ? status : 'all';
    const day = /^\d{4}-\d{2}-\d{2}/;
    const from = fromQ && day.test(fromQ) ? new Date(`${fromQ.slice(0, 10)}T00:00:00+05:30`) : scope === 'all' ? undefined : startOfTradingDayIST();
    const to = toQ && day.test(toQ) ? new Date(`${toQ.slice(0, 10)}T23:59:59.999+05:30`) : undefined;
    const strategyIds = ids ? ids.split(',').filter(Boolean).slice(0, 50) : undefined;
    return this.signals.list(user.id, { status: st, from, to, strategyIds });
  }

  /** Correct entry / exit / quantity of one of MY signals in trade history (copy orders unchanged). */
  @Patch('signals/:id')
  editSignal(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: EditSignalDto) {
    return this.signals.edit(id, dto, user.id, user.id);
  }

  /** Remove one of MY closed signals from history (soft delete). */
  @Delete('signals/:id')
  deleteSignal(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.signals.remove(id, user.id, user.id);
  }

  /** Square off ONE signal for the master and every follower (MARKET). */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('signals/:id/square-off')
  squareOffSignal(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.signals.squareOff(user.id, id, 'SQUARE_OFF', user.id);
  }

  /** Exit ONE row of my signal book (virtual position): its open signals for me + all clients, then the book. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('signal-book/exit')
  exitSignalBook(@CurrentUser() user: RequestUser, @Body() dto: SignalBookExitDto) {
    return this.signals.exitBookPosition(user.id, dto);
  }

  /** Set / change / clear the target and stop loss of ONE signal (null clears). */
  @Patch('signals/:id/tpsl')
  setTpSl(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: SignalTpSlDto) {
    return this.signals.setTpSl(user.id, id, dto.targetPrice ?? null, dto.stopLossPrice ?? null);
  }

  /** Average copy latency (ms) for the dashboard. */
  @Get('latency')
  async latency() {
    return this.engine.latency.snapshot();
  }

  // ------------------------------------------------------------------ live

  @Get('live')
  async live(@CurrentUser() user: RequestUser) {
    const [live, paper, accounts] = await Promise.all([
      this.trading.liveData(user.id, { hideZerodha: true }),
      this.prisma.position.findMany({ where: { userId: user.id, isPaper: true, OR: [{ quantity: { not: 0 } }, { updatedAt: { gte: startOfTradingDayIST() } }] }, orderBy: { updatedAt: 'desc' } }),
      this.prisma.brokerAccount.findMany({ where: { userId: user.id, broker: { not: 'ZERODHA' } } }),
    ]);
    return {
      paperMode: this.trading.isSimulated({ broker: 'ZERODHA', isPaper: false }),
      accounts: accounts.map(toBrokerAccountView),
      live: overlayLivePrices(live, this.prices, this.feed),
      paperPositions: paper.map((p) => paperPositionView(p, this.prices, this.feed)),
    };
  }

  /** LTP from the live price cache (fed by the master feed) — never a broker quote call. */
  @Get('ltp')
  async ltp(@Query('exchange') exchange: string, @Query('symbol') symbol: string) {
    if (!exchange || !symbol) return { ltp: null };
    this.feed.ensure(exchange.toUpperCase() as never, symbol.toUpperCase());
    const tick = this.prices.getTick(instrumentKey(exchange, symbol));
    return { ltp: tick?.ltp ?? null, ts: tick ? new Date(tick.ts).toISOString() : null };
  }
}
