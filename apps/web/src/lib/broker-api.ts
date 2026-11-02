'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './api';
import { qk } from './queries';

export type BrokerSlug = 'angel-one' | 'zerodha' | 'upstox' | 'dhan' | 'fyers' | 'kotak-neo' | '5paisa' | 'alice-blue';
type SecretKey = 'apiKey' | 'apiSecret' | 'pin' | 'totpSecret' | 'proxyUser' | 'proxyPass' | 'mobile' | 'userId';

export interface BrokerApiConfigView {
  broker: 'ANGEL_ONE' | 'ZERODHA' | 'UPSTOX' | 'DHAN' | 'FYERS' | 'KOTAK_NEO' | 'FIVE_PAISA' | 'ALICE_BLUE';
  clientCode: string | null;
  proxyHost: string | null;
  proxyPort: number | null;
  saved: Record<SecretKey, boolean>;
  autoLogin: boolean;
  consentAt: string | null;
  complete: boolean;
  missing: string[];
  lastTest: { at: string; ok: boolean; ip: string | null; error: string | null } | null;
  lastLogin: { at: string | null; error: string | null };
  redirectUrl: string;
  latencyMs?: number;
}

export interface SaveBrokerApiConfigInput {
  clientCode?: string;
  apiKey?: string;
  apiSecret?: string;
  pin?: string;
  totpSecret?: string;
  proxyHost?: string;
  proxyPort?: number;
  proxyUser?: string;
  proxyPass?: string;
  mobile?: string;
  userId?: string;
  autoLogin?: boolean;
  consent?: boolean;
}

const key = (b: BrokerSlug) => ['broker-api', b] as const;

export const useBrokerApiConfig = (b: BrokerSlug) => useQuery({ queryKey: key(b), queryFn: () => api<BrokerApiConfigView>(`/brokers/api-config/${b}`) });

export function useBrokerApiMutations(b: BrokerSlug) {
  const qc = useQueryClient();
  const set = (v: BrokerApiConfigView) => qc.setQueryData(key(b), v);
  return {
    save: useMutation({ mutationFn: (body: SaveBrokerApiConfigInput) => api<BrokerApiConfigView>(`/brokers/api-config/${b}`, { method: 'PUT', body }), onSuccess: set }),
    test: useMutation({ mutationFn: () => api<BrokerApiConfigView>(`/brokers/api-config/${b}/test`, { method: 'POST' }), onSuccess: set }),
    connect: useMutation({
      mutationFn: (body?: { accessToken?: string }) => api<{ loginUrl?: string; account?: unknown }>(`/brokers/api-config/${b}/connect`, { method: 'POST', body: body ?? {} }),
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: key(b) });
        void qc.invalidateQueries({ queryKey: qk.myBrokerAccounts });
        void qc.invalidateQueries({ queryKey: ['client-dashboard'] });
      },
    }),
  };
}

export interface ClientDashboard {
  todayPnl: number;
  /** PAPER when no demat is connected. */
  tradingMode?: 'PAPER' | 'LIVE';
  broker: {
    accountId: string;
    broker: string;
    brokerClientId: string | null;
    status: string;
    connected: boolean;
    tradingMode: 'PAPER' | 'LIVE';
    /** Server runs with PAPER_MODE=true — live trading is impossible for everyone. */
    paperForced: boolean;
  } | null;
  subscriptions: { total: number; on: number; off: number; paused: number };
  licence: { expiresAt: string | null; assignedAt: string | null; days: number | null; remainingDays: number | null; active: boolean | null; demo?: boolean };
  strategies: {
    followerId: string;
    strategyId: string;
    name: string;
    strategyStatus: string;
    copyStatus: 'ON' | 'OFF' | 'PAUSED';
    allocation: string;
    todayPnl: number;
    todayTrades: number;
  }[];
}

export const useClientDashboard = (enabled = true) =>
  useQuery({ queryKey: ['client-dashboard'], queryFn: () => api<ClientDashboard>('/follow/dashboard'), refetchInterval: 10_000, enabled });
