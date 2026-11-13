'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BrokerAccountView, CopyOrderView, MarketFeedStatus, MasterTradeView, StrategyFollowerView, StrategyView } from '@ctp/types';
import { api } from './api';

export interface LiveOrder {
  brokerOrderId: string;
  exchange: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: string;
  productType: string;
  quantity: number;
  filledQuantity: number;
  price: number | null;
  averagePrice: number | null;
  status: string;
  statusMessage?: string;
  timestamp: string;
}
export interface LivePosition {
  exchange: string;
  symbol: string;
  productType?: string;
  quantity: number;
  averagePrice: number;
  lastPrice: number | null;
  pnl: number | null;
}
export interface LiveAccount {
  accountId: string;
  broker: string;
  brokerClientId: string | null;
  error?: string;
  funds?: { availableCash: number | null; net: number | null };
  positions?: LivePosition[];
  holdings?: LivePosition[];
  orders?: LiveOrder[];
}
export interface PaperPosition {
  id: string;
  brokerAccountId: string;
  exchange: string;
  symbol: string;
  productType: string;
  quantity: number;
  averagePrice: string;
  lastPrice: string | null;
  realizedPnl: string;
  unrealizedPnl: string;
  updatedAt?: string;
}
export type MasterTradeRow = MasterTradeView & { copyStatusCounts: Record<string, number> };
export type MasterTradeDetail = MasterTradeView & { copyOrders: CopyOrderView[] };
export type FollowerRow = StrategyFollowerView & {
  followerEmail: string;
  followerMobile: string | null;
  brokerAccount: BrokerAccountView | null;
  paperRealizedPnl: string;
  paperUnrealizedPnl: string;
};
export type StrategyWithSub = StrategyView & { subscription: StrategyFollowerView | null; allocationLabel?: string | null };

export interface StrategyInput {
  name: string;
  description?: string;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH';
  allowedExchanges?: string[];
  allowedInstruments?: string[];
  maxFollowers?: number;
  masterCapital: number;
  maxOrderValue?: number;
  maxQuantityPerOrder?: number;
}
export interface MasterOrderInput {
  strategyId: string;
  exchange: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL_M';
  productType: 'DELIVERY' | 'INTRADAY' | 'CARRY_FORWARD';
  price?: number;
  triggerPrice?: number;
  lotSize?: number;
  targetPrice?: number;
  stopLossPrice?: number;
}
export interface FollowInput {
  /** Optional — without a demat the strategy runs on paper. */
  brokerAccountId?: string;
  /** Resize trades already booked (still open) to the new lot multiplier (default true). */
  applyToOpenTrades?: boolean;
  allocationMode: 'FIXED_QUANTITY' | 'CAPITAL_PERCENTAGE' | 'PROPORTIONAL';
  allocationAmount?: number;
  allocationPercent?: number;
  fixedQuantity?: number;
  maxQuantity?: number;
  maxTradeValue?: number;
  fixedLots?: number;
  maxLots?: number;
  maxDailyLoss?: number;
  maxTradesPerDay?: number;
  allowedSegments?: ('EQ' | 'FO')[];
}

const LIVE_MS = 10_000;

// ---------------------------------------------------------------- master
export const useMasterStrategies = (enabled = true) => useQuery({ queryKey: ['master', 'strategies'], queryFn: () => api<StrategyView[]>('/master/strategies'), enabled });
export const useMasterLive = () =>
  useQuery({
    queryKey: ['master', 'live'],
    queryFn: () => api<{ paperMode: boolean; accounts: BrokerAccountView[]; live: LiveAccount[]; paperPositions: PaperPosition[] }>('/master/live'),
    refetchInterval: LIVE_MS,
  });
export const useMasterTrades = () => useQuery({ queryKey: ['master', 'trades'], queryFn: () => api<MasterTradeRow[]>('/master/trades'), refetchInterval: LIVE_MS });
export const useMasterTrade = (id: string | null) =>
  useQuery({ queryKey: ['master', 'trade', id], queryFn: () => api<MasterTradeDetail>(`/master/trades/${id}`), enabled: !!id, refetchInterval: LIVE_MS });
export const useStrategyFollowers = (id: string | null) =>
  useQuery({ queryKey: ['master', 'followers', id], queryFn: () => api<FollowerRow[]>(`/master/strategies/${id}/followers`), enabled: !!id, refetchInterval: LIVE_MS });
export const useClientLive = (userId: string | null) =>
  useQuery({
    queryKey: ['master', 'client', userId],
    queryFn: () => api<{ live: LiveAccount[]; paperPositions: PaperPosition[] }>(`/master/clients/${userId}/live`),
    enabled: !!userId,
    refetchInterval: LIVE_MS,
  });

// ------------------------------------------------------------ live prices / exits / assignment

export type LtpMap = Record<string, { ltp: number; ts: string } | null>;

/** Cached LTPs from the server price cache (no broker calls) — polled every 2 s for live movement. */
export const useLtps = (keys: string[]) => {
  const list = [...new Set(keys.map((k) => k.toUpperCase()))].sort();
  return useQuery({
    queryKey: ['ltps', list.join(',')],
    queryFn: () => api<LtpMap>('/market/ltps', { query: { keys: list.join(',') } }),
    enabled: list.length > 0,
    refetchInterval: 2_000,
    refetchIntervalInBackground: false,
  });
};

export interface ExitPositionInput {
  accountId: string;
  exchange: string;
  symbol: string;
  productType: string;
}

/** Exit one running position. `clientUserId` set = master exiting a client's position. */
export function useExitPosition(clientUserId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ExitPositionInput) =>
      api<{ orderId: string | null; quantity: number }>(clientUserId ? `/master/clients/${clientUserId}/positions/exit` : '/follow/positions/exit', {
        method: 'POST',
        body,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['follow'] });
      void qc.invalidateQueries({ queryKey: ['master'] });
    },
  });
}

/** Master: exit one row of the signal book (its open signals for master + all clients, then the virtual position). */
export function useExitSignalBook() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { exchange: string; symbol: string; productType: string }) =>
      api<{ signalsClosed: number; symbol: string }>('/master/signal-book/exit', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['master'] }),
  });
}

export interface AssignStrategyInput {
  brokerAccountId?: string;
  allocationMode: 'FIXED_QUANTITY' | 'CAPITAL_PERCENTAGE' | 'PROPORTIONAL';
  fixedQuantity?: number;
  fixedLots?: number;
  allocationPercent?: number;
  allocationAmount?: number;
  maxDailyLoss?: number;
  maxLots?: number;
  maxQuantity?: number;
  maxTradeValue?: number;
  maxTradesPerDay?: number;
  allowedSegments?: ('EQ' | 'FO')[];
  startCopy?: boolean;
}
export interface AssignClientInput extends AssignStrategyInput {
  email: string;
}

export function useAssignClient(strategyId: string, scope: 'master' | 'admin' = 'master') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: AssignClientInput) =>
      api<{ warning: string | null; resized?: ResizeResult[] }>(`/${scope}/strategies/${strategyId}/assign`, { method: 'POST', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['master'] });
      void qc.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function useRemoveClient(strategyId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (followerId: string) => api(`/master/strategies/${strategyId}/followers/${followerId}/remove`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['master'] }),
  });
}

export function useSaveStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id?: string; body: StrategyInput }) =>
      api<StrategyView>(id ? `/master/strategies/${id}` : '/master/strategies', { method: id ? 'PATCH' : 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['master', 'strategies'] }),
  });
}
export function useStrategyStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' }) =>
      api<StrategyView>(`/master/strategies/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['master', 'strategies'] }),
  });
}
export function usePlaceMasterOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: MasterOrderInput) => api<MasterTradeDetail>('/master/orders', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['master'] }),
  });
}

// -------------------------------------------------------------- follower
export const useFollowStrategies = () => useQuery({ queryKey: ['follow', 'strategies'], queryFn: () => api<StrategyWithSub[]>('/follow/strategies') });
export type CopyOrderRow = CopyOrderView & { strategyName?: string };
export const usePortfolio = () =>
  useQuery({
    queryKey: ['follow', 'portfolio'],
    queryFn: () =>
      api<{ paperMode: boolean; todayPnl: number; live: LiveAccount[]; paperPositions: PaperPosition[]; copyOrders: CopyOrderRow[] }>('/follow/portfolio'),
    refetchInterval: LIVE_MS,
  });
export function useSetTradingMode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (mode: 'PAPER' | 'LIVE') => api<{ mode: 'PAPER' | 'LIVE'; paperClosed?: number }>('/follow/trading-mode', { method: 'POST', body: { mode } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['client-dashboard'] });
      void qc.invalidateQueries({ queryKey: ['follow'] });
    },
  });
}
export function useFollow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ strategyId, body }: { strategyId: string; body: FollowInput }) =>
      api<StrategyFollowerView & { resized?: { symbol: string; from: number; to: number; side: 'BUY' | 'SELL'; quantity: number; ok: boolean; error?: string }[] }>(
        `/follow/strategies/${strategyId}`,
        { method: 'POST', body },
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['follow'] });
      void qc.invalidateQueries({ queryKey: ['client-dashboard'] });
    },
  });
}
export function useToggleCopy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'start' | 'stop' }) => api<StrategyFollowerView>(`/follow/subscriptions/${id}/${action}`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['follow'] }),
  });
}

// ---------------------------------------------------------- live feed / speed / risk
export interface LatencySnapshot {
  todayCount: number;
  todayAvgMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  lastMs: number | null;
  dbTodayAvgMs?: number | null;
  dbTodayCount?: number;
}
/** Feed status: pushed over the socket every 5 s (see RealtimeProvider), polled as a fallback. */
export const useFeedStatus = (enabled = true) =>
  useQuery({ queryKey: ['trading', 'feed-status'], queryFn: () => api<MarketFeedStatus>('/market/feed/status'), refetchInterval: 15_000, enabled });
export function useFeedAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: { kind: 'restart' } | { kind: 'broker'; broker: 'ANGEL_ONE' } | { kind: 'subscribe' | 'unsubscribe'; instruments: string[] }) =>
      a.kind === 'restart'
        ? api<MarketFeedStatus>('/market/feed/restart', { method: 'POST' })
        : a.kind === 'broker'
          ? api<MarketFeedStatus>('/market/feed/broker', { method: 'POST', body: { broker: a.broker } })
          : api<MarketFeedStatus>(`/market/feed/${a.kind}`, { method: 'POST', body: { instruments: a.instruments } }),
    onSuccess: (st) => qc.setQueryData(['trading', 'feed-status'], st),
  });
}
export const useMasterLatency = (enabled = true) =>
  useQuery({ queryKey: ['trading', 'latency'], queryFn: () => api<LatencySnapshot>('/master/latency'), refetchInterval: 15_000, enabled });
export const useAdminLatency = () => useQuery({ queryKey: ['admin', 'latency'], queryFn: () => api<LatencySnapshot>('/admin/copy-trading/latency'), refetchInterval: 15_000 });
export function useExitStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ signalsClosed?: number; orders: number; failed: number; errors?: string[] }>(`/master/strategies/${id}/exit-all`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['master'] }),
  });
}
export function useExitAllMine() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<{ orders: number; failed: number }>('/follow/exit-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['follow'] }),
  });
}

// ------------------------------------------------------------------ signals

export interface SignalRow {
  id: string;
  strategyId: string | null;
  strategyName: string | null;
  exchange: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  productType: string;
  quantity: number;
  openQuantity: number;
  entryPrice: number | null;
  entryAt: string;
  exitPrice: number | null;
  exitAt: string | null;
  exitReason: string | null;
  targetPrice: number | null;
  stopLossPrice: number | null;
  status: 'OPEN' | 'CLOSED';
  realizedPnl: number;
  ltp: number | null;
  copyStatusCounts: Record<string, number>;
}

export const useSignals = (status: 'all' | 'open' | 'closed', scope: 'today' | 'all') =>
  useQuery({
    queryKey: ['master', 'signals', status, scope],
    queryFn: () => api<SignalRow[]>('/master/signals', { query: { status, scope } }),
    refetchInterval: 5_000,
  });

export function useSquareOffSignal(scope: 'master' | 'admin' = 'master') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ exitPrice: number | null; quantity: number; reason: string }>(`/${scope}/signals/${id}/square-off`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['master'] });
      void qc.invalidateQueries({ queryKey: ['admin-signals'] });
    },
  });
}

export function useSetSignalTpSl(scope: 'master' | 'admin' = 'master') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetPrice, stopLossPrice }: { id: string; targetPrice: number | null; stopLossPrice: number | null }) =>
      api(`/${scope}/signals/${id}/tpsl`, { method: 'PATCH', body: { targetPrice, stopLossPrice } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['master', 'signals'] });
      void qc.invalidateQueries({ queryKey: ['admin-signals'] });
    },
  });
}

export type AdminSignalRow = SignalRow & { masterName: string | null };

export const useAdminSignals = (p: { from: string; to: string; strategyIds: string[]; status: 'all' | 'open' | 'closed' }, scope: 'admin' | 'master' = 'admin') =>
  useQuery({
    queryKey: ['admin-signals', scope, p],
    queryFn: () =>
      api<AdminSignalRow[]>(`/${scope}/signals`, { query: { from: p.from, to: p.to, status: p.status, strategyIds: p.strategyIds.join(',') || undefined } }),
    refetchInterval: 5_000,
  });

// ------------------------------------------------------------ master: clients

export type LicenceState = 'NONE' | 'ACTIVE' | 'EXPIRING' | 'EXPIRED';
export interface MasterClientRow {
  userId: string;
  name: string;
  email: string;
  mobile: string | null;
  status: string;
  licenceExpiresAt: string | null;
  licenceDays?: number | null;
  demo?: boolean;
  licenceStatus: LicenceState;
  broker: (BrokerAccountView & { simulated: boolean }) | null;
  todayPnl: number;
  todayTrades: number;
  subscriptions: { followerId: string; strategyId: string; strategyName: string; copyStatus: 'ON' | 'OFF' | 'PAUSED'; allocation: string }[];
}
export interface StrategyDay {
  followerId: string;
  strategyId: string;
  name: string;
  copyStatus: 'ON' | 'OFF' | 'PAUSED';
  allocation: string;
  todayPnl: number;
  todayTrades: number;
}
export type HistoryRange = 'today' | '7d' | '30d' | 'all';
export interface MasterClientDetail {
  profile: {
    id: string;
    name: string;
    email: string;
    mobile: string | null;
    status: string;
    createdAt: string;
    lastLoginAt: string | null;
    licenceDays: number | null;
    licenceAssignedAt: string | null;
    licenceExpiresAt: string | null;
    licenceStatus: LicenceState;
  };
  brokerAccounts: (BrokerAccountView & { simulated: boolean })[];
  todayPnl: number;
  strategies: (StrategyFollowerView & { allocation: string; today: StrategyDay | null })[];
  range: HistoryRange;
  orders: CopyOrderRow[];
}
export const useMasterClients = () =>
  useQuery({ queryKey: ['master', 'clients'], queryFn: () => api<MasterClientRow[]>('/master/clients'), refetchInterval: LIVE_MS });
/** Master deletes one of his clients (history kept; login blocked; email freed). */
export function useDeleteMasterClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (userId: string) => api<{ deleted: boolean }>(`/master/clients/${userId}/delete`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['master'] });
    },
  });
}
export const useMasterClient = (userId: string | null, range: HistoryRange) =>
  useQuery({
    queryKey: ['master', 'client-detail', userId, range],
    queryFn: () => api<MasterClientDetail>(`/master/clients/${userId}`, { query: { range } }),
    enabled: !!userId,
    refetchInterval: LIVE_MS,
  });

// ------------------------------------------------------------ admin: strategy access per client

export interface UserStrategyRow {
  strategyId: string;
  name: string;
  masterName: string;
  status: string;
  assigned: boolean;
  subscription: (StrategyFollowerView & { allocation: string }) | null;
}
export type StaffScope = 'admin' | 'master';
const userBase = (scope: StaffScope, userId: string) => (scope === 'admin' ? `/admin/users/${userId}` : `/master/clients/${userId}`);
export const useAdminUserStrategies = (userId: string | null, scope: StaffScope = 'admin') =>
  useQuery({ queryKey: [scope, 'user-strategies', userId], queryFn: () => api<UserStrategyRow[]>(`${userBase(scope, userId!)}/strategies`), enabled: !!userId });

export function useAdminUserStrategyMutations(userId: string, scope: StaffScope = 'admin') {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: [scope] });
  return {
    assign: useMutation({
      mutationFn: ({ strategyId, body }: { strategyId: string; body: AssignStrategyInput }) =>
        api<{ warning: string | null; resized?: ResizeResult[] }>(`${userBase(scope, userId)}/strategies/${strategyId}`, { method: 'POST', body }),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (strategyId: string) => api(`${userBase(scope, userId)}/strategies/${strategyId}/remove`, { method: 'POST' }),
      onSuccess: done,
    }),
  };
}

// ------------------------------------------------------------ admin: trade history corrections

export function useAdminSignalMutations(scope: 'admin' | 'master' = 'admin') {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['admin-signals'] });
  return {
    edit: useMutation({
      mutationFn: ({ id, ...body }: { id: string; entryPrice?: number; exitPrice?: number; quantity?: number }) =>
        api<{ id: string; realizedPnl: number | null }>(`/${scope}/signals/${id}`, { method: 'PATCH', body }),
      onSuccess: done,
    }),
    remove: useMutation({ mutationFn: (id: string) => api(`/${scope}/signals/${id}`, { method: 'DELETE' }), onSuccess: done }),
  };
}

// ------------------------------------------------------------ client picker (assign client)

export interface DirectoryClient {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  assigned: boolean;
}
export const useClientDirectory = (scope: 'master' | 'admin', search: string, strategyId: string | null, enabled = true) =>
  useQuery({
    queryKey: [scope, 'client-directory', search.trim(), strategyId],
    queryFn: () => api<DirectoryClient[]>(`/${scope}/client-directory`, { query: { search: search.trim() || undefined, strategyId: strategyId ?? undefined } }),
    enabled,
    placeholderData: (prev) => prev,
  });

// ------------------------------------------------------------ F&O contract list (master order form)

export type FnoExchange = 'NFO' | 'BFO' | 'MCX';
export interface FnoScript {
  name: string;
  lotSize: number;
  nearestExpiry: string | null;
}
export interface FnoChain {
  name: string;
  lotSize: number | null;
  expiries: { date: string; lotSize: number; monthly: boolean; strikes: number[] }[];
}
export const useFnoScripts = (exchange: FnoExchange | null, q: string) =>
  useQuery({
    queryKey: ['master', 'fno-scripts', exchange, q.trim().toUpperCase()],
    queryFn: () => api<FnoScript[]>('/master/fno/scripts', { query: { exchange: exchange!, q: q.trim() } }),
    enabled: !!exchange,
    staleTime: 10 * 60_000,
    placeholderData: (prev) => prev,
  });
export const useFnoChain = (exchange: FnoExchange | null, name: string, kind: 'OPT' | 'FUT') =>
  useQuery({
    queryKey: ['master', 'fno-chain', exchange, name.trim().toUpperCase(), kind],
    queryFn: () => api<FnoChain>('/master/fno/chain', { query: { exchange: exchange!, name: name.trim(), kind } }),
    enabled: !!exchange && name.trim().length > 0,
    staleTime: 10 * 60_000,
  });

// ------------------------------------------------------------ client trade book

export interface TradeBookRow {
  id: string;
  strategyName: string;
  exchange: string;
  symbol: string;
  productType: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  lots: number | null;
  openQuantity: number;
  entryPrice: number;
  entryAt: string;
  /** Entered on an earlier day (carry forward). */
  carried?: boolean;
  exitPrice: number | null;
  exitAt: string | null;
  ltp: number | null;
  status: 'OPEN' | 'CLOSED';
  pnl: number;
  /** Broker rejected the order — tracked at the strategy's prices, not in the demat, not in the total. */
  rejected?: boolean;
  rejectReason?: string | null;
}
export const useTradeBook = () =>
  useQuery({
    queryKey: ['follow', 'trades'],
    queryFn: () => api<{ totalPnl: number; rejectedPnl?: number; rows: TradeBookRow[] }>('/follow/trades'),
    refetchInterval: 5_000,
  });

export interface ResizeResult {
  symbol: string;
  from: number;
  to: number;
  side: 'BUY' | 'SELL';
  quantity: number;
  ok: boolean;
  error?: string;
}

// ------------------------------------------------------------ client marketplace

export type MarketplaceRow = StrategyWithSub & { connected: boolean };
export const useMarketplace = () => useQuery({ queryKey: ['follow', 'marketplace'], queryFn: () => api<MarketplaceRow[]>('/follow/marketplace') });
export function useDisconnectStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (strategyId: string) => api<{ disconnected: boolean }>(`/follow/strategies/${strategyId}/disconnect`, { method: 'POST' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['follow'] });
      void qc.invalidateQueries({ queryKey: ['client-dashboard'] });
    },
  });
}

// ------------------------------------------------------------------ client: marketplace history & activity log

export interface StrategyHistoryRow {
  id: string;
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  productType: string;
  quantity: number;
  entryPrice: number | null;
  entryAt: string;
  exitPrice: number | null;
  exitAt: string | null;
  status: 'OPEN' | 'CLOSED';
  realizedPnl: number;
  ltp: number | null;
}
export const useStrategyHistory = (id: string | null) =>
  useQuery({ queryKey: ['follow', 'history', id], queryFn: () => api<StrategyHistoryRow[]>(`/follow/strategies/${id}/history`), enabled: !!id });

export interface ActivityRow {
  id: string;
  at: string;
  action: string;
  on: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  userAgent: string | null;
}
export const useActivity = (page: number) =>
  useQuery({ queryKey: ['follow', 'activity', page], queryFn: () => api<{ total: number; page: number; pageSize: number; items: ActivityRow[] }>(`/follow/activity?page=${page}`), refetchInterval: 30_000 });

// ------------------------------------------------------------ master: client licence & sub-admins

export function useMasterLicenceMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['master'] });
  return {
    licence: useMutation({
      mutationFn: ({ id, days, extend, demo }: { id: string; days: number; extend: boolean; demo?: boolean }) => api(`/master/clients/${id}/licence`, { method: 'POST', body: { days, extend, demo } }),
      onSuccess: done,
    }),
    revoke: useMutation({ mutationFn: (id: string) => api(`/master/clients/${id}/licence/revoke`, { method: 'POST' }), onSuccess: done }),
  };
}

/** One strategy trade booked in the software (Signals) — independent of whether the demat executed it. */
export interface SoftwareTradeRow {
  tradeId: string;
  signalId: string;
  followerId: string;
  strategyName: string;
  mode: 'PAPER' | 'LIVE';
  exchange: string;
  symbol: string;
  productType: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  lots: number | null;
  openQuantity: number;
  entryPrice: number;
  entryAt: string;
  carried: boolean;
  exitPrice: number | null;
  exitAt: string | null;
  ltp: number | null;
  status: 'OPEN' | 'CLOSED';
  realizedPnl: number;
  unrealizedPnl: number;
  pnl: number;
  execution: 'PAPER' | 'EXECUTED' | 'PARTIAL' | 'PENDING' | 'NOT_EXECUTED';
}
export const useMySignals = () =>
  useQuery({
    queryKey: ['follow', 'signals'],
    queryFn: () => api<{ totalPnl: number; summary: { trades: number; open: number; closed: number; realizedPnl: number; unrealizedPnl: number; totalPnl: number }; rows: SoftwareTradeRow[] }>('/follow/signals'),
    refetchInterval: 5_000,
  });

export type ApiLogExecution = 'success' | 'error' | 'pending' | 'paper' | 'skipped';
export interface ApiLogRow {
  id: string;
  at: string;
  userName: string;
  email: string;
  broker: string;
  loginId: string | null;
  strategy: string | null;
  type: 'ENTRY' | 'EXIT' | 'LOGIN';
  side: string | null;
  symbol: string | null;
  quantity: number | null;
  execution: ApiLogExecution;
  response: Record<string, unknown>;
}
export const useApiLog = (p: { execution?: string; type?: string; q?: string; page?: number; date?: string }) =>
  useQuery({
    queryKey: ['follow', 'api-log', p],
    queryFn: () => api<{ date: string; total: number; page: number; pageSize: number; items: ApiLogRow[] }>('/follow/api-log', { query: p }),
    refetchInterval: 10_000,
  });

export interface LicenceHistoryItem {
  at: string;
  kind: 'ASSIGNED' | 'EXTENDED' | 'REVOKED' | 'CREATED';
  days: number | null;
  demo: boolean;
  expiresAt: string | null;
  by: { name: string; role: string } | null;
}
/** Licence history of a user — admin (`/admin/users/:id`) or master (`/master/clients/:id`). */
export const useLicenceHistory = (scope: StaffScope, id: string | null) =>
  useQuery({
    queryKey: [scope, 'licence-history', id],
    queryFn: () => api<LicenceHistoryItem[]>(scope === 'admin' ? `/admin/users/${id}/licence-history` : `/master/clients/${id}/licence-history`),
    enabled: !!id,
  });
/** The signed-in client's own licence history. */
export const useMyLicenceHistory = (enabled = true) =>
  useQuery({ queryKey: ['follow', 'licence-history'], queryFn: () => api<LicenceHistoryItem[]>('/follow/licence-history'), enabled });

export interface SubAdminRow {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  status: string;
  createdAt: string;
  lastLoginAt: string | null;
}
export const useSubAdmins = () => useQuery({ queryKey: ['master', 'sub-admins'], queryFn: () => api<SubAdminRow[]>('/master/sub-admins') });
export function useSubAdminMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['master', 'sub-admins'] });
  return {
    create: useMutation({ mutationFn: (body: { name: string; email: string; mobile?: string; password: string }) => api('/master/sub-admins', { method: 'POST', body }), onSuccess: done }),
    setStatus: useMutation({ mutationFn: ({ id, status }: { id: string; status: 'ACTIVE' | 'DISABLED' }) => api(`/master/sub-admins/${id}/status`, { method: 'POST', body: { status } }), onSuccess: done }),
  };
}

export function useMasterCreateClient() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; email: string; mobile?: string; password: string; licenceDays?: number; demo?: boolean }) => api<{ id: string }>('/master/clients', { method: 'POST', body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['master'] }),
  });
}

export const useMasterLicenceQuota = (enabled = true) =>
  useQuery({ queryKey: ['master', 'licence-quota'], queryFn: () => api<{ remaining: number; customAllowed: boolean }>('/master/licence-quota'), enabled });

// ------------------------------------------------------------ TradingView / alert webhook (master)

export interface WebhookLogRow {
  at: string;
  ok: boolean;
  action: string;
  symbol: string | null;
  message: string;
  tradeId?: string;
}
export interface WebhookInfo {
  enabled: boolean;
  url: string | null;
  chartinkUrl: string | null;
  recent: WebhookLogRow[];
}

export const useStrategyWebhook = (id: string | null) =>
  useQuery({
    queryKey: ['master', 'webhook', id],
    queryFn: () => api<WebhookInfo>(`/master/strategies/${id}/webhook`),
    enabled: !!id,
    refetchInterval: 15_000,
    retry: false,
  });

export function useWebhookChange(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (op: 'rotate' | 'disable') => api<WebhookInfo>(`/master/strategies/${id}/webhook`, { method: op === 'rotate' ? 'POST' : 'DELETE' }),
    onSuccess: (data) => qc.setQueryData(['master', 'webhook', id], data),
  });
}

// ------------------------------------------------------------ strategy automation (master)

export interface ScheduleLeg {
  underlying: string;
  option: 'CE' | 'PE' | 'FUT';
  strike: number;
  side: 'BUY' | 'SELL';
  lots: number;
}
export interface AutomationSettings {
  schedule: {
    enabled: boolean;
    entryTime: string;
    exitTime: string | null;
    days: number[];
    expiry: 'nearest' | 'next' | 'monthly';
    product: 'INTRADAY' | 'CARRY_FORWARD';
    legs: ScheduleLeg[];
    targetPoints: number | null;
    stoplossPoints: number | null;
  };
  trailPoints: number | null;
  daily: { maxLoss: number | null; maxProfit: number | null };
  reentry: { enabled: boolean; max: number };
  chartink: { enabled: boolean; side: 'BUY' | 'SELL'; qty: number; product: 'INTRADAY' | 'DELIVERY'; targetPct: number | null; stoplossPct: number | null; maxStocks: number };
}
export interface AutomationInfo {
  settings: AutomationSettings;
  today: { pnl: number; halted: boolean };
}

export const useStrategyAutomation = (id: string | null) =>
  useQuery({
    queryKey: ['master', 'automation', id],
    queryFn: () => api<AutomationInfo>(`/master/strategies/${id}/automation`),
    enabled: !!id,
    refetchInterval: 15_000,
    retry: false,
  });

export function useSaveAutomation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (settings: AutomationSettings) => api<AutomationInfo>(`/master/strategies/${id}/automation`, { method: 'PUT', body: settings }),
    onSuccess: (data) => qc.setQueryData(['master', 'automation', id], data),
  });
}
