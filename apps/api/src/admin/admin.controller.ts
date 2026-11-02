import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { clientInfo } from '../common/client-info';
import { AdminOnly, CurrentUser, RequestUser, Roles } from '../common/decorators/auth.decorators';
import { AdminService } from './admin.service';
import { CopyEngineService } from '../trading/copy-engine.service';
import { RiskService } from '../trading/risk.service';
import { ClientAssignService } from '../trading/client-assign.service';
import { AssignClientDto, AssignStrategyDto, EditSignalDto, SignalTpSlDto } from '../trading/trading.dto';
import { allocationLabel, isRemoved } from '../trading/follower-access';
import { clientDirectory } from '../trading/client-directory';
import { SignalService } from '../trading/signal.service';
import { toStrategyFollowerView } from '../common/mappers';
import { PRISMA } from '../common/prisma/prisma.service';
import type { PrismaClient } from '@ctp/database';
import { startOfTradingDayIST } from './admin.service';
import {
  AdminAuditLogsQueryDto,
  AdminSignalsQueryDto,
  AssignLicenceDto,
  CreateUserDto,
  UpdateUserDto,
  AdminBrokerAccountsQueryDto,
  AdminCopyOrdersQueryDto,
  AdminMasterTradesQueryDto,
  AdminPositionsQueryDto,
  AdminStrategiesQueryDto,
  AdminCreateStrategyDto,
  AdminStrategyMasterDto,
  LicenceQuotaDto,
  AdminSystemEventsQueryDto,
  AdminUsersQueryDto,
  ReasonDto,
  UpdateUserStatusDto,
} from './dto/admin.dto';

/** Every route here requires role ADMIN (enforced by the global RolesGuard). */
@Roles('ADMIN')
@Controller('admin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly risk: RiskService,
    private readonly engine: CopyEngineService,
    private readonly assigner: ClientAssignService,
    private readonly signals: SignalService,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
  ) {}

  /** KILL SWITCH: halt copying, turn every subscription OFF and exit all open client positions. */
  @AdminOnly()
  @Post('kill-switch')
  killSwitch(@CurrentUser() me: RequestUser, @Body() dto: ReasonDto) {
    return this.risk.killSwitch(me.id, dto.reason);
  }

  /** Manual square-off of all INTRADAY client positions (same as the auto square-off). */
  @AdminOnly()
  @Post('square-off')
  squareOff() {
    return this.risk.squareOffAll({ intradayOnly: true });
  }

  /** Copy order latency: in-memory p50/p95 + today's DB average. */
  @Get('copy-trading/latency')
  async latency() {
    const agg = await this.prisma.copyOrder.aggregate({
      where: { createdAt: { gte: startOfTradingDayIST() }, latencyMs: { not: null }, isPaper: false },
      _avg: { latencyMs: true },
      _count: true,
    });
    return { ...this.engine.latency.snapshot(), dbTodayAvgMs: agg._avg.latencyMs ? Math.round(agg._avg.latencyMs) : null, dbTodayCount: agg._count };
  }

  @Get('dashboard')
  dashboard() {
    return this.admin.dashboard();
  }

  // users
  @Get('users')
  users(@Query() q: AdminUsersQueryDto) {
    return this.admin.listUsers(q);
  }

  @Get('users/:id')
  user(@Param('id') id: string) {
    return this.admin.getUser(id);
  }

  @Post('users')
  createUser(@CurrentUser() me: RequestUser, @Body() dto: CreateUserDto, @Req() req: Request) {
    return this.admin.createUser(me, dto, clientInfo(req));
  }

  @Patch('users/:id')
  updateUser(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: UpdateUserDto, @Req() req: Request) {
    return this.admin.updateUser(me, id, dto, clientInfo(req));
  }

  @Post('users/:id/licence')
  assignLicence(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: AssignLicenceDto, @Req() req: Request) {
    return this.admin.assignLicence(me, id, dto, clientInfo(req));
  }

  @Post('users/:id/licence/revoke')
  revokeLicence(@CurrentUser() me: RequestUser, @Param('id') id: string, @Req() req: Request) {
    return this.admin.revokeLicence(me, id, clientInfo(req));
  }

  /** Licence history (assign / extend / revoke, by whom) of one user, newest first. */
  @Get('users/:id/licence-history')
  licenceHistory(@CurrentUser() me: RequestUser, @Param('id') id: string) {
    return this.admin.licenceHistory(me, id);
  }

  // --------------------------------------------------------------- signals (all masters)

  @Get('signals')
  listSignals(@Query() q: AdminSignalsQueryDto) {
    const from = q.from ? new Date(`${q.from.slice(0, 10)}T00:00:00+05:30`) : undefined;
    const to = q.to ? new Date(`${q.to.slice(0, 10)}T23:59:59.999+05:30`) : undefined;
    const strategyIds = q.strategyIds ? q.strategyIds.split(',').filter(Boolean).slice(0, 50) : undefined;
    return this.signals.list(null, { status: q.status ?? 'all', from, to, strategyIds });
  }

  @HttpCode(HttpStatus.OK)
  @Post('signals/:id/square-off')
  squareOffSignal(@CurrentUser() me: RequestUser, @Param('id') id: string) {
    return this.signals.squareOff(null, id, 'SQUARE_OFF', me.id);
  }

  @Patch('signals/:id/tpsl')
  setSignalTpSl(@Param('id') id: string, @Body() dto: SignalTpSlDto) {
    return this.signals.setTpSl(null, id, dto.targetPrice ?? null, dto.stopLossPrice ?? null);
  }

  /** Client picker for "Assign client" on the Strategies page. */
  @Get('client-directory')
  clientDirectory(@Query('search') search?: string, @Query('strategyId') strategyId?: string) {
    return clientDirectory(this.prisma, search, strategyId);
  }

  // --------------------------------------------------------------- per-client strategy access

  /** Every strategy with this client's assignment (null = not assigned). */
  @Get('users/:id/strategies')
  async userStrategies(@Param('id') id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, role: true } });
    if (!u) throw new NotFoundException('User not found');
    const [strategies, subs] = await Promise.all([
      this.prisma.strategy.findMany({ where: { status: { not: 'ARCHIVED' } }, include: { master: { select: { name: true } } }, orderBy: { name: 'asc' } }),
      this.prisma.strategyFollower.findMany({ where: { followerUserId: id } }),
    ]);
    const bySid = new Map(subs.map((x) => [x.strategyId, x]));
    return strategies.map((st) => {
      const sub = bySid.get(st.id);
      const assigned = !!sub && !isRemoved(sub);
      return {
        strategyId: st.id,
        name: st.name,
        masterName: st.master.name,
        status: st.status,
        assigned,
        subscription: assigned && sub ? { ...toStrategyFollowerView(sub), allocation: allocationLabel(sub) } : null,
      };
    });
  }

  /** Give one strategy to one client (or change the allocation / lot multiplier). */
  @HttpCode(HttpStatus.OK)
  @Post('users/:id/strategies/:strategyId')
  async assignUserStrategy(@CurrentUser() me: RequestUser, @Param('id') id: string, @Param('strategyId') strategyId: string, @Body() dto: AssignStrategyDto) {
    const [u, s] = await Promise.all([this.prisma.user.findUnique({ where: { id } }), this.prisma.strategy.findUnique({ where: { id: strategyId } })]);
    if (!u) throw new NotFoundException('User not found');
    if (!s) throw new NotFoundException('Strategy not found');
    const { follower, warning, resized } = await this.assigner.assign(s, { ...dto, email: u.email }, me.id);
    return { follower: toStrategyFollowerView(follower), warning, resized };
  }

  /** Take one strategy away from one client (copying stops; history and positions are kept). */
  @HttpCode(HttpStatus.OK)
  @Post('users/:id/strategies/:strategyId/remove')
  async removeUserStrategy(@CurrentUser() me: RequestUser, @Param('id') id: string, @Param('strategyId') strategyId: string) {
    const sub = await this.prisma.strategyFollower.findUnique({ where: { strategyId_followerUserId: { strategyId, followerUserId: id } } });
    if (!sub) throw new NotFoundException('This strategy is not assigned to the client');
    return toStrategyFollowerView(await this.assigner.unassign(strategyId, sub.id, me.id));
  }

  // --------------------------------------------------------------- trade history corrections

  @Patch('signals/:id')
  editSignal(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: EditSignalDto) {
    return this.signals.edit(id, dto, me.id);
  }

  @Delete('signals/:id')
  deleteSignal(@CurrentUser() me: RequestUser, @Param('id') id: string) {
    return this.signals.remove(id, me.id);
  }

  @Patch('users/:id/status')
  setUserStatus(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: UpdateUserStatusDto, @Req() req: Request) {
    return this.admin.setUserStatus(me, id, dto, clientInfo(req));
  }

  // broker accounts
  @Get('broker-accounts')
  brokerAccounts(@Query() q: AdminBrokerAccountsQueryDto) {
    return this.admin.listBrokerAccounts(q);
  }

  @Post('broker-accounts/:id/disconnect')
  disconnectBroker(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.admin.disconnectBrokerAccount(me, id, dto.reason, clientInfo(req));
  }

  // strategies & copy control
  @Get('strategies')
  strategies(@Query() q: AdminStrategiesQueryDto) {
    return this.admin.listStrategies(q);
  }

  @Get('strategies/:id/followers')
  strategyFollowers(@Param('id') id: string) {
    return this.admin.listStrategyFollowers(id);
  }

  /** Admin-assigned Master → Client mapping. */
  @Post('strategies/:id/assign')
  async assignClient(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: AssignClientDto) {
    const s = await this.prisma.strategy.findUnique({ where: { id } });
    if (!s) throw new NotFoundException('Strategy not found');
    const { follower, warning, resized } = await this.assigner.assign(s, dto, me.id);
    return { follower: toStrategyFollowerView(follower), warning, resized };
  }

  /** Create a strategy on behalf of a master (allocate). */
  @Post('strategies')
  createStrategy(@CurrentUser() me: RequestUser, @Body() dto: AdminCreateStrategyDto, @Req() req: Request) {
    return this.admin.createStrategyForMaster(me, dto.masterUserId, dto, clientInfo(req));
  }

  /** Move a strategy to another master. */
  @Post('strategies/:id/master')
  reassignStrategy(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: AdminStrategyMasterDto, @Req() req: Request) {
    return this.admin.reassignStrategy(me, id, dto.masterUserId, clientInfo(req));
  }

  /** Remove (archive) a strategy: all client copying stops, history is kept. */
  @Post('strategies/:id/remove')
  removeStrategy(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.admin.removeStrategy(me, id, dto.reason, clientInfo(req));
  }

  /** Master licence limit: increase / decrease, and allow custom licence periods. Admin only. */
  @AdminOnly()
  @Post('users/:id/licence-quota')
  async licenceQuota(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: LicenceQuotaDto, @Req() req: Request) {
    const u = await this.prisma.user.findUnique({ where: { id }, select: { role: true, licenceQuota: true } });
    if (!u || u.role !== 'MASTER') throw new NotFoundException('Master not found');
    const quota = Math.max(0, u.licenceQuota + (dto.delta ?? 0));
    const row = await this.prisma.user.update({
      where: { id },
      data: { licenceQuota: quota, ...(dto.customAllowed !== undefined ? { licenceCustomAllowed: dto.customAllowed } : {}) },
      select: { licenceQuota: true, licenceCustomAllowed: true },
    });
    await this.prisma.auditLog.create({ data: { action: 'PROFILE_UPDATED', actorUserId: me.id, targetType: 'User', targetId: id, ip: clientInfo(req).ip ?? null, metadata: { licenceQuota: row.licenceQuota, delta: dto.delta ?? 0, customAllowed: row.licenceCustomAllowed } } });
    return { remaining: row.licenceQuota, customAllowed: row.licenceCustomAllowed };
  }

  @Post('strategies/:id/pause')
  pauseStrategy(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.admin.pauseStrategy(me, id, dto.reason, clientInfo(req));
  }

  @Post('strategy-followers/:id/stop')
  stopFollower(@CurrentUser() me: RequestUser, @Param('id') id: string, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.admin.stopFollowerCopy(me, id, dto.reason, clientInfo(req));
  }

  @Get('copy-trading/status')
  async copyStatus() {
    const halt = await this.admin.copyHaltState();
    return { halted: halt !== null, ...(halt ? { halt } : {}) };
  }

  @AdminOnly()
  @Post('copy-trading/halt')
  halt(@CurrentUser() me: RequestUser, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.admin.haltCopyTrading(me, dto.reason, clientInfo(req));
  }

  @AdminOnly()
  @Post('copy-trading/resume')
  resume(@CurrentUser() me: RequestUser, @Body() dto: ReasonDto, @Req() req: Request) {
    return this.admin.resumeCopyTrading(me, dto.reason, clientInfo(req));
  }

  // trading data
  @Get('master-trades')
  masterTrades(@Query() q: AdminMasterTradesQueryDto) {
    return this.admin.listMasterTrades(q);
  }

  @Get('copy-orders')
  copyOrders(@Query() q: AdminCopyOrdersQueryDto) {
    return this.admin.listCopyOrders(q);
  }

  @Get('positions')
  positions(@Query() q: AdminPositionsQueryDto) {
    return this.admin.listPositions(q);
  }

  // audit & health
  @Get('audit-logs')
  auditLogs(@Query() q: AdminAuditLogsQueryDto) {
    return this.admin.listAuditLogs(q);
  }

  @Get('system-events')
  systemEvents(@Query() q: AdminSystemEventsQueryDto) {
    return this.admin.listSystemEvents(q);
  }

  @Get('system-health')
  systemHealth() {
    return this.admin.systemHealth();
  }
}
