import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ArrayMaxSize, IsArray, IsIn, IsString, MaxLength } from 'class-validator';
import type { MarketFeedStatus } from '@ctp/types';
import { CurrentUser, type RequestUser, Roles } from '../common/decorators/auth.decorators';
import { MarketFeedService } from './market-feed.service';
import { PriceCacheService } from './price-cache.service';

export class FeedInstrumentsDto {
  @IsArray() @ArrayMaxSize(500) @IsString({ each: true }) @MaxLength(60, { each: true }) instruments!: string[];
}
export class FeedBrokerDto {
  @IsIn(['ANGEL_ONE']) broker!: 'ANGEL_ONE';
}

/** Master live market data: feed status/control and cached LTPs (no broker quote calls). */
@Controller('market')
export class MarketDataController {
  constructor(
    private readonly feed: MarketFeedService,
    private readonly prices: PriceCacheService,
  ) {}

  /**
   * Cached LTPs for up to 100 "EXCHANGE:SYMBOL" keys (comma separated). Memory only — no broker call — so the
   * UI can poll it every couple of seconds for live price movement. Unknown keys are subscribed on the feed.
   */
  @Roles('MASTER', 'ADMIN', 'SUB_ADMIN', 'FOLLOWER')
  @Get('ltps')
  ltps(@Query('keys') keys?: string): Record<string, { ltp: number; ts: string } | null> {
    const out: Record<string, { ltp: number; ts: string } | null> = {};
    const list = (keys ?? '').split(',').map((k) => k.trim().toUpperCase()).filter((k) => /^[A-Z]{2,4}:[A-Z0-9&_\-]{1,40}$/.test(k)).slice(0, 100);
    for (const k of list) {
      const [ex, sym] = k.split(':') as [string, string];
      this.feed.ensure(ex as never, sym);
      const t = this.prices.getTick(k);
      out[k] = t ? { ltp: t.ltp, ts: new Date(t.ts).toISOString() } : null;
    }
    return out;
  }

  /** The feed is shared by all masters: a master sees its health only, never what other masters watch. */
  private view(user: RequestUser, st: MarketFeedStatus): MarketFeedStatus {
    return user.role === 'MASTER' ? this.feed.publicStatus(st) : st;
  }

  @Roles('MASTER', 'ADMIN', 'SUB_ADMIN')
  @Get('feed/status')
  status(@CurrentUser() user: RequestUser): MarketFeedStatus {
    return this.view(user, this.feed.status());
  }

  @Roles('MASTER', 'ADMIN', 'SUB_ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post('feed/restart')
  async restart(@CurrentUser() user: RequestUser): Promise<MarketFeedStatus> {
    return this.view(user, await this.feed.restart());
  }

  /** Shared feed controls: platform admin only (one master must not change another master's live data). */
  @Roles('ADMIN', 'SUB_ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post('feed/broker')
  broker(@Body() dto: FeedBrokerDto): Promise<MarketFeedStatus> {
    return this.feed.setPreferredBroker(dto.broker);
  }

  @Roles('ADMIN', 'SUB_ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post('feed/subscribe')
  async subscribe(@Body() dto: FeedInstrumentsDto): Promise<MarketFeedStatus> {
    await this.feed.subscribe(dto.instruments);
    return this.feed.status();
  }

  @Roles('ADMIN', 'SUB_ADMIN')
  @HttpCode(HttpStatus.OK)
  @Post('feed/unsubscribe')
  async unsubscribe(@Body() dto: FeedInstrumentsDto): Promise<MarketFeedStatus> {
    await this.feed.unsubscribe(dto.instruments);
    return this.feed.status();
  }

  /** GET /market/ltp?i=NSE:INFY&i=NFO:NIFTY24OCT25000CE — from the in-memory cache. */
  @Get('ltp')
  ltp(@Query('i') i?: string | string[]) {
    const keys = (Array.isArray(i) ? i : i ? [i] : []).slice(0, 200).map((k) => k.toUpperCase());
    return this.prices.snapshot(keys);
  }
}
