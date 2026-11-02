import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import type Redis from 'ioredis';
import { Prisma } from '@ctp/database';
import type { BrokerAccount, BrokerName, PrismaClient } from '@ctp/database';
import { generateToken, SecretBox } from '@ctp/shared';
import { type BrokerEventPayload, WsEvent } from '@ctp/types';
import { AuditService } from '../audit/audit.service';
import type { ClientInfo } from '../auth/token.service';
import { PRISMA } from '../common/prisma/prisma.service';
import { REDIS } from '../common/redis/redis.module';
import { API_CONFIG, ApiConfig } from '../config/config.module';
import { AccountEvents } from '../realtime/account-events';
import { NotifyService } from '../realtime/notify.service';
import { RealtimeService } from '../realtime/realtime.gateway';
import { AngelOneClient } from './angel-one/angel-one.client';
import { BrokerApiError } from './broker-http';
import { ZerodhaClient } from './zerodha/zerodha.client';

const STATE_TTL_SECONDS = 600;
const stateKey = (state: string) => `broker:oauth-state:${state}`;

export const TAKEOVER_REASON = 'Account doosre user ne connect kar liya';

interface SessionMaterial {
  brokerClientId: string;
  accessToken: string;
  refreshToken?: string;
  extra?: Record<string, string | undefined>;
  expiresAt: Date;
}

export interface DisconnectOptions {
  /** Who initiated it — stored in the audit log. */
  by: 'user' | 'admin' | 'system';
  /** Shown on the account card. */
  reason?: string;
  /** Admin id when by=admin. */
  actorUserId?: string;
  /** Also stop copy trading for subscriptions using this account. */
  stopCopy?: boolean;
}

/**
 * Owns broker login state (CSRF `state` in Redis), token exchange and encrypted persistence.
 * Raw tokens only ever exist in memory here and in BrokerCredential as AES-256-GCM ciphertext.
 */
const brokerTitle = (b: string) => (b === 'ZERODHA' ? 'Zerodha' : b === 'UPSTOX' ? 'Upstox' : 'Angel One');

@Injectable()
export class BrokerSessionService {
  private readonly logger = new Logger('BrokerSession');
  private readonly box: SecretBox;
  private zerodhaClient?: ZerodhaClient;
  private angelClient?: AngelOneClient;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
    private readonly notifier: NotifyService,
    private readonly accountEvents: AccountEvents,
  ) {
    this.box = new SecretBox(config.ENCRYPTION_KEY);
  }

  // ------------------------------------------------------------- clients

  zerodha(): ZerodhaClient {
    const { ZERODHA_API_KEY, ZERODHA_API_SECRET, ZERODHA_PROXY_URL } = this.config;
    if (!ZERODHA_API_KEY || !ZERODHA_API_SECRET) {
      throw new ServiceUnavailableException('Zerodha is not configured (ZERODHA_API_KEY / ZERODHA_API_SECRET).');
    }
    return (this.zerodhaClient ??= new ZerodhaClient({ apiKey: ZERODHA_API_KEY, apiSecret: ZERODHA_API_SECRET, proxyUrl: ZERODHA_PROXY_URL }));
  }

  angelOne(): AngelOneClient {
    const c = this.config;
    if (!c.ANGEL_API_KEY) throw new ServiceUnavailableException('Angel One is not configured (ANGEL_API_KEY).');
    return (this.angelClient ??= new AngelOneClient({
      apiKey: c.ANGEL_API_KEY,
      publicIp: c.ANGEL_PUBLIC_IP,
      localIp: c.ANGEL_LOCAL_IP,
      macAddress: c.ANGEL_MAC_ADDRESS,
      proxyUrl: c.ANGEL_PROXY_URL,
    }));
  }

  /** Client for an account that logged in with its own API app / static-IP proxy (falls back to the server's). */
  angelOneFor(extra: Record<string, string | undefined>): AngelOneClient {
    if (!extra.apiKey) return this.angelOne();
    const c = this.config;
    return new AngelOneClient({
      apiKey: extra.apiKey,
      proxyUrl: extra.proxyUrl,
      publicIp: extra.publicIp ?? c.ANGEL_PUBLIC_IP,
      localIp: c.ANGEL_LOCAL_IP,
      macAddress: c.ANGEL_MAC_ADDRESS,
    });
  }

  zerodhaFor(extra: Record<string, string | undefined>, apiSecret = ''): ZerodhaClient {
    if (!extra.apiKey) return this.zerodha();
    return new ZerodhaClient({ apiKey: extra.apiKey, apiSecret, proxyUrl: extra.proxyUrl });
  }

  /** Encrypt / decrypt arbitrary JSON bound to a row id (used for the client's broker API secrets). */
  sealJson(value: unknown, aad: string): string {
    return this.box.encrypt(JSON.stringify(value), aad);
  }
  openJson<T>(ciphertext: string | null | undefined, aad: string): T | null {
    if (!ciphertext) return null;
    try {
      return JSON.parse(this.box.decrypt(ciphertext, aad)) as T;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- state

  async createState(userId: string, broker: BrokerName): Promise<string> {
    const state = generateToken(24);
    await this.redis.set(stateKey(state), JSON.stringify({ userId, broker }), 'EX', STATE_TTL_SECONDS);
    return state;
  }

  /** One-time use: the state is deleted as it is read. */
  async consumeState(state: string | undefined, broker: BrokerName): Promise<string> {
    if (!state || state.length > 128) throw new BadRequestException('Missing login state. Please start the broker login again.');
    const raw = await this.redis.getdel(stateKey(state));
    if (!raw) throw new BadRequestException('Broker login expired. Please start again.');
    const parsed = JSON.parse(raw) as { userId: string; broker: BrokerName };
    if (parsed.broker !== broker) throw new BadRequestException('Broker login state mismatch.');
    return parsed.userId;
  }

  // ------------------------------------------------------------- persist

  /**
   * Stores a fresh broker session for `userId`.
   *
   * TAKEOVER: if the same broker client ID is currently CONNECTED to a *different* platform user, that
   * user's link is disconnected in the same transaction (credentials deleted, status DISCONNECTED,
   * reason saved, their copy trading stopped) and they are notified in real time. The partial unique
   * index on CONNECTED rows guarantees at most one CONNECTED owner even under concurrent logins.
   */
  async saveSession(userId: string, broker: BrokerName, s: SessionMaterial, client?: ClientInfo): Promise<BrokerAccount> {
    try {
      return await this.saveSessionOnce(userId, broker, s, client);
    } catch (err) {
      // Two users finishing login for the same client ID at the same instant: the partial unique index
      // rejects one of them. Retrying once makes the later login take over cleanly.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.saveSessionOnce(userId, broker, s, client);
      }
      throw err;
    }
  }

  private async saveSessionOnce(userId: string, broker: BrokerName, s: SessionMaterial, client?: ClientInfo): Promise<BrokerAccount> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true, licenceExpiresAt: true, demo: true } });
    if (!user) throw new NotFoundException('User not found');
    if (user.role === 'FOLLOWER' && user.licenceExpiresAt && user.licenceExpiresAt.getTime() <= Date.now()) {
      throw new ForbiddenException('Your licence has expired — contact your master to renew it before connecting a broker.');
    }
    // Master accounts are market-data feeds only; they never place orders.
    const mode = user.role === 'MASTER' ? 'DATA_ONLY' : 'TRADING';
    // A client who was paper-trading without a demat stays on paper after connecting one (switches to Live himself).
    const wasPaperTrading = mode === 'TRADING' && (await this.prisma.brokerAccount.count({ where: { userId, broker: 'MOCK' } })) > 0;

    const { account, takenOver } = await this.prisma.$transaction(async (tx) => {
      // 1) Take the client ID away from any other user that currently has it connected.
      const others = await tx.brokerAccount.findMany({
        where: { broker, brokerClientId: s.brokerClientId, status: 'CONNECTED', userId: { not: userId } },
      });
      const now = new Date();
      for (const old of others) {
        await tx.brokerCredential.deleteMany({ where: { brokerAccountId: old.id } });
        await tx.brokerAccount.update({
          where: { id: old.id },
          data: { status: 'DISCONNECTED', tokenExpiresAt: null, disconnectReason: TAKEOVER_REASON, disconnectedAt: now, lastError: null },
        });
        await tx.strategyFollower.updateMany({
          where: { brokerAccountId: old.id, copyStatus: { not: 'OFF' } },
          data: { copyStatus: 'OFF', stoppedAt: now, stoppedReason: TAKEOVER_REASON },
        });
        await this.audit.logTx(tx, {
          action: 'BROKER_TAKEN_OVER',
          actorUserId: userId,
          targetType: 'BrokerAccount',
          targetId: old.id,
          metadata: { broker, brokerClientId: s.brokerClientId, previousUserId: old.userId, newUserId: userId },
          client,
        });
      }

      // 2) Upsert this user's row for the broker.
      const existing = await tx.brokerAccount.upsert({
        where: { userId_broker: { userId, broker } },
        // A new client account starts in PAPER when the platform default is paper (PAPER_MODE=true); the client switches to LIVE.
        create: { userId, broker, brokerClientId: s.brokerClientId, status: 'PENDING', mode, isPaper: mode === 'TRADING' && (this.config.PAPER_MODE || user.demo || wasPaperTrading) },
        update: {},
      });
      if (existing.status === 'CONNECTED' && existing.brokerClientId && existing.brokerClientId !== s.brokerClientId) {
        throw new ConflictException(
          `You logged in as ${s.brokerClientId}, but this profile is connected to ${existing.brokerClientId}. Disconnect it first to switch accounts.`,
        );
      }

      // 3) Encrypt and store the session (AAD = account id binds ciphertext to this row).
      const aad = existing.id;
      const extra = s.extra && Object.values(s.extra).some(Boolean) ? JSON.stringify(s.extra) : undefined;
      const data = {
        encryptedAccessToken: this.box.encrypt(s.accessToken, aad),
        encryptedRefreshToken: s.refreshToken ? this.box.encrypt(s.refreshToken, aad) : null,
        encryptedExtra: extra ? this.box.encrypt(extra, aad) : null,
        keyId: 'k1',
      };
      await tx.brokerCredential.upsert({
        where: { brokerAccountId: existing.id },
        create: { brokerAccountId: existing.id, ...data },
        update: data,
      });
      const updated = await tx.brokerAccount.update({
        where: { id: existing.id },
        data: {
          brokerClientId: s.brokerClientId,
          status: 'CONNECTED',
          // isPaper is the client's paper / live switch — a daily re-login must not flip it.
          mode,
          tokenExpiresAt: s.expiresAt,
          lastConnectedAt: now,
          lastError: null,
          disconnectReason: null,
          disconnectedAt: null,
        },
      });
      // Strategies that ran without a demat (internal paper account) now use this account. Copy ON/OFF and the
      // paper / live switch are not changed by connecting.
      if (mode === 'TRADING') {
        await tx.strategyFollower.updateMany({
          where: { followerUserId: userId, OR: [{ brokerAccountId: null }, { brokerAccount: { broker: 'MOCK' } }] },
          data: { brokerAccountId: existing.id },
        });
      }
      await this.audit.logTx(tx, {
        action: 'BROKER_CONNECTED',
        actorUserId: userId,
        targetType: 'BrokerAccount',
        targetId: existing.id,
        metadata: { broker, brokerClientId: s.brokerClientId, mode, expiresAt: s.expiresAt.toISOString(), tookOverFrom: others.map((o) => o.userId) },
        client,
      });
      return { account: updated, takenOver: others };
    });

    // After commit: realtime + in-memory state.
    for (const old of takenOver) {
      this.accountEvents.emit({ type: 'disconnected', brokerAccountId: old.id, userId: old.userId });
      const payload: BrokerEventPayload = { brokerAccountId: old.id, broker, brokerClientId: s.brokerClientId, reason: TAKEOVER_REASON };
      this.realtime.toUser(old.userId, WsEvent.BROKER_TAKEN_OVER, payload);
      this.realtime.toUser(old.userId, WsEvent.BROKER_DISCONNECTED, payload);
      void this.notifier.notify({
        userId: old.userId,
        type: 'BROKER_TAKEN_OVER',
        severity: 'WARNING',
        title: `${brokerTitle(broker)} ${s.brokerClientId} disconnected`,
        body: TAKEOVER_REASON,
        data: { brokerAccountId: old.id },
      });
    }
    this.accountEvents.emit({ type: 'connected', brokerAccountId: account.id, userId });
    this.realtime.toUser(userId, WsEvent.BROKER_CONNECTED, {
      brokerAccountId: account.id,
      broker,
      brokerClientId: account.brokerClientId,
    } satisfies BrokerEventPayload);
    return account;
  }

  /** Records a failed login on the account (if one exists) without touching credentials. */
  async recordError(userId: string, broker: BrokerName, err: unknown): Promise<string> {
    const message = err instanceof BrokerApiError || err instanceof Error ? err.message : 'Broker login failed.';
    this.logger.warn(`${broker} login failed for user ${userId}: ${message}`);
    await this.prisma.brokerAccount
      .updateMany({ where: { userId, broker }, data: { lastError: message.slice(0, 500) } })
      .catch(() => undefined);
    return message;
  }

  async decryptAccess(account: Pick<BrokerAccount, 'id'>): Promise<string | null> {
    const cred = await this.prisma.brokerCredential.findUnique({ where: { brokerAccountId: account.id } });
    return cred ? this.box.decrypt(cred.encryptedAccessToken, account.id) : null;
  }

  private readonly renewing = new Map<string, Promise<boolean>>();

  /**
   * Angel One: try to recover a rejected session with the stored refresh token (once at a time per account).
   * Returns true when a verified new token was stored — the caller must then NOT mark the account expired.
   */
  renewAngelSession(account: BrokerAccount): Promise<boolean> {
    if (account.broker !== 'ANGEL_ONE' || account.status !== 'CONNECTED') return Promise.resolve(false);
    if (account.tokenExpiresAt && account.tokenExpiresAt.getTime() <= Date.now()) return Promise.resolve(false); // daily expiry: needs a new login
    let p = this.renewing.get(account.id);
    if (!p) {
      p = this.doRenewAngel(account).finally(() => setTimeout(() => this.renewing.delete(account.id), 30_000));
      this.renewing.set(account.id, p);
    }
    return p;
  }

  private async doRenewAngel(account: BrokerAccount): Promise<boolean> {
    try {
      const cred = await this.prisma.brokerCredential.findUnique({ where: { brokerAccountId: account.id } });
      if (!cred?.encryptedRefreshToken) return false;
      const jwt = this.box.decrypt(cred.encryptedAccessToken, account.id);
      const refresh = this.box.decrypt(cred.encryptedRefreshToken, account.id);
      const extra = await this.decryptExtra(account);
      const s = await this.angelOneFor(extra).renewSession(jwt, refresh);
      if (account.brokerClientId && s.clientCode !== account.brokerClientId) return false;
      if (s.feedToken) extra.feedToken = s.feedToken;
      await this.prisma.brokerCredential.update({
        where: { brokerAccountId: account.id },
        data: {
          encryptedAccessToken: this.box.encrypt(s.jwtToken, account.id),
          encryptedRefreshToken: s.refreshToken ? this.box.encrypt(s.refreshToken, account.id) : cred.encryptedRefreshToken,
          encryptedExtra: Object.values(extra).some(Boolean) ? this.box.encrypt(JSON.stringify(extra), account.id) : cred.encryptedExtra,
        },
      });
      await this.prisma.brokerAccount.update({ where: { id: account.id }, data: { lastError: null } }).catch(() => undefined);
      // Rebuild cached adapters with the new token.
      this.accountEvents.emit({ type: 'settings', brokerAccountId: account.id, userId: account.userId });
      this.logger.log(`Angel One session renewed for ${account.brokerClientId ?? account.id}`);
      return true;
    } catch (err) {
      this.logger.warn(`Angel One session renewal failed for ${account.brokerClientId ?? account.id}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Decrypted broker-specific extras (e.g. Angel feedToken, Kite publicToken). */
  async decryptExtra(account: Pick<BrokerAccount, 'id'>): Promise<Record<string, string | undefined>> {
    const cred = await this.prisma.brokerCredential.findUnique({ where: { brokerAccountId: account.id } });
    if (!cred?.encryptedExtra) return {};
    try {
      return JSON.parse(this.box.decrypt(cred.encryptedExtra, account.id)) as Record<string, string | undefined>;
    } catch {
      return {};
    }
  }

  /** User-initiated disconnect (only the owner can do it). */
  async disconnect(userId: string, accountId: string, client?: ClientInfo): Promise<BrokerAccount> {
    const account = await this.prisma.brokerAccount.findFirst({ where: { id: accountId, userId } });
    if (!account) throw new NotFoundException('Broker account not found');
    return this.disconnectAccount(account, { by: 'user', reason: 'Disconnected by you', actorUserId: userId }, client);
  }

  /**
   * Full disconnect: invalidate the token at the broker (Zerodha: DELETE /session/token, i.e.
   * invalidateAccessToken; Angel: logout), delete encrypted credentials, mark DISCONNECTED with a reason,
   * stop the live feed / evict from the order cache (via AccountEvents) and notify the owner.
   */
  async disconnectAccount(account: BrokerAccount, opts: DisconnectOptions, client?: ClientInfo): Promise<BrokerAccount> {
    try {
      const token = await this.decryptAccess(account);
      const extra = await this.decryptExtra(account);
      if (token && account.broker === 'ZERODHA') await this.zerodhaFor(extra).logout(token);
      if (token && account.broker === 'ANGEL_ONE' && account.brokerClientId) await this.angelOneFor(extra).logout(account.brokerClientId, token);
    } catch (err) {
      this.logger.warn(`Broker logout failed for account ${account.id}: ${(err as Error).message}`);
    }

    const reason = opts.reason ?? (opts.by === 'admin' ? 'Disconnected by admin' : 'Disconnected');
    const updated = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.brokerCredential.deleteMany({ where: { brokerAccountId: account.id } });
      const row = await tx.brokerAccount.update({
        where: { id: account.id },
        data: { status: 'DISCONNECTED', tokenExpiresAt: null, disconnectReason: reason.slice(0, 300), disconnectedAt: now },
      });
      let stopped = 0;
      if (opts.stopCopy) {
        const r = await tx.strategyFollower.updateMany({
          where: { brokerAccountId: account.id, copyStatus: { not: 'OFF' } },
          data: { copyStatus: 'OFF', stoppedAt: now, stoppedReason: reason.slice(0, 300), stoppedByUserId: opts.actorUserId ?? null },
        });
        stopped = r.count;
      }
      await this.audit.logTx(tx, {
        action: opts.by === 'admin' ? 'ADMIN_DISCONNECTED_BROKER' : 'BROKER_DISCONNECTED',
        actorUserId: opts.actorUserId ?? null,
        targetType: 'BrokerAccount',
        targetId: account.id,
        metadata: { broker: account.broker, by: opts.by, reason, userId: account.userId, stoppedFollows: stopped },
        client,
      });
      return row;
    });

    this.accountEvents.emit({ type: 'disconnected', brokerAccountId: account.id, userId: account.userId });
    this.realtime.toUser(account.userId, WsEvent.BROKER_DISCONNECTED, {
      brokerAccountId: account.id,
      broker: account.broker,
      brokerClientId: account.brokerClientId,
      reason,
    } satisfies BrokerEventPayload);
    if (opts.by !== 'user') {
      void this.notifier.notify({
        userId: account.userId,
        type: 'BROKER_DISCONNECTED',
        severity: 'WARNING',
        title: `${brokerTitle(account.broker)} ${account.brokerClientId ?? ''} disconnected`,
        body: reason,
        data: { brokerAccountId: account.id },
      });
    }
    return updated;
  }

  /** Marks accounts whose daily token has expired. Returns the accounts that changed. */
  async expireDue(now = new Date()): Promise<BrokerAccount[]> {
    const due = await this.prisma.brokerAccount.findMany({
      where: { status: 'CONNECTED', isPaper: false, broker: { not: 'MOCK' }, tokenExpiresAt: { lte: now } },
    });
    for (const a of due) await this.markExpired(a, 'Daily broker token expired — please reconnect.');
    return due;
  }

  /** Marks one account EXPIRED (token rejected by the broker or daily expiry) and notifies the owner. */
  async markExpired(account: BrokerAccount, reason: string): Promise<void> {
    const r = await this.prisma.brokerAccount.updateMany({
      where: { id: account.id, status: 'CONNECTED' },
      data: { status: 'EXPIRED', disconnectReason: reason.slice(0, 300), disconnectedAt: new Date(), lastError: reason.slice(0, 500) },
    });
    if (!r.count) return; // already handled elsewhere
    await this.audit.log({ action: 'BROKER_TOKEN_EXPIRED', targetType: 'BrokerAccount', targetId: account.id, metadata: { broker: account.broker, reason } });
    this.accountEvents.emit({ type: 'expired', brokerAccountId: account.id, userId: account.userId });
    this.realtime.toUser(account.userId, WsEvent.BROKER_TOKEN_EXPIRED, {
      brokerAccountId: account.id,
      broker: account.broker,
      brokerClientId: account.brokerClientId,
      reason,
    } satisfies BrokerEventPayload);
    void this.notifier.notify({
      userId: account.userId,
      type: 'BROKER_TOKEN_EXPIRED',
      severity: 'WARNING',
      title: `${brokerTitle(account.broker)} session expired`,
      body: 'Reconnect your broker to resume copy trading.',
      data: { brokerAccountId: account.id },
    });
  }
}
