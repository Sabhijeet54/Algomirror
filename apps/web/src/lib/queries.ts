'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdminDashboardStats,
  AdminUserDetail,
  AdminUserListItem,
  AuditLogView,
  AuthResponse,
  AuthUser,
  BrokerAccountView,
  CopyHaltState,
  CopyOrderView,
  EnquiryView,
  LoginRequest,
  MasterTradeView,
  Paginated,
  PositionView,
  RegisterRequest,
  StrategyFollowerView,
  StrategyView,
  SystemEventView,
  SystemHealthDetail,
} from '@ctp/types';
import { api, ApiError } from './api';

export const qk = {
  me: ['me'] as const,
  myBrokerAccounts: ['brokers', 'accounts'] as const,
  admin: (resource: string, params?: object) => ['admin', resource, params ?? {}] as const,
};

// ---------------------------------------------------------------- auth

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        const u = await api<AuthUser>('/auth/me');
        // A master's sub-admin works inside that master's workspace: treat as MASTER in the UI.
        return u.role === 'SUB_ADMIN' && u.masterId ? ({ ...u, role: 'MASTER', isSubAdmin: true } as AuthUser & { isSubAdmin?: boolean }) : (u as AuthUser & { isSubAdmin?: boolean });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: LoginRequest) => api<AuthResponse>('/auth/login', { method: 'POST', body }),
    onSuccess: (res) => {
      qc.clear();
      qc.setQueryData(qk.me, res.user);
    },
  });
}

export function useRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterRequest) =>
      api<AuthResponse | { user: AuthUser; verificationRequired: true }>('/auth/register', { method: 'POST', body }),
    onSuccess: (res) => {
      if ('accessTokenExpiresAt' in res) {
        qc.clear();
        qc.setQueryData(qk.me, res.user);
      }
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api<void>('/auth/logout', { method: 'POST' }),
    onSettled: () => {
      qc.clear();
      qc.setQueryData(qk.me, null);
    },
  });
}

export function useUpdateProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; mobile?: string; telegramChatId?: string }) => api<AuthUser>('/users/me', { method: 'PATCH', body }),
    onSuccess: (user) => qc.setQueryData(qk.me, user),
  });
}

export function useChangePassword() {
  return useMutation({
    mutationFn: (body: { currentPassword: string; newPassword: string }) =>
      api<void>('/users/me/password', { method: 'POST', body }),
  });
}

export function useMyBrokerAccounts() {
  return useQuery({ queryKey: qk.myBrokerAccounts, queryFn: () => api<BrokerAccountView[]>('/brokers/accounts') });
}

export function useBrokerAvailability() {
  return useQuery({
    queryKey: ['brokers', 'available'] as const,
    queryFn: () => api<{ zerodha: boolean; angelOne: boolean; angelOnePublisherLogin: boolean }>('/brokers/available'),
    staleTime: 5 * 60_000,
  });
}

/** Starts a redirect-based broker login (Zerodha Kite / Angel publisher login). */
export function useStartBrokerLogin() {
  return useMutation({
    mutationFn: async (broker: 'zerodha' | 'angel-one') => {
      const { loginUrl } = await api<{ loginUrl: string }>(`/brokers/${broker}/connect`);
      window.location.assign(loginUrl);
    },
  });
}

export function useAngelOneLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { clientCode: string; pin: string; totp: string }) =>
      api<BrokerAccountView>('/brokers/angel-one/login', { method: 'POST', body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.myBrokerAccounts }),
  });
}

export function useDisconnectBroker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<BrokerAccountView>(`/brokers/accounts/${id}/disconnect`, { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.myBrokerAccounts }),
  });
}

// ---------------------------------------------------------------- admin

type Query = Record<string, string | number | undefined>;

function useAdminList<T>(resource: string, path: string, params: Query, enabled = true) {
  return useQuery({
    enabled,
    queryKey: qk.admin(resource, params),
    queryFn: () => api<Paginated<T>>(path, { query: params }),
    placeholderData: (prev) => prev,
  });
}

export const useAdminDashboard = () =>
  useQuery({ queryKey: qk.admin('dashboard'), queryFn: () => api<AdminDashboardStats>('/admin/dashboard'), refetchInterval: 15_000 });

export const useAdminUsers = (p: Query) => useAdminList<AdminUserListItem>('users', '/admin/users', p);
export const useAdminUser = (id: string) =>
  useQuery({ queryKey: qk.admin('user', { id }), queryFn: () => api<AdminUserDetail>(`/admin/users/${id}`) });
export const useAdminBrokerAccounts = (p: Query) =>
  useAdminList<BrokerAccountView & { userName: string; userEmail: string }>('broker-accounts', '/admin/broker-accounts', p);
export const useAdminStrategies = (p: Query, opts?: { enabled?: boolean }) => useAdminList<StrategyView>('strategies', '/admin/strategies', p, opts?.enabled ?? true);
export const useAdminStrategyFollowers = (id: string | null) =>
  useQuery({
    queryKey: qk.admin('strategy-followers', { id }),
    queryFn: () => api<StrategyFollowerView[]>(`/admin/strategies/${id}/followers`),
    enabled: Boolean(id),
  });
export const useAdminMasterTrades = (p: Query) => useAdminList<MasterTradeView>('master-trades', '/admin/master-trades', p);
export const useAdminCopyOrders = (p: Query) => useAdminList<CopyOrderView>('copy-orders', '/admin/copy-orders', p);
export const useAdminPositions = (p: Query) => useAdminList<PositionView>('positions', '/admin/positions', p);
export const useAdminAuditLogs = (p: Query) => useAdminList<AuditLogView>('audit-logs', '/admin/audit-logs', p);
export const useAdminEnquiries = (p: Query) =>
  useQuery({
    queryKey: qk.admin('enquiries', p),
    queryFn: () => api<Paginated<EnquiryView> & { counts: Record<'CLIENT' | 'PARTNER', number> }>('/admin/enquiries', { query: p }),
    placeholderData: (prev) => prev,
    refetchInterval: 60_000,
  });
export const useAdminSystemEvents = (p: Query) => useAdminList<SystemEventView>('system-events', '/admin/system-events', p);
export const useAdminSystemHealth = () =>
  useQuery({
    queryKey: qk.admin('system-health'),
    queryFn: () => api<SystemHealthDetail & { copyHalt: CopyHaltState | null }>('/admin/system-health'),
    refetchInterval: 10_000,
  });

/** Generic admin action that invalidates every admin query afterwards. */
export function useAdminAction<TBody, TResult = unknown>(method: 'POST' | 'PATCH', pathFor: (id: string) => string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: TBody }) => api<TResult>(pathFor(id), { method, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
}

// ------------------------------------------------------------------ admin: users & licence

export interface CreateUserInput {
  name: string;
  email: string;
  mobile?: string;
  password: string;
  role: 'ADMIN' | 'SUB_ADMIN' | 'MASTER' | 'FOLLOWER';
  licenceDays?: number;
  demo?: boolean;
}

export function useAdminUserMutations() {
  const qc = useQueryClient();
  const done = () => void qc.invalidateQueries({ queryKey: ['admin'] });
  return {
    create: useMutation({ mutationFn: (body: CreateUserInput) => api('/admin/users', { method: 'POST', body }), onSuccess: done }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string; name?: string; mobile?: string; role?: 'ADMIN' | 'SUB_ADMIN' | 'MASTER' | 'FOLLOWER' }) =>
        api(`/admin/users/${id}`, { method: 'PATCH', body }),
      onSuccess: done,
    }),
    licence: useMutation({
      mutationFn: ({ id, days, extend, demo }: { id: string; days: number; extend: boolean; demo?: boolean }) => api(`/admin/users/${id}/licence`, { method: 'POST', body: { days, extend, demo } }),
      onSuccess: done,
    }),
    revoke: useMutation({ mutationFn: (id: string) => api(`/admin/users/${id}/licence/revoke`, { method: 'POST' }), onSuccess: done }),
  };
}
