import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { PrismaClient, Strategy } from '@ctp/database';
import { AuditService } from '../audit/audit.service';
import { PRISMA } from '../common/prisma/prisma.service';
import { AccountEvents } from '../realtime/account-events';
import type { AssignClientDto } from './trading.dto';
import { PositionResizeService, type ResizeResult } from './position-resize.service';
import { clientOwner } from './client-directory';
import { isRemoved, REMOVED_REASON } from './follower-access';
import { TradingService } from './trading.service';

/**
 * Master / admin assigns a client to a strategy (instead of the client subscribing himself).
 * The client's first connected TRADING account is used unless one is given. Copying starts only when asked
 * AND the broker is connected — otherwise the client is mapped with copy OFF and can start it later.
 */
@Injectable()
export class ClientAssignService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
    private readonly accountEvents: AccountEvents,
    private readonly resizer: PositionResizeService,
    private readonly trading: TradingService,
  ) {}

  /** `byMaster`: the master himself assigns — only his own (or not yet owned) clients are allowed. */
  async assign(strategy: Strategy, dto: AssignClientDto, actorUserId: string, opts: { byMaster?: boolean } = {}) {
    if (strategy.status === 'ARCHIVED') throw new BadRequestException('Strategy is archived');
    const client = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!client) throw new NotFoundException(`No user with email ${dto.email}`);
    if (client.role !== 'FOLLOWER') throw new BadRequestException('Only client (follower) accounts can be assigned to a strategy');
    // Multi-master: a client of another master can never be taken (no other master's client is even revealed).
    const owner = await clientOwner(this.prisma, client);
    if (opts.byMaster && owner && owner !== strategy.masterUserId) throw new NotFoundException(`No user with email ${dto.email}`);
    if (client.status !== 'ACTIVE') throw new BadRequestException('This client account is not active');
    // A client nobody owns yet (self sign-up) becomes this master's client once assigned.
    const claim = !client.parentUserId && (!owner || owner === strategy.masterUserId);

    const accounts = await this.prisma.brokerAccount.findMany({ where: { userId: client.id, mode: 'TRADING' }, orderBy: { createdAt: 'asc' } });
    const account = dto.brokerAccountId
      ? accounts.find((a) => a.id === dto.brokerAccountId)
      : (accounts.find((a) => a.status === 'CONNECTED') ?? accounts.find((a) => a.isPaper || a.broker === 'MOCK') ?? accounts[0]);
    if (dto.brokerAccountId && !account) throw new BadRequestException('That broker account does not belong to this client');
    // No demat at all: the client paper-trades on the internal paper account.
    const useAccount = account ?? (await this.trading.ensureLedgerAccount(client.id));

    const existing = await this.prisma.strategyFollower.findUnique({ where: { strategyId_followerUserId: { strategyId: strategy.id, followerUserId: client.id } } });
    if (!existing && strategy.maxFollowers) {
      const n = await this.prisma.strategyFollower.count({ where: { strategyId: strategy.id } });
      if (n >= strategy.maxFollowers) throw new BadRequestException('This strategy is full');
    }
    const mode = dto.allocationMode ?? 'FIXED_QUANTITY';
    if (mode === 'FIXED_QUANTITY' && !dto.fixedQuantity && !dto.fixedLots) throw new BadRequestException('Fixed quantity or fixed lots is required');
    if (mode === 'CAPITAL_PERCENTAGE' && !dto.allocationPercent) throw new BadRequestException('Allocation % is required');
    if (mode === 'PROPORTIONAL' && !dto.allocationAmount) throw new BadRequestException('Capital amount is required');

    const canStart = Boolean(dto.startCopy && (useAccount.status === 'CONNECTED' || this.trading.isSimulated(useAccount)));
    const data = {
      brokerAccountId: useAccount.id,
      allocationMode: mode,
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
      // Re-assigning a removed client gives the strategy back to them.
      ...(existing && isRemoved(existing) ? { stoppedReason: null } : {}),
      ...(canStart ? { copyStatus: 'ON' as const, startedAt: new Date(), stoppedAt: null, stoppedReason: null } : {}),
    };
    const row = await this.prisma.strategyFollower.upsert({
      where: { strategyId_followerUserId: { strategyId: strategy.id, followerUserId: client.id } },
      create: { strategyId: strategy.id, followerUserId: client.id, ...data },
      update: data,
      include: { strategy: { select: { name: true } } },
    });
    if (claim) await this.prisma.user.update({ where: { id: client.id }, data: { parentUserId: strategy.masterUserId } });
    await this.audit.log({
      action: 'PROFILE_UPDATED',
      actorUserId,
      targetType: 'StrategyFollower',
      targetId: row.id,
      metadata: { assignedBy: actorUserId, strategyId: strategy.id, clientId: client.id, copy: canStart ? 'ON' : 'OFF' },
    });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: useAccount.id, userId: client.id });
    // A changed lot multiplier also applies to trades already booked (still open) in this strategy.
    let resized: ResizeResult[] = [];
    if (existing && process.env.ALLOW_LIVE_RESIZE === 'true') {
      try {
        resized = await this.resizer.resizeOpen(row.id, actorUserId);
      } catch (err) {
        resized = [{ symbol: '—', from: 0, to: 0, side: 'BUY', quantity: 0, ok: false, error: (err as Error).message }];
      }
    }
    return {
      follower: row,
      resized,
      warning: dto.startCopy && !canStart ? 'Assigned with copy OFF — the client is on LIVE and the demat is not connected (paper needs no demat).' : null,
    };
  }

  /** Removes a client from a strategy: copying stops and the client no longer sees it (history is kept). Positions are not touched. */
  async unassign(strategyId: string, followerId: string, actorUserId: string) {
    const sub = await this.prisma.strategyFollower.findFirst({ where: { id: followerId, strategyId } });
    if (!sub) throw new NotFoundException('Client is not assigned to this strategy');
    const row = await this.prisma.strategyFollower.update({
      where: { id: sub.id },
      data: { copyStatus: 'OFF', stoppedAt: new Date(), stoppedReason: REMOVED_REASON, stoppedByUserId: actorUserId },
      include: { strategy: { select: { name: true } } },
    });
    await this.audit.log({ action: 'COPY_STOPPED', actorUserId, targetType: 'StrategyFollower', targetId: sub.id, metadata: { reason: 'unassigned' } });
    this.accountEvents.emit({ type: 'settings', brokerAccountId: sub.brokerAccountId ?? '', userId: sub.followerUserId });
    return row;
  }
}
