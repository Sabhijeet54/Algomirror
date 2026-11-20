'use client';

import { brokerLabel } from '@/lib/format';

import { createContext, useContext, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { toast } from 'sonner';
import { type BrokerEventPayload, type MarketFeedStatus, type NotificationPayload, WsEvent } from '@ctp/types';
import { qk } from '@/lib/queries';

const RealtimeContext = createContext<{ socket: Socket | null; connected: boolean }>({ socket: null, connected: false });

export const useRealtime = () => useContext(RealtimeContext);

/** Subscribes to one realtime event for the lifetime of the calling component. */
export function useRealtimeEvent<T>(event: string, handler: (payload: T) => void) {
  const { socket } = useRealtime();
  useEffect(() => {
    if (!socket) return;
    socket.on(event, handler);
    return () => {
      socket.off(event, handler);
    };
  }, [socket, event, handler]);
}

const brokerName = (b: string) => brokerLabel(b);

/**
 * One Socket.IO connection per signed-in tab, through the Next.js proxy (/api/socket.io), authenticated by
 * the httpOnly session cookie. Broker / order / notification events refresh the affected queries and toast.
 */
export function RealtimeProvider({ children }: { children: React.ReactNode }) {
  const qc = useQueryClient();
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const url = process.env.NEXT_PUBLIC_SOCKET_URL || undefined;
    const s = io(url ?? '', {
      path: url ? '/socket.io' : '/api/socket.io',
      addTrailingSlash: false,
      withCredentials: true,
      transports: ['polling', 'websocket'],
      reconnectionDelayMax: 10_000,
    });
    setSocket(s);
    s.on('connect', () => setConnected(true));
    s.on('disconnect', () => setConnected(false));

    const refreshBrokers = () => {
      void qc.invalidateQueries({ queryKey: qk.myBrokerAccounts });
      void qc.invalidateQueries({ queryKey: ['admin'] });
      void qc.invalidateQueries({ queryKey: ['trading'] });
      void qc.invalidateQueries({ queryKey: ['master'] });
      void qc.invalidateQueries({ queryKey: ['follow'] });
    };
    s.on(WsEvent.BROKER_TAKEN_OVER, (p: BrokerEventPayload) => {
      toast.warning(`${brokerName(p.broker)} ${p.brokerClientId ?? ''} disconnected`, { description: p.reason, duration: 15_000 });
      refreshBrokers();
    });
    s.on(WsEvent.BROKER_DISCONNECTED, refreshBrokers);
    s.on(WsEvent.BROKER_CONNECTED, refreshBrokers);
    s.on(WsEvent.BROKER_TOKEN_EXPIRED, (p: BrokerEventPayload) => {
      toast.warning(`${brokerName(p.broker)} session expired — please reconnect`);
      refreshBrokers();
    });
    s.on(WsEvent.NOTIFICATION_CREATED, (n: NotificationPayload) => {
      if (n.type === 'BROKER_TAKEN_OVER' || n.type === 'BROKER_TOKEN_EXPIRED') return; // already toasted above
      const fn = n.severity === 'ERROR' ? toast.error : n.severity === 'WARNING' ? toast.warning : n.severity === 'SUCCESS' ? toast.success : toast.info;
      fn(n.title, n.body ? { description: n.body } : undefined);
    });
    for (const e of [WsEvent.COPY_ORDER_FILLED, WsEvent.COPY_ORDER_FAILED, WsEvent.COPY_ORDER_SUBMITTED, WsEvent.MASTER_TRADE_DETECTED, WsEvent.POSITION_UPDATED]) {
      s.on(e, () => {
        void qc.invalidateQueries({ queryKey: ['master'] });
        void qc.invalidateQueries({ queryKey: ['follow'] });
        void qc.invalidateQueries({ queryKey: ['trading', 'latency'] });
      });
    }
    s.on(WsEvent.KILL_SWITCH, (p: { reason: string }) => {
      toast.error('Kill switch activated — auto-trading stopped', { description: p.reason, duration: 20_000 });
      refreshBrokers();
    });
    s.on(WsEvent.MARKET_FEED_STATUS, (st: MarketFeedStatus) => qc.setQueryData(['trading', 'feed-status'], st));

    return () => {
      s.removeAllListeners();
      s.disconnect();
    };
  }, [qc]);

  return <RealtimeContext.Provider value={{ socket, connected }}>{children}</RealtimeContext.Provider>;
}
