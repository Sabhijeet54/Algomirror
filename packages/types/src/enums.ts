/**
 * Frontend-safe mirrors of the Prisma enums in packages/database/prisma/schema.prisma.
 * The web app must never import @prisma/client, so these are duplicated here.
 * A unit test (apps/api/test/enums-sync.spec.ts) fails if the two drift apart.
 */

export const Role = {
  ADMIN: 'ADMIN',
  SUB_ADMIN: 'SUB_ADMIN',
  MASTER: 'MASTER',
  FOLLOWER: 'FOLLOWER',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  DISABLED: 'DISABLED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const BrokerName = {
  ZERODHA: 'ZERODHA',
  ANGEL_ONE: 'ANGEL_ONE',
  UPSTOX: 'UPSTOX',
  DHAN: 'DHAN',
  FYERS: 'FYERS',
  KOTAK_NEO: 'KOTAK_NEO',
  FIVE_PAISA: 'FIVE_PAISA',
  ALICE_BLUE: 'ALICE_BLUE',
  GROWW: 'GROWW',
  MOTILAL_OSWAL: 'MOTILAL_OSWAL',
  MOCK: 'MOCK',
} as const;
export type BrokerName = (typeof BrokerName)[keyof typeof BrokerName];

export const BrokerAccountStatus = {
  PENDING: 'PENDING',
  CONNECTED: 'CONNECTED',
  EXPIRED: 'EXPIRED',
  DISCONNECTED: 'DISCONNECTED',
  ERROR: 'ERROR',
} as const;
export type BrokerAccountStatus = (typeof BrokerAccountStatus)[keyof typeof BrokerAccountStatus];

export const BrokerAccountMode = {
  TRADING: 'TRADING',
  DATA_ONLY: 'DATA_ONLY',
} as const;
export type BrokerAccountMode = (typeof BrokerAccountMode)[keyof typeof BrokerAccountMode];

export const StrategyStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type StrategyStatus = (typeof StrategyStatus)[keyof typeof StrategyStatus];

export const RiskLevel = {
  LOW: 'LOW',
  MEDIUM: 'MEDIUM',
  HIGH: 'HIGH',
} as const;
export type RiskLevel = (typeof RiskLevel)[keyof typeof RiskLevel];

export const AllocationMode = {
  FIXED_QUANTITY: 'FIXED_QUANTITY',
  CAPITAL_PERCENTAGE: 'CAPITAL_PERCENTAGE',
  PROPORTIONAL: 'PROPORTIONAL',
} as const;
export type AllocationMode = (typeof AllocationMode)[keyof typeof AllocationMode];

export const CopyStatus = {
  OFF: 'OFF',
  ON: 'ON',
  PAUSED: 'PAUSED',
} as const;
export type CopyStatus = (typeof CopyStatus)[keyof typeof CopyStatus];

export const Exchange = {
  NSE: 'NSE',
  BSE: 'BSE',
  NFO: 'NFO',
  BFO: 'BFO',
  MCX: 'MCX',
  CDS: 'CDS',
  BCD: 'BCD',
} as const;
export type Exchange = (typeof Exchange)[keyof typeof Exchange];

export const OrderSide = {
  BUY: 'BUY',
  SELL: 'SELL',
} as const;
export type OrderSide = (typeof OrderSide)[keyof typeof OrderSide];

export const OrderType = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  SL: 'SL',
  SL_M: 'SL_M',
} as const;
export type OrderType = (typeof OrderType)[keyof typeof OrderType];

/** Broker-neutral product type. Adapters map to broker codes (e.g. Kite CNC/MIS/NRML). */
export const ProductType = {
  DELIVERY: 'DELIVERY',
  INTRADAY: 'INTRADAY',
  CARRY_FORWARD: 'CARRY_FORWARD',
} as const;
export type ProductType = (typeof ProductType)[keyof typeof ProductType];

export const OrderStatus = {
  PENDING: 'PENDING',
  SUBMITTED: 'SUBMITTED',
  OPEN: 'OPEN',
  PARTIALLY_FILLED: 'PARTIALLY_FILLED',
  FILLED: 'FILLED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];

export const OrderSource = {
  MASTER: 'MASTER',
  COPY: 'COPY',
  EXTERNAL: 'EXTERNAL',
} as const;
export type OrderSource = (typeof OrderSource)[keyof typeof OrderSource];

export const NotificationSeverity = {
  INFO: 'INFO',
  SUCCESS: 'SUCCESS',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
} as const;
export type NotificationSeverity = (typeof NotificationSeverity)[keyof typeof NotificationSeverity];

export const TransactionType = {
  REALIZED_PNL: 'REALIZED_PNL',
  CHARGES: 'CHARGES',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type TransactionType = (typeof TransactionType)[keyof typeof TransactionType];

export const SystemEventSeverity = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL',
} as const;
export type SystemEventSeverity = (typeof SystemEventSeverity)[keyof typeof SystemEventSeverity];

export const AuditAction = {
  USER_REGISTERED: 'USER_REGISTERED',
  USER_LOGIN: 'USER_LOGIN',
  USER_LOGIN_FAILED: 'USER_LOGIN_FAILED',
  USER_LOGOUT: 'USER_LOGOUT',
  EMAIL_VERIFIED: 'EMAIL_VERIFIED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  PROFILE_UPDATED: 'PROFILE_UPDATED',
  REFRESH_TOKEN_REUSE_DETECTED: 'REFRESH_TOKEN_REUSE_DETECTED',
  BROKER_CONNECTED: 'BROKER_CONNECTED',
  BROKER_DISCONNECTED: 'BROKER_DISCONNECTED',
  STRATEGY_CREATED: 'STRATEGY_CREATED',
  STRATEGY_UPDATED: 'STRATEGY_UPDATED',
  STRATEGY_STARTED: 'STRATEGY_STARTED',
  STRATEGY_STOPPED: 'STRATEGY_STOPPED',
  COPY_STARTED: 'COPY_STARTED',
  COPY_STOPPED: 'COPY_STOPPED',
  MASTER_TRADE_DETECTED: 'MASTER_TRADE_DETECTED',
  COPY_ORDER_CREATED: 'COPY_ORDER_CREATED',
  COPY_ORDER_SUBMITTED: 'COPY_ORDER_SUBMITTED',
  COPY_ORDER_FILLED: 'COPY_ORDER_FILLED',
  COPY_ORDER_FAILED: 'COPY_ORDER_FAILED',
  ADMIN_DISABLED_USER: 'ADMIN_DISABLED_USER',
  ADMIN_ENABLED_USER: 'ADMIN_ENABLED_USER',
  ADMIN_STOPPED_COPY: 'ADMIN_STOPPED_COPY',
  ADMIN_RESUMED_COPY: 'ADMIN_RESUMED_COPY',
  ADMIN_DISCONNECTED_BROKER: 'ADMIN_DISCONNECTED_BROKER',
  BROKER_TAKEN_OVER: 'BROKER_TAKEN_OVER',
  BROKER_TOKEN_EXPIRED: 'BROKER_TOKEN_EXPIRED',
  KILL_SWITCH_ACTIVATED: 'KILL_SWITCH_ACTIVATED',
  AUTO_SQUARE_OFF: 'AUTO_SQUARE_OFF',
  RISK_LIMIT_HIT: 'RISK_LIMIT_HIT',
} as const;
export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];
