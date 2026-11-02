'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { brokerLabel, humanize } from '@/lib/format';
import { useMyBrokerAccounts } from '@/lib/queries';
import { toastResized } from '@/lib/resize-toast';
import { type FollowInput, type StrategyWithSub, useFollow, useToggleCopy } from '@/lib/trading';

const PRESETS = ['1', '2', '3', '5'];
const num = (v: string | number | null | undefined) => (v == null || v === '' ? undefined : Number(v));

/**
 * Client settings for one assigned strategy — kept simple: broker account + lot multiplier only.
 * Limits set by the admin (max loss / day etc.) are kept unchanged when the client saves.
 */
export function FollowDialog({ s, onClose }: { s: StrategyWithSub | null; onClose: () => void }) {
  const accounts = useMyBrokerAccounts();
  const follow = useFollow();
  const toggle = useToggleCopy();
  const [brokerAccountId, setBrokerAccountId] = useState('');
  const [mult, setMult] = useState('1');
  // Fill the form ONCE when the dialog opens (not on every background refetch — that used to reset the
  // multiplier the client had just picked back to the old value before Save).
  useEffect(() => {
    if (!s) return;
    const sub = s.subscription;
    setMult(sub?.allocationMode === 'CAPITAL_PERCENTAGE' && sub.allocationPercent ? String(+(Number(sub.allocationPercent) / 100).toFixed(2)) : sub?.fixedLots ? String(sub.fixedLots) : '1');
    setBrokerAccountId(sub?.brokerAccountId ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s?.id]);
  // Pick a broker account when none is set yet (accounts may load after the dialog opens).
  useEffect(() => {
    if (!s || brokerAccountId) return;
    const firstConnected = accounts.data?.find((a) => a.status === 'CONNECTED' && a.broker !== 'MOCK' && a.mode !== 'DATA_ONLY') ?? accounts.data?.[0];
    if (firstConnected) setBrokerAccountId(firstConnected.id);
  }, [s, accounts.data, brokerAccountId]);

  const m = Number(mult);
  const valid = m > 0 && m < 10;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    if (!s || !valid) return void toast.error('Lot multiplier must be between 0.01 and 9.99');
    const sub = s.subscription;
    const body: FollowInput = {
      // No demat → server uses the internal paper account (paper trading).
      ...(brokerAccountId ? { brokerAccountId } : {}),
      applyToOpenTrades: false,
      allocationMode: 'CAPITAL_PERCENTAGE',
      allocationPercent: Math.round(m * 10000) / 100,
      // keep the limits the admin set
      maxQuantity: num(sub?.maxQuantity),
      maxTradeValue: num(sub?.maxTradeValue),
      maxLots: num(sub?.maxLots),
      maxDailyLoss: num(sub?.maxDailyLoss),
      maxTradesPerDay: num(sub?.maxTradesPerDay),
      allowedSegments: (sub?.allowedSegments ?? []) as ('EQ' | 'FO')[],
    };
    follow.mutate(
      { strategyId: s.id, body },
      {
        onSuccess: (r) => {
          const isNew = !s.subscription;
          toast.success(isNew ? `Connected to ${s.name} — ${m}× lots` : `Saved — ${m}× lots`);
          // New connection from the marketplace: start right away (paper needs no demat).
          if (isNew)
            toggle.mutate(
              { id: r.id, action: 'start' },
              { onError: (e) => toast.warning(`Connected, auto trading not started: ${e.message}. Press Start in My strategies.`) },
            );
          toastResized(r.resized);
          if (!isNew) toast.info('Trade book & P&L now shown at the new lot size (website only).');
          onClose();
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  return (
    <Dialog open={!!s} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{s?.subscription ? s?.name : `Connect ${s?.name ?? ''}`}</DialogTitle>
          <DialogDescription>How many lots to trade for every strategy trade. Auto trading starts only when you press Start.</DialogDescription>
        </DialogHeader>
        {(
          <form className="grid gap-4" onSubmit={save}>
            {accounts.data && accounts.data.length === 0 ? (
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                No demat connected — trades run in <strong className="text-foreground">Paper</strong> mode (simulated). Connect your broker on the{' '}
                <Link className="underline" href="/broker">
                  Broker connection
                </Link>{' '}
                page only when you want LIVE orders.
              </p>
            ) : null}
            {(accounts.data?.length ?? 0) > 1 ? (
              <div className="grid gap-1.5">
                <Label htmlFor="fd-acc">Broker account</Label>
                <Select id="fd-acc" value={brokerAccountId} onChange={(e) => setBrokerAccountId(e.target.value)} required>
                  {accounts.data?.map((a) => (
                    <option key={a.id} value={a.id}>
                      {brokerLabel(a.broker)} {a.brokerClientId ?? ''} — {humanize(a.status)}
                    </option>
                  ))}
                </Select>
              </div>
            ) : null}
            <div className="grid gap-2">
              <Label htmlFor="fd-mult">Lot multiplier</Label>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <Button key={p} type="button" size="sm" variant={mult === p ? 'default' : 'outline'} onClick={() => setMult(p)}>
                    {p}×
                  </Button>
                ))}
                <Input id="fd-mult" className="w-24" type="number" min={0.01} max={9.99} step="any" inputMode="decimal" value={mult} onChange={(e) => setMult(e.target.value)} required />
              </div>
              <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                {valid ? (
                  <>
                    Master 1 lot → you <strong className="text-foreground">{Math.floor(m)} lot{Math.floor(m) === 1 ? '' : 's'}</strong> · master 2 lots → you{' '}
                    <strong className="text-foreground">{Math.floor(2 * m)} lots</strong> (rounded down to whole lots).
                  </>
                ) : (
                  'Enter a multiplier between 0.01 and 9.99'
                )}
              </p>
            </div>
            <p className="rounded-md border border-primary/20 bg-accent px-3 py-2 text-xs text-accent-foreground">
              Today&apos;s trades (open and closed) are re-shown at the new lot size on this website (Trade book, P&amp;L). No extra order is sent to
              your broker / demat for them.
            </p>
            <DialogFooter>
              <Button type="submit" disabled={follow.isPending || !valid}>
                {follow.isPending ? 'Saving…' : s?.subscription ? 'Save' : 'Connect'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
