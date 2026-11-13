import { BadRequestException, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type Redis from 'ioredis';
import type { BrokerAccount, Exchange, PrismaClient, ProductType } from '@ctp/database';
import { type CopyHaltState, RedisKeys, WsEvent } from '@ctp/types';
import { AuditService } from '../audit/audit.service';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { API_CONFIG, ApiConfig } from '../config/config.module';
import { instrumentKey, PriceCacheService } from '../market-data/price-cache.service';
import { NotifyService } from '../realtime/notify.service';
import { RealtimeService } from '../realtime/realtime.gateway';
import type { BrokerAdapter } from './broker-adapter';
import { ClientRegistryService } from './client-registry.service';
import { CopyEngineService } from './copy-engine.service';
import { SignalService } from './signal.service';
import { TradingService } from './trading.service';

export interface SquareOffResult {
  accountId: string;
  orders: number;
  failed: number;
  errors: string[];
}

const istParts = (now = new Date()) => {
  const ist = new Date(now.getTime() + 330 * 60_000);
  return { day: ist.toISOString().slice(0, 10), weekday: ist.getUTCDay(), mins: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
};

/**
 * Global risk controls:
 *  - per-client daily max loss (polls broker P&L; on breach: copy OFF + square off + notify)
 *  - auto square-off of INTRADAY positions at AUTO_SQUARE_OFF_TIME (IST, weekdays)
 *  - kill switch: halt copying, turn every subscription OFF, exit all open positions of client accounts
 *  - exit-all for one client (self) or for all clients of a strategy (master)
 */
@Injectable()
export class RiskService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Risk');
  private pnlTimer?: NodeJS.Timeout;
  private clock?: NodeJS.Timeout;
  private squaredOffDay = '';
  private polling = false;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly trading: TradingService,
    private readonly registry: ClientRegistryService,
    private readonly engine: CopyEngineService,
    private readonly prices: PriceCacheService,
    private readonly audit: AuditService,
    private readonly notifier: NotifyService,
    private readonly realtime: RealtimeService,
    private readonly signals: SignalService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.NODE_ENV === 'test') return;
    if (this.config.RISK_POLL_INTERVAL_MS > 0) this.pnlTimer = setInterval(() => void this.pollPnl(), this.config.RISK_POLL_INTERVAL_MS);
    this.clock = setInterval(() => void this.autoSquareOffTick(), 20_000);
  }

  onModuleDestroy(): void {
    if (this.pnlTimer) clearInterval(this.pnlTimer);
    if (this.clock) clearInterval(this.clock);
  }

  // ------------------------------------------------------------ daily loss

  async pollPnl(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const entries = this.registry.allEntries();
      await Promise.all(
        entries.map(async (e) => {
          let pnl: number | null = null;
          if (e.simulated) {
            const agg = await this.prisma.position.aggregate({ where: { brokerAccountId: e.accountId, isPaper: true }, _sum: { realizedPnl: true, unrealizedPnl: true } });
            pnl = Number(agg._sum.realizedPnl ?? 0) + Number(agg._sum.unrealizedPnl ?? 0);
          } else if (e.adapter) {
            const positions = await e.adapter.positions().catch(() => null);
            if (positions) pnl = positions.reduce((s, p) => s + (p.pnl ?? 0), 0);
          }
          const day = this.registry.day(e.followerId);
          day.pnl = pnl;
          const limit = e.settings.maxDailyLoss;
          if (limit && pnl !== null && pnl <= -limit && !day.breached) {
            day.breached = true;
            await this.onLossLimit(e.followerId, e.userId, e.accountId, pnl, limit);
          }
        }),
      );
    } catch (err) {
      this.logger.warn(`P&L poll failed: ${(err as Error).message}`);
    } finally {
      this.polling = false;
    }
  }

  private async onLossLimit(followerId: string, userId: string, accountId: string, pnl: number, limit: number): Promise<void> {
    const reason = `Daily loss limit hit (P&L ₹${pnl.toFixed(0)} ≤ -₹${limit})`;
    this.logger.warn(`${followerId}: ${reason}`);
    this.registry.evictFollower(followerId);
    await this.prisma.strategyFollower.update({ where: { id: followerId }, data: { copyStatus: 'OFF', stoppedAt: new Date(), stoppedReason: reason } });
    await this.audit.log({ action: 'RISK_LIMIT_HIT', targetType: 'StrategyFollower', targetId: followerId, metadata: { pnl, limit } });
    const account = await this.prisma.brokerAccount.findUnique({ where: { id: accountId } });
    if (account) await this.squareOffAccount(account, { intradayOnly: false }).catch(() => undefined);
    this.realtime.toUser(userId, WsEvent.RISK_LIMIT_HIT, { followerId, pnl, limit });
    void this.notifier.notify({ userId, type: 'RISK_LIMIT_HIT', severity: 'ERROR', title: 'Loss limit hit — copy trading stopped', body: reason });
  }

  // ------------------------------------------------------------ auto square-off

  private async autoSquareOffTick(): Promise<void> {
    const t = this.config.AUTO_SQUARE_OFF_TIME;
    if (!t) return;
    const [h, m] = t.split(':').map(Number) as [number, number];
    const now = istParts();
    if (now.weekday === 0 || now.weekday === 6) return;
    if (now.mins < h * 60 + m || now.mins > 15 * 60 + 30 || this.squaredOffDay === now.day) return;
    this.squaredOffDay = now.day;
    this.logger.warn(`Auto square-off (${t} IST) started`);
    // Intraday signals first: closes them in history and exits each follower's copy of them.
    const sig = await this.signals.squareOffWhere({ productType: 'INTRADAY' }, 'AUTO_SQUARE_OFF').catch(() => ({ closed: 0 }));
    if (sig.closed) this.logger.warn(`Auto square-off closed ${sig.closed} intraday signal(s)`);
    const results = await this.squareOffAll({ intradayOnly: true });
    const orders = results.reduce((s, r) => s + r.orders, 0);
    await this.audit.log({ action: 'AUTO_SQUARE_OFF', metadata: { time: t, accounts: results.length, orders } });
    void this.notifier.alertAdmins('Auto square-off done', `${orders} exit order(s) across ${results.length} account(s)`);
  }

  // ------------------------------------------------------------ kill switch

  async killSwitch(adminId: string, reason: string): Promise<{ stoppedFollowers: number; results: SquareOffResult[] }> {
    const state: CopyHaltState = { haltedAt: new Date().toISOString(), haltedByUserId: adminId, reason };
    await this.redis.set(RedisKeys.copyHalted, JSON.stringify(state));
    const stopped = await this.prisma.strategyFollower.updateMany({
      where: { copyStatus: { not: 'OFF' } },
      data: { copyStatus: 'OFF', stoppedAt: new Date(), stoppedReason: `Kill switch: ${reason}`, stoppedByUserId: adminId },
    });
    this.registry.scheduleReload(0);
    const results = await this.squareOffAll({ intradayOnly: false, includeAllTradingAccounts: true });
    // Copying is halted, so this only books every open signal as closed (positions were squared off above).
    await this.signals.squareOffWhere({}, 'KILL_SWITCH', adminId).catch(() => undefined);
    await this.audit.log({ action: 'KILL_SWITCH_ACTIVATED', actorUserId: adminId, metadata: { reason, stoppedFollowers: stopped.count, accounts: results.length } });
    await this.prisma.systemEvent
      .create({ data: { source: 'API', type: 'KILL_SWITCH', severity: 'CRITICAL', message: `Kill switch by admin: ${reason}`, context: { adminId } } })
      .catch(() => undefined);
    this.realtime.toRole('FOLLOWER', WsEvent.KILL_SWITCH, { reason });
    this.realtime.toRole('MASTER', WsEvent.KILL_SWITCH, { reason });
    void this.notifier.alertAdmins('KILL SWITCH activated', reason);
    return { stoppedFollowers: stopped.count, results };
  }

  // ------------------------------------------------------------ exits

  /** One client: stop own copying and exit all own open positions. */
  async exitAllForUser(userId: string): Promise<SquareOffResult[]> {
    await this.prisma.strategyFollower.updateMany({
      where: { followerUserId: userId, copyStatus: { not: 'OFF' } },
      data: { copyStatus: 'OFF', stoppedAt: new Date(), stoppedReason: 'Exit all by client', stoppedByUserId: userId },
    });
    this.registry.scheduleReload(0);
    const accounts = await this.prisma.brokerAccount.findMany({ where: { userId, mode: 'TRADING' } });
    return Promise.all(accounts.map((a) => this.squareOffAccount(a, { intradayOnly: false })));
  }

  /** Master: exit every follower's open COPY positions of a strategy (only what the platform copied). */
  async exitStrategy(strategyId: string): Promise<SquareOffResult[]> {
    const subs = await this.prisma.strategyFollower.findMany({ where: { strategyId, brokerAccountId: { not: null } }, include: { brokerAccount: true } });
    return Promise.all(
      subs.map(async (s) => {
        const positions = this.registry.clientPositions(s.id);
        const res: SquareOffResult = { accountId: s.brokerAccountId!, orders: 0, failed: 0, errors: [] };
        if (!positions.length || !s.brokerAccount) return res;
        const sim = this.trading.isSimulated(s.brokerAccount);
        const adapter = sim ? null : await this.trading.adapterFor(s.brokerAccount).catch((e: Error) => (res.errors.push(e.message), null));
        await Promise.all(
          positions.map(async (p) => {
            const side = p.qty > 0 ? 'SELL' : 'BUY';
            const qty = Math.abs(p.qty);
            try {
              if (sim) {
                const held = (await this.engine.paperAccountFor(s.followerUserId, { ...p, side }, s.brokerAccountId)) ?? s.brokerAccountId!;
                await this.engine.applyPaperFill(s.followerUserId, held, { ...p, side }, qty, this.prices.get(instrumentKey(p.exchange, p.symbol)) ?? 0);
              } else if (adapter) {
                this.trading.assertOrderAllowed(s.brokerAccount!);
                // Part / all of it may already be closed by the client in his broker app — that part is booked as
                // exited (and taken off the net position) instead of sending an order for it.
                const send = await this.engine.exitQtyHeldAtBroker(adapter, {
                  userId: s.followerUserId,
                  accountId: s.brokerAccountId!,
                  followerId: s.id,
                  exchange: p.exchange,
                  symbol: p.symbol,
                  productType: p.productType,
                  exitSide: side,
                  qty,
                  fallbackPrice: this.prices.get(instrumentKey(p.exchange, p.symbol)) ?? null,
                });
                if (send <= 0) return;
                await adapter.placeOrder({ exchange: p.exchange, symbol: p.symbol, side, quantity: send, orderType: 'MARKET', productType: p.productType, tag: 'ctpexit' });
                this.registry.applyClientFill(s.id, p.exchange, p.symbol, p.productType, side === 'SELL' ? -send : send);
                await this.logManualExit(s.brokerAccount!, p, side, send, this.prices.get(instrumentKey(p.exchange, p.symbol)) ?? null, null);
                res.orders++;
                return;
              } else return;
              this.registry.applyClientFill(s.id, p.exchange, p.symbol, p.productType, -p.qty);
              await this.logManualExit(s.brokerAccount!, p, side, qty, this.prices.get(instrumentKey(p.exchange, p.symbol)) ?? null, null);
              res.orders++;
            } catch (e) {
              res.failed++;
              res.errors.push((e as Error).message);
            }
          }),
        );
        return res;
      }),
    );
  }

  /**
   * Records an exit that did not go through the copy engine (client / master "Exit", exit-all, square-off,
   * strategy exit). Today's P&L (ClientSummaryService) reads these so a closed position stops moving with LTP.
   */
  private async logManualExit(
    account: Pick<BrokerAccount, 'id'>,
    p: { exchange: Exchange; symbol: string; productType: ProductType },
    side: 'BUY' | 'SELL',
    quantity: number,
    price: number | null,
    actorUserId: string | null,
    orderId: string | null = null,
  ): Promise<void> {
    await this.audit.log({
      action: 'COPY_STOPPED',
      actorUserId: actorUserId ?? undefined,
      targetType: 'BrokerAccount',
      targetId: account.id,
      metadata: { manualExit: true, exchange: p.exchange, symbol: p.symbol, productType: p.productType, side, quantity, price, orderId },
    });
  }

  /** Follower subscriptions using this account (their net copy positions must follow manual exits). */
  private async followerIdsOf(accountId: string): Promise<string[]> {
    const subs = await this.prisma.strategyFollower.findMany({ where: { brokerAccountId: accountId }, select: { id: true } });
    return subs.map((s) => s.id);
  }

  /**
   * Exits ONE open position of an account with a MARKET order (paper: closes the paper position at LTP).
   * Quantity comes from the broker's own position, so it never sells more than is held.
   */
  async exitPosition(
    account: BrokerAccount,
    pos: { exchange: Exchange; symbol: string; productType: ProductType },
    actorUserId: string,
  ): Promise<{ orderId: string | null; quantity: number }> {
    if (account.mode === 'DATA_ONLY') throw new BadRequestException('A data-only (master) account never places orders');
    const key = instrumentKey(pos.exchange, pos.symbol);
    let quantity = 0;
    let orderId: string | null = null;
    let side: 'BUY' | 'SELL' = 'SELL';
    let price: number | null = null;
    if (this.trading.isSimulated(account)) {
      const p = await this.prisma.position.findFirst({
        where: { brokerAccountId: account.id, isPaper: true, exchange: pos.exchange, symbol: pos.symbol, productType: pos.productType, quantity: { not: 0 } },
      });
      if (!p) throw new BadRequestException('No open position for this symbol');
      price = this.prices.get(key) ?? Number(p.lastPrice ?? p.averagePrice);
      quantity = Math.abs(p.quantity);
      side = p.quantity > 0 ? 'SELL' : 'BUY';
      await this.engine.applyPaperFill(account.userId, account.id, { ...p, side }, quantity, price);
    } else {
      const adapter = await this.trading.adapterFor(account);
      const p = (await adapter.positions()).find(
        (x) => x.exchange === pos.exchange && x.symbol === pos.symbol && x.productType === pos.productType && x.quantity !== 0,
      );
      if (!p) {
        // Not held at the broker any more (the client closed it in his broker app), but still OPEN here: book it
        // as exited here too instead of failing, so the trade closes.
        let booked = 0;
        for (const fid of await this.followerIdsOf(account.id)) {
          const net = this.registry.clientNet(fid, pos.exchange, pos.symbol, pos.productType);
          if (!net) continue;
          await this.engine.exitQtyHeldAtBroker(adapter, {
            userId: account.userId,
            accountId: account.id,
            followerId: fid,
            exchange: pos.exchange,
            symbol: pos.symbol,
            productType: pos.productType,
            exitSide: net > 0 ? 'SELL' : 'BUY',
            qty: Math.abs(net),
            fallbackPrice: this.prices.get(key) ?? null,
          });
          booked += Math.abs(net) - Math.abs(this.registry.clientNet(fid, pos.exchange, pos.symbol, pos.productType));
        }
        if (!booked) throw new BadRequestException('No open position for this symbol at the broker');
        return { orderId: null, quantity: booked };
      }
      quantity = Math.abs(p.quantity);
      side = p.quantity > 0 ? 'SELL' : 'BUY';
      price = this.prices.get(key) ?? p.lastPrice;
      this.trading.assertOrderAllowed(account);
      ({ brokerOrderId: orderId } = await adapter.placeOrder({
        exchange: p.exchange,
        symbol: p.symbol,
        side: p.quantity > 0 ? 'SELL' : 'BUY',
        quantity,
        orderType: 'MARKET',
        productType: p.productType,
        tag: 'ctpexit',
      }));
    }
    this.registry.clearPosition(await this.followerIdsOf(account.id), pos.exchange, pos.symbol, pos.productType);
    await this.logManualExit(account, pos, side, quantity, price, actorUserId, orderId);
    this.realtime.toUser(account.userId, WsEvent.POSITION_UPDATED, { symbol: pos.symbol, status: 'EXITED', quantity });
    return { orderId, quantity };
  }

  /** Square off every client trading account currently in the registry (or every connected TRADING account). */
  async squareOffAll(opts: { intradayOnly: boolean; includeAllTradingAccounts?: boolean }): Promise<SquareOffResult[]> {
    const ids = new Set(this.registry.allEntries().map((e) => e.accountId));
    const accounts = await this.prisma.brokerAccount.findMany({
      where: opts.includeAllTradingAccounts ? { mode: 'TRADING', OR: [{ status: 'CONNECTED' }, { isPaper: true }, { broker: 'MOCK' }] } : { id: { in: [...ids] } },
    });
    return Promise.all(accounts.map((a) => this.squareOffAccount(a, opts).catch((e: Error) => ({ accountId: a.id, orders: 0, failed: 1, errors: [e.message] }))));
  }

  /** Exits all non-zero positions of one account with MARKET orders (paper: zeroes the paper positions). */
  async squareOffAccount(account: BrokerAccount, opts: { intradayOnly: boolean }): Promise<SquareOffResult> {
    const res: SquareOffResult = { accountId: account.id, orders: 0, failed: 0, errors: [] };
    if (account.mode === 'DATA_ONLY') return res; // master feed account — never trades
    const keep = (p: ProductType) => !opts.intradayOnly || p === 'INTRADAY';
    if (this.trading.isSimulated(account)) {
      const rows = await this.prisma.position.findMany({ where: { brokerAccountId: account.id, isPaper: true, quantity: { not: 0 } } });
      for (const p of rows.filter((r) => keep(r.productType))) {
        const price = this.prices.get(instrumentKey(p.exchange, p.symbol)) ?? Number(p.lastPrice ?? p.averagePrice);
        await this.engine.applyPaperFill(account.userId, account.id, { ...p, side: p.quantity > 0 ? 'SELL' : 'BUY' }, Math.abs(p.quantity), price);
        this.registry.clearPosition(await this.followerIdsOf(account.id), p.exchange, p.symbol, p.productType);
        await this.logManualExit(account, p, p.quantity > 0 ? 'SELL' : 'BUY', Math.abs(p.quantity), price, null);
        res.orders++;
      }
      return res;
    }
    let adapter: BrokerAdapter;
    try {
      adapter = await this.trading.adapterFor(account);
    } catch (e) {
      res.errors.push((e as Error).message);
      return res;
    }
    const positions = (await adapter.positions()).filter((p) => p.quantity !== 0 && keep(p.productType));
    await Promise.all(
      positions.map(async (p) => {
        try {
          this.trading.assertOrderAllowed(account);
          const { brokerOrderId } = await adapter.placeOrder({ exchange: p.exchange, symbol: p.symbol, side: p.quantity > 0 ? 'SELL' : 'BUY', quantity: Math.abs(p.quantity), orderType: 'MARKET', productType: p.productType, tag: 'ctpsqoff' });
          // Keep the copy engine's net position in step, so a later master exit never double-exits.
          this.registry.clearPosition(await this.followerIdsOf(account.id), p.exchange, p.symbol, p.productType);
          await this.logManualExit(account, p, p.quantity > 0 ? 'SELL' : 'BUY', Math.abs(p.quantity), this.prices.get(instrumentKey(p.exchange, p.symbol)) ?? p.lastPrice, null, brokerOrderId);
          res.orders++;
        } catch (e) {
          res.failed++;
          res.errors.push(`${p.symbol}: ${(e as Error).message}`);
        }
      }),
    );
    if (res.orders || res.failed) {
      void this.notifier.notify({
        userId: account.userId,
        type: 'SQUARE_OFF',
        severity: res.failed ? 'WARNING' : 'INFO',
        title: `Square-off: ${res.orders} exit order(s)${res.failed ? `, ${res.failed} failed` : ''}`,
        body: res.errors.slice(0, 3).join('\n') || undefined,
      });
    }
    return res;
  }
}
