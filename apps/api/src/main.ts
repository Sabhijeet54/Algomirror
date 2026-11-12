import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { EnvValidationError, loadApiEnv, loadDotenv } from '@ctp/config';
import { AppModule } from './app.module';
import { CLIENT_HEADER, accessLog, csrfHeaderCheck, requestId } from './common/middleware/http.middleware';
import { API_CONFIG, ApiConfig } from './config/config.module';

export async function createApp(): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  configureApp(app);
  return app;
}

/** Shared by main() and the e2e tests so both run the exact same HTTP pipeline. */
export function configureApp(app: NestExpressApplication): void {
  const config = app.get<ApiConfig>(API_CONFIG);

  if (config.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // JSON API — no HTML is served, so a locked-down CSP is safe.
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      hsts: config.APP_ENV !== 'development' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    }),
  );
  app.use(cookieParser());
  app.use(requestId);
  app.use(accessLog);
  app.use(csrfHeaderCheck);
  app.useBodyParser('json', { limit: '100kb' });
  // TradingView posts the alert message as text/plain unless it is valid JSON (webhook reads both).
  app.useBodyParser('text', { limit: '16kb' });

  app.enableCors({
    origin: [config.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', CLIENT_HEADER, 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Never echo submitted values (e.g. passwords) back in validation errors.
      validationError: { target: false, value: false },
    }),
  );
  app.useWebSocketAdapter(new IoAdapter(app));
  app.enableShutdownHooks();
}

async function bootstrap(): Promise<void> {
  // Validate configuration before Nest starts so a bad .env fails fast with a readable message.
  loadDotenv();
  loadApiEnv();
  const logger = new Logger('Bootstrap');
  const app = await createApp();
  const config = app.get<ApiConfig>(API_CONFIG);
  const port = config.PORT ? Number(config.PORT) : config.API_PORT;
  await app.listen(port, '0.0.0.0');
  logger.log(`API listening on :${port} (env=${config.APP_ENV}, paperMode=${config.PAPER_MODE})`);
  if (!config.PAPER_MODE) {
    logger.warn('PAPER_MODE=false — real broker orders can be placed once broker adapters are enabled.');
  }
}

if (require.main === module) {
  bootstrap().catch((err) => {
    if (err instanceof EnvValidationError) {
      // eslint-disable-next-line no-console
      console.error(err.message);
    } else {
      // eslint-disable-next-line no-console
      console.error('Fatal startup error:', err);
    }
    process.exit(1);
  });
}
