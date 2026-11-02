'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import type { AdminUserDetail, AdminUserListItem } from '@ctp/types';
import { AllocationFields, type AllocState, allocFromSub, allocToInput } from '@/components/allocation-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { formatDateTime } from '@/lib/format';
import { useAdminUserMutations, useMe } from '@/lib/queries';
import {
  type LicenceHistoryItem,
  type StaffScope,
  type UserStrategyRow,
  useAdminUserStrategies,
  useAdminUserStrategyMutations,
  useLicenceHistory,
  useMasterLicenceMutations,
  useMasterLicenceQuota,
} from '@/lib/trading';
import { cn } from '@/lib/utils';
import { toastResized } from '@/lib/resize-toast';

type RoleValue = 'ADMIN' | 'SUB_ADMIN' | 'MASTER' | 'FOLLOWER';
const ROLE_LABEL: Record<RoleValue, string> = { FOLLOWER: 'Client (follower)', MASTER: 'Master trader', SUB_ADMIN: 'Sub-admin', ADMIN: 'Admin' };

function F({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Licence plans offered everywhere (Add user + Assign licence). */
export const LICENCE_PLANS = [
  { value: '2', label: '2 Days' },
  { value: '30', label: '1 Month' },
] as const;

/** Roles the signed-in staff member may assign (a sub-admin manages masters & clients only). */
function useAssignableRoles(): RoleValue[] {
  const me = useMe().data;
  return me?.role === 'ADMIN' ? ['FOLLOWER', 'MASTER', 'SUB_ADMIN', 'ADMIN'] : ['FOLLOWER', 'MASTER'];
}

function LicencePicker({ id, plan, custom, onPlan, onCustom, allowNone, allowDemo = true, allowCustom = true }: { id: string; plan: string; custom: string; onPlan: (v: string) => void; onCustom: (v: string) => void; allowNone?: boolean; allowDemo?: boolean; allowCustom?: boolean }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-end gap-2">
      <Select id={id} value={plan} onChange={(e) => onPlan(e.target.value)}>
        {LICENCE_PLANS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
        {allowCustom ? <option value="custom">Custom period (days)…</option> : null}
        {allowDemo ? <option value="demo">Demo — paper only (days)…</option> : null}
        {allowNone ? <option value="none">No licence</option> : null}
      </Select>
      {plan === 'custom' || plan === 'demo' ? (
        <Input aria-label="Days" className="w-24" type="number" min={1} max={3650} inputMode="numeric" placeholder="Days" value={custom} onChange={(e) => onCustom(e.target.value)} />
      ) : (
        <span />
      )}
    </div>
  );
}

const planDays = (plan: string, custom: string) => (plan === 'none' ? undefined : plan === 'custom' || plan === 'demo' ? Number(custom) || undefined : Number(plan));

export function AddUserDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated?: (u: AdminUserDetail) => void }) {
  const { create } = useAdminUserMutations();
  const roles = useAssignableRoles();
  const empty = { name: '', email: '', mobile: '', password: '', role: 'FOLLOWER' as RoleValue, plan: '2', custom: '' };
  const [f, setF] = useState(empty);
  useEffect(() => {
    if (open) setF(empty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    create.mutate(
      {
        name: f.name.trim(),
        email: f.email.trim(),
        mobile: f.mobile.trim() || undefined,
        password: f.password,
        role: f.role,
        licenceDays: f.role === 'FOLLOWER' || f.role === 'MASTER' ? planDays(f.plan, f.custom) : undefined,
        demo: f.role === 'FOLLOWER' && f.plan === 'demo',
      },
      {
        onSuccess: (u) => {
          toast.success(`User ${f.email} created`);
          onOpenChange(false);
          onCreated?.(u as AdminUserDetail);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add user</DialogTitle>
            <DialogDescription>The account is ready to log in immediately (email marked verified). Share the password securely.</DialogDescription>
          </DialogHeader>
          <F id="au-name" label="Name">
            <Input id="au-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />
          </F>
          <F id="au-email" label="Email">
            <Input id="au-email" type="email" autoComplete="off" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          </F>
          <div className="grid grid-cols-2 gap-3">
            <F id="au-mobile" label="Mobile">
              <Input id="au-mobile" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />
            </F>
            <F id="au-role" label="User type">
              <Select id="au-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as RoleValue })}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABEL[r]}
                  </option>
                ))}
              </Select>
            </F>
          </div>
          <F id="au-pass" label="Password" hint="At least 10 characters with a letter and a number">
            <Input id="au-pass" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required minLength={10} />
          </F>
          {f.role === 'FOLLOWER' || f.role === 'MASTER' ? (
            <F id="au-lic" label="Licence key" hint={f.role === 'MASTER' ? 'Master cannot place trades after the licence expires' : 'Auto trading stops automatically when the licence expires'}>
              <LicencePicker id="au-lic" plan={f.plan} custom={f.custom} onPlan={(v) => setF({ ...f, plan: v })} onCustom={(v) => setF({ ...f, custom: v })} allowNone allowDemo={f.role === 'FOLLOWER'} />
            </F>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create user'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function EditUserDialog({ user, onClose }: { user: AdminUserListItem | null; onClose: () => void }) {
  const { update } = useAdminUserMutations();
  const [f, setF] = useState({ name: '', mobile: '', role: 'FOLLOWER' as RoleValue });
  const assignable = useAssignableRoles();
  const roles = user && !assignable.includes(user.role as RoleValue) ? [...assignable, user.role as RoleValue] : assignable;
  useEffect(() => {
    if (user) setF({ name: user.name, mobile: user.mobile ?? '', role: user.role as RoleValue });
  }, [user]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    update.mutate(
      { id: user.id, name: f.name.trim(), mobile: f.mobile.trim() || undefined, role: f.role !== user.role ? f.role : undefined },
      { onSuccess: () => (toast.success('User updated'), onClose()), onError: (err) => toast.error(err.message) },
    );
  };
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Edit user</DialogTitle>
            <DialogDescription>{user?.email} — email cannot be changed here. Use the status menu to disable an account.</DialogDescription>
          </DialogHeader>
          <F id="eu-name" label="Name">
            <Input id="eu-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required minLength={2} />
          </F>
          <F id="eu-mobile" label="Mobile">
            <Input id="eu-mobile" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />
          </F>
          <F id="eu-role" label="User type" hint="Role change is blocked while the user has active strategies / copy trading">
            <Select id="eu-role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as RoleValue })}>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </Select>
          </F>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const KIND_LABEL: Record<LicenceHistoryItem['kind'], string> = { ASSIGNED: 'Assigned', EXTENDED: 'Extended', REVOKED: 'Revoked', CREATED: 'Given at sign-up' };

/** Licence history list (newest first). Used in the Assign licence dialog and on the client dashboard. */
export function LicenceHistoryList({ rows, loading }: { rows: LicenceHistoryItem[] | undefined; loading?: boolean }) {
  if (loading) return <p className="text-xs text-muted-foreground">Loading history…</p>;
  if (!rows?.length) return <p className="text-xs text-muted-foreground">No licence history yet.</p>;
  return (
    <ul className="grid max-h-56 gap-1.5 overflow-y-auto pr-1 text-xs">
      {rows.map((h, i) => (
        <li key={`${h.at}-${i}`} className="rounded-md border px-2.5 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className={cn('font-semibold', h.kind === 'REVOKED' && 'text-destructive')}>
              {KIND_LABEL[h.kind]}
              {h.days ? ` · ${h.days} day${h.days === 1 ? '' : 's'}` : ''}
              {h.demo ? ' · demo' : ''}
            </span>
            <span className="text-muted-foreground">{formatDateTime(h.at)}</span>
          </div>
          <div className="text-muted-foreground">
            {h.kind === 'REVOKED' ? 'Stopped immediately' : h.expiresAt ? `Valid till ${formatDateTime(h.expiresAt)}` : ''}
            {h.by ? ` · by ${h.by.name} (${h.by.role.toLowerCase().replace('_', ' ')})` : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LicenceDialog({ user, onClose, scope = 'admin' }: { user: (Pick<AdminUserListItem, 'id' | 'name' | 'mobile' | 'licenceDays' | 'licenceExpiresAt'> & { demo?: boolean; role?: string }) | null; onClose: () => void; scope?: StaffScope }) {
  const adminM = useAdminUserMutations();
  const masterM = useMasterLicenceMutations();
  const { licence, revoke } = scope === 'admin' ? adminM : masterM;
  const quota = useMasterLicenceQuota(scope === 'master');
  const [plan, setPlan] = useState('30');
  const [custom, setCustom] = useState('');
  const [extend, setExtend] = useState(true);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const history = useLicenceHistory(scope, user?.id ?? null);
  useEffect(() => {
    setConfirmRevoke(false);
    if (user) {
      if (user.demo) { setPlan('demo'); setCustom(String(user.licenceDays ?? 7)); }
      else if (user.licenceDays === 2 || user.licenceDays === 30) { setPlan(String(user.licenceDays)); setCustom(''); }
      else { setPlan('custom'); setCustom(String(user.licenceDays ?? 30)); }
      setExtend(true);
    }
  }, [user]);
  const days = planDays(plan, custom) ?? 0;
  const running = user?.licenceExpiresAt && new Date(user.licenceExpiresAt).getTime() > Date.now();
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-sm overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Assign licence</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{user?.name}</span> {user?.mobile ? `· ${user.mobile}` : ''}
            <br />
            {user?.licenceExpiresAt ? `${running ? 'Valid till' : 'Expired on'} ${formatDateTime(user.licenceExpiresAt)}` : 'No licence assigned yet.'}
          </DialogDescription>
        </DialogHeader>
        <F id="lic-plan" label="Select licence">
          <LicencePicker id="lic-plan" plan={plan} custom={custom} onPlan={setPlan} onCustom={setCustom} allowDemo={user?.role !== 'MASTER'} allowCustom={scope === 'admin' || !!quota.data?.customAllowed} />
          {scope === 'master' && quota.data ? <p className="text-xs text-muted-foreground">Licences left in your limit: <strong>{quota.data.remaining}</strong> (demo is free)</p> : null}
          {plan === 'demo' ? <p className="text-xs text-muted-foreground">Demo: the client can only paper trade — switching to live is blocked.</p> : null}
          <p className="text-xs text-muted-foreground">The licence runs till 11:59 pm IST on its last day.</p>
        </F>
        {running ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={extend} onChange={(e) => setExtend(e.target.checked)} />
            Add to the current licence (otherwise start fresh from today)
          </label>
        ) : null}
        <DialogFooter className="gap-2">
          {running ? (
            // Two clicks: a stray click on Revoke used to end the licence at once.
            <Button
              variant={confirmRevoke ? 'destructive' : 'ghost'}
              className={confirmRevoke ? undefined : 'text-destructive'}
              disabled={revoke.isPending}
              onClick={() => {
                if (!user) return;
                if (!confirmRevoke) return setConfirmRevoke(true);
                revoke.mutate(user.id, { onSuccess: () => (toast.success('Licence revoked — copy trading stopped'), onClose()), onError: (e) => toast.error(e.message) });
              }}
            >
              {confirmRevoke ? 'Yes, revoke now' : 'Revoke'}
            </Button>
          ) : null}
          <Button
            disabled={licence.isPending || !(days > 0)}
            onClick={() =>
              user &&
              licence.mutate(
                { id: user.id, days, extend, demo: plan === 'demo' },
                { onSuccess: () => (toast.success(plan === 'demo' ? `Demo (paper only) licence of ${days} day(s) assigned` : `Licence of ${days} day(s) assigned`), onClose()), onError: (e) => toast.error(e.message) },
              )
            }
          >
            {licence.isPending ? 'Saving…' : 'Assign licence'}
          </Button>
        </DialogFooter>
        {confirmRevoke ? <p className="text-xs text-destructive">Revoking ends the licence right now and stops copy trading. Click “Yes, revoke now” to confirm.</p> : null}
        <div className="grid gap-1.5 border-t pt-3">
          <p className="text-sm font-medium">Licence history</p>
          <LicenceHistoryList rows={history.data} loading={history.isLoading} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Which strategies this client gets, and with which lot multiplier / allocation. */
export function UserStrategiesDialog({ user, onClose, scope = 'admin' }: { user: Pick<AdminUserListItem, 'id' | 'name' | 'email'> | null; onClose: () => void; scope?: StaffScope }) {
  const q = useAdminUserStrategies(user?.id ?? null, scope);
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Strategies · {user?.name}</DialogTitle>
          <DialogDescription>Give each client only the strategies you want, each with its own lot multiplier. The client sees only these.</DialogDescription>
        </DialogHeader>
        {q.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {q.error ? <p className="text-sm text-destructive">{q.error.message}</p> : null}
        {q.data && q.data.length === 0 ? <p className="text-sm text-muted-foreground">No strategies exist yet — a master must create one first.</p> : null}
        <div className="grid gap-3">{user ? q.data?.map((row) => <StrategyAccessRow key={row.strategyId} userId={user.id} row={row} scope={scope} />) : null}</div>
      </DialogContent>
    </Dialog>
  );
}

function StrategyAccessRow({ userId, row, scope = 'admin' }: { userId: string; row: UserStrategyRow; scope?: StaffScope }) {
  const { assign, remove } = useAdminUserStrategyMutations(userId, scope);
  const [open, setOpen] = useState(false);
  const [alloc, setAlloc] = useState<AllocState>(allocFromSub(row.subscription));
  const [startCopy, setStartCopy] = useState(false);
  useEffect(() => setAlloc(allocFromSub(row.subscription)), [row.subscription]);
  const save = () => {
    const body = allocToInput(alloc);
    if (typeof body === 'string') return void toast.error(body);
    assign.mutate(
      { strategyId: row.strategyId, body: { ...body, startCopy: startCopy || row.subscription?.copyStatus === 'ON' } },
      {
        onSuccess: (r) => {
          if (r.warning) toast.warning(r.warning);
          else toast.success(`${row.name} ${row.assigned ? 'updated' : 'assigned'}`);
          toastResized(r.resized);
          setOpen(false);
        },
        onError: (e) => toast.error(e.message),
      },
    );
  };
  return (
    <div className={cn('rounded-lg border p-3', row.assigned && 'border-primary/40 bg-primary/5')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">
            {row.name} <span className="text-xs font-normal text-muted-foreground">by {row.masterName}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            {row.assigned && row.subscription ? (
              <>
                Assigned · {row.subscription.allocation} · copy {row.subscription.copyStatus}
              </>
            ) : (
              'Not assigned'
            )}
            {row.status !== 'ACTIVE' ? ` · strategy ${row.status.toLowerCase()}` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          {row.assigned ? (
            <>
              <Button size="sm" variant="outline" onClick={() => setOpen((o) => !o)}>
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate(row.strategyId, { onSuccess: () => toast.success(`${row.name} removed`), onError: (e) => toast.error(e.message) })}
              >
                Remove
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setOpen((o) => !o)}>
              Assign
            </Button>
          )}
        </div>
      </div>
      {open ? (
        <div className="mt-3 grid gap-3 border-t pt-3">
          <AllocationFields id={`as-${row.strategyId}`} value={alloc} onChange={setAlloc} compact />
          {row.subscription?.copyStatus !== 'ON' ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="size-4" checked={startCopy} onChange={(e) => setStartCopy(e.target.checked)} />
              Start copying now (only if the client&apos;s broker is connected)
            </label>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={assign.isPending} onClick={save}>
              {assign.isPending ? 'Saving…' : row.assigned ? 'Save' : 'Assign strategy'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Admin: a master's licence limit (licences the master can give clients) and custom-period permission. */
export function LicenceQuotaDialog({ user, onClose }: { user: Pick<AdminUserListItem, 'id' | 'name' | 'licenceQuota' | 'licenceCustomAllowed'> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [delta, setDelta] = useState('');
  const [custom, setCustom] = useState(false);
  useEffect(() => {
    if (user) {
      setDelta('');
      setCustom(!!user.licenceCustomAllowed);
    }
  }, [user]);
  const save = useMutation({
    mutationFn: (body: { delta?: number; customAllowed?: boolean }) => api<{ remaining: number; customAllowed: boolean }>(`/admin/users/${user!.id}/licence-quota`, { method: 'POST', body }),
    onSuccess: (r) => (void qc.invalidateQueries({ queryKey: ['admin'] }), toast.success(`Licence limit: ${r.remaining} left`), onClose()),
    onError: (e) => toast.error(e.message),
  });
  const n = Number(delta) || 0;
  const now = user?.licenceQuota ?? 0;
  return (
    <Dialog open={!!user} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Licence limit · {user?.name}</DialogTitle>
          <DialogDescription>
            Licences this master can give to clients. Each 2-day / 30-day / custom licence uses 1 (demo is free). Now: <strong>{now}</strong> left.
          </DialogDescription>
        </DialogHeader>
        <F id="lq-delta" label="Add (+) or remove (−) licences" hint={n ? `New limit: ${Math.max(0, now + n)}` : 'e.g. 10 or -5'}>
          <Input id="lq-delta" type="number" inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} placeholder="0" />
        </F>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={custom} onChange={(e) => setCustom(e.target.checked)} />
          Allow custom licence period (otherwise only Demo / 2 Days / 30 Days)
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate({ delta: n || undefined, customAllowed: custom })}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
