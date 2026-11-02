import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma, PrismaClient } from '@ctp/database';
import type Redis from 'ioredis';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AdminDashboardStats,
  AdminUserDetail,
  AdminUserListItem,
  AuditLogView,
  BrokerAccountView,
  CopyHaltState,
  CopyOrderView,
  MasterTradeView,
  Paginated,
  PositionView,
  RedisKeys,
  StrategyView,
  SystemEventView,
  SystemHealthDetail,
} from '@ctp/types';
import { AuditService } from '../audit/audit.service';
import { TokenService, ClientInfo } from '../auth/token.service';
import type { RequestUser } from '../common/decorators/auth.decorators';
import {
  toAdminUserListItem,
  toAuditLogView,
  toBrokerAccountView,
  toCopyOrderView,
  toMasterTradeView,
  toPositionView,
  toStrategyFollowerView,
  toStrategyView,
  toSystemEventView,
} from '../common/mappers';
import { isRemoved } from '../trading/follower-access';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { API_CONFIG, ApiConfig } from '../config/config.module';
import { HealthService } from '../health/health.service';
import { BrokerSessionService } from '../brokers/broker-session.service';
import { AccountEvents } from '../realtime/account-events';
import {
  AdminAuditLogsQueryDto,
  AdminBrokerAccountsQueryDto,
  AdminCopyOrdersQueryDto,
  AdminMasterTradesQueryDto,
  AdminPositionsQueryDto,
  AdminStrategiesQueryDto,
  AdminSystemEventsQueryDto,
  AdminUsersQueryDto,
  UpdateUserStatusDto,
  AssignLicenceDto,
  CreateUserDto,
  UpdateUserDto,
} from './dto/admin.dto';
import { hashPassword } from '@ctp/shared';
import { licenceExpiry, licenceHistory } from '../common/licence';

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Midnight in India (IST, UTC+05:30) for the current trading day, as a UTC Date. */
export function startOfTradingDayIST(now: Date = new Date()): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

function dateRange(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
  if (!from && !to) return undefined;
  return { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lt: new Date(to) } : {}) };
}

function readVersion(): string {
  try {
    return (JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

@Injectable()
export class AdminService {
  private readonly startedAt = Date.now();
  private readonly version = readVersion();

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly audit: AuditService,
    private readonly tokens: TokenService,
    private readonly health: HealthService,
    private readonly sessions: BrokerSessionService,
    private readonly accountEvents: AccountEvents,
  ) {}

  // ------------------------------------------------------------------ dashboard

  async dashboard(): Promise<AdminDashboardStats> {
    const today = startOfTradingDayIST();
    const [
      totalUsers,
      connectedAccounts,
      activeMasters,
      activeFollowerGroups,
      activeStrategies,
      todaysMasterTrades,
      successfulCopyOrders,
      failedCopyOrders,
    ] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.brokerAccount.count({ where: { status: 'CONNECTED', broker: { not: 'MOCK' } } }),
      this.prisma.user.count({ where: { role: 'MASTER', status: 'ACTIVE', strategies: { some: { status: 'ACTIVE' } } } }),
      this.prisma.strategyFollower.groupBy({ by: ['followerUserId'], where: { copyStatus: 'ON' } }),
      this.prisma.strategy.count({ where: { status: 'ACTIVE' } }),
      this.prisma.masterTrade.count({ where: { createdAt: { gte: today } } }),
      this.prisma.copyOrder.count({ where: { createdAt: { gte: today }, status: 'FILLED' } }),
      this.prisma.copyOrder.count({ where: { createdAt: { gte: today }, status: { in: ['FAILED', 'REJECTED'] } } }),
    ]);
    const now = new Date();
    const ist = new Date(now.getTime() + 330 * 60_000);
    const monthStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 1) - 330 * 60_000);
    const lastMonthStart = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth() - 1, 1) - 330 * 60_000);
    const [newUsersThisMonth, newUsersLastMonth, expiredUsers, expiringThisWeek, activeClients] = await Promise.all([
      this.prisma.user.count({ where: { createdAt: { gte: monthStart } } }),
      this.prisma.user.count({ where: { createdAt: { gte: lastMonthStart, lt: monthStart } } }),
      this.prisma.user.count({ where: { licenceExpiresAt: { lte: now } } }),
      this.prisma.user.count({ where: { licenceExpiresAt: { gt: now, lte: new Date(now.getTime() + 7 * 86_400_000) } } }),
      this.prisma.user.count({ where: { role: 'FOLLOWER', status: 'ACTIVE', brokerAccounts: { some: { status: 'CONNECTED', mode: 'TRADING', broker: { not: 'MOCK' } } } } }),
    ]);
    return {
      totalUsers,
      connectedAccounts,
      activeMasters,
      activeFollowers: activeFollowerGroups.length,
      activeStrategies,
      todaysMasterTrades,
      successfulCopyOrders,
      failedCopyOrders,
      paperMode: this.config.PAPER_MODE,
      newUsersThisMonth,
      newUsersLastMonth,
      expiredUsers,
      expiringThisWeek,
      activeClients,
    };
  }

  // ------------------------------------------------------------------ users

  async listUsers(q: AdminUsersQueryDto): Promise<Paginated<AdminUserListItem>> {
    const where: Prisma.UserWhereInput = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.broker ? { brokerAccounts: { some: { broker: q.broker } } } : {}),
      ...licenceWhere(q.licence),
      ...(q.search
        ? {
            OR: [
              { email: { contains: q.search, mode: 'insensitive' } },
              { name: { contains: q.search, mode: 'insensitive' } },
              { mobile: { contains: q.search } },
            ],
          }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        include: {
          brokerAccounts: { select: { id: true, broker: true, status: true } },
          follows: { select: { strategyId: true, copyStatus: true, stoppedReason: true, strategy: { select: { name: true } } } },
        },
        orderBy: { createdAt: 'desc' },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);
    return {
      items: items.map((u) => ({
        ...toAdminUserListItem(u),
        assignedStrategies: u.follows.filter((f) => !isRemoved(f)).map((f) => ({ id: f.strategyId, name: f.strategy.name, copyStatus: f.copyStatus })),
      })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  // ------------------------------------------------------------------ add / edit / licence

  /** A sub-admin manages masters and clients only — never admins / sub-admins. */
  private guardStaff(actor: RequestUser, ...roles: (string | undefined | null)[]): void {
    if (actor.role === 'SUB_ADMIN' && roles.some((r) => r === 'ADMIN' || r === 'SUB_ADMIN')) {
      throw new ForbiddenException('A sub-admin cannot create or change admin / sub-admin accounts');
    }
  }

  async createUser(admin: RequestUser, dto: CreateUserDto, client: ClientInfo): Promise<AdminUserDetail> {
    this.guardStaff(admin, dto.role);
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new BadRequestException('A user with this email already exists');
    const now = new Date();
    const user = await this.prisma.user.create({
      data: {
        name: dto.name,
        email: dto.email,
        mobile: dto.mobile ?? null,
        role: dto.role,
        passwordHash: await hashPassword(dto.password),
        emailVerifiedAt: now, // created by an admin: no verification mail needed
        demo: dto.role === 'FOLLOWER' && !!dto.demo,
        ...(dto.licenceDays ? { licenceDays: dto.licenceDays, licenceAssignedAt: now, licenceExpiresAt: licenceExpiry(now, dto.licenceDays) } : {}),
      },
    });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: admin.id, targetType: 'User', targetId: user.id, metadata: { createdByAdmin: true, role: dto.role, licenceDays: dto.licenceDays ?? null, demo: dto.role === 'FOLLOWER' && !!dto.demo, ...(dto.licenceDays ? { expiresAt: user.licenceExpiresAt?.toISOString() } : {}) }, client });
    return this.getUser(user.id);
  }

  async updateUser(admin: RequestUser, id: string, dto: UpdateUserDto, client: ClientInfo): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    this.guardStaff(admin, user.role, dto.role);
    if (dto.role && dto.role !== user.role) {
      if (id === admin.id) throw new BadRequestException('You cannot change your own role');
      if (user.role === 'MASTER' && (await this.prisma.strategy.count({ where: { masterUserId: id, status: { in: ['ACTIVE', 'PAUSED'] } } }))) {
        throw new BadRequestException('Archive this master’s strategies before changing the role');
      }
      if (user.role === 'FOLLOWER' && (await this.prisma.strategyFollower.count({ where: { followerUserId: id, copyStatus: { not: 'OFF' } } }))) {
        throw new BadRequestException('Stop this client’s copy trading before changing the role');
      }
    }
    await this.prisma.user.update({ where: { id }, data: { name: dto.name, mobile: dto.mobile, role: dto.role } });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: admin.id, targetType: 'User', targetId: id, metadata: { ...dto, byAdmin: true }, client });
    return this.getUser(id);
  }

  /** Assigns (or extends) a licence. Copy trading resumes automatically for subscriptions that are ON. */
  async assignLicence(admin: RequestUser, id: string, dto: AssignLicenceDto, client: ClientInfo): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    this.guardStaff(admin, user.role);
    const now = new Date();
    const running = !!user.licenceExpiresAt && user.licenceExpiresAt > now;
    const extend = dto.extend !== false && running;
    // Runs to the end of the last day (IST) — never stops in the middle of a trading day.
    const expires = licenceExpiry(extend ? user.licenceExpiresAt! : now, dto.days);
    await this.prisma.user.update({
      where: { id },
      data: { licenceDays: (extend ? (user.licenceDays ?? 0) : 0) + dto.days, licenceAssignedAt: now, licenceExpiresAt: expires, demo: !!dto.demo },
    });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: admin.id, targetType: 'User', targetId: id, metadata: { licenceDays: dto.days, demo: !!dto.demo, extend, expiresAt: expires.toISOString() }, client });
    if (dto.demo) await this.prisma.brokerAccount.updateMany({ where: { userId: id, mode: 'TRADING' }, data: { isPaper: true } });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId: id });
    return this.getUser(id);
  }

  async licenceHistory(admin: RequestUser, id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (!user) throw new NotFoundException('User not found');
    this.guardStaff(admin, user.role);
    return licenceHistory(this.prisma, id);
  }

  async revokeLicence(admin: RequestUser, id: string, client: ClientInfo): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    this.guardStaff(admin, user.role);
    await this.prisma.user.update({ where: { id }, data: { licenceExpiresAt: new Date() } });
    await this.audit.log({ action: 'PROFILE_UPDATED', actorUserId: admin.id, targetType: 'User', targetId: id, metadata: { licenceRevoked: true }, client });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId: id });
    return this.getUser(id);
  }

  async getUser(id: string): Promise<AdminUserDetail> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: {
        brokerAccounts: { orderBy: { createdAt: 'asc' } },
        follows: { include: { strategy: { select: { name: true } } }, orderBy: { createdAt: 'desc' } },
        strategies: { include: { _count: { select: { followers: true } } }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return {
      ...toAdminUserListItem(user),
      brokerAccounts: user.brokerAccounts.map(toBrokerAccountView),
      follows: user.follows.map(toStrategyFollowerView),
      strategies: user.strategies.map((s) => toStrategyView(s)),
    };
  }

  /**
   * Disabling a user: revokes every session immediately, stops all of their copy subscriptions
   * and, for masters, pauses their active strategies so no follower copies their trades.
   * Re-enabling does NOT restart copying — the user must explicitly start it again.
   */
  async setUserStatus(admin: RequestUser, id: string, dto: UpdateUserStatusDto, client: ClientInfo): Promise<AdminUserDetail> {
    if (id === admin.id) throw new BadRequestException('You cannot change the status of your own account');
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');
    this.guardStaff(admin, user.role);

    if (dto.status === 'DISABLED') {
      if (!dto.reason) throw new BadRequestException('A reason is required to disable a user');
      if (user.status === 'DISABLED') throw new BadRequestException('User is already disabled');
      const now = new Date();
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data: { status: 'DISABLED', disabledAt: now, disabledReason: dto.reason } });
        const activeFollows = await tx.strategyFollower.findMany({ where: { followerUserId: id, copyStatus: { not: 'OFF' } } });
        if (activeFollows.length) {
          await tx.strategyFollower.updateMany({
            where: { id: { in: activeFollows.map((f) => f.id) } },
            data: { copyStatus: 'OFF', stoppedAt: now, stoppedReason: 'Account disabled by admin', stoppedByUserId: admin.id },
          });
          for (const f of activeFollows) {
            await this.audit.logTx(tx, {
              action: 'COPY_STOPPED',
              actorUserId: admin.id,
              targetType: 'StrategyFollower',
              targetId: f.id,
              metadata: { reason: 'user_disabled', followerUserId: id, strategyId: f.strategyId },
              client,
            });
          }
        }
        const pausedStrategies = await tx.strategy.updateMany({
          where: { masterUserId: id, status: 'ACTIVE' },
          data: { status: 'PAUSED' },
        });
        await this.audit.logTx(tx, {
          action: 'ADMIN_DISABLED_USER',
          actorUserId: admin.id,
          targetType: 'User',
          targetId: id,
          metadata: { reason: dto.reason, stoppedFollows: activeFollows.length, pausedStrategies: pausedStrategies.count },
          client,
        });
      });
      await this.tokens.revokeAllForUser(id);
    } else {
      if (user.status === 'ACTIVE') throw new BadRequestException('User is already active');
      await this.prisma.$transaction(async (tx) => {
        await tx.user.update({ where: { id }, data: { status: 'ACTIVE', disabledAt: null, disabledReason: null } });
        await this.audit.logTx(tx, {
          action: 'ADMIN_ENABLED_USER',
          actorUserId: admin.id,
          targetType: 'User',
          targetId: id,
          metadata: dto.reason ? { reason: dto.reason } : undefined,
          client,
        });
      });
    }
    return this.getUser(id);
  }

  // ------------------------------------------------------------------ broker accounts

  async listBrokerAccounts(q: AdminBrokerAccountsQueryDto): Promise<Paginated<BrokerAccountView & { userName: string; userEmail: string }>> {
    const where: Prisma.BrokerAccountWhereInput = {
      ...(q.broker ? { broker: q.broker } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.brokerAccount.findMany({
        where,
        include: { user: { select: { name: true, email: true } } },
        orderBy: { updatedAt: 'desc' },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.brokerAccount.count({ where }),
    ]);
    return {
      items: items.map((a) => ({ ...toBrokerAccountView(a), userName: a.user.name, userEmail: a.user.email })),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  /**
   * Force Disconnect: invalidates the token at the broker, deletes the encrypted credentials, marks the
   * account DISCONNECTED (reason shown on the user's card), stops copy subscriptions through it, evicts it
   * from the order cache / live feed and notifies the user in real time.
   */
  async disconnectBrokerAccount(admin: RequestUser, id: string, reason: string, client: ClientInfo): Promise<BrokerAccountView> {
    const account = await this.prisma.brokerAccount.findUnique({ where: { id } });
    if (!account) throw new NotFoundException('Broker account not found');
    if (account.status === 'DISCONNECTED') throw new BadRequestException('Broker account is already disconnected');
    const updated = await this.sessions.disconnectAccount(
      account,
      { by: 'admin', actorUserId: admin.id, reason: `Disconnected by admin: ${reason}`, stopCopy: true },
      client,
    );
    return toBrokerAccountView(updated);
  }

  // ------------------------------------------------------------------ strategies & copy control

  async listStrategies(q: AdminStrategiesQueryDto): Promise<Paginated<StrategyView>> {
    const where: Prisma.StrategyWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.masterUserId ? { masterUserId: q.masterUserId } : {}),
      ...(q.search ? { name: { contains: q.search, mode: 'insensitive' } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.strategy.findMany({
        where,
        include: { master: { select: { name: true } }, _count: { select: { followers: true } } },
        orderBy: { createdAt: 'desc' },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.strategy.count({ where }),
    ]);
    const active = await this.prisma.strategyFollower.groupBy({
      by: ['strategyId'],
      where: { strategyId: { in: items.map((s) => s.id) }, copyStatus: 'ON' },
      _count: { _all: true },
    });
    const activeMap = new Map(active.map((a) => [a.strategyId, a._count._all]));
    return {
      items: items.map((s) => toStrategyView(s, activeMap.get(s.id) ?? 0)),
      total,
      page: q.page,
      pageSize: q.pageSize,
    };
  }

  async listStrategyFollowers(strategyId: string) {
    const follows = await this.prisma.strategyFollower.findMany({
      where: { strategyId },
      include: { follower: { select: { name: true } }, strategy: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return follows.filter((f) => !isRemoved(f)).map(toStrategyFollowerView);
  }

  async pauseStrategy(admin: RequestUser, id: string, reason: string, client: ClientInfo): Promise<StrategyView> {
    const strategy = await this.prisma.strategy.findUnique({ where: { id } });
    if (!strategy) throw new NotFoundException('Strategy not found');
    if (strategy.status !== 'ACTIVE') throw new BadRequestException('Only an ACTIVE strategy can be paused');
    const updated = await this.prisma.$transaction(async (tx) => {
      const s = await tx.strategy.update({
        where: { id },
        data: { status: 'PAUSED' },
        include: { master: { select: { name: true } }, _count: { select: { followers: true } } },
      });
      await this.audit.logTx(tx, {
        action: 'STRATEGY_STOPPED',
        actorUserId: admin.id,
        targetType: 'Strategy',
        targetId: id,
        metadata: { reason, initiatedBy: 'admin' },
        client,
      });
      return s;
    });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId: '' });
    return toStrategyView(updated);
  }

  private async requireMaster(masterUserId: string) {
    const m = await this.prisma.user.findUnique({ where: { id: masterUserId }, select: { id: true, role: true, status: true } });
    if (!m || m.role !== 'MASTER') throw new BadRequestException('Select a valid master');
    if (m.status !== 'ACTIVE') throw new BadRequestException('This master account is not active');
    return m;
  }

  async createStrategyForMaster(
    admin: RequestUser,
    masterUserId: string,
    dto: { name: string; description?: string; riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH'; allowedExchanges?: string[]; allowedInstruments?: string[]; maxFollowers?: number; masterCapital: number; maxOrderValue?: number; maxQuantityPerOrder?: number },
    client: ClientInfo,
  ): Promise<StrategyView> {
    await this.requireMaster(masterUserId);
    const s = await this.prisma.strategy.create({
      data: {
        masterUserId,
        name: dto.name,
        description: dto.description,
        riskLevel: dto.riskLevel ?? 'MEDIUM',
        allowedExchanges: (dto.allowedExchanges ?? []) as never,
        allowedInstruments: (dto.allowedInstruments ?? []).map((x) => x.toUpperCase()),
        maxFollowers: dto.maxFollowers,
        masterCapital: dto.masterCapital,
        maxOrderValue: dto.maxOrderValue,
        maxQuantityPerOrder: dto.maxQuantityPerOrder,
      },
      include: { master: { select: { name: true } }, _count: { select: { followers: true } } },
    });
    await this.audit.log({ action: 'STRATEGY_CREATED', actorUserId: admin.id, targetType: 'Strategy', targetId: s.id, metadata: { masterUserId, initiatedBy: 'admin' }, client });
    return toStrategyView(s);
  }

  async reassignStrategy(admin: RequestUser, id: string, masterUserId: string, client: ClientInfo): Promise<StrategyView> {
    const strategy = await this.prisma.strategy.findUnique({ where: { id } });
    if (!strategy) throw new NotFoundException('Strategy not found');
    if (strategy.status === 'ARCHIVED') throw new BadRequestException('This strategy was removed');
    if (strategy.masterUserId === masterUserId) throw new BadRequestException('Strategy already belongs to this master');
    await this.requireMaster(masterUserId);
    const open = await this.prisma.masterTrade.count({ where: { strategyId: id, signalStatus: 'OPEN' } });
    if (open) throw new BadRequestException('Close the open trades of this strategy before moving it to another master');
    const s = await this.prisma.strategy.update({
      where: { id },
      data: { masterUserId },
      include: { master: { select: { name: true } }, _count: { select: { followers: true } } },
    });
    await this.audit.log({ action: 'STRATEGY_UPDATED', actorUserId: admin.id, targetType: 'Strategy', targetId: id, metadata: { fromMaster: strategy.masterUserId, toMaster: masterUserId }, client });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId: '' });
    return toStrategyView(s);
  }

  async removeStrategy(admin: RequestUser, id: string, reason: string, client: ClientInfo): Promise<StrategyView> {
    const strategy = await this.prisma.strategy.findUnique({ where: { id } });
    if (!strategy) throw new NotFoundException('Strategy not found');
    if (strategy.status === 'ARCHIVED') throw new BadRequestException('Strategy is already removed');
    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.strategyFollower.updateMany({
        where: { strategyId: id, copyStatus: { not: 'OFF' } },
        data: { copyStatus: 'OFF', stoppedAt: new Date(), stoppedReason: `Strategy removed by admin: ${reason}`, stoppedByUserId: admin.id },
      });
      const s = await tx.strategy.update({
        where: { id },
        data: { status: 'ARCHIVED' },
        include: { master: { select: { name: true } }, _count: { select: { followers: true } } },
      });
      await this.audit.logTx(tx, { action: 'STRATEGY_STOPPED', actorUserId: admin.id, targetType: 'Strategy', targetId: id, metadata: { reason, removed: true, initiatedBy: 'admin' }, client });
      return s;
    });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId: '' });
    return toStrategyView(updated);
  }

  async stopFollowerCopy(admin: RequestUser, followId: string, reason: string, client: ClientInfo) {
    const follow = await this.prisma.strategyFollower.findUnique({ where: { id: followId } });
    if (!follow) throw new NotFoundException('Subscription not found');
    if (follow.copyStatus === 'OFF') throw new BadRequestException('Copy trading is already off for this subscription');
    const updated = await this.prisma.$transaction(async (tx) => {
      const f = await tx.strategyFollower.update({
        where: { id: followId },
        data: { copyStatus: 'OFF', stoppedAt: new Date(), stoppedReason: `Stopped by admin: ${reason}`, stoppedByUserId: admin.id },
        include: { follower: { select: { name: true } }, strategy: { select: { name: true } } },
      });
      await this.audit.logTx(tx, {
        action: 'ADMIN_STOPPED_COPY',
        actorUserId: admin.id,
        targetType: 'StrategyFollower',
        targetId: followId,
        metadata: { reason, followerUserId: follow.followerUserId, strategyId: follow.strategyId },
        client,
      });
      await this.audit.logTx(tx, {
        action: 'COPY_STOPPED',
        actorUserId: admin.id,
        targetType: 'StrategyFollower',
        targetId: followId,
        metadata: { initiatedBy: 'admin', followerUserId: follow.followerUserId, strategyId: follow.strategyId },
        client,
      });
      return f;
    });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: '', userId: '' });
    return toStrategyFollowerView(updated);
  }

  async copyHaltState(): Promise<CopyHaltState | null> {
    const raw = await this.redis.get(RedisKeys.copyHalted);
    return raw ? (JSON.parse(raw) as CopyHaltState) : null;
  }

  /** Platform-wide kill switch. The copy engine checks this flag before creating or submitting any order. */
  async haltCopyTrading(admin: RequestUser, reason: string, client: ClientInfo): Promise<CopyHaltState> {
    const state: CopyHaltState = { haltedAt: new Date().toISOString(), haltedByUserId: admin.id, reason };
    // Halt first (fail-safe): even if recording the event below fails, copying is already stopped.
    await this.redis.set(RedisKeys.copyHalted, JSON.stringify(state));
    await this.prisma.$transaction(async (tx) => {
      await tx.systemEvent.create({
        data: { source: 'API', type: 'COPY_TRADING_HALTED', severity: 'CRITICAL', message: `Copy trading halted by admin: ${reason}`, context: { adminUserId: admin.id } },
      });
      await this.audit.logTx(tx, { action: 'ADMIN_STOPPED_COPY', actorUserId: admin.id, targetType: 'Platform', metadata: { scope: 'GLOBAL', reason }, client });
    });
    return state;
  }

  async resumeCopyTrading(admin: RequestUser, reason: string, client: ClientInfo): Promise<{ halted: false }> {
    if (!(await this.copyHaltState())) throw new BadRequestException('Copy trading is not halted');
    // Record first, then lift the halt: if recording fails the platform stays halted (fail-safe).
    await this.prisma.$transaction(async (tx) => {
      await tx.systemEvent.create({
        data: { source: 'API', type: 'COPY_TRADING_RESUMED', severity: 'WARNING', message: `Copy trading resumed by admin: ${reason}`, context: { adminUserId: admin.id } },
      });
      await this.audit.logTx(tx, { action: 'ADMIN_RESUMED_COPY', actorUserId: admin.id, targetType: 'Platform', metadata: { scope: 'GLOBAL', reason }, client });
    });
    await this.redis.del(RedisKeys.copyHalted);
    return { halted: false };
  }

  // ------------------------------------------------------------------ trades / orders / positions

  async listMasterTrades(q: AdminMasterTradesQueryDto): Promise<Paginated<MasterTradeView>> {
    const where: Prisma.MasterTradeWhereInput = {
      ...(q.broker ? { broker: q.broker } : {}),
      ...(q.userId ? { masterUserId: q.userId } : {}),
      ...(q.strategyId ? { strategyId: q.strategyId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.symbol ? { symbol: { contains: q.symbol, mode: 'insensitive' } } : {}),
      ...(dateRange(q.from, q.to) ? { createdAt: dateRange(q.from, q.to) } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.masterTrade.findMany({
        where,
        include: { master: { select: { name: true } }, _count: { select: { copyOrders: true } } },
        orderBy: { createdAt: 'desc' },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.masterTrade.count({ where }),
    ]);
    return { items: items.map(toMasterTradeView), total, page: q.page, pageSize: q.pageSize };
  }

  async listCopyOrders(q: AdminCopyOrdersQueryDto): Promise<Paginated<CopyOrderView>> {
    const where: Prisma.CopyOrderWhereInput = {
      ...(q.broker ? { broker: q.broker } : {}),
      ...(q.userId ? { followerUserId: q.userId } : {}),
      ...(q.strategyId ? { strategyFollower: { strategyId: q.strategyId } } : {}),
      ...(q.masterTradeId ? { masterTradeId: q.masterTradeId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(dateRange(q.from, q.to) ? { createdAt: dateRange(q.from, q.to) } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.copyOrder.findMany({
        where,
        include: { follower: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.copyOrder.count({ where }),
    ]);
    return { items: items.map(toCopyOrderView), total, page: q.page, pageSize: q.pageSize };
  }

  async listPositions(q: AdminPositionsQueryDto): Promise<Paginated<PositionView>> {
    const where: Prisma.PositionWhereInput = {
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.broker ? { brokerAccount: { broker: q.broker } } : {}),
      ...(q.scope !== 'all' ? { quantity: { not: 0 } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.position.findMany({
        where,
        include: { user: { select: { name: true } }, brokerAccount: { select: { broker: true } } },
        orderBy: { updatedAt: 'desc' },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.position.count({ where }),
    ]);
    return { items: items.map(toPositionView), total, page: q.page, pageSize: q.pageSize };
  }

  // ------------------------------------------------------------------ audit & health

  async listAuditLogs(q: AdminAuditLogsQueryDto): Promise<Paginated<AuditLogView>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: q.action } : {}),
      ...(q.userId ? { OR: [{ actorUserId: q.userId }, { targetType: 'User', targetId: q.userId }] } : {}),
      ...(dateRange(q.from, q.to) ? { createdAt: dateRange(q.from, q.to) } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { actor: { select: { email: true } } },
        orderBy: { createdAt: 'desc' },
        skip: q.skip,
        take: q.pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { items: items.map(toAuditLogView), total, page: q.page, pageSize: q.pageSize };
  }

  async listSystemEvents(q: AdminSystemEventsQueryDto): Promise<Paginated<SystemEventView>> {
    const where: Prisma.SystemEventWhereInput = q.severity ? { severity: q.severity } : {};
    const [items, total] = await Promise.all([
      this.prisma.systemEvent.findMany({ where, orderBy: { createdAt: 'desc' }, skip: q.skip, take: q.pageSize }),
      this.prisma.systemEvent.count({ where }),
    ]);
    return { items: items.map(toSystemEventView), total, page: q.page, pageSize: q.pageSize };
  }

  async systemHealth(): Promise<SystemHealthDetail & { copyHalt: CopyHaltState | null }> {
    const [basic, heartbeat, recent, copyHalt] = await Promise.all([
      this.health.check(),
      this.health.workerHeartbeat(),
      this.prisma.systemEvent.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
      this.copyHaltState(),
    ]);
    return {
      ...basic,
      api: {
        uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
        version: this.version,
        environment: this.config.APP_ENV,
        paperMode: this.config.PAPER_MODE,
      },
      workerHeartbeat: { lastSeenAt: heartbeat?.at ?? null, pid: heartbeat?.pid ?? null, host: heartbeat?.host ?? null },
      // Populated once BullMQ queues (Phase 3) and broker order streams (Phase 4/5) exist.
      queues: [],
      brokerStreams: [],
      recentEvents: recent.map(toSystemEventView),
      copyHalt,
    };
  }
}

function licenceWhere(l?: 'NONE' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED'): Prisma.UserWhereInput {
  const now = new Date();
  const week = new Date(now.getTime() + 7 * 86_400_000);
  switch (l) {
    case 'NONE':
      return { licenceExpiresAt: null };
    case 'EXPIRED':
      return { licenceExpiresAt: { lte: now } };
    case 'EXPIRING':
      return { licenceExpiresAt: { gt: now, lte: week } };
    case 'ACTIVE':
      return { licenceExpiresAt: { gt: now } };
    default:
      return {};
  }
}
