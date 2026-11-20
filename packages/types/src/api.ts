import type {
  AllocationMode,
  AuditAction,
  BrokerAccountMode,
  BrokerAccountStatus,
  BrokerName,
  CopyStatus,
  Exchange,
  OrderSide,
  OrderStatus,
  OrderType,
  ProductType,
  RiskLevel,
  Role,
  StrategyStatus,
  SystemEventSeverity,
  UserStatus,
} from './enums';

/** Money and price values are serialized as decimal strings to avoid float rounding. */
export type DecimalString = string;
/** ISO-8601 timestamp */
export type IsoDate = string;

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
  requestId?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------- Auth ----------

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  mobile: string | null;
  /** Telegram chat id for personal alerts (optional). */
  telegramChatId?: string | null;
  role: Role;
  /** Set for a master's sub-admin (works inside that master's workspace). */
  masterId?: string | null;
  /** Set while a master is viewing this client's panel. */
  impersonatedBy?: string | null;
  status: UserStatus;
  emailVerified: boolean;
  createdAt: IsoDate;
}

export interface AuthResponse {
  user: AuthUser;
  /** Access token expiry (epoch ms). Tokens themselves are only ever sent as httpOnly cookies. */
  accessTokenExpiresAt: number;
}

export interface RegisterRequest {
  email: string;
  password: string;
  name: string;
  mobile?: string;
  /** Self-registration creates client accounts only. */
  role?: 'FOLLOWER';
}

export interface LoginRequest {
  email: string;
  password: string;
  /** client = /login (clients only) · staff = /master-login (masters and admins). */
  portal?: 'client' | 'staff';
}

// ---------- Broker accounts (never contains credentials) ----------

export interface BrokerAccountView {
  id: string;
  userId: string;
  broker: BrokerName;
  brokerClientId: string | null;
  status: BrokerAccountStatus;
  isPaper: boolean;
  /** TRADING (client) or DATA_ONLY (master live-feed account — never places orders). */
  mode: BrokerAccountMode;
  tokenExpiresAt: IsoDate | null;
  tokenStatus: 'ACTIVE' | 'EXPIRED' | 'NONE';
  lastConnectedAt: IsoDate | null;
  lastError: string | null;
  disconnectReason: string | null;
  disconnectedAt: IsoDate | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

// ---------- Strategies ----------

export interface StrategyView {
  id: string;
  masterUserId: string;
  masterName?: string;
  name: string;
  description: string | null;
  riskLevel: RiskLevel;
  status: StrategyStatus;
  allowedExchanges: Exchange[];
  allowedInstruments: string[];
  maxFollowers: number | null;
  masterCapital: DecimalString;
  followerCount?: number;
  activeFollowerCount?: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface StrategyFollowerView {
  id: string;
  strategyId: string;
  strategyName?: string;
  followerUserId: string;
  followerName?: string;
  brokerAccountId: string | null;
  allocationMode: AllocationMode;
  allocationAmount: DecimalString | null;
  allocationPercent: DecimalString | null;
  fixedQuantity: number | null;
  fixedLots: number | null;
  maxLots: number | null;
  maxTradesPerDay: number | null;
  allowedSegments: string[];
  riskLevel: RiskLevel | null;
  maxTradeValue: DecimalString | null;
  maxDailyLoss: DecimalString | null;
  maxQuantity: number | null;
  maxOpenPositions: number | null;
  copyStatus: CopyStatus;
  startedAt: IsoDate | null;
  stoppedAt: IsoDate | null;
  stoppedReason: string | null;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

// ---------- Trades & orders ----------

export interface MasterTradeView {
  id: string;
  masterUserId: string;
  masterName?: string;
  strategyId: string | null;
  brokerAccountId: string;
  broker: BrokerName;
  brokerOrderId: string;
  exchange: Exchange;
  symbol: string;
  instrumentToken: string | null;
  side: OrderSide;
  orderType: OrderType;
  productType: ProductType;
  quantity: number;
  filledQuantity: number;
  price: DecimalString | null;
  averagePrice: DecimalString | null;
  status: OrderStatus;
  eventTimestamp: IsoDate;
  createdAt: IsoDate;
  copyOrderCount?: number;
}

export interface CopyOrderView {
  id: string;
  masterTradeId: string;
  followerUserId: string;
  followerName?: string;
  brokerAccountId: string;
  broker: BrokerName;
  exchange: Exchange;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  productType: ProductType;
  quantity: number;
  filledQuantity: number;
  averagePrice: DecimalString | null;
  status: OrderStatus;
  brokerOrderId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  attempts: number;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface PositionView {
  id: string;
  userId: string;
  userName?: string;
  brokerAccountId: string;
  broker?: BrokerName;
  exchange: Exchange;
  symbol: string;
  productType: ProductType;
  quantity: number;
  averagePrice: DecimalString;
  lastPrice: DecimalString | null;
  realizedPnl: DecimalString;
  unrealizedPnl: DecimalString;
  isPaper: boolean;
  updatedAt: IsoDate;
}

// ---------- Admin ----------

export interface AdminDashboardStats {
  totalUsers: number;
  connectedAccounts: number;
  activeMasters: number;
  activeFollowers: number;
  activeStrategies: number;
  todaysMasterTrades: number;
  successfulCopyOrders: number;
  failedCopyOrders: number;
  paperMode: boolean;
  /** Users registered this calendar month (IST) and last month, for the % change. */
  newUsersThisMonth: number;
  newUsersLastMonth: number;
  /** Users whose licence has expired. */
  expiredUsers: number;
  /** Licences expiring in the next 7 days. */
  expiringThisWeek: number;
  /** Clients (followers) with a connected broker account. */
  activeClients: number;
}

export interface AdminUserListItem {
  id: string;
  email: string;
  name: string;
  mobile: string | null;
  role: Role;
  status: UserStatus;
  emailVerified: boolean;
  lastLoginAt: IsoDate | null;
  createdAt: IsoDate;
  brokerAccounts: Pick<BrokerAccountView, 'id' | 'broker' | 'status'>[];
  licenceDays: number | null;
  /** Demo licence: paper only. */
  demo?: boolean;
  /** Master: licences left / custom periods allowed. */
  licenceQuota?: number;
  licenceCustomAllowed?: boolean;
  licenceAssignedAt: IsoDate | null;
  licenceExpiresAt: IsoDate | null;
  /** NONE = no licence assigned, ACTIVE, EXPIRING (≤ 7 days), EXPIRED. */
  licenceStatus: 'NONE' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED';
  /** Strategies assigned to this client (users list only). */
  assignedStrategies?: { id: string; name: string; copyStatus: CopyStatus }[];
}

export interface AdminUserDetail extends AdminUserListItem {
  brokerAccounts: BrokerAccountView[];
  follows: StrategyFollowerView[];
  strategies: StrategyView[];
}

export interface AuditLogView {
  id: string;
  actorUserId: string | null;
  actorEmail: string | null;
  action: AuditAction;
  targetType: string | null;
  targetId: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  createdAt: IsoDate;
}

export interface SystemEventView {
  id: string;
  source: string;
  type: string;
  severity: SystemEventSeverity;
  message: string;
  context: Record<string, unknown> | null;
  resolvedAt: IsoDate | null;
  createdAt: IsoDate;
}

export type ComponentState = 'connected' | 'disconnected';

/** Shape of GET /health */
export interface HealthResponse {
  status: 'ok' | 'degraded';
  database: ComponentState;
  redis: ComponentState;
  worker: ComponentState;
}

export interface SystemHealthDetail extends HealthResponse {
  api: { uptimeSeconds: number; version: string; environment: string; paperMode: boolean };
  workerHeartbeat: { lastSeenAt: IsoDate | null; pid: number | null; host: string | null };
  queues: Array<{ name: string; waiting: number; active: number; failed: number; delayed: number }>;
  brokerStreams: Array<{ brokerAccountId: string; broker: BrokerName; state: string; lastEventAt: IsoDate | null }>;
  recentEvents: SystemEventView[];
}

// ---------- Website enquiries ----------

export interface EnquiryView {
  id: string;
  kind: 'CLIENT' | 'PARTNER';
  status: 'NEW' | 'CONTACTED' | 'CLOSED';
  name: string;
  email: string;
  phone: string;
  company: string | null;
  city: string | null;
  interest: string;
  details: { partnerType?: string; clients?: string; modules?: string[] } | null;
  message: string | null;
  note: string | null;
  page: string | null;
  ip: string | null;
  createdAt: string;
  updatedAt: string;
}
