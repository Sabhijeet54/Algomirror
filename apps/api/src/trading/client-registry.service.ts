import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from "@nestjs/common";
import type { Subscription } from "rxjs";
import type {
  AllocationMode,
  BrokerAccount,
  BrokerName,
  Exchange,
  PrismaClient,
  ProductType,
} from "@ctp/database";
import { startOfTradingDayIST } from "../admin/admin.service";
import { warmConnection } from "../brokers/broker-http";
import { BrokerSessionService } from "../brokers/broker-session.service";
import { PRISMA } from "../common/prisma/prisma.service";
import { API_CONFIG, ApiConfig } from "../config/config.module";
import { AccountEvents } from "../realtime/account-events";
import { ADAPTERS, overridesFrom } from "./adapter-factory";
import type { BrokerAdapter } from "./broker-adapter";
import type { QtySettings, QtyStrategy } from "./copy-quantity";
import { TradingService } from "./trading.service";

export interface ClientSettings extends QtySettings {
  allocationMode: AllocationMode;
  maxDailyLoss: number | null;
  maxTradesPerDay: number | null;
  allowedSegments: string[];
}

/** Everything needed to place one follower's copy order without touching the database. */
export interface ClientEntry {
  followerId: string;
  strategyId: string;
  userId: string;
  accountId: string;
  broker: BrokerName;
  brokerClientId: string | null;
  /** Paper: PAPER_MODE, isPaper or MOCK. */
  simulated: boolean;
  /** Pre-built adapter with the decrypted token (null for simulated accounts). */
  adapter: BrokerAdapter | null;
  /** epoch ms, null = no expiry known */
  tokenExpiresAt: number | null;
  settings: ClientSettings;
}

export interface SkippedClient {
  followerId: string;
  userId: string;
  accountId: string | null;
  broker: BrokerName | null;
  reason: string;
  /** Present when the follower's settings are known, so a "missed signal" can show the would-be quantity. */
  settings?: ClientSettings;
}

export interface StrategyInfo extends QtyStrategy {
  id: string;
  masterUserId: string;
  allowedExchanges: Exchange[];
  allowedInstruments: string[];
}

export interface DayState {
  day: string;
  trades: number;
  /** Latest day P&L of the follower account (from the risk poller), null = unknown. */
  pnl: number | null;
  breached: boolean;
}

const istDay = () =>
  new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
const posKey = (
  owner: string,
  exchange: string,
  symbol: string,
  product: ProductType,
) => `${owner}|${exchange}:${symbol}|${product}`;
const N = (v: unknown) => (v == null ? null : Number(v));

/**
 * In-memory snapshot of every follower that is currently copying: decrypted tokens → pre-built broker
 * adapters, allocation + risk settings, today's trade counts and net copy positions. Loaded at boot and on
 * every connect / disconnect / expiry / settings change (AccountEvents), plus a 60 s safety refresh.
 * The copy engine's hot path reads only from here — no DB, no decryption, no quote calls.
 */
@Injectable()
export class ClientRegistryService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger("ClientRegistry");
  private byStrategy = new Map<string, ClientEntry[]>();
  private skippedByStrategy = new Map<string, SkippedClient[]>();
  private strategies = new Map<string, StrategyInfo>();
  private readonly days = new Map<string, DayState>();
  /** follower net copy positions (followerId|EX:SYM|PRODUCT) and master net positions (strategyId|…) */
  private readonly netPos = new Map<string, number>();
  private readonly masterNet = new Map<string, number>();
  private seededDay = "";
  private reloadTimer?: NodeJS.Timeout;
  private refresh?: NodeJS.Timeout;
  private warm?: NodeJS.Timeout;
  private sub?: Subscription;
  private loading?: Promise<void>;
  loadedAt = 0;

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly sessions: BrokerSessionService,
    private readonly trading: TradingService,
    private readonly accountEvents: AccountEvents,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.NODE_ENV === "test") return;
    this.sub = this.accountEvents.events$.subscribe((e) => {
      // Disconnect/expiry must take effect immediately, before the debounced reload finishes.
      if (e.type === "disconnected" || e.type === "expired")
        this.evictAccount(e.brokerAccountId, `Broker account ${e.type}`);
      this.scheduleReload();
    });
    await this.reload().catch((err) =>
      this.logger.error(`Initial load failed: ${(err as Error).message}`),
    );
    this.refresh = setInterval(
      () => void this.reload().catch(() => undefined),
      60_000,
    );
    this.warm = setInterval(() => this.warmConnections(), 30_000);
    this.warmConnections();
  }

  onModuleDestroy(): void {
    this.sub?.unsubscribe();
    for (const t of [this.reloadTimer]) if (t) clearTimeout(t);
    for (const t of [this.refresh, this.warm]) if (t) clearInterval(t);
  }

  // ------------------------------------------------------------ reads (sync)

  forStrategy(strategyId: string): ClientEntry[] {
    return this.byStrategy.get(strategyId) ?? [];
  }
  skipped(strategyId: string): SkippedClient[] {
    return this.skippedByStrategy.get(strategyId) ?? [];
  }
  strategy(strategyId: string): StrategyInfo | undefined {
    return this.strategies.get(strategyId);
  }
  allEntries(): ClientEntry[] {
    return [...this.byStrategy.values()].flat();
  }

  day(followerId: string): DayState {
    const today = istDay();
    let d = this.days.get(followerId);
    if (!d || d.day !== today) {
      d = { day: today, trades: 0, pnl: null, breached: false };
      this.days.set(followerId, d);
    }
    return d;
  }

  clientNet(
    followerId: string,
    ex: string,
    sym: string,
    product: ProductType,
  ): number {
    return this.netPos.get(posKey(followerId, ex, sym, product)) ?? 0;
  }
  applyClientFill(
    followerId: string,
    ex: string,
    sym: string,
    product: ProductType,
    signedQty: number,
  ): void {
    const k = posKey(followerId, ex, sym, product);
    this.netPos.set(k, (this.netPos.get(k) ?? 0) + signedQty);
  }
  /** Non-zero net copy positions of a follower (for exit-all). */
  clientPositions(
    followerId: string,
  ): {
    exchange: Exchange;
    symbol: string;
    productType: ProductType;
    qty: number;
  }[] {
    const out: {
      exchange: Exchange;
      symbol: string;
      productType: ProductType;
      qty: number;
    }[] = [];
    for (const [k, q] of this.netPos) {
      if (!q || !k.startsWith(`${followerId}|`)) continue;
      const [, inst, product] = k.split("|");
      const [ex, ...sym] = inst!.split(":");
      out.push({
        exchange: ex as Exchange,
        symbol: sym.join(":"),
        productType: product as ProductType,
        qty: q,
      });
    }
    return out;
  }
  /** Non-zero master net positions of a strategy (for strategy exit / signal-book exit). */
  masterPositions(
    strategyId: string,
  ): {
    exchange: Exchange;
    symbol: string;
    productType: ProductType;
    qty: number;
  }[] {
    const out: {
      exchange: Exchange;
      symbol: string;
      productType: ProductType;
      qty: number;
    }[] = [];
    for (const [k, q] of this.masterNet) {
      if (!q || !k.startsWith(`${strategyId}|`)) continue;
      const [, inst, product] = k.split("|");
      const [ex, ...sym] = inst!.split(":");
      out.push({
        exchange: ex as Exchange,
        symbol: sym.join(":"),
        productType: product as ProductType,
        qty: q,
      });
    }
    return out;
  }

  masterNetOf(
    strategyId: string,
    ex: string,
    sym: string,
    product: ProductType,
  ): number {
    return this.masterNet.get(posKey(strategyId, ex, sym, product)) ?? 0;
  }
  applyMasterFill(
    strategyId: string,
    ex: string,
    sym: string,
    product: ProductType,
    signedQty: number,
  ): void {
    const k = posKey(strategyId, ex, sym, product);
    this.masterNet.set(k, (this.masterNet.get(k) ?? 0) + signedQty);
  }

  // ------------------------------------------------------------ mutations

  evictAccount(accountId: string, reason: string): void {
    for (const [sid, list] of this.byStrategy) {
      const keep = list.filter((e) => e.accountId !== accountId);
      if (keep.length === list.length) continue;
      const gone = list.filter((e) => e.accountId === accountId);
      this.byStrategy.set(sid, keep);
      this.skippedByStrategy.set(sid, [
        ...(this.skippedByStrategy.get(sid) ?? []),
        ...gone.map((g) => ({
          followerId: g.followerId,
          userId: g.userId,
          accountId,
          broker: g.broker,
          reason,
          settings: g.settings,
        })),
      ]);
    }
  }

  /** Position was exited outside the copy engine (manual exit / square-off): forget the net copy position. */
  clearPosition(
    followerIds: string[],
    exchange: string,
    symbol: string,
    product: ProductType,
  ): void {
    for (const f of followerIds)
      this.netPos.delete(posKey(f, exchange, symbol, product));
  }

  /** Removes a follower from copying immediately (copy OFF / loss limit). */
  evictFollower(followerId: string): void {
    for (const [sid, list] of this.byStrategy)
      this.byStrategy.set(
        sid,
        list.filter((e) => e.followerId !== followerId),
      );
  }

  scheduleReload(delayMs = 150): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = undefined;
      void this.reload().catch((err) =>
        this.logger.warn(`Reload failed: ${(err as Error).message}`),
      );
    }, delayMs);
  }

  /** Rebuilds the snapshot (off the hot path) and swaps it in atomically. */
  reload(): Promise<void> {
    this.loading ??= this.doReload().finally(() => (this.loading = undefined));
    return this.loading;
  }

  private async doReload(): Promise<void> {
    const started = Date.now();
    const rows = await this.prisma.strategyFollower.findMany({
      where: { copyStatus: "ON", strategy: { status: "ACTIVE" } },
      include: {
        brokerAccount: true,
        strategy: true,
        follower: {
          select: { licenceExpiresAt: true, status: true, demo: true },
        },
      },
    });
    const now = Date.now();
    const byStrategy = new Map<string, ClientEntry[]>();
    const skipped = new Map<string, SkippedClient[]>();
    const strategies = new Map<string, StrategyInfo>();
    const adapters = new Map<string, BrokerAdapter | null>();

    for (const r of rows) {
      const s = r.strategy;
      strategies.set(s.id, {
        id: s.id,
        masterUserId: s.masterUserId,
        masterCapital: N(s.masterCapital),
        maxOrderValue: N(s.maxOrderValue),
        maxQuantityPerOrder: s.maxQuantityPerOrder,
        allowedExchanges: s.allowedExchanges,
        allowedInstruments: s.allowedInstruments,
      });
      const a = r.brokerAccount;
      const settings: ClientSettings = {
        allocationMode: r.allocationMode,
        allocationPercent: N(r.allocationPercent),
        allocationAmount: N(r.allocationAmount),
        fixedQuantity: r.fixedQuantity,
        fixedLots: r.fixedLots,
        maxLots: r.maxLots,
        maxQuantity: r.maxQuantity,
        maxTradeValue: N(r.maxTradeValue),
        maxDailyLoss: N(r.maxDailyLoss),
        maxTradesPerDay: r.maxTradesPerDay,
        allowedSegments: r.allowedSegments ?? [],
      };
      const skip = (reason: string) =>
        skipped.set(s.id, [
          ...(skipped.get(s.id) ?? []),
          {
            followerId: r.id,
            userId: r.followerUserId,
            accountId: a?.id ?? null,
            broker: a?.broker ?? null,
            reason,
            settings,
          },
        ]);
      if (r.follower.status !== "ACTIVE") {
        skip("Client account disabled");
        continue;
      }
      // Licence: none assigned = allowed unless LICENCE_REQUIRED; an expired licence always stops copying.
      const lic = r.follower.licenceExpiresAt?.getTime() ?? null;
      if (lic !== null ? lic <= now : this.config.LICENCE_REQUIRED) {
        skip(
          lic !== null
            ? "Licence expired — renew to resume copy trading"
            : "No licence assigned",
        );
        continue;
      }
      if (!a) {
        skip("No broker account selected");
        continue;
      }
      // Demo licence: always paper, whatever the account switch says.
      const simulated = this.trading.isSimulated(a) || r.follower.demo;
      if (!simulated) {
        if (a.mode === "DATA_ONLY") {
          skip("Account is DATA_ONLY (master) — orders blocked");
          continue;
        }
        if (a.status !== "CONNECTED") {
          skip(
            `Broker ${a.status.toLowerCase()}${a.disconnectReason ? `: ${a.disconnectReason}` : ""}`,
          );
          continue;
        }
        if (a.tokenExpiresAt && a.tokenExpiresAt.getTime() <= now) {
          skip("Broker token expired");
          continue;
        }
      }
      let adapter: BrokerAdapter | null = null;
      if (!simulated) {
        if (!adapters.has(a.id)) adapters.set(a.id, await this.buildAdapter(a));
        adapter = adapters.get(a.id) ?? null;
        if (!adapter) {
          skip("Broker session unavailable");
          continue;
        }
      }
      const entry: ClientEntry = {
        followerId: r.id,
        strategyId: s.id,
        userId: r.followerUserId,
        accountId: a.id,
        broker: a.broker,
        brokerClientId: a.brokerClientId,
        simulated,
        adapter,
        tokenExpiresAt: a.tokenExpiresAt?.getTime() ?? null,
        settings,
      };
      byStrategy.set(s.id, [...(byStrategy.get(s.id) ?? []), entry]);
    }

    if (this.seededDay !== istDay()) await this.seedDay();

    this.byStrategy = byStrategy;
    this.skippedByStrategy = skipped;
    this.strategies = strategies;
    this.loadedAt = Date.now();
    const n = rows.length;
    if (n)
      this.logger.debug?.(
        `Registry: ${n} followers, ${[...byStrategy.values()].flat().length} ready, ${Date.now() - started} ms`,
      );
  }

  private async buildAdapter(a: BrokerAccount): Promise<BrokerAdapter | null> {
    try {
      const token = await this.sessions.decryptAccess(a);
      if (!token) return null;
      const o = overridesFrom(await this.sessions.decryptExtra(a));
      // Live orders must leave from the client's registered static IP when the server requires it.
      if (
        this.config.REQUIRE_CLIENT_PROXY &&
        !this.trading.isSimulated(a) &&
        !o.proxyUrl
      ) {
        this.logger.warn(
          `Account ${a.id} has no static-IP proxy — skipped (REQUIRE_CLIENT_PROXY)`,
        );
        return null;
      }
      return this.trading.buildAdapter(a, token, o);
    } catch (err) {
      this.logger.warn(`Adapter for ${a.id} failed: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * Once per IST day: trade counts (today) + net positions (survives restarts). Net positions start from the
   * oldest still-OPEN signal, so a carry-forward (NRML) BUY from an earlier day is still known: the master's
   * SELL next day exits it instead of opening an opposite (short) trade for every client.
   */
  private async seedDay(): Promise<void> {
    const today = startOfTradingDayIST();
    const oldestOpen = await this.prisma.masterTrade.findFirst({
      where: { signalStatus: "OPEN", createdAt: { lt: today } },
      orderBy: { createdAt: "asc" },
      select: { createdAt: true },
    });
    const since = oldestOpen ? oldestOpen.createdAt : today;
    const [orders, masters] = await Promise.all([
      this.prisma.copyOrder.findMany({
        where: {
          createdAt: { gte: since },
          OR: [
            {
              status: {
                in: ["SUBMITTED", "OPEN", "PARTIALLY_FILLED", "FILLED"],
              },
            },
            {
              status: { in: ["CANCELLED", "REJECTED"] },
              filledQuantity: { gt: 0 },
            },
          ],
        },
        select: {
          strategyFollowerId: true,
          exchange: true,
          symbol: true,
          productType: true,
          side: true,
          quantity: true,
          filledQuantity: true,
          status: true,
          mirrored: true,
          createdAt: true,
        },
      }),
      this.prisma.masterTrade.findMany({
        where: {
          createdAt: { gte: since },
          strategyId: { not: null },
          OR: [
            {
              status: {
                in: ["SUBMITTED", "OPEN", "PARTIALLY_FILLED", "FILLED"],
              },
            },
            {
              status: { in: ["CANCELLED", "REJECTED"] },
              filledQuantity: { gt: 0 },
            },
          ],
        },
        select: {
          strategyId: true,
          exchange: true,
          symbol: true,
          productType: true,
          side: true,
          quantity: true,
          filledQuantity: true,
          status: true,
        },
      }),
    ]);
    // Exits / resizes done outside the copy engine (manual exit, square-off, lot-multiplier change) — replayed in
    // time order with the copy orders so the net positions match what the client really holds.
    const manual = await this.prisma.auditLog.findMany({
      where: {
        createdAt: { gte: since },
        OR: [
          { action: "COPY_STOPPED", targetType: "BrokerAccount" },
          { action: "PROFILE_UPDATED", targetType: "StrategyFollower" },
        ],
      },
      select: {
        targetId: true,
        targetType: true,
        metadata: true,
        createdAt: true,
      },
    });
    const followersByAccount = new Map<string, string[]>();
    for (const f of await this.prisma.strategyFollower.findMany({
      where: { brokerAccountId: { not: null } },
      select: { id: true, brokerAccountId: true },
    })) {
      followersByAccount.set(f.brokerAccountId!, [
        ...(followersByAccount.get(f.brokerAccountId!) ?? []),
        f.id,
      ]);
    }
    type M = {
      manualExit?: boolean;
      manualAdjust?: boolean;
      exchange?: string;
      symbol?: string;
      productType?: ProductType;
      side?: string;
      quantity?: number;
      /** Exit done in the broker app: exact per-subscription reductions (may be partial). */
      followerAdjust?: { followerId: string; qty: number }[];
    };
    const events: { at: number; run: () => void }[] = [];
    this.netPos.clear();
    this.masterNet.clear();
    this.days.clear();
    for (const o of orders) {
      if (!o.mirrored && o.createdAt >= today)
        this.day(o.strategyFollowerId).trades++;
      // Mirrored SL/target orders count only when filled; a normal order still pending counts in full.
      const pendingNormal =
        !o.mirrored &&
        (o.status === "SUBMITTED" ||
          o.status === "OPEN" ||
          o.status === "PARTIALLY_FILLED");
      const q = pendingNormal ? o.quantity : o.filledQuantity;
      if (!q) continue;
      events.push({
        at: o.createdAt.getTime(),
        run: () =>
          this.applyClientFill(
            o.strategyFollowerId,
            o.exchange,
            o.symbol,
            o.productType,
            o.side === "BUY" ? q : -q,
          ),
      });
    }
    for (const a of manual) {
      const m = a.metadata as M | null;
      if (!m?.exchange || !m.symbol || !m.productType || !a.targetId) continue;
      if (
        m.manualExit &&
        a.targetType === "BrokerAccount" &&
        m.followerAdjust?.length
      ) {
        const adj = m.followerAdjust;
        events.push({
          at: a.createdAt.getTime(),
          run: () =>
            adj.forEach((x) =>
              this.applyClientFill(
                x.followerId,
                m.exchange!,
                m.symbol!,
                m.productType!,
                x.qty,
              ),
            ),
        });
      } else if (m.manualExit && a.targetType === "BrokerAccount") {
        events.push({
          at: a.createdAt.getTime(),
          run: () =>
            this.clearPosition(
              followersByAccount.get(a.targetId!) ?? [],
              m.exchange!,
              m.symbol!,
              m.productType!,
            ),
        });
      } else if (
        m.manualAdjust &&
        a.targetType === "StrategyFollower" &&
        m.quantity
      ) {
        const signed = m.side === "SELL" ? -m.quantity : m.quantity;
        events.push({
          at: a.createdAt.getTime(),
          run: () =>
            this.applyClientFill(
              a.targetId!,
              m.exchange!,
              m.symbol!,
              m.productType!,
              signed,
            ),
        });
      }
    }
    events.sort((x, y) => x.at - y.at).forEach((e) => e.run());
    for (const m of masters) {
      // Platform-placed master orders not yet confirmed count in full; everything else counts what filled.
      const q = m.status === "SUBMITTED" ? m.quantity : m.filledQuantity;
      if (!q) continue;
      this.applyMasterFill(
        m.strategyId!,
        m.exchange,
        m.symbol,
        m.productType,
        m.side === "BUY" ? q : -q,
      );
    }
    this.seededDay = istDay();
  }

  /** Keeps TLS connections to each broker in use warm so the first order of the day is fast. */
  private warmConnections(): void {
    const brokers = new Set(
      this.allEntries()
        .filter((e) => !e.simulated)
        .map((e) => e.broker),
    );
    for (const b of brokers) {
      const f = ADAPTERS[b];
      if (f) void warmConnection(f.origin, f.proxyUrl?.(this.config));
    }
  }
}
