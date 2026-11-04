'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { useMasterCreateClient, useMasterLicenceQuota } from '@/lib/trading';

const EMPTY = { name: '', email: '', mobile: '', password: '', plan: '2', custom: '' };

/** Master creates a client account (client logs in on the client login page). */
export function AddClientDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (c: { id: string; name: string; email: string }) => void }) {
  const create = useMasterCreateClient();
  const quota = useMasterLicenceQuota();
  const [f, setF] = useState(EMPTY);
  useEffect(() => {
    if (open) setF(EMPTY);
  }, [open]);
  const days = f.plan === 'none' ? undefined : f.plan === 'custom' || f.plan === 'demo' ? Number(f.custom) || undefined : Number(f.plan);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if ((f.plan === 'custom' || f.plan === 'demo') && !days) return toast.error('Enter the number of days');
    const body = { name: f.name.trim(), email: f.email.trim(), mobile: f.mobile.trim() || undefined, password: f.password, licenceDays: days, demo: f.plan === 'demo' };
    create.mutate(body, {
      onSuccess: (r) => (toast.success(`Client ${body.email} created`), onOpenChange(false), onCreated?.({ id: r.id, name: body.name, email: body.email })),
      onError: (err) => toast.error(err.message),
    });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Create new client</DialogTitle>
            <DialogDescription>The client signs in on the client login page with this email and password. Share the password securely.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="nc-name">Name</Label>
            <Input id="nc-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nc-email">Email</Label>
            <Input id="nc-email" type="email" autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nc-mobile">Mobile</Label>
            <Input id="nc-mobile" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nc-pass">Password</Label>
            <Input id="nc-pass" type="password" autoComplete="new-password" minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
            <p className="text-xs text-muted-foreground">At least 10 characters with a letter and a number</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="nc-lic">Licence</Label>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <Select id="nc-lic" value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>
                <option value="2">2 Days</option>
                <option value="30">1 Month</option>
                <option value="demo">Demo — paper only (days)…</option>
                {quota.data?.customAllowed ? <option value="custom">Custom period (days)…</option> : null}
                <option value="none">No licence</option>
              </Select>
              {f.plan === 'custom' || f.plan === 'demo' ? (
                <Input aria-label="Days" className="w-24" type="number" min={1} max={3650} placeholder="Days" value={f.custom} onChange={(e) => setF({ ...f, custom: e.target.value })} />
              ) : (
                <span />
              )}
            </div>
            <p className="text-xs text-muted-foreground">Licences left: <strong>{quota.data?.remaining ?? '—'}</strong> (30 days / custom use 1 — demo and 2 days are free).</p>
            <p className="text-xs text-muted-foreground">After expiry the client cannot trade (paper or live) or connect a broker.</p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create client'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
