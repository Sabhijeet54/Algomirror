import { BadRequestException, Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import type { BrokerApiConfig, BrokerName, PrismaClient } from '@ctp/database';
import type { ClientInfo } from '../auth/token.service';
import { PRISMA } from '../common/prisma/prisma.service';
import { API_CONFIG, ApiConfig } from '../config/config.module';
import { AngelOneClient } from './angel-one/angel-one.client';
import { BrokerApiError, brokerFetch } from './broker-http';
import { BrokerSessionService } from './broker-session.service';
import { extractTotpSecret, totp } from './totp';
import { ZerodhaClient } from './zerodha/zerodha.client';
import { UpstoxClient, upstoxTokenExpiry } from '../trading/upstox.adapter';
import { DhanClient } from '../trading/dhan.adapter';
import { FyersClient } from '../trading/fyers.adapter';
import { KotakNeoClient, kotakInstruments } from '../trading/kotak.adapter';
import { FivePaisaClient } from '../trading/fivepaisa.adapter';
import { AliceBlueClient } from '../trading/aliceblue.adapter';
import { GrowwClient } from '../trading/groww.adapter';
import { MotilalClient } from '../trading/motilal.adapter';

/** Secrets kept encrypted; never sent back to the browser. */
interface Secrets {
  apiKey?: string;
  apiSecret?: string;
  pin?: string;
  totpSecret?: string;
  proxyUser?: string;
  proxyPass?: string;
  /** Kotak Neo: registered mobile number. */
  mobile?: string;
  /** 5paisa: API "User ID" from the Xtream dashboard. */
  userId?: string;
  /** Motilal Oswal: login password (hashed with the API key at login). */
  password?: string;
  /** Motilal Oswal: second factor — date of birth (DD/MM/YYYY) or PAN. */
  twoFa?: string;
}
const SECRET_KEYS: (keyof Secrets)[] = ['apiKey', 'apiSecret', 'pin', 'totpSecret', 'proxyUser', 'proxyPass', 'mobile', 'userId', 'password', 'twoFa'];
/** Internal (never shown, never typed by the client): Fyers refresh token for the daily PIN refresh. */
interface StoredSecrets extends Secrets {
  refreshToken?: string;
}

/** Brokers that log in server-side every trading morning (no browser): TOTP / PIN, or Fyers refresh token + PIN. */
const AUTO_LOGIN_BROKERS: BrokerName[] = ['ANGEL_ONE', 'DHAN', 'KOTAK_NEO', 'FIVE_PAISA', 'FYERS', 'ALICE_BLUE', 'GROWW', 'MOTILAL_OSWAL'];

/** Next occurrence of hh:mm IST (today if still ahead, else tomorrow). */
function nextIst(hh: number, mm: number, now = new Date()): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const at = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), hh, mm) - 330 * 60_000;
  return new Date(at > now.getTime() ? at : at + 86_400_000);
}

export interface SaveBrokerApiConfigInput extends Secrets {
  clientCode?: string;
  proxyHost?: string;
  proxyPort?: number;
  autoLogin?: boolean;
  consent?: boolean;
}

export interface BrokerApiConfigView {
  broker: BrokerName;
  clientCode: string | null;
  proxyHost: string | null;
  proxyPort: number | null;
  /** Which secrets are stored (values are never returned). */
  saved: Record<keyof Secrets, boolean>;
  autoLogin: boolean;
  consentAt: string | null;
  complete: boolean;
  missing: string[];
  lastTest: { at: string; ok: boolean; ip: string | null; error: string | null } | null;
  lastLogin: { at: string | null; error: string | null };
  redirectUrl: string;
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOST = /^(?=.{1,253}$)([a-zA-Z0-9-]{1,63}\.)*[a-zA-Z0-9-]{1,63}$/;

/**
 * The client's own broker API app and static-IP proxy (one config per broker):
 * save (encrypted) → test proxy health (which IP do we really leave from?) → connect.
 * Angel One connects server-side with PIN + TOTP (and again every trading morning when autoLogin is on);
 * Dhan, Kotak Neo and 5paisa connect server-side with PIN + TOTP too (auto-login each morning); Fyers refreshes
 * with its refresh token + PIN after one browser login. Zerodha / Upstox / Fyers browser logins return a login URL.
 * The session then carries { apiKey, proxyUrl } so every order for that account uses the client's app and IP.
 */
@Injectable()
export class BrokerApiConfigService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('BrokerApiConfig');
  private timer?: NodeJS.Timeout;
  private autoLoginDay = '';

  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly sessions: BrokerSessionService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.config.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.autoLoginTick(), 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ------------------------------------------------------------ helpers

  private redirectUrl(broker: BrokerName): string {
    const base = this.config.API_PUBLIC_URL?.replace(/\/$/, '') ?? '';
    if (broker === 'UPSTOX') return `${base}/brokers/upstox/callback`;
    if (broker === 'FYERS') return `${base}/brokers/fyers/callback`;
    return broker === 'ZERODHA'
      ? (this.config.ZERODHA_REDIRECT_URL ?? `${base}/brokers/zerodha/callback`)
      : (this.config.ANGEL_REDIRECT_URL ?? `${base}/brokers/angel-one/callback`);
  }

  private secretsOf(row: BrokerApiConfig | null): StoredSecrets {
    return (row && this.sessions.openJson<StoredSecrets>(row.encryptedSecrets, row.id)) ?? {};
  }

  private required(broker: BrokerName): (keyof Secrets | 'clientCode' | 'proxyHost' | 'proxyPort')[] {
    const proxy = ['proxyHost', 'proxyPort'] as const;
    switch (broker) {
      case 'ANGEL_ONE':
        return ['clientCode', 'apiKey', 'pin', 'totpSecret', ...proxy];
      case 'DHAN':
        return ['clientCode', 'pin', 'totpSecret', ...proxy];
      case 'KOTAK_NEO':
        return ['clientCode', 'apiKey', 'mobile', 'pin', 'totpSecret', ...proxy];
      case 'FIVE_PAISA':
        return ['clientCode', 'apiKey', 'apiSecret', 'userId', 'pin', 'totpSecret', ...proxy];
      case 'ALICE_BLUE':
        return ['clientCode', 'apiKey', ...proxy];
      case 'GROWW':
        return ['clientCode', 'apiKey', 'totpSecret', ...proxy];
      case 'MOTILAL_OSWAL':
        return ['clientCode', 'apiKey', 'password', 'twoFa', 'totpSecret', ...proxy];
      default: // ZERODHA, UPSTOX, FYERS: own app key + secret, browser login
        return ['apiKey', 'apiSecret', ...proxy];
    }
  }

  private missing(row: BrokerApiConfig | null, broker: BrokerName): string[] {
    const s = this.secretsOf(row);
    return this.required(broker).filter((k) => {
      if (k === 'clientCode' || k === 'proxyHost' || k === 'proxyPort') return !row?.[k];
      return !s[k];
    });
  }

  /** http://user:pass@host:port — credentials URL-encoded. Never logged or returned. */
  proxyUrlOf(row: BrokerApiConfig, s: Secrets): string | undefined {
    if (!row.proxyHost || !row.proxyPort) return undefined;
    const auth = s.proxyUser ? `${encodeURIComponent(s.proxyUser)}:${encodeURIComponent(s.proxyPass ?? '')}@` : '';
    return `http://${auth}${row.proxyHost}:${row.proxyPort}`;
  }

  private view(row: BrokerApiConfig | null, broker: BrokerName): BrokerApiConfigView {
    const s = this.secretsOf(row);
    const missing = this.missing(row, broker);
    return {
      broker,
      clientCode: row?.clientCode ?? null,
      proxyHost: row?.proxyHost ?? null,
      proxyPort: row?.proxyPort ?? null,
      saved: Object.fromEntries(SECRET_KEYS.map((k) => [k, Boolean(s[k])])) as Record<keyof Secrets, boolean>,
      autoLogin: row?.autoLogin ?? true,
      consentAt: row?.consentAt?.toISOString() ?? null,
      complete: missing.length === 0,
      missing,
      lastTest: row?.lastTestAt ? { at: row.lastTestAt.toISOString(), ok: Boolean(row.lastTestOk), ip: row.lastTestIp, error: row.lastTestError } : null,
      lastLogin: { at: row?.lastLoginAt?.toISOString() ?? null, error: row?.lastLoginError ?? null },
      redirectUrl: this.redirectUrl(broker),
    };
  }

  private async row(userId: string, broker: BrokerName): Promise<BrokerApiConfig | null> {
    return this.prisma?.brokerApiConfig.findUnique({ where: { userId_broker: { userId, broker } } });
  }

  // ------------------------------------------------------------ CRUD

  async get(userId: string, broker: BrokerName): Promise<BrokerApiConfigView> {
    return this.view(await this.row(userId, broker), broker);
  }

  /** Saves the form. Empty secret fields keep what is already stored (so the client never has to re-type them). */
  async save(userId: string, broker: BrokerName, dto: SaveBrokerApiConfigInput, actorUserId?: string): Promise<BrokerApiConfigView> {
    // Accept "151.245.182.35:443" (IP with port in one box, as other platforms show it) — split it.
    const hp = dto.proxyHost?.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '').match(/^(.+):(\d{1,5})$/);
    if (hp) {
      dto.proxyHost = hp[1];
      dto.proxyPort ??= Number(hp[2]);
    }
    if (dto.proxyHost && !IPV4.test(dto.proxyHost) && !HOST.test(dto.proxyHost)) throw new BadRequestException('Static IP / host is not valid');
    if (dto.totpSecret) {
      try {
        const secret = extractTotpSecret(dto.totpSecret);
        totp(secret); // validates base32
        dto.totpSecret = secret;
      } catch {
        throw new BadRequestException('TOTP secret is not valid — paste the key shown under the QR code (or the otpauth:// link)');
      }
    }
    const existing = await this.row(userId, broker);
    const row =
      existing ??
      (await this.prisma.brokerApiConfig.create({ data: { userId, broker } }));
    const current = this.secretsOf(existing);
    const next: StoredSecrets = { ...current };
    for (const k of SECRET_KEYS) {
      const v = dto[k]?.trim();
      if (v) next[k] = v;
    }
    if (next.mobile) next.mobile = next.mobile.replace(/[\s-]/g, '');
    const proxyChanged = dto.proxyHost !== undefined && dto.proxyHost !== row.proxyHost;
    const saved = await this.prisma.brokerApiConfig.update({
      where: { id: row.id },
      data: {
        clientCode: dto.clientCode?.trim().toUpperCase() || row.clientCode,
        proxyHost: dto.proxyHost?.trim() || row.proxyHost,
        proxyPort: dto.proxyPort ?? row.proxyPort,
        autoLogin: dto.autoLogin ?? row.autoLogin,
        consentAt: dto.consent ? (row.consentAt ?? new Date()) : row.consentAt,
        encryptedSecrets: this.sessions.sealJson(next, row.id),
        // A different proxy has to be tested again.
        ...(proxyChanged ? { lastTestAt: null, lastTestOk: null, lastTestIp: null, lastTestError: null } : {}),
      },
    });
    const changed = [
      ...SECRET_KEYS.filter((k) => dto[k]?.trim()),
      ...(dto.clientCode ? ['clientCode'] : []),
      ...(proxyChanged ? ['staticIp'] : []),
      ...(dto.autoLogin !== undefined && dto.autoLogin !== row.autoLogin ? ['autoLogin'] : []),
    ];
    await this.prisma.auditLog
      .create({ data: { action: 'PROFILE_UPDATED', actorUserId: actorUserId ?? userId, targetType: 'BrokerApiConfig', targetId: row.id, metadata: { brokerApi: broker, changed, ownerUserId: userId } } })
      .catch(() => undefined);
    return this.view(saved, broker);
  }

  // ------------------------------------------------------------ proxy health

  /** Calls an IP echo service THROUGH the client's proxy: proves it works and shows the IP brokers will see. */
  async test(userId: string, broker: BrokerName): Promise<BrokerApiConfigView & { latencyMs?: number }> {
    const row = await this.row(userId, broker);
    if (!row?.proxyHost || !row.proxyPort) throw new BadRequestException('Save the static IP and port first');
    const proxyUrl = this.proxyUrlOf(row, this.secretsOf(row))!;
    const t0 = Date.now();
    let ok = false;
    let ip: string | null = null;
    let error: string | null = null;
    try {
      const { status, body } = await brokerFetch<{ ip?: string }>('https://api.ipify.org?format=json', { proxyUrl, timeoutMs: 10_000 });
      if (status !== 200 || !body?.ip) throw new Error(`Proxy answered HTTP ${status}`);
      ip = body.ip;
      ok = !IPV4.test(row.proxyHost) || ip === row.proxyHost;
      if (!ok) error = `Traffic leaves from ${ip}, not ${row.proxyHost} — register ${ip} with the broker or fix the proxy`;
    } catch (err) {
      error = (err as Error).message.replace(/\/\/[^@\s]*@/g, '//***@').slice(0, 300);
    }
    const saved = await this.prisma.brokerApiConfig.update({
      where: { id: row.id },
      data: { lastTestAt: new Date(), lastTestOk: ok, lastTestIp: ip, lastTestError: error },
    });
    return { ...this.view(saved, broker), latencyMs: Date.now() - t0 };
  }

  // ------------------------------------------------------------ connect

  /** Angel One: server-side login with the client's own app + PIN + TOTP, through the client's proxy. */
  async connectAngel(userId: string, client?: ClientInfo) {
    const row = await this.row(userId, 'ANGEL_ONE');
    const missing = this.missing(row, 'ANGEL_ONE');
    if (!row || missing.length) throw new BadRequestException(`Fill and save: ${missing.join(', ')}`);
    const s = this.secretsOf(row);
    const proxyUrl = this.proxyUrlOf(row, s);
    const publicIp = IPV4.test(row.proxyHost!) ? row.proxyHost! : (row.lastTestIp ?? undefined);
    const c = this.config;
    const angel = new AngelOneClient({ apiKey: s.apiKey!, proxyUrl, publicIp, localIp: c.ANGEL_LOCAL_IP, macAddress: c.ANGEL_MAC_ADDRESS });
    try {
      const session = await angel.loginWithTotp(row.clientCode!, s.pin!, totp(s.totpSecret!));
      if (session.clientCode.toUpperCase() !== row.clientCode!.toUpperCase()) {
        throw new BrokerApiError(`Logged in as ${session.clientCode}, but the saved client code is ${row.clientCode}`);
      }
      const account = await this.sessions.saveSession(
        userId,
        'ANGEL_ONE',
        {
          brokerClientId: session.clientCode,
          accessToken: session.jwtToken,
          refreshToken: session.refreshToken,
          extra: { feedToken: session.feedToken, apiKey: s.apiKey, proxyUrl, publicIp },
          expiresAt: session.expiresAt,
        },
        client,
      );
      await this.prisma.brokerApiConfig.update({ where: { id: row.id }, data: { lastLoginAt: new Date(), lastLoginError: null } });
      return account;
    } catch (err) {
      const message = (err as Error).message.replace(/\/\/[^@\s]*@/g, '//***@').slice(0, 300);
      await this.prisma.brokerApiConfig.update({ where: { id: row.id }, data: { lastLoginError: message } });
      if (err instanceof BrokerApiError) throw new BadRequestException(await this.sessions.recordError(userId, 'ANGEL_ONE', err));
      throw err;
    }
  }

  // ------------------------------------------------------------ Upstox

  private upstoxClient(row: BrokerApiConfig, s: Secrets): UpstoxClient {
    return new UpstoxClient({ apiKey: s.apiKey!, apiSecret: s.apiSecret, redirectUrl: this.redirectUrl('UPSTOX'), proxyUrl: this.proxyUrlOf(row, s) });
  }

  /** Upstox: login dialog URL of the client's own app (its redirect URL must point to our callback). */
  async upstoxLoginUrl(userId: string): Promise<{ loginUrl: string }> {
    const row = await this.row(userId, 'UPSTOX');
    const missing = this.missing(row, 'UPSTOX');
    if (!row || missing.length) throw new BadRequestException(`Fill and save: ${missing.join(', ')}`);
    const state = await this.sessions.createState(userId, 'UPSTOX');
    return { loginUrl: this.upstoxClient(row, this.secretsOf(row)).loginUrl(state) };
  }

  /** Upstox: stores a session from an OAuth code (callback) or a pasted access token, checked against the profile API. */
  async connectUpstox(userId: string, input: { code?: string; accessToken?: string }, client?: ClientInfo) {
    const row = await this.row(userId, 'UPSTOX');
    if (!row) throw new BadRequestException('Save your Upstox API details first');
    const s = this.secretsOf(row);
    const missing = this.missing(row, 'UPSTOX').filter((k) => !(input.accessToken && k === 'apiSecret'));
    if (missing.length) throw new BadRequestException(`Fill and save: ${missing.join(', ')}`);
    const up = this.upstoxClient(row, s);
    try {
      const token = input.accessToken?.trim() || (await up.exchangeCode(input.code ?? '')).accessToken;
      const profile = await up.profile(token);
      if (row.clientCode && profile.userId.toUpperCase() !== row.clientCode.toUpperCase()) {
        throw new BrokerApiError(`This token belongs to ${profile.userId}, but the saved client code is ${row.clientCode}`);
      }
      const proxyUrl = this.proxyUrlOf(row, s);
      const account = await this.sessions.saveSession(
        userId,
        'UPSTOX',
        { brokerClientId: profile.userId.toUpperCase(), accessToken: token, extra: { apiKey: s.apiKey, proxyUrl }, expiresAt: upstoxTokenExpiry() },
        client,
      );
      await this.prisma.brokerApiConfig.update({ where: { id: row.id }, data: { lastLoginAt: new Date(), lastLoginError: null } });
      return account;
    } catch (err) {
      const message = (err as Error).message.replace(/\/\/[^@\s]*@/g, '//***@').slice(0, 300);
      await this.prisma.brokerApiConfig.update({ where: { id: row.id }, data: { lastLoginError: message } });
      if (err instanceof BrokerApiError) throw new BadRequestException(await this.sessions.recordError(userId, 'UPSTOX', err));
      throw err;
    }
  }

  /** Zerodha: Kite login URL for the client's own app (redirect URL in that app must point to our callback). */
  async zerodhaLoginUrl(userId: string): Promise<{ loginUrl: string }> {
    const row = await this.row(userId, 'ZERODHA');
    const missing = this.missing(row, 'ZERODHA');
    if (!row || missing.length) throw new BadRequestException(`Fill and save: ${missing.join(', ')}`);
    const s = this.secretsOf(row);
    const state = await this.sessions.createState(userId, 'ZERODHA');
    return { loginUrl: new ZerodhaClient({ apiKey: s.apiKey!, apiSecret: s.apiSecret!, proxyUrl: this.proxyUrlOf(row, s) }).loginUrl(state) };
  }

  /** Zerodha callback: the client's own app (key/secret/proxy) when configured, else null → server app. */
  async zerodhaClientFor(userId: string): Promise<{ client: ZerodhaClient; extra: Record<string, string | undefined> } | null> {
    const row = await this.row(userId, 'ZERODHA');
    const s = this.secretsOf(row);
    if (!row || !s.apiKey || !s.apiSecret) return null;
    const proxyUrl = this.proxyUrlOf(row, s);
    await this.prisma.brokerApiConfig.update({ where: { id: row.id }, data: { lastLoginAt: new Date(), lastLoginError: null } }).catch(() => undefined);
    return { client: new ZerodhaClient({ apiKey: s.apiKey, apiSecret: s.apiSecret, proxyUrl }), extra: { apiKey: s.apiKey, proxyUrl } };
  }

  // ------------------------------------------------------- Dhan / Kotak Neo / 5paisa / Fyers

  /** Common wrapper: loads the saved config, checks required fields, records the login result. */
  private async login(
    userId: string,
    broker: BrokerName,
    skip: string[],
    work: (row: BrokerApiConfig, s: StoredSecrets, proxyUrl: string | undefined) => Promise<Parameters<BrokerSessionService['saveSession']>[2]>,
    client?: ClientInfo,
  ) {
    const row = await this.row(userId, broker);
    const missing = this.missing(row, broker).filter((k) => !skip.includes(k));
    if (!row || missing.length) throw new BadRequestException(`Fill and save: ${missing.join(', ')}`);
    const s = this.secretsOf(row);
    const proxyUrl = this.proxyUrlOf(row, s);
    try {
      const material = await work(row, s, proxyUrl);
      const account = await this.sessions.saveSession(userId, broker, material, client);
      await this.prisma.brokerApiConfig.update({ where: { id: row.id }, data: { lastLoginAt: new Date(), lastLoginError: null } });
      return account;
    } catch (err) {
      const message = (err as Error).message.replace(/\/\/[^@\s]*@/g, '//***@').slice(0, 300);
      await this.prisma.brokerApiConfig.update({ where: { id: row.id }, data: { lastLoginError: message } });
      if (err instanceof BrokerApiError) throw new BadRequestException(await this.sessions.recordError(userId, broker, err));
      throw err;
    }
  }

  private sameClient(actual: string, saved: string | null) {
    if (saved && actual.toUpperCase() !== saved.toUpperCase()) throw new BrokerApiError(`Logged in as ${actual}, but the saved client code is ${saved}`);
  }

  /** Dhan: access token from client ID + PIN + TOTP (24 h) — or a pasted token from web.dhan.co. */
  connectDhan(userId: string, input: { accessToken?: string }, client?: ClientInfo) {
    const pasted = input.accessToken?.trim();
    return this.login(
      userId,
      'DHAN',
      pasted ? ['pin', 'totpSecret'] : [],
      async (row, s, proxyUrl) => {
        const dhan = new DhanClient(proxyUrl);
        const clientId = row.clientCode!;
        let token: string;
        let expiresAt: Date;
        if (pasted) {
          await dhan.check(clientId, pasted);
          token = pasted;
          expiresAt = new Date(Date.now() + 23.5 * 3600_000);
        } else {
          const r = await dhan.loginWithTotp(clientId, s.pin!, totp(s.totpSecret!));
          this.sameClient(r.clientId, clientId);
          token = r.accessToken;
          expiresAt = r.expiresAt;
        }
        return { brokerClientId: clientId.toUpperCase(), accessToken: token, extra: { clientId, proxyUrl }, expiresAt };
      },
      client,
    );
  }

  /** Kotak Neo: consumer key + mobile + UCC + TOTP → MPIN, server-side. */
  connectKotak(userId: string, client?: ClientInfo) {
    return this.login(
      userId,
      'KOTAK_NEO',
      [],
      async (row, s, proxyUrl) => {
        const k = await new KotakNeoClient({ consumerKey: s.apiKey!, proxyUrl }).login(s.mobile!, row.clientCode!, totp(s.totpSecret!), s.pin!);
        this.sameClient(k.ucc, row.clientCode);
        // Warm the F&O scrip masters now so the first copy order of the day doesn't wait ~10 s for them.
        for (const ex of ['NFO', 'BFO']) void kotakInstruments.ensure(ex, { baseUrl: k.baseUrl, consumerKey: s.apiKey, proxyUrl }).catch(() => undefined);
        return {
          brokerClientId: k.ucc,
          accessToken: k.token,
          extra: { apiKey: s.apiKey, sid: k.sid, serverId: k.serverId, baseUrl: k.baseUrl, proxyUrl },
          expiresAt: nextIst(5, 0),
        };
      },
      client,
    );
  }

  /** Alice Blue: user ID + API key → encryption key → session id (valid for the day). */
  connectAliceBlue(userId: string, client?: ClientInfo) {
    return this.login(
      userId,
      'ALICE_BLUE',
      [],
      async (row, s, proxyUrl) => {
        const r = await new AliceBlueClient({ proxyUrl }).login(row.clientCode!, s.apiKey!);
        const code = row.clientCode!.toUpperCase();
        return { brokerClientId: code, accessToken: r.sessionId, extra: { apiKey: s.apiKey, clientCode: code, proxyUrl }, expiresAt: nextIst(23, 55) };
      },
      client,
    );
  }

  /** Groww: TOTP-type API key + TOTP → access token (expires 6:00 AM). */
  connectGroww(userId: string, client?: ClientInfo) {
    return this.login(
      userId,
      'GROWW',
      [],
      async (row, s, proxyUrl) => {
        const r = await new GrowwClient(proxyUrl).loginWithTotp(s.apiKey!, totp(s.totpSecret!));
        const code = row.clientCode!.toUpperCase();
        return { brokerClientId: code, accessToken: r.accessToken, extra: { clientCode: code, proxyUrl }, expiresAt: r.expiresAt };
      },
      client,
    );
  }

  /** Motilal Oswal: user ID + password (hashed with the API key) + DOB/PAN + TOTP → AuthToken (expires 6:00 AM). */
  connectMotilal(userId: string, client?: ClientInfo) {
    return this.login(
      userId,
      'MOTILAL_OSWAL',
      [],
      async (row, s, proxyUrl) => {
        const code = row.clientCode!.toUpperCase();
        const publicIp = IPV4.test(row.proxyHost!) ? row.proxyHost! : (row.lastTestIp ?? undefined);
        const net = { publicIp, localIp: this.config.ANGEL_LOCAL_IP, macAddress: this.config.ANGEL_MAC_ADDRESS };
        const r = await new MotilalClient({ apiKey: s.apiKey!, apiSecret: s.apiSecret, clientCode: code, proxyUrl, ...net }).login(s.password!, s.twoFa!, totp(s.totpSecret!));
        return {
          brokerClientId: code,
          accessToken: r.authToken,
          extra: { apiKey: s.apiKey, apiSecret: s.apiSecret, clientCode: code, accessToken: r.accessToken, proxyUrl, ...net },
          expiresAt: nextIst(5, 55),
        };
      },
      client,
    );
  }

  /** 5paisa: TOTP + PIN → request token → access token (valid till 11:59 PM). */
  connectFivePaisa(userId: string, client?: ClientInfo) {
    return this.login(
      userId,
      'FIVE_PAISA',
      [],
      async (row, s, proxyUrl) => {
        const r = await new FivePaisaClient({ userKey: s.apiKey!, encryptionKey: s.apiSecret!, userId: s.userId!, proxyUrl }).login(row.clientCode!, totp(s.totpSecret!), s.pin!);
        this.sameClient(r.clientCode, row.clientCode);
        return { brokerClientId: r.clientCode.toUpperCase(), accessToken: r.accessToken, extra: { apiKey: s.apiKey, clientCode: r.clientCode, proxyUrl }, expiresAt: nextIst(23, 55) };
      },
      client,
    );
  }

  private fyersClient(row: BrokerApiConfig, s: Secrets): FyersClient {
    return new FyersClient({ appId: s.apiKey!, secret: s.apiSecret, redirectUrl: this.redirectUrl('FYERS'), proxyUrl: this.proxyUrlOf(row, s) });
  }

  /** Fyers: login page of the client's own app (redirect URL in the app must point to our callback). */
  async fyersLoginUrl(userId: string): Promise<{ loginUrl: string }> {
    const row = await this.row(userId, 'FYERS');
    const missing = this.missing(row, 'FYERS');
    if (!row || missing.length) throw new BadRequestException(`Fill and save: ${missing.join(', ')}`);
    const state = await this.sessions.createState(userId, 'FYERS');
    return { loginUrl: this.fyersClient(row, this.secretsOf(row)).loginUrl(state) };
  }

  /**
   * Fyers session from the OAuth auth code (callback), or — every morning — from the stored refresh token +
   * the client's PIN (no browser). The refresh token is kept encrypted with the config.
   */
  connectFyers(userId: string, input: { code?: string }, client?: ClientInfo) {
    return this.login(
      userId,
      'FYERS',
      [],
      async (row, s) => {
        const fy = this.fyersClient(row, s);
        let t: { accessToken: string; refreshToken: string | null };
        if (input.code) t = await fy.exchangeCode(input.code);
        else {
          if (!s.refreshToken || !s.pin) throw new BrokerApiError('Fyers needs a fresh login (no saved refresh token / PIN) — press Connect Broker.');
          t = await fy.refresh(s.refreshToken, s.pin);
        }
        const profile = await fy.profile(t.accessToken);
        this.sameClient(profile.userId, row.clientCode);
        if (t.refreshToken) {
          await this.prisma.brokerApiConfig.update({ where: { id: row.id }, data: { encryptedSecrets: this.sessions.sealJson({ ...s, refreshToken: t.refreshToken }, row.id) } });
        }
        return { brokerClientId: profile.userId.toUpperCase(), accessToken: t.accessToken, extra: { apiKey: s.apiKey, proxyUrl: this.proxyUrlOf(row, s) }, expiresAt: nextIst(6, 25) };
      },
      client,
    );
  }

  /** One entry point for the Broker API page "Connect Broker" button. */
  async connect(userId: string, broker: BrokerName, input: { accessToken?: string }, client?: ClientInfo): Promise<{ loginUrl?: string; account?: Awaited<ReturnType<BrokerSessionService['saveSession']>> }> {
    switch (broker) {
      case 'ANGEL_ONE':
        return { account: await this.connectAngel(userId, client) };
      case 'ZERODHA':
        return this.zerodhaLoginUrl(userId);
      case 'UPSTOX':
        return input.accessToken ? { account: await this.connectUpstox(userId, input, client) } : this.upstoxLoginUrl(userId);
      case 'DHAN':
        return { account: await this.connectDhan(userId, input, client) };
      case 'KOTAK_NEO':
        return { account: await this.connectKotak(userId, client) };
      case 'FIVE_PAISA':
        return { account: await this.connectFivePaisa(userId, client) };
      case 'ALICE_BLUE':
        return { account: await this.connectAliceBlue(userId, client) };
      case 'GROWW':
        return { account: await this.connectGroww(userId, client) };
      case 'MOTILAL_OSWAL':
        return { account: await this.connectMotilal(userId, client) };
      case 'FYERS':
        return this.fyersLoginUrl(userId);
      default:
        throw new BadRequestException('Unsupported broker');
    }
  }

  // ------------------------------------------------------------ daily auto-login

  /** Server-side morning login for one saved config (no browser). */
  private autoLogin(r: BrokerApiConfig) {
    switch (r.broker) {
      case 'ANGEL_ONE':
        return this.connectAngel(r.userId);
      case 'DHAN':
        return this.connectDhan(r.userId, {});
      case 'KOTAK_NEO':
        return this.connectKotak(r.userId);
      case 'FIVE_PAISA':
        return this.connectFivePaisa(r.userId);
      case 'ALICE_BLUE':
        return this.connectAliceBlue(r.userId);
      case 'GROWW':
        return this.connectGroww(r.userId);
      case 'MOTILAL_OSWAL':
        return this.connectMotilal(r.userId);
      case 'FYERS':
        return this.connectFyers(r.userId, {});
      default:
        return Promise.resolve(null);
    }
  }

  private async autoLoginTick(): Promise<void> {
    const t = this.config.ANGEL_AUTO_LOGIN_TIME;
    if (!t) return;
    const ist = new Date(Date.now() + 330 * 60_000);
    const day = ist.toISOString().slice(0, 10);
    const wd = ist.getUTCDay();
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    const [h, m] = t.split(':').map(Number) as [number, number];
    if (wd === 0 || wd === 6 || mins < h * 60 + m || mins > 15 * 60 + 30 || this.autoLoginDay === day) return;
    this.autoLoginDay = day;
    const rows = await this.prisma.brokerApiConfig.findMany({ where: { broker: { in: AUTO_LOGIN_BROKERS }, autoLogin: true, user: { status: 'ACTIVE', OR: [{ licenceExpiresAt: null }, { licenceExpiresAt: { gt: new Date() } }, { role: { not: 'FOLLOWER' } }] } } });
    const done: Record<string, number> = {};
    for (const r of rows) {
      if (this.missing(r, r.broker).length) continue;
      if (r.broker === 'FYERS') {
        const s = this.secretsOf(r);
        if (!s.refreshToken || !s.pin) continue; // needs a browser login first
      }
      try {
        await this.autoLogin(r);
        done[r.broker] = (done[r.broker] ?? 0) + 1;
      } catch (err) {
        this.logger.warn(`${r.broker} auto-login failed for user ${r.userId}: ${(err as Error).message}`);
      }
      await new Promise((res) => setTimeout(res, 1200)); // stay under broker login rate limits
    }
    this.logger.log(`Auto-login: ${Object.entries(done).map(([b, n]) => `${b} ${n}`).join(', ') || 'none'} of ${rows.length}`);
  }
}
