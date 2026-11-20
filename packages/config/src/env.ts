import { z } from 'zod';

/** Treat empty strings as "not set" so `.env.example` placeholders don't count as values. */
const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

/** Strict boolean parser: only "true" / "false" (case-insensitive) are accepted. */
const booleanFlag = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      const s = v.trim().toLowerCase();
      if (s === 'true') return true;
      if (s === 'false') return false;
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected "true" or "false", got "${v}"` });
      return z.NEVER;
    });

const intFromString = (defaultValue: number, min = 1) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `expected an integer >= ${min}` });
        return z.NEVER;
      }
      return n;
    });

const encryptionKey = z
  .string({ required_error: 'ENCRYPTION_KEY is required (generate: openssl rand -base64 32)' })
  .refine((v) => {
    try {
      return Buffer.from(v, 'base64').length === 32;
    } catch {
      return false;
    }
  }, 'ENCRYPTION_KEY must be 32 bytes, base64 encoded (generate: openssl rand -base64 32)');

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production']).default('development'),
  DATABASE_URL: z.string({ required_error: 'DATABASE_URL is required' }).min(1),
  REDIS_URL: z.string({ required_error: 'REDIS_URL is required' }).min(1),
  ENCRYPTION_KEY: encryptionKey,
  PAPER_MODE: booleanFlag(true),

  ZERODHA_API_KEY: optionalString,
  ZERODHA_API_SECRET: optionalString,
  ZERODHA_REDIRECT_URL: optionalString,

  ANGEL_API_KEY: optionalString,
  ANGEL_CLIENT_ID: optionalString,
  ANGEL_CLIENT_SECRET: optionalString,
  ANGEL_REDIRECT_URL: optionalString,
  /** Public static IP sent to SmartAPI in X-ClientPublicIP (must be the IP registered on the SmartAPI app). */
  ANGEL_PUBLIC_IP: optionalString,
  ANGEL_LOCAL_IP: optionalString,
  ANGEL_MAC_ADDRESS: optionalString,

  /**
   * Optional outbound proxies (static-IP egress) for broker API calls, e.g.
   * http://user:pass@dc-mum-006.staticip.in:443 — the proxy's exit IP is what you whitelist at the broker.
   */
  ZERODHA_PROXY_URL: optionalString,
  ANGEL_PROXY_URL: optionalString,
});

export const apiEnvSchema = baseSchema
  .extend({
    API_PORT: intFromString(4000),
    // Railway injects PORT; it wins over API_PORT when present.
    PORT: optionalString,
    WEB_ORIGIN: z.string().url().default('http://localhost:3000'),
    /** More origins serving the same web app (comma separated, e.g. https://trade.example.com). */
    EXTRA_WEB_ORIGINS: z
      .string()
      .optional()
      .transform((v) => (v ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)),
    API_PUBLIC_URL: z.string().url().default('http://localhost:4000'),
    /** Public websites allowed to post the enquiry form (comma separated, e.g. https://sanchaytechnologies.com). */
    PUBLIC_SITE_ORIGINS: z
      .string()
      .optional()
      .transform((v) => (v ?? '').split(',').map((o) => o.trim().replace(/\/$/, '')).filter(Boolean)),
    JWT_SECRET: z
      .string({ required_error: 'JWT_SECRET is required (generate: openssl rand -base64 48)' })
      .min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_ACCESS_TTL_SECONDS: intFromString(900, 60),
    REFRESH_TOKEN_TTL_DAYS: intFromString(14, 1),
    COOKIE_SECURE: booleanFlag(false),
    REQUIRE_EMAIL_VERIFICATION: booleanFlag(false),
    TRUST_PROXY: booleanFlag(false),
    SMTP_HOST: optionalString,
    SMTP_PORT: intFromString(587),
    SMTP_USER: optionalString,
    SMTP_PASSWORD: optionalString,
    /** Gets an email for every new website enquiry (e.g. info@sanchaytechnologies.com). */
    ENQUIRY_NOTIFY_EMAIL: optionalString,
    MAIL_FROM: z.string().default('Copy Trading Platform <no-reply@example.com>'),
    /** How often master broker order books are polled for trades placed outside the platform. 0 disables polling. */
    COPY_POLL_INTERVAL_MS: intFromString(5000, 0),

    /** Telegram alerts (optional). Bot token from @BotFather; admin chat receives platform alerts. */
    TELEGRAM_BOT_TOKEN: optionalString,
    TELEGRAM_ADMIN_CHAT_ID: optionalString,
    /** IST HH:MM at which INTRADAY copy positions are auto squared off on weekdays. Empty = disabled. */
    AUTO_SQUARE_OFF_TIME: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? '15:15' : v.trim()))
      .refine((v) => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'AUTO_SQUARE_OFF_TIME must be HH:MM (IST) or empty'),
    /** Master market feed is considered DOWN (and restarted) after this many seconds without a tick during market hours. */
    FEED_STALE_SECONDS: intFromString(30, 5),
    /** Max orders per second sent to each broker (all client accounts together). */
    ORDER_RATE_PER_SEC_ZERODHA: intFromString(10, 1),
    ORDER_RATE_PER_SEC_ANGEL: intFromString(10, 1),
    /** How often expired broker tokens are detected. */
    TOKEN_EXPIRY_CHECK_MS: intFromString(60_000, 5_000),
    /** How often client P&L is polled for the daily-loss limit. 0 disables. */
    RISK_POLL_INTERVAL_MS: intFromString(30_000, 0),
    /** Copy each new partial fill of a master order as it happens (false = wait until the master order is done). */
    COPY_PARTIAL_FILLS: booleanFlag(true),
    /** How often submitted follower orders are reconciled with the broker order book. 0 disables. */
    COPY_RECONCILE_INTERVAL_MS: intFromString(15_000, 0),
    /** New entries are skipped when LTP moved more than this % away from the master's fill price. 0 disables. */
    MAX_ENTRY_DEVIATION_PCT: z
      .string()
      .optional()
      .transform((v, ctx) => {
        if (v === undefined || v.trim() === '') return 2;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'MAX_ENTRY_DEVIATION_PCT must be a number >= 0' });
          return z.NEVER;
        }
        return n;
      }),
    /** A live price older than this (seconds) counts as stale. */
    STALE_PRICE_MAX_AGE_SEC: intFromString(15, 1),
    /** Block new entries (never exits) during market hours when no fresh live price is available. */
    COPY_BLOCK_ON_STALE_PRICE: booleanFlag(false),
    /** Mirror pending master SL / SL-M / LIMIT exit orders to followers and keep them in sync (modify / cancel). */
    COPY_MIRROR_EXIT_ORDERS: booleanFlag(true),
    /** Seconds after the master's SL/target filled before a still-pending follower order is cancelled and exited at MARKET. */
    COPY_MIRROR_FALLBACK_SEC: intFromString(20, 5),
    /** A LIMIT/SL entry copy order still open after this many seconds is cancelled. 0 disables. */
    COPY_CANCEL_PENDING_ENTRY_SEC: intFromString(60, 0),
    /** Total attempts for a copy order that failed with a transient error (network, timeout, rate limit). */
    COPY_MAX_RETRIES: intFromString(3, 1),
    /** Failed copy orders older than this many seconds are not retried (the signal is stale). */
    COPY_RETRY_WINDOW_SEC: intFromString(30, 5),
    /** true: clients without any licence are not copied. An expired licence always stops copying. */
    LICENCE_REQUIRED: booleanFlag(false),
    /** true: a live client account without its own static-IP proxy is never sent orders (shown as skipped). */
    REQUIRE_CLIENT_PROXY: booleanFlag(false),
    /** IST HH:MM to auto-login clients that saved PIN + TOTP (Angel One, Dhan, Kotak Neo, 5paisa) or a Fyers refresh token (weekdays). Empty = disabled. */
    ANGEL_AUTO_LOGIN_TIME: z
      .string()
      .optional()
      .transform((v) => (v === undefined ? '08:45' : v.trim()))
      .refine((v) => v === '' || /^([01]\d|2[0-3]):[0-5]\d$/.test(v), 'ANGEL_AUTO_LOGIN_TIME must be HH:MM (IST) or empty'),
  })
  .superRefine((env, ctx) => {
    if (env.APP_ENV !== 'development' && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE must be true outside development (HTTPS is required).',
      });
    }
    if (env.APP_ENV !== 'development' && !env.SMTP_HOST && env.REQUIRE_EMAIL_VERIFICATION) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['SMTP_HOST'],
        message: 'SMTP_HOST is required when REQUIRE_EMAIL_VERIFICATION=true outside development.',
      });
    }
  });

export const workerEnvSchema = baseSchema.extend({
  WORKER_HEARTBEAT_INTERVAL_MS: intFromString(10_000, 1000),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

function parse<T extends z.ZodTypeAny>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(source);
  if (!result.success) {
    // Only variable names and messages are reported — never values.
    const issues = result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new EnvValidationError(issues);
  }
  return result.data;
}

export function loadApiEnv(source: NodeJS.ProcessEnv = process.env): ApiEnv {
  return parse(apiEnvSchema, source);
}

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  return parse(workerEnvSchema, source);
}
