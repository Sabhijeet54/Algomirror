import { Inject, Injectable, Logger } from "@nestjs/common";
import type { PrismaClient } from "@ctp/database";
import { startOfTradingDayIST } from "../admin/admin.service";
import { PRISMA } from "../common/prisma/prisma.service";
import { MarketFeedService } from "../market-data/market-feed.service";
import {
  instrumentKey,
  PriceCacheService,
} from "../market-data/price-cache.service";
import { allocationLabel, isRemoved } from "./follower-access";

export { allocationLabel, isRemoved, REMOVED_REASON } from "./follower-access";

/** Trades are shown at the client's current lot multiplier (see displayQty). */
const DISPLAY_SCALED = true;

type SubLike = {
  allocationMode: string;
  allocationPercent: unknown;
  fixedQuantity: number | null;
  fixedLots: number | null;
};
type MasterLike =
  | { quantity: number; filledQuantity: number; rawPayload: unknown }
  | null
  | undefined;

/**
 * DISPLAY quantity of a copied order at the client's CURRENT lot multiplier (website only).
 * Changing the multiplier re-states today's trades (open and closed) on the website; nothing is sent to the
 * broker and the real copied quantity is unchanged. Falls back to the real filled quantity.
 */
export function displayQty(
  sub: SubLike | undefined,
  master: MasterLike,
  realQty: number,
): number {
  if (!sub || !master) return realQty;
  const masterQty =
    master.filledQuantity > 0 ? master.filledQuantity : master.quantity;
  const lot = Math.max(
    1,
    Number((master.rawPayload as { lotSize?: number } | null)?.lotSize) || 1,
  );
  let q: number;
  if (sub.allocationMode === "CAPITAL_PERCENTAGE")
    q = Math.floor((masterQty * (Number(sub.allocationPercent) || 0)) / 100);
  else if (sub.allocationMode === "FIXED_QUANTITY")
    q = sub.fixedLots ? sub.fixedLots * lot : (sub.fixedQuantity ?? realQty);
  else return realQty;
  q = Math.floor(q / lot) * lot;
  return q > 0 ? q : realQty;
}

export interface StrategyDaySummary {
  followerId: string;
  strategyId: string;
  name: string;
  strategyStatus: string;
  copyStatus: "ON" | "OFF" | "PAUSED";
  allocation: string;
  todayPnl: number;
  todayTrades: number;
  todayQty: number;
  brokerPnl: number;
}

/** Broker side of a software trade (from the linked entry order). */
export type ExecutionState =
  "PAPER" | "EXECUTED" | "PARTIAL" | "PENDING" | "NOT_EXECUTED";

/** One software-generated strategy trade (internal trade ledger). */
export interface LedgerTrade {
  /** Strategy Trade ID = id of the entry copy order created for this strategy signal (unique per signal × client). */
  tradeId: string;
  /** Short display form of tradeId. */
  tradeRef: string;
  signalId: string;
  followerId: string;
  strategyName: string;
  mode: "PAPER" | "LIVE";
  exchange: string;
  symbol: string;
  productType: string;
  side: "BUY" | "SELL";
  quantity: number;
  lots: number | null;
  openQuantity: number;
  entryPrice: number;
  entryAt: string;
  carried: boolean;
  exitPrice: number | null;
  exitAt: string | null;
  ltp: number | null;
  /** Software status: from the strategy signal (and exits done in the software), never from the broker. */
  status: "OPEN" | "CLOSED";
  realizedPnl: number;
  unrealizedPnl: number;
  pnl: number;
  /** Broker execution of the entry order — details live in the Orders section. */
  execution: ExecutionState;
}

export interface LedgerSummary {
  trades: number;
  open: number;
  closed: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
}

/** Not a strategy trade for this client (risk-rule / licence skip) — kept in Orders only. */
export const isLedgerEligible = (o: {
  errorCode: string | null;
  quantity: number;
  isExit: boolean;
  mirrored: boolean;
}) => !o.isExit && !o.mirrored && o.quantity > 0 && o.errorCode !== "SKIPPED";

export function executionOf(o: {
  isPaper: boolean;
  status: string;
  filledQuantity: number;
  quantity: number;
}): ExecutionState {
  if (o.isPaper) return "PAPER";
  if (o.filledQuantity > 0)
    return o.filledQuantity >= o.quantity || o.status === "FILLED"
      ? "EXECUTED"
      : "PARTIAL";
  if (
    ["PENDING", "SUBMITTED", "OPEN", "UNKNOWN", "PARTIALLY_FILLED"].includes(
      o.status,
    )
  )
    return "PENDING";
  return "NOT_EXECUTED";
}

export const tradeRef = (id: string) => `T-${id.slice(-8).toUpperCase()}`;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Today's (IST trading day) P&L of a client, per strategy subscription.
 * todayPnl = SOFTWARE P&L from the trade ledger (every strategy trade at the strategy's prices, also when the
 * broker rejected it or the demat was not connected); brokerPnl = actual executed P&L (copy fills, paper fills).
 */
@Injectable()
export class ClientSummaryService {
  private readonly logger = new Logger("ClientSummary");
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    private readonly prices: PriceCacheService,
    private readonly feed: MarketFeedService,
  ) {}

  /** `masterUserId` set = only subscriptions to that master's strategies. Removed subscriptions are left out. */
  async today(
    userId: string,
    masterUserId?: string,
  ): Promise<{
    todayPnl: number;
    brokerPnl: number;
    strategies: StrategyDaySummary[];
  }> {
    const since = startOfTradingDayIST();
    const subsAll = await this.prisma.strategyFollower.findMany({
      where: {
        followerUserId: userId,
        ...(masterUserId ? { strategy: { masterUserId } } : {}),
      },
      include: { strategy: { select: { name: true, status: true } } },
      orderBy: { createdAt: "asc" },
    });
    const subs = subsAll.filter((s) => !isRemoved(s));
    const orders = await this.prisma.copyOrder.findMany({
      where: {
        followerUserId: userId,
        createdAt: { gte: since },
        filledQuantity: { gt: 0 },
        strategyFollowerId: { in: subsAll.map((s) => s.id) },
      },
      select: {
        strategyFollowerId: true,
        exchange: true,
        symbol: true,
        side: true,
        filledQuantity: true,
        averagePrice: true,
        masterTrade: {
          select: { quantity: true, filledQuantity: true, rawPayload: true },
        },
      },
    });
    const subById = new Map(subsAll.map((x) => [x.id, x]));
    // Per subscription & instrument: cash flow and net quantity.
    const book = new Map<
      string,
      Map<string, { cash: number; net: number; last: number }>
    >();
    const trades = new Map<string, number>();
    for (const o of orders) {
      const px = o.averagePrice == null ? 0 : Number(o.averagePrice);
      const sign = o.side === "BUY" ? 1 : -1;
      const inst = `${o.exchange}:${o.symbol}`;
      const m = book.get(o.strategyFollowerId) ?? new Map();
      const cur = m.get(inst) ?? { cash: 0, net: 0, last: px };
      const q = displayQty(
        subById.get(o.strategyFollowerId),
        o.masterTrade,
        o.filledQuantity,
      );
      cur.cash -= sign * q * px;
      cur.net += sign * q;
      cur.last = px || cur.last;
      m.set(inst, cur);
      book.set(o.strategyFollowerId, m);
      trades.set(
        o.strategyFollowerId,
        (trades.get(o.strategyFollowerId) ?? 0) + 1,
      );
    }
    // Lot-multiplier resizes of open trades (PositionResizeService): extra bought / sold quantity per subscription.
    const adjusts = await this.prisma.auditLog.findMany({
      where: {
        action: "PROFILE_UPDATED",
        targetType: "StrategyFollower",
        targetId: { in: subsAll.map((x) => x.id) },
        createdAt: { gte: since },
      },
      select: { targetId: true, metadata: true },
    });
    for (const a of adjusts) {
      const m = a.metadata as {
        manualAdjust?: boolean;
        exchange?: string;
        symbol?: string;
        side?: string;
        quantity?: number;
        price?: number | null;
      } | null;
      // Display uses the CURRENT multiplier for every trade (displayQty), so real resize orders are not added again.
      if (
        DISPLAY_SCALED ||
        !m?.manualAdjust ||
        !m.exchange ||
        !m.symbol ||
        !m.quantity ||
        !a.targetId
      )
        continue;
      const inst = `${m.exchange}:${m.symbol}`;
      const sign = m.side === "SELL" ? -1 : 1;
      const fm =
        book.get(a.targetId) ??
        new Map<string, { cash: number; net: number; last: number }>();
      const px =
        m.price ??
        this.prices.get(instrumentKey(m.exchange, m.symbol)) ??
        fm.get(inst)?.last ??
        0;
      const cur = fm.get(inst) ?? { cash: 0, net: 0, last: px };
      cur.cash -= sign * m.quantity * px;
      cur.net += sign * m.quantity;
      fm.set(inst, cur);
      book.set(a.targetId, fm);
    }
    // Exits done outside the copy engine (client / master "Exit", exit-all, square-off): close the copied net
    // quantity at the exit price, so a closed position stops moving with the LTP.
    if (book.size) {
      const accounts = await this.prisma.brokerAccount.findMany({
        where: { userId, mode: "TRADING" },
        select: { id: true },
      });
      const exits = accounts.length
        ? await this.prisma.auditLog.findMany({
            where: {
              action: "COPY_STOPPED",
              targetType: "BrokerAccount",
              targetId: { in: accounts.map((a) => a.id) },
              createdAt: { gte: since },
            },
            select: { metadata: true },
            orderBy: { createdAt: "asc" },
          })
        : [];
      for (const e of exits) {
        const m = e.metadata as {
          manualExit?: boolean;
          exchange?: string;
          symbol?: string;
          side?: string;
          quantity?: number;
          price?: number | null;
        } | null;
        if (!m?.manualExit || !m.exchange || !m.symbol || !m.quantity) continue;
        const inst = `${m.exchange}:${m.symbol}`;
        const exitSign = m.side === "BUY" ? 1 : -1; // SELL closes a long (net > 0)
        let left = m.quantity;
        for (const fm of book.values()) {
          const cur = fm.get(inst);
          if (
            !cur ||
            left <= 0 ||
            cur.net === 0 ||
            Math.sign(cur.net) === exitSign
          )
            continue;
          const q = Math.min(left, Math.abs(cur.net));
          const px =
            m.price ??
            this.prices.get(instrumentKey(m.exchange, m.symbol)) ??
            cur.last;
          cur.cash -= exitSign * q * px;
          cur.net += exitSign * q;
          left -= q;
        }
      }
    }
    const pnlOf = (followerId: string) => {
      let pnl = 0;
      for (const [inst, v] of book.get(followerId) ?? []) {
        const [ex, sym] = inst.split(":") as [string, string];
        if (v.net) this.feed.ensure(ex as never, sym);
        const ltp = this.prices.get(instrumentKey(ex, sym)) ?? v.last;
        pnl += v.cash + v.net * ltp;
      }
      return Math.round(pnl * 100) / 100;
    };
    // Same numbers as the trade book (current lot size, manual exits closed at the full shown quantity).
    let tbPnl: Map<string, number> | null = new Map<string, number>();
    try {
      const tb = await this.tradeBook(userId);
      for (const r of tb.rows)
        if (!r.rejected)
          tbPnl.set(r.followerId, (tbPnl.get(r.followerId) ?? 0) + r.pnl);
    } catch (err) {
      this.logger.error(
        `tradeBook failed for ${userId}: ${(err as Error).stack ?? err}`,
      );
      tbPnl = null;
    }
    // SOFTWARE P&L (what the strategy did, at your lot size) — includes trades the broker rejected or that never
    // reached the demat. The actual demat P&L stays in `brokerPnl` (Portfolio / positions).
    const sw = new Map<string, { pnl: number; trades: number; qty: number }>();
    let ledgerOk = true;
    try {
      for (const t of (await this.ledger(userId, masterUserId)).trades) {
        const cur = sw.get(t.followerId) ?? { pnl: 0, trades: 0, qty: 0 };
        cur.pnl += t.pnl;
        cur.trades += 1;
        cur.qty += t.quantity;
        sw.set(t.followerId, cur);
      }
    } catch (err) {
      ledgerOk = false;
      this.logger.error(
        `ledger failed for ${userId}: ${(err as Error).stack ?? err}`,
      );
    }
    const actual = (id: string) =>
      tbPnl ? Math.round((tbPnl.get(id) ?? 0) * 100) / 100 : pnlOf(id);
    const strategies = subs.map((s) => ({
      followerId: s.id,
      strategyId: s.strategyId,
      name: s.strategy.name,
      strategyStatus: s.strategy.status,
      copyStatus: s.copyStatus,
      allocation: allocationLabel(s),
      todayPnl: ledgerOk ? r2(sw.get(s.id)?.pnl ?? 0) : actual(s.id),
      todayTrades: ledgerOk
        ? (sw.get(s.id)?.trades ?? 0)
        : (trades.get(s.id) ?? 0),
      /** Total quantity of today's strategy trades. */
      todayQty: sw.get(s.id)?.qty ?? 0,
      /** Actual demat / paper-fill P&L (executed trades only). */
      brokerPnl: actual(s.id),
    }));
    return {
      todayPnl: r2(strategies.reduce((a, x) => a + x.todayPnl, 0)),
      brokerPnl: r2(strategies.reduce((a, x) => a + x.brokerPnl, 0)),
      strategies,
    };
  }

  /**
   * INTERNAL TRADE LEDGER — the software's own record of every valid strategy-generated trade of a client,
   * independent of what the broker did with the order.
   *
   * One trade per (strategy entry signal × client), identified by its entry order row (Strategy Trade ID). The
   * entry row is written for every follower that was due the trade: paper fill, live order sent, live order
   * rejected / failed by the broker, or live trade NOT SENT because no valid broker connection was available.
   * Rows skipped by the client's own risk rules (segment, max trades, loss limit, quantity 0) are not trades.
   *
   * Software price / status come from the strategy signal (entry / exit price, open / closed), so a broker
   * rejection never erases the trade or its performance. Exits done in the software for a position that is
   * really held (exit-all, square-off, loss limit) close the trade at that exit price.
   * Shown for today: entered today, still open, or exited today.
   */
  async ledger(
    userId: string,
    masterUserId?: string,
  ): Promise<{
    trades: LedgerTrade[];
    summary: LedgerSummary;
    exitLinks: Map<string, string>;
  }> {
    const since = startOfTradingDayIST();
    const lookback = new Date(since.getTime() - 10 * 86_400_000);
    const subs = (
      await this.prisma.strategyFollower.findMany({
        where: {
          followerUserId: userId,
          ...(masterUserId ? { strategy: { masterUserId } } : {}),
        },
        include: { strategy: { select: { name: true } } },
      })
    ).filter((x) => !isRemoved(x));
    const empty = {
      trades: [],
      summary: {
        trades: 0,
        open: 0,
        closed: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        totalPnl: 0,
      },
      exitLinks: new Map<string, string>(),
    };
    if (!subs.length) return empty;
    const subById = new Map(subs.map((x) => [x.id, x]));
    const orders = await this.prisma.copyOrder.findMany({
      where: {
        followerUserId: userId,
        createdAt: { gte: lookback },
        strategyFollowerId: { in: subs.map((x) => x.id) },
        mirrored: false,
      },
      include: { masterTrade: true },
      orderBy: { createdAt: "asc" },
    });
    const accountIds = [...new Set(orders.map((o) => o.brokerAccountId))];
    const manual = accountIds.length
      ? (
          await this.prisma.auditLog.findMany({
            where: {
              action: "COPY_STOPPED",
              targetType: "BrokerAccount",
              targetId: { in: accountIds },
              createdAt: { gte: lookback },
            },
            select: { targetId: true, metadata: true, createdAt: true },
            orderBy: { createdAt: "asc" },
          })
        )
          .map((a) => ({
            accountId: a.targetId,
            at: a.createdAt.getTime(),
            m: a.metadata as {
              manualExit?: boolean;
              followerId?: string;
              exchange?: string;
              symbol?: string;
              productType?: string;
              side?: string;
              price?: number | null;
            } | null,
          }))
          .filter((e) => e.m?.manualExit && e.m.exchange && e.m.symbol)
      : [];
    const N = (v: unknown) => (v == null ? null : Number(v));
    const sinceMs = since.getTime();
    const all: (LedgerTrade & { _entryMs: number; _exitMs: number | null })[] =
      [];
    for (const o of orders) {
      if (!isLedgerEligible(o)) continue;
      const mt = o.masterTrade;
      if (!mt.signalStatus || mt.signalStatus === "DELETED") continue;
      const sub = subById.get(o.strategyFollowerId);
      const qty = displayQty(sub, mt, o.quantity);
      if (qty <= 0) continue;
      const key = instrumentKey(mt.exchange, mt.symbol);
      const ltpNow = this.prices.get(key);
      const entry =
        N(mt.averagePrice) ?? N(mt.price) ?? N(o.averagePrice) ?? ltpNow ?? 0;
      const masterQty = Math.max(
        1,
        mt.filledQuantity > 0 ? mt.filledQuantity : mt.quantity,
      );
      let closedQty =
        mt.signalStatus === "CLOSED"
          ? qty
          : Math.min(qty, Math.round((qty * mt.closedQuantity) / masterQty));
      let exitPx = closedQty ? N(mt.exitPrice) : null;
      let exitMs: number | null =
        closedQty && mt.exitedAt ? mt.exitedAt.getTime() : null;
      const entryMs = (mt.eventTimestamp ?? o.createdAt).getTime();
      const execution = executionOf(o);
      // A software exit of a position the client really held (paper or broker fill) closes the trade.
      if (closedQty < qty && (execution === "PAPER" || o.filledQuantity > 0)) {
        const exitSide = mt.side === "BUY" ? "SELL" : "BUY";
        const e = manual.find(
          (x) =>
            x.accountId === o.brokerAccountId &&
            (!x.m!.followerId || x.m!.followerId === o.strategyFollowerId) &&
            x.m!.exchange === mt.exchange &&
            x.m!.symbol === mt.symbol &&
            x.m!.productType === mt.productType &&
            x.m!.side === exitSide &&
            x.at >= o.createdAt.getTime(),
        );
        if (e) {
          const px = e.m!.price ?? ltpNow ?? entry;
          const signalFirst =
            exitMs != null && exitMs <= e.at && exitPx != null;
          const keep = signalFirst ? closedQty : 0;
          const rest = qty - keep;
          exitPx = keep ? (exitPx! * keep + px * rest) / qty : px;
          closedQty = qty;
          exitMs = e.at;
        }
      }
      const openQty = qty - closedQty;
      if (openQty) this.feed.ensure(mt.exchange as never, mt.symbol);
      const ltp = openQty ? (ltpNow ?? entry) : null;
      const dir = mt.side === "BUY" ? 1 : -1;
      const realized =
        exitPx != null && closedQty ? (exitPx - entry) * closedQty * dir : 0;
      const unrealized = ltp != null ? (ltp - entry) * openQty * dir : 0;
      const lot = Math.max(
        1,
        Number((mt.rawPayload as { lotSize?: number } | null)?.lotSize) || 1,
      );
      all.push({
        tradeId: o.id,
        tradeRef: tradeRef(o.id),
        signalId: mt.id,
        followerId: o.strategyFollowerId,
        strategyName: sub?.strategy.name ?? "—",
        mode: o.isPaper ? "PAPER" : "LIVE",
        exchange: mt.exchange,
        symbol: mt.symbol,
        productType: mt.productType,
        side: mt.side,
        quantity: qty,
        lots: lot > 1 ? +(qty / lot).toFixed(2) : null,
        openQuantity: openQty,
        entryPrice: r2(entry),
        entryAt: new Date(entryMs).toISOString(),
        carried: entryMs < sinceMs,
        exitPrice: exitPx == null || !closedQty ? null : r2(exitPx),
        exitAt:
          openQty || exitMs == null ? null : new Date(exitMs).toISOString(),
        ltp,
        status: openQty ? "OPEN" : "CLOSED",
        realizedPnl: r2(realized),
        unrealizedPnl: r2(unrealized),
        pnl: r2(realized + unrealized),
        execution,
        _entryMs: entryMs,
        _exitMs: exitMs,
      });
    }
    // Exit orders → the strategy trade(s) they close (same client, contract, opposite side; FIFO).
    const exitLinks = new Map<string, string>();
    for (const o of orders) {
      if (!o.isExit) continue;
      const at = o.createdAt.getTime();
      const cands = all.filter(
        (t) =>
          t.followerId === o.strategyFollowerId &&
          t.exchange === o.exchange &&
          t.symbol === o.symbol &&
          t.productType === o.productType &&
          t.side !== o.side &&
          t._entryMs <= at,
      );
      const hit =
        cands.find((t) => t._exitMs == null || t._exitMs >= at - 60_000) ??
        cands[cands.length - 1];
      if (hit) exitLinks.set(o.id, hit.tradeId);
    }
    const trades = all
      .filter(
        (t) =>
          t._entryMs >= sinceMs ||
          t.openQuantity > 0 ||
          (t._exitMs != null && t._exitMs >= sinceMs),
      )
      .map(({ _entryMs: _a, _exitMs: _b, ...t }) => t)
      .sort((a, b) =>
        a.entryAt < b.entryAt ? 1 : a.entryAt > b.entryAt ? -1 : 0,
      );
    const realizedPnl = r2(trades.reduce((x, t) => x + t.realizedPnl, 0));
    const unrealizedPnl = r2(trades.reduce((x, t) => x + t.unrealizedPnl, 0));
    return {
      trades,
      summary: {
        trades: trades.length,
        open: trades.filter((t) => t.status === "OPEN").length,
        closed: trades.filter((t) => t.status === "CLOSED").length,
        realizedPnl,
        unrealizedPnl,
        totalPnl: r2(realizedPnl + unrealizedPnl),
      },
      exitLinks,
    };
  }

  /**
   * Client trade book for today (like a broker's trade history): one row per entry signal with the strategy
   * (algo) name, script, side, entry / exit time and price, quantity, lots and P&L. Exits (master exit, TP/SL,
   * manual exit, square-off) are matched FIFO; lot-multiplier resizes add to / reduce the open row.
   */
  async tradeBook(userId: string) {
    const since = startOfTradingDayIST();
    // Disconnected / removed strategies and their trades are not shown to the client.
    const subs = (
      await this.prisma.strategyFollower.findMany({
        where: { followerUserId: userId },
        include: { strategy: { select: { name: true } } },
      })
    ).filter((x) => !isRemoved(x));
    const subName = new Map(subs.map((x) => [x.id, x.strategy.name]));
    const [orders, audits] = await Promise.all([
      this.prisma.copyOrder.findMany({
        // From 10 days back, so a position bought earlier (carry forward) and exited today is matched to its entry.
        where: {
          followerUserId: userId,
          createdAt: { gte: new Date(since.getTime() - 10 * 86_400_000) },
          filledQuantity: { gt: 0 },
          strategyFollowerId: { in: subs.map((x) => x.id) },
        },
        include: {
          masterTrade: {
            select: { rawPayload: true, quantity: true, filledQuantity: true },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.auditLog.findMany({
        where: {
          createdAt: { gte: new Date(since.getTime() - 10 * 86_400_000) },
          OR: [
            {
              action: "PROFILE_UPDATED",
              targetType: "StrategyFollower",
              targetId: { in: subs.map((x) => x.id) },
            },
            {
              action: "COPY_STOPPED",
              targetType: "BrokerAccount",
              targetId: {
                in: [
                  ...new Set(
                    subs
                      .map((x) => x.brokerAccountId)
                      .filter(Boolean) as string[],
                  ),
                ],
              },
            },
          ],
        },
        select: {
          targetId: true,
          targetType: true,
          metadata: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      }),
    ]);
    type Row = {
      id: string;
      followerId: string;
      strategyName: string;
      exchange: string;
      symbol: string;
      productType: string;
      side: "BUY" | "SELL";
      quantity: number;
      lotSize: number;
      entryPrice: number;
      entryAt: string;
      closedQty: number;
      exitValue: number;
      exitAt: string | null;
    };
    type Ev = {
      at: number;
      kind: "entry" | "exit" | "adjust" | "manualExit";
      key: string;
      followerId?: string;
      accountId?: string;
      side: "BUY" | "SELL";
      qty: number;
      price: number;
      id: string;
      lot: number;
      ex: string;
      sym: string;
      product: string;
      partial?: boolean;
    };
    const evs: Ev[] = [];
    const subById2 = new Map(subs.map((x) => [x.id, x]));
    for (const o of orders) {
      const lot =
        (o.masterTrade.rawPayload as { lotSize?: number } | null)?.lotSize ?? 1;
      evs.push({
        at: (o.filledAt ?? o.createdAt).getTime(),
        kind: o.isExit ? "exit" : "entry",
        key: `${o.strategyFollowerId}|${o.exchange}:${o.symbol}|${o.productType}`,
        followerId: o.strategyFollowerId,
        side: o.side,
        qty: displayQty(
          subById2.get(o.strategyFollowerId),
          o.masterTrade,
          o.filledQuantity,
        ),
        price: o.averagePrice == null ? 0 : Number(o.averagePrice),
        id: o.id,
        lot,
        ex: o.exchange,
        sym: o.symbol,
        product: o.productType,
      });
    }
    for (const a of audits) {
      const m = a.metadata as {
        manualExit?: boolean;
        manualAdjust?: boolean;
        partial?: boolean;
        followerId?: string;
        exchange?: string;
        symbol?: string;
        productType?: string;
        side?: string;
        quantity?: number;
        price?: number | null;
      } | null;
      if (!m?.exchange || !m.symbol || !m.productType || !a.targetId) continue;
      const px =
        m.price ?? this.prices.get(instrumentKey(m.exchange, m.symbol)) ?? 0;
      if (
        !DISPLAY_SCALED &&
        m.manualAdjust &&
        a.targetType === "StrategyFollower" &&
        m.quantity
      ) {
        evs.push({
          at: a.createdAt.getTime(),
          kind: "adjust",
          key: `${a.targetId}|${m.exchange}:${m.symbol}|${m.productType}`,
          followerId: a.targetId,
          side: m.side === "SELL" ? "SELL" : "BUY",
          qty: m.quantity,
          price: px,
          id: "",
          lot: 1,
          ex: m.exchange,
          sym: m.symbol,
          product: m.productType,
        });
      } else if (m.manualExit && a.targetType === "BrokerAccount") {
        evs.push({
          at: a.createdAt.getTime(),
          kind: "manualExit",
          key: `*|${m.exchange}:${m.symbol}|${m.productType}`,
          accountId: a.targetId,
          side: m.side === "BUY" ? "BUY" : "SELL",
          qty: m.quantity ?? 0,
          price: px,
          id: "",
          lot: 1,
          ex: m.exchange,
          sym: m.symbol,
          product: m.productType,
          partial: !!m.partial,
          followerId: m.followerId,
        });
      }
    }
    evs.sort((x, y) => x.at - y.at);
    const rows: Row[] = [];
    const openRows = (key: string) =>
      rows.filter(
        (r) =>
          `${r.followerId}|${r.exchange}:${r.symbol}|${r.productType}` ===
            key && r.closedQty < r.quantity,
      );
    const close = (list: Row[], qty: number, price: number, at: number) => {
      let left = qty;
      for (const r of list) {
        if (left <= 0) break;
        const q = Math.min(left, r.quantity - r.closedQty);
        r.closedQty += q;
        r.exitValue += q * price;
        r.exitAt = new Date(at).toISOString();
        left -= q;
      }
    };
    const accountOf = new Map(subs.map((x) => [x.id, x.brokerAccountId]));
    for (const e of evs) {
      if (e.kind === "entry") {
        const open = openRows(e.key);
        if (open.length && open[0]!.side !== e.side) {
          close(open, e.qty, e.price, e.at); // an opposite entry first closes what is open
          continue;
        }
        rows.push({
          id: e.id,
          followerId: e.followerId!,
          strategyName: subName.get(e.followerId!) ?? "—",
          exchange: e.ex,
          symbol: e.sym,
          productType: e.product,
          side: e.side,
          quantity: e.qty,
          lotSize: e.lot,
          entryPrice: e.price,
          entryAt: new Date(e.at).toISOString(),
          closedQty: 0,
          exitValue: 0,
          exitAt: null,
        });
      } else if (e.kind === "exit") {
        close(openRows(e.key), e.qty, e.price, e.at);
      } else if (e.kind === "adjust") {
        const open = openRows(e.key);
        const last = open[open.length - 1];
        if (!last) continue;
        if (last.side === e.side) {
          last.entryPrice =
            (last.entryPrice * last.quantity + e.price * e.qty) /
            (last.quantity + e.qty);
          last.quantity += e.qty;
        } else close(open, e.qty, e.price, e.at);
      } else if (e.partial) {
        // exited in the broker app (all or part): close that quantity, oldest trades first
        // `followerId` set = only that subscription's trades (another strategy on the same demat is untouched)
        const list = rows.filter(
          (r) =>
            (e.followerId
              ? r.followerId === e.followerId
              : accountOf.get(r.followerId) === e.accountId) &&
            r.exchange === e.ex &&
            r.symbol === e.sym &&
            r.productType === e.product &&
            r.closedQty < r.quantity &&
            r.side !== e.side,
        );
        close(list, e.qty, e.price, e.at);
      } else {
        // manual exit of the whole account position: close every open row of this contract on that account
        for (const r of rows) {
          if (
            accountOf.get(r.followerId) === e.accountId &&
            r.exchange === e.ex &&
            r.symbol === e.sym &&
            r.productType === e.product &&
            r.closedQty < r.quantity
          ) {
            close([r], r.quantity - r.closedQty, e.price, e.at);
          }
        }
      }
    }
    // Today's book: trades entered today, plus earlier trades that were exited today or are still open.
    const sinceIso = since.toISOString();
    const visible = rows.filter(
      (r) =>
        r.entryAt >= sinceIso ||
        r.closedQty < r.quantity ||
        (r.exitAt != null && r.exitAt >= sinceIso),
    );
    const out = visible.map((r) => {
      const dir = r.side === "BUY" ? 1 : -1;
      const openQty = r.quantity - r.closedQty;
      const exitPrice = r.closedQty ? r.exitValue / r.closedQty : null;
      if (openQty) this.feed.ensure(r.exchange as never, r.symbol);
      const ltp = openQty
        ? (this.prices.get(instrumentKey(r.exchange, r.symbol)) ?? r.entryPrice)
        : null;
      const pnl =
        (exitPrice != null
          ? (exitPrice - r.entryPrice) * r.closedQty * dir
          : 0) + (ltp != null ? (ltp - r.entryPrice) * openQty * dir : 0);
      return {
        id: r.id,
        followerId: r.followerId,
        strategyName: r.strategyName,
        exchange: r.exchange,
        symbol: r.symbol,
        productType: r.productType,
        side: r.side,
        quantity: r.quantity,
        lots: r.lotSize > 1 ? +(r.quantity / r.lotSize).toFixed(2) : null,
        openQuantity: openQty,
        entryPrice: Math.round(r.entryPrice * 100) / 100,
        entryAt: r.entryAt,
        carried: r.entryAt < sinceIso,
        exitPrice: exitPrice == null ? null : Math.round(exitPrice * 100) / 100,
        exitAt: openQty ? null : r.exitAt,
        ltp,
        status: openQty ? ("OPEN" as const) : ("CLOSED" as const),
        pnl: Math.round(pnl * 100) / 100,
        rejected: false,
        rejectReason: null as string | null,
      };
    });

    // Trades the broker REJECTED (never reached the demat) are still tracked here at the strategy's prices,
    // so the client sees what the strategy did. They are tagged and kept out of the total P&L.
    const rejectedOrders = await this.prisma.copyOrder.findMany({
      where: {
        followerUserId: userId,
        createdAt: { gte: since },
        isExit: false,
        filledQuantity: 0,
        status: { in: ["REJECTED", "FAILED"] },
        strategyFollowerId: { in: subs.map((x) => x.id) },
      },
      include: { masterTrade: true },
      orderBy: { createdAt: "asc" },
    });
    for (const o of rejectedOrders) {
      const mt = o.masterTrade;
      if (!mt.signalStatus || mt.signalStatus === "DELETED") continue;
      const entry = Number(mt.averagePrice ?? mt.price ?? 0);
      if (!entry) continue;
      const qty = displayQty(
        subById2.get(o.strategyFollowerId),
        mt,
        o.quantity,
      );
      const masterQty = mt.filledQuantity > 0 ? mt.filledQuantity : mt.quantity;
      const closedQty =
        mt.signalStatus === "CLOSED"
          ? qty
          : Math.min(
              qty,
              Math.round((qty * mt.closedQuantity) / Math.max(1, masterQty)),
            );
      const openQty = qty - closedQty;
      const exit = mt.exitPrice != null ? Number(mt.exitPrice) : null;
      const dir = mt.side === "BUY" ? 1 : -1;
      if (openQty) this.feed.ensure(mt.exchange as never, mt.symbol);
      const ltp = openQty
        ? (this.prices.get(instrumentKey(mt.exchange, mt.symbol)) ?? entry)
        : null;
      const pnl =
        (exit != null && closedQty ? (exit - entry) * closedQty * dir : 0) +
        (ltp != null ? (ltp - entry) * openQty * dir : 0);
      const lot = Math.max(
        1,
        Number((mt.rawPayload as { lotSize?: number } | null)?.lotSize) || 1,
      );
      out.push({
        id: o.id,
        followerId: o.strategyFollowerId,
        strategyName: subName.get(o.strategyFollowerId) ?? "—",
        exchange: mt.exchange,
        symbol: mt.symbol,
        productType: mt.productType,
        side: mt.side,
        quantity: qty,
        lots: lot > 1 ? +(qty / lot).toFixed(2) : null,
        openQuantity: openQty,
        entryPrice: Math.round(entry * 100) / 100,
        entryAt: (mt.eventTimestamp ?? o.createdAt).toISOString(),
        carried: false,
        exitPrice:
          exit == null || !closedQty ? null : Math.round(exit * 100) / 100,
        exitAt: openQty ? null : (mt.exitedAt?.toISOString() ?? null),
        ltp,
        status: openQty ? ("OPEN" as const) : ("CLOSED" as const),
        pnl: Math.round(pnl * 100) / 100,
        rejected: true,
        rejectReason: o.errorMessage ?? "Rejected by broker",
      });
    }
    out.sort((a, b) =>
      a.entryAt < b.entryAt ? 1 : a.entryAt > b.entryAt ? -1 : 0,
    ); // newest first
    const sum = (list: typeof out) =>
      Math.round(list.reduce((a, r) => a + r.pnl, 0) * 100) / 100;
    return {
      totalPnl: sum(out.filter((r) => !r.rejected)),
      rejectedPnl: sum(out.filter((r) => r.rejected)),
      rows: out,
    };
  }
}
