import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import type Redis from "ioredis";
import { REDIS } from "../common/redis/redis.module";
import type { BrokerAccount, PrismaClient } from "@ctp/database";
import { PRISMA } from "../common/prisma/prisma.service";
import { API_CONFIG, ApiConfig } from "../config/config.module";
import { BrokerApiError } from "../brokers/broker-http";
import { BrokerSessionService } from "../brokers/broker-session.service";
import {
  type AccountOverrides,
  ADAPTERS,
  overridesFrom,
} from "./adapter-factory";
import {
  OrderBlockedError,
  type BrokerAdapter,
  type BrokerFunds,
  type BrokerHolding,
  type BrokerOrder,
  type BrokerPosition,
} from "./broker-adapter";

export interface LiveAccountData {
  accountId: string;
  broker: string;
  brokerClientId: string | null;
  isPaper: boolean;
  error?: string;
  funds?: BrokerFunds;
  positions?: BrokerPosition[];
  holdings?: BrokerHolding[];
  orders?: Omit<BrokerOrder, "raw">[];
}

/** Builds broker adapters from stored (encrypted) sessions and reads live account data. */
@Injectable()
export class TradingService implements OnModuleInit {
  private readonly logger = new Logger("TradingService");

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly sessions: BrokerSessionService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * One-time switch to per-client paper / live: before this, PAPER_MODE=true forced every account to paper.
   * To keep that behaviour, every client trading account starts in PAPER once; clients then choose Live
   * themselves from the dashboard toggle. Runs only when PAPER_MODE=true and only once (Redis marker).
   */
  async onModuleInit(): Promise<void> {
    if (!this.config.PAPER_MODE || this.config.NODE_ENV === "test") return;
    const marker = "ctp:migrate:client-paper-switch:v1";
    try {
      if (await this.redis.get(marker)) return;
      const r = await this.prisma.brokerAccount.updateMany({
        where: { mode: "TRADING", broker: { not: "MOCK" }, isPaper: false },
        data: { isPaper: true },
      });
      await this.redis.set(marker, new Date().toISOString());
      if (r.count)
        this.logger.log(
          `Paper/live switch: ${r.count} client account(s) start in PAPER — clients can switch to LIVE themselves`,
        );
    } catch (err) {
      this.logger.error(
        `Paper/live switch migration failed: ${(err as Error).message}`,
      );
    }
  }

  /**
   * True when this account must never receive a real order.
   *  - MOCK accounts and accounts switched to Paper (isPaper) are always simulated.
   *  - Client TRADING accounts: the client's own Paper / Live switch decides (isPaper).
   *  - Everything else (master DATA_ONLY accounts, platform-level checks without a mode) follows PAPER_MODE.
   */
  isSimulated(
    account: Pick<BrokerAccount, "broker" | "isPaper"> &
      Partial<Pick<BrokerAccount, "mode">>,
  ): boolean {
    if (account.broker === "MOCK" || account.isPaper) return true;
    if (account.mode === "TRADING") return false;
    return this.config.PAPER_MODE;
  }

  /**
   * The client's internal PAPER account (broker MOCK) — not a broker connection. Lets a client paper-trade (and
   * see paper trades / P&L) without connecting a demat. Created on demand; always simulated.
   */
  async ensureLedgerAccount(userId: string): Promise<BrokerAccount> {
    return this.prisma.brokerAccount.upsert({
      where: { userId_broker: { userId, broker: "MOCK" } },
      create: {
        userId,
        broker: "MOCK",
        status: "CONNECTED",
        isPaper: true,
        mode: "TRADING",
        lastConnectedAt: new Date(),
      },
      update: {},
    });
  }

  /** Hard guard used before every order: DATA_ONLY (master) accounts can never place orders. */
  assertOrderAllowed(account: Pick<BrokerAccount, "mode" | "id">): void {
    if (account.mode === "DATA_ONLY") throw new OrderBlockedError();
  }

  /** Builds an adapter from an already-decrypted token (no DB access). */
  buildAdapter(
    account: Pick<BrokerAccount, "broker" | "mode">,
    token: string,
    overrides?: AccountOverrides,
  ): BrokerAdapter {
    const f = ADAPTERS[account.broker];
    if (!f)
      throw new BrokerApiError(`${account.broker} has no live broker adapter.`);
    return f.create(this.config, token, account, overrides);
  }

  /** Throws when the account cannot be used for a real broker call (not connected / token expired). */
  async adapterFor(account: BrokerAccount): Promise<BrokerAdapter> {
    if (account.broker === "MOCK")
      throw new BrokerApiError(
        "Paper (MOCK) accounts have no broker connection.",
      );
    if (account.status !== "CONNECTED")
      throw new BrokerApiError(
        `${account.broker} account is not connected. Please log in again.`,
      );
    if (
      account.tokenExpiresAt &&
      account.tokenExpiresAt.getTime() <= Date.now()
    ) {
      await this.sessions
        .markExpired(account, "Daily broker token expired — please reconnect.")
        .catch(() => undefined);
      throw new BrokerApiError(
        `${account.broker} session expired. Please log in again.`,
      );
    }
    const token = await this.sessions.decryptAccess(account);
    if (!token)
      throw new BrokerApiError(
        "No broker session stored. Please log in again.",
      );
    return this.buildAdapter(
      account,
      token,
      overridesFrom(await this.sessions.decryptExtra(account)),
    );
  }

  /** True when a broker error means the session is no longer valid. */
  isSessionError(err: unknown): boolean {
    if (!(err instanceof BrokerApiError)) return false;
    const msg = err.message;
    // Angel One returns HTTP 403 for rate limits ("exceeding access rate") and static-IP / WAF blocks too —
    // those are transient and must NOT disconnect the account. Only explicit session error codes count.
    if (
      err.brokerCode === "RATE_LIMIT" ||
      /access rate|rate limit|too many|static ip|not allowed from this ip/i.test(
        msg,
      )
    )
      return false;
    if (
      err.brokerCode &&
      /^(AG8001|AG8002|AG8003|AB1010|AB8050|AB8051)$/i.test(err.brokerCode)
    )
      return true; // Angel
    if (err.brokerCode === "TokenException") return true; // Zerodha
    if (err.brokerCode === "DH-901") return true; // Dhan: invalid / expired access token
    if (err.brokerCode && /^-(8|15|16|17)$/.test(err.brokerCode)) return true; // Fyers token errors
    if (err.brokerCode === "UDAPI100050") return true; // Upstox invalid token
    if (err.brokerCode === "TOKEN_EXPIRED") return true; // Alice Blue / Groww / Motilal: adapter mapped a session error
    return /invalid token|token expired|invalid jwt|invalid session|session expired|incorrect `api_key` or `access_token`/i.test(
      msg,
    );
  }

  /** Marks the account EXPIRED (and notifies the owner) when the broker says the session is invalid. */
  async handleBrokerError(
    account: BrokerAccount,
    err: unknown,
  ): Promise<string> {
    const msg = err instanceof Error ? err.message : "Broker error";
    if (this.isSessionError(err)) {
      // Angel One: recover with the refresh token before giving up on the session.
      const full = account.status
        ? account
        : await this.prisma.brokerAccount.findUnique({
            where: { id: account.id },
          });
      if (full && (await this.sessions.renewAngelSession(full)))
        return `${msg} (session renewed — retrying)`;
      await this.sessions
        .markExpired(account, `Broker rejected the session: ${msg}`)
        .catch(() => undefined);
    }
    return msg;
  }

  /** Funds, positions, holdings and today's orders for every connected real account of a user. */
  async liveData(
    userId: string,
    opts: { hideZerodha?: boolean } = {},
  ): Promise<LiveAccountData[]> {
    const accounts = await this.prisma.brokerAccount.findMany({
      where: {
        userId,
        broker: { notIn: opts.hideZerodha ? ["MOCK", "ZERODHA"] : ["MOCK"] },
      },
      orderBy: { createdAt: "asc" },
    });
    return Promise.all(
      accounts.map(async (a): Promise<LiveAccountData> => {
        const base = {
          accountId: a.id,
          broker: a.broker,
          brokerClientId: a.brokerClientId,
          isPaper: a.isPaper,
        };
        try {
          const ad = await this.adapterFor(a);
          const [funds, positions, holdings, orders] = await Promise.all([
            ad.funds().catch(() => undefined),
            ad.positions(),
            ad.holdings().catch(() => []),
            ad.orders(),
          ]);
          return {
            ...base,
            funds,
            positions,
            holdings,
            orders: orders.map(({ raw: _raw, ...o }) => o),
          };
        } catch (err) {
          return { ...base, error: await this.handleBrokerError(a, err) };
        }
      }),
    );
  }
}
