import { BadRequestException, Body, ForbiddenException, Controller, Get, HttpCode, HttpStatus, Inject, Module, NotFoundException, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import type { Request, Response } from 'express';
import type { BrokerName, PrismaClient } from '@ctp/database';
import type { BrokerAccountView } from '@ctp/types';
import { clientInfo } from '../common/client-info';
import { CurrentUser, Public, RequestUser } from '../common/decorators/auth.decorators';
import { toBrokerAccountView } from '../common/mappers';
import { PRISMA } from '../common/prisma/prisma.service';
import { API_CONFIG, ApiConfig } from '../config/config.module';
import { BrokerApiError } from './broker-http';
import { BrokerApiConfigService } from './broker-api-config.service';
import { BrokerSessionService } from './broker-session.service';
import { TokenExpiryService } from './token-expiry.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class AngelOneLoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Matches(/^[A-Z0-9]{3,20}$/, { message: 'Enter a valid Angel One client ID' })
  clientCode!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^\d{4,6}$/, { message: 'PIN must be 4–6 digits' })
  pin!: string;

  @Transform(trim)
  @IsString()
  @Matches(/^\d{6}$/, { message: 'TOTP must be 6 digits' })
  totp!: string;
}

const opt = (max: number) => [IsOptional(), Transform(trim), IsString(), MaxLength(max)];
const apply = (decorators: PropertyDecorator[]): PropertyDecorator => (target, key) => decorators.forEach((d) => d(target, key));

/** Client's own broker API app + static-IP proxy. Empty secret fields keep the stored value. */
export class SaveBrokerApiConfigDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9]{0,20}$/, { message: 'Enter a valid client code / user id' })
  clientCode?: string;
  @apply(opt(200)) apiKey?: string;
  @apply(opt(200)) apiSecret?: string;
  @IsOptional() @Transform(trim) @Matches(/^(\d{4,6})?$/, { message: 'PIN must be 4–6 digits' }) pin?: string;
  @apply(opt(500)) totpSecret?: string;
  @apply(opt(253)) proxyHost?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(65535) proxyPort?: number;
  @IsOptional() @Transform(trim) @Matches(/^(\+?\d[\d\s-]{8,15})?$/, { message: 'Enter the mobile number registered with the broker' }) mobile?: string;
  @apply(opt(200)) userId?: string;
  @apply(opt(200)) proxyUser?: string;
  @apply(opt(200)) proxyPass?: string;
  @IsOptional() @IsBoolean() autoLogin?: boolean;
  @IsOptional() @IsBoolean() consent?: boolean;
}

export class ConnectApiConfigDto {
  /** Upstox: access token generated in the Upstox developer portal (optional). */
  @IsOptional() @Transform(trim) @IsString() @MaxLength(4000) accessToken?: string;
}

const BROKER_SLUG: Record<string, BrokerName> = { 'angel-one': 'ANGEL_ONE', zerodha: 'ZERODHA', upstox: 'UPSTOX', dhan: 'DHAN', fyers: 'FYERS', 'kotak-neo': 'KOTAK_NEO', '5paisa': 'FIVE_PAISA', 'alice-blue': 'ALICE_BLUE' };
const SLUG_OF: Record<string, string> = Object.fromEntries(Object.entries(BROKER_SLUG).map(([k, v]) => [v, k]));
function brokerFromSlug(slug: string): BrokerName {
  const b = BROKER_SLUG[slug];
  if (!b) throw new NotFoundException('Unknown broker');
  return b;
}

/**
 * Broker connection flows.
 *   Zerodha   : GET /brokers/zerodha/connect → Kite login → GET /brokers/zerodha/callback
 *   Angel One : POST /brokers/angel-one/login (client ID + PIN + TOTP)
 *               or GET /brokers/angel-one/connect → publisher login → GET /brokers/angel-one/callback
 *   Both      : POST /brokers/accounts/:id/disconnect
 */
@Controller('brokers')
export class BrokersController {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    private readonly sessions: BrokerSessionService,
    private readonly apiConfigs: BrokerApiConfigService,
  ) {}

  // ------------------------------------------------- client's own API app + static IP

  @Get('api-config/:broker')
  getApiConfig(@CurrentUser() user: RequestUser, @Param('broker') broker: string) {
    return this.apiConfigs.get(user.id, brokerFromSlug(broker));
  }

  @Put('api-config/:broker')
  saveApiConfig(@CurrentUser() user: RequestUser, @Param('broker') broker: string, @Body() dto: SaveBrokerApiConfigDto) {
    return this.apiConfigs.save(user.id, brokerFromSlug(broker), dto);
  }

  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('api-config/:broker/test')
  testApiConfig(@CurrentUser() user: RequestUser, @Param('broker') broker: string) {
    return this.apiConfigs.test(user.id, brokerFromSlug(broker));
  }

  /** Angel One: connects right away (PIN + TOTP). Zerodha: returns the Kite login URL of the client's own app. */
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('api-config/:broker/connect')
  async connectApiConfig(@CurrentUser() user: RequestUser, @Param('broker') broker: string, @Body() dto: ConnectApiConfigDto, @Req() req: Request) {
    if (brokerFromSlug(broker) === 'ZERODHA' && user.role !== 'FOLLOWER') throw new ForbiddenException('Zerodha is available for clients only.');
    const r = await this.apiConfigs.connect(user.id, brokerFromSlug(broker), { accessToken: dto?.accessToken }, clientInfo(req));
    return r.account ? { account: toBrokerAccountView(r.account) } : { loginUrl: r.loginUrl };
  }

  @Get('accounts')
  async myAccounts(@CurrentUser() user: RequestUser): Promise<BrokerAccountView[]> {
    // Clients: real demat connections only — the internal paper account (MOCK) is not a broker connection.
    const accounts = await this.prisma.brokerAccount.findMany({
      where: { userId: user.id, broker: { notIn: user.role !== 'FOLLOWER' ? ['ZERODHA'] : ['MOCK'] } },
      orderBy: { createdAt: 'asc' },
    });
    return accounts.map(toBrokerAccountView);
  }

  /** Which brokers are configured on this server (the UI hides buttons for the rest). */
  @Get('available')
  available(): { zerodha: boolean; angelOne: boolean; angelOnePublisherLogin: boolean } {
    const c = this.config;
    return {
      zerodha: Boolean(c.ZERODHA_API_KEY && c.ZERODHA_API_SECRET),
      angelOne: Boolean(c.ANGEL_API_KEY),
      angelOnePublisherLogin: Boolean(c.ANGEL_API_KEY && c.ANGEL_REDIRECT_URL),
    };
  }

  // ------------------------------------------------------------ Zerodha

  @Get('zerodha/connect')
  async zerodhaConnect(@CurrentUser() user: RequestUser): Promise<{ loginUrl: string }> {
    if (user.role !== 'FOLLOWER') throw new ForbiddenException('Zerodha is available for clients only — masters and admins use Angel One.');
    // The client's OWN Kite app (saved in Broker API) — the same app the callback uses to finish the login.
    // Logging in through the platform's app fails with "The user is not enabled for the app" for every client
    // that is not registered on that app.
    if (await this.apiConfigs.zerodhaClientFor(user.id).then(Boolean, () => false)) return this.apiConfigs.zerodhaLoginUrl(user.id);
    const client = this.sessions.zerodha();
    const state = await this.sessions.createState(user.id, 'ZERODHA');
    return { loginUrl: client.loginUrl(state) };
  }

  /** Kite redirects the browser here; the user is identified by the one-time `state`. */
  @Public()
  @Get('zerodha/callback')
  async zerodhaCallback(
    @Query('request_token') requestToken: string | undefined,
    @Query('status') status: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.handleCallback('ZERODHA', state, res, async (userId) => {
      if (status !== 'success' || !requestToken) throw new BrokerApiError('Zerodha login was cancelled or failed.');
      // The client's own Kite app (key/secret/static-IP proxy) when they configured one, else the server's app.
      const own = await this.apiConfigs.zerodhaClientFor(userId);
      const s = await (own?.client ?? this.sessions.zerodha()).createSession(requestToken);
      return this.sessions.saveSession(
        userId,
        'ZERODHA',
        {
          brokerClientId: s.userId,
          accessToken: s.accessToken,
          refreshToken: s.refreshToken,
          extra: { publicToken: s.publicToken, ...(own?.extra ?? {}) },
          expiresAt: s.expiresAt,
        },
        clientInfo(req),
      );
    });
  }

  // ------------------------------------------------------------- Upstox

  /** Upstox redirects the browser here with ?code=…&state=… after the client logs in to their own app. */
  @Public()
  @Get('upstox/callback')
  async upstoxCallback(@Query('code') code: string | undefined, @Query('state') state: string | undefined, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.handleCallback('UPSTOX', state, res, async (userId) => {
      if (!code) throw new BrokerApiError('Upstox login was cancelled or failed.');
      return this.apiConfigs.connectUpstox(userId, { code }, clientInfo(req));
    });
  }

  // -------------------------------------------------------------- Fyers

  /** Fyers redirects here with ?s=ok&auth_code=…&state=… after the client logs in to their own app. */
  @Public()
  @Get('fyers/callback')
  async fyersCallback(
    @Query('auth_code') authCode: string | undefined,
    @Query('s') s: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.handleCallback('FYERS', state, res, async (userId) => {
      if (!authCode || (s && s !== 'ok')) throw new BrokerApiError('Fyers login was cancelled or failed.');
      return this.apiConfigs.connectFyers(userId, { code: authCode }, clientInfo(req));
    });
  }

  // ---------------------------------------------------------- Angel One

  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('angel-one/login')
  async angelOneLogin(@CurrentUser() user: RequestUser, @Body() dto: AngelOneLoginDto, @Req() req: Request): Promise<BrokerAccountView> {
    const client = this.sessions.angelOne();
    try {
      const s = await client.loginWithTotp(dto.clientCode, dto.pin, dto.totp);
      const account = await this.sessions.saveSession(
        user.id,
        'ANGEL_ONE',
        { brokerClientId: s.clientCode, accessToken: s.jwtToken, refreshToken: s.refreshToken, extra: { feedToken: s.feedToken }, expiresAt: s.expiresAt },
        clientInfo(req),
      );
      return toBrokerAccountView(account);
    } catch (err) {
      if (err instanceof BrokerApiError) {
        throw new BadRequestException(await this.sessions.recordError(user.id, 'ANGEL_ONE', err));
      }
      throw err;
    }
  }

  @Get('angel-one/connect')
  async angelOneConnect(@CurrentUser() user: RequestUser): Promise<{ loginUrl: string }> {
    if (!this.config.ANGEL_REDIRECT_URL) {
      throw new BadRequestException('Angel One publisher login is not configured; use client ID + PIN + TOTP.');
    }
    const state = await this.sessions.createState(user.id, 'ANGEL_ONE');
    return { loginUrl: this.sessions.angelOne().publisherLoginUrl(state, this.config.ANGEL_REDIRECT_URL) };
  }

  @Public()
  @Get('angel-one/callback')
  async angelOneCallback(
    @Query('auth_token') authToken: string | undefined,
    @Query('feed_token') feedToken: string | undefined,
    @Query('refresh_token') refreshToken: string | undefined,
    @Query('state') state: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.handleCallback('ANGEL_ONE', state, res, async (userId) => {
      if (!authToken) throw new BrokerApiError('Angel One login was cancelled or failed.');
      const s = await this.sessions.angelOne().sessionFromPublisherTokens(authToken, refreshToken, feedToken);
      return this.sessions.saveSession(
        userId,
        'ANGEL_ONE',
        { brokerClientId: s.clientCode, accessToken: s.jwtToken, refreshToken: s.refreshToken, extra: { feedToken: s.feedToken }, expiresAt: s.expiresAt },
        clientInfo(req),
      );
    });
  }

  // -------------------------------------------------------------- shared

  @HttpCode(HttpStatus.OK)
  @Post('accounts/:id/disconnect')
  async disconnect(@CurrentUser() user: RequestUser, @Param('id') id: string, @Req() req: Request): Promise<BrokerAccountView> {
    return toBrokerAccountView(await this.sessions.disconnect(user.id, id, clientInfo(req)));
  }

  /** Runs a broker callback and always redirects the browser back to the web app with a result. */
  private async handleCallback(broker: BrokerName, state: string | undefined, res: Response, work: (userId: string) => Promise<unknown>) {
    const slug = SLUG_OF[broker] ?? 'angel-one';
    const back = new URL('/dashboard', this.config.WEB_ORIGIN);
    back.searchParams.set('broker', slug);
    let userId: string | undefined;
    try {
      userId = await this.sessions.consumeState(state, broker);
      await work(userId);
      back.searchParams.set('result', 'connected');
    } catch (err) {
      const message = userId ? await this.sessions.recordError(userId, broker, err) : (err as Error).message;
      back.searchParams.set('result', 'error');
      back.searchParams.set('message', message.slice(0, 200));
    }
    res.redirect(HttpStatus.FOUND, back.toString());
  }
}

@Module({
  controllers: [BrokersController],
  providers: [BrokerSessionService, BrokerApiConfigService, TokenExpiryService],
  exports: [BrokerSessionService, BrokerApiConfigService],
})
export class BrokersModule {}
