'use client';

import { RefreshCw, Unplug, Wallet } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import type { BrokerAccountView } from '@ctp/types';
import { AngelOneLoginDialog } from '@/components/broker-connect';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { brokerLabel, formatDateTime } from '@/lib/format';
import { useBrokerAvailability, useDisconnectBroker, useStartBrokerLogin } from '@/lib/queries';

type CardState = 'CONNECTED' | 'EXPIRED' | 'DISCONNECTED';

/** Collapses account status + token state into the three states users care about. */
export function cardState(a: BrokerAccountView): CardState {
  if (a.status === 'CONNECTED' && (a.isPaper || a.tokenStatus === 'ACTIVE')) return 'CONNECTED';
  if (a.status === 'EXPIRED' || (a.status === 'CONNECTED' && a.tokenStatus === 'EXPIRED')) return 'EXPIRED';
  return 'DISCONNECTED';
}

export function ConnectionBadge({ account }: { account: BrokerAccountView }) {
  const s = cardState(account);
  if (s === 'CONNECTED') return <Badge variant="success">🟢 Connected</Badge>;
  if (s === 'EXPIRED') return <Badge variant="warning">🟡 Token Expired</Badge>;
  return <Badge variant="destructive">🔴 Disconnected</Badge>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="text-right font-medium break-words">{children}</span>
    </div>
  );
}

/** Broker account card: broker, client ID, role, status badge, reason and Connect / Reconnect / Disconnect. */
export function BrokerAccountCard({ account: a }: { account: BrokerAccountView }) {
  const state = cardState(a);
  const disconnect = useDisconnectBroker();
  const start = useStartBrokerLogin();
  const available = useBrokerAvailability();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [angelOpen, setAngelOpen] = useState(false);
  const name = brokerLabel(a.broker);
  const role = a.mode === 'DATA_ONLY' ? 'Master · live data only' : 'Client · trading';

  const connect = () => {
    if (a.broker === 'ZERODHA') start.mutate('zerodha', { onError: (e) => toast.error(e.message) });
    else if (a.broker === 'ANGEL_ONE') {
      if (available.data?.angelOnePublisherLogin) start.mutate('angel-one', { onError: (e) => toast.error(e.message) });
      else setAngelOpen(true);
    } else {
      const slug = ({ UPSTOX: 'upstox', DHAN: 'dhan', FYERS: 'fyers', KOTAK_NEO: 'kotak-neo', FIVE_PAISA: '5paisa', ALICE_BLUE: 'alice-blue', GROWW: 'groww', MOTILAL_OSWAL: 'motilal-oswal' } as Record<string, string>)[a.broker];
      if (slug) window.location.href = `/broker-api?broker=${slug}`;
    }
  };

  return (
    <div className="rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2 font-medium">
          <Wallet className="size-4 text-muted-foreground" />
          {name}
        </span>
        <ConnectionBadge account={a} />
      </div>
      <div className="mt-2 divide-y">
        <Row label="Client ID">
          <span className="font-mono">{a.brokerClientId ?? '—'}</span>
        </Row>
        <Row label="Role">{role}</Row>
        {state === 'CONNECTED' && a.tokenExpiresAt ? <Row label="Token valid till">{formatDateTime(a.tokenExpiresAt)}</Row> : null}
        {state !== 'CONNECTED' && a.disconnectReason ? (
          <Row label="Reason">
            <span className="text-destructive">{a.disconnectReason}</span>
          </Row>
        ) : null}
        {state !== 'CONNECTED' && a.disconnectedAt ? <Row label="Since">{formatDateTime(a.disconnectedAt)}</Row> : null}
      </div>
      {a.broker !== 'MOCK' ? (
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          {state === 'CONNECTED' ? (
            <Button size="sm" variant="outline" disabled={disconnect.isPending} onClick={() => setConfirmOpen(true)}>
              <Unplug /> Disconnect
            </Button>
          ) : (
            <Button size="sm" disabled={start.isPending} onClick={connect}>
              <RefreshCw /> {state === 'EXPIRED' ? 'Reconnect' : 'Connect'}
            </Button>
          )}
        </div>
      ) : null}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disconnect {name} {a.brokerClientId}?</DialogTitle>
            <DialogDescription>
              The broker session will be logged out and its token deleted. {a.mode === 'DATA_ONLY' ? 'The live market feed will stop.' : 'Copy orders will not be placed on this account until you reconnect.'}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() =>
                disconnect.mutate(a.id, {
                  onSuccess: () => {
                    toast.success(`${name} disconnected`);
                    setConfirmOpen(false);
                  },
                  onError: (err) => toast.error(err.message),
                })
              }
            >
              {disconnect.isPending ? 'Disconnecting…' : 'Disconnect'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {a.broker === 'ANGEL_ONE' ? (
        <AngelOneLoginDialog key={a.brokerClientId ?? 'new'} open={angelOpen} onOpenChange={setAngelOpen} defaultClientCode={a.brokerClientId ?? undefined} />
      ) : null}
    </div>
  );
}
