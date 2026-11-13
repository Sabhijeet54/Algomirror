import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../common/decorators/auth.decorators';
import { WebhookService } from './webhook.service';

/**
 * Incoming TradingView / alert webhooks. Public: the secret token in the URL picks the strategy (rotate it
 * from the strategy page if it leaks). Throttled per strategy inside the service — TradingView posts from a
 * few shared IPs, so the global per-IP limit would throttle every master at once.
 */
@Controller('hooks')
export class WebhookController {
  constructor(private readonly hooks: WebhookService) {}

  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @Post('tv/:token')
  handle(@Param('token') token: string, @Body() body: unknown) {
    return this.hooks.handle(token, body);
  }

  /** Chartink scanner alert (same secret token; Chartink settings on the Automation page). */
  @Public()
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @Post('chartink/:token')
  chartink(@Param('token') token: string, @Body() body: unknown) {
    return this.hooks.handleChartink(token, body);
  }
}
