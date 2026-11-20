'use client';

import { Eye, KeyRound, Layers, Pencil, Plus, Search } from 'lucide-react';
import { useState } from 'react';
import type { AdminUserListItem } from '@ctp/types';
import { AddUserDialog, EditUserDialog, LicenceDialog, LicenceQuotaDialog, UserStrategiesDialog } from '@/components/admin-user-dialogs';
import { ReasonDialog } from '@/components/reason-dialog';
import { Select } from '@/components/ui/select';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import Link from 'next/link';
import { EnumSelect } from '@/components/enum-select';
import { Field, FilterBar } from '@/components/filter-bar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { StatusBadge } from '@/components/status-badge';
import { TableEmpty, TableError, TableLoading } from '@/components/table-states';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BrokerName, Role, UserStatus } from '@ctp/types';
import { brokerLabel } from '@/lib/format';
import { useAdminAction, useAdminUsers } from '@/lib/queries';
import { useListState } from '@/lib/use-list-state';

const COLS = 10;
const fmtDay = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : 'N/A');
const ROLE_LABEL: Record<string, string> = { FOLLOWER: 'Client', MASTER: 'Master', SUB_ADMIN: 'Sub-admin', ADMIN: 'Admin' };
const LICENCE_LABEL = { NONE: 'No licence', ACTIVE: 'Active', EXPIRING: 'Expiring ≤ 7d', EXPIRED: 'Expired' } as const;
const LICENCE_TONE = { NONE: 'text-muted-foreground', ACTIVE: 'text-success', EXPIRING: 'text-warning', EXPIRED: 'text-destructive' } as const;

export default function AdminUsersPage() {
  const list = useListState({ search: '', role: '', status: '', broker: '', licence: '' });
  const q = useAdminUsers(list.params);
  const [addOpen, setAddOpen] = useState(false);
  const [editUser, setEditUser] = useState<AdminUserListItem | null>(null);
  const [licUser, setLicUser] = useState<AdminUserListItem | null>(null);
  const [quotaUser, setQuotaUser] = useState<AdminUserListItem | null>(null);
  const [stratUser, setStratUser] = useState<Pick<AdminUserListItem, 'id' | 'name' | 'email'> | null>(null);
  const [disableUser, setDisableUser] = useState<AdminUserListItem | null>(null);
  const setStatus = useAdminAction<{ status: 'ACTIVE' | 'DISABLED'; reason?: string }>('PATCH', (id) => `/admin/users/${id}/status`);
  const changeStatus = (u: AdminUserListItem, status: string) => {
    if (status === u.status) return;
    if (status === 'DISABLED') return setDisableUser(u);
    setStatus.mutate({ id: u.id, body: { status: 'ACTIVE' } }, { onSuccess: () => toast.success(`${u.name} is active again`), onError: (e) => toast.error(e.message) });
  };

  return (
    <>
      <PageHeader
        title="User management"
        description={`Every account on the platform${q.data ? ` · ${q.data.total} total` : ''}. Assign licences and decide which client gets which strategy.`}
        actions={
          <Button onClick={() => setAddOpen(true)}>
            <Plus /> Add user
          </Button>
        }
      />
      <Card className="overflow-hidden">
        <FilterBar onReset={list.reset} active={list.active}>
          <Field label="Search" className="grid w-64 gap-1.5">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-8"
                placeholder="Name, email or mobile"
                value={list.filters.search}
                onChange={(e) => list.setFilter('search', e.target.value)}
              />
            </div>
          </Field>
          <Field label="Role">
            <EnumSelect value={list.filters.role} onChange={(v) => list.setFilter('role', v)} options={Object.values(Role)} />
          </Field>
          <Field label="Status">
            <EnumSelect value={list.filters.status} onChange={(v) => list.setFilter('status', v)} options={Object.values(UserStatus)} />
          </Field>
          <Field label="Licence">
            <EnumSelect
              value={list.filters.licence}
              onChange={(v) => list.setFilter('licence', v)}
              options={['ACTIVE', 'EXPIRING', 'EXPIRED', 'NONE']}
              labels={(v) => LICENCE_LABEL[v as keyof typeof LICENCE_LABEL]}
            />
          </Field>
          <Field label="Broker">
            <EnumSelect
              value={list.filters.broker}
              onChange={(v) => list.setFilter('broker', v)}
              options={Object.values(BrokerName).filter((b) => b !== 'ZERODHA')}
              labels={brokerLabel}
            />
          </Field>
        </FilterBar>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Mobile</TableHead>
              <TableHead>Licence</TableHead>
              <TableHead>User type</TableHead>
              <TableHead>Registration date</TableHead>
              <TableHead>Licence assigned</TableHead>
              <TableHead>Licence expiry</TableHead>
              <TableHead>Strategies</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              <TableLoading cols={COLS} />
            ) : q.error ? (
              <TableError cols={COLS} error={q.error} />
            ) : !q.data?.items.length ? (
              <TableEmpty cols={COLS} message="No users match these filters." />
            ) : (
              q.data.items.map((u) => (
                <TableRow key={u.id}>
                  <TableCell>
                    <Link href={`/admin/users/${u.id}`} className="font-medium hover:underline">
                      {u.name}
                    </Link>
                    <div className="text-xs text-muted-foreground">{u.email}</div>
                    {u.brokerAccounts.length ? (
                      <div className="mt-1 flex flex-wrap gap-1">
                        {u.brokerAccounts.map((b) => (
                          <StatusBadge key={b.id} value={b.status} label={brokerLabel(b.broker)} />
                        ))}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{u.mobile ?? <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {u.licenceDays ? <div className="font-medium">{u.licenceDays} Days</div> : <div className="text-muted-foreground">N/A</div>}
                    <div className={LICENCE_TONE[u.licenceStatus]}>{LICENCE_LABEL[u.licenceStatus]}</div>
                  </TableCell>
                  <TableCell>
                    <StatusBadge value={u.role} label={ROLE_LABEL[u.role]} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{fmtDay(u.createdAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{fmtDay(u.licenceAssignedAt)}</TableCell>
                  <TableCell className={`whitespace-nowrap text-xs ${u.licenceStatus === 'EXPIRED' ? 'text-destructive' : ''}`}>{fmtDay(u.licenceExpiresAt)}</TableCell>
                  <TableCell className="text-xs">
                    {u.role !== 'FOLLOWER' ? (
                      <span className="text-muted-foreground">—</span>
                    ) : u.assignedStrategies?.length ? (
                      <div className="flex max-w-48 flex-wrap gap-1">
                        {u.assignedStrategies.map((s) => (
                          <StatusBadge key={s.id} value={s.copyStatus} label={s.name} />
                        ))}
                      </div>
                    ) : (
                      <button type="button" className="text-primary hover:underline" onClick={() => setStratUser(u)}>
                        + Assign strategy
                      </button>
                    )}
                  </TableCell>
                  <TableCell>
                    <Select
                      aria-label={`Status of ${u.name}`}
                      className={`h-8 w-28 text-xs font-semibold ${u.status === 'ACTIVE' ? 'border-emerald-600 text-emerald-700 dark:text-emerald-400' : 'border-destructive text-destructive'}`}
                      value={u.status}
                      disabled={setStatus.isPending}
                      onChange={(e) => changeStatus(u, e.target.value)}
                    >
                      <option value="ACTIVE">Active</option>
                      <option value="DISABLED">Inactive</option>
                    </Select>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button asChild size="icon" variant="ghost" className="size-8" title="View details">
                        <Link href={`/admin/users/${u.id}`} aria-label={`View ${u.name}`}>
                          <Eye />
                        </Link>
                      </Button>
                      <Button size="icon" variant="ghost" className="size-8" title="Edit user" aria-label={`Edit ${u.name}`} onClick={() => setEditUser(u)}>
                        <Pencil />
                      </Button>
                      <Button size="icon" variant="ghost" className="size-8" title="Assign licence" aria-label={`Licence for ${u.name}`} onClick={() => setLicUser(u)}>
                        <KeyRound />
                      </Button>
                      {u.role === 'MASTER' ? (
                        <Button size="sm" variant="outline" className="h-8" title="Licence limit for this master" onClick={() => setQuotaUser(u)}>
                          Limit: {u.licenceQuota ?? 0}
                        </Button>
                      ) : null}
                      {u.role === 'FOLLOWER' ? (
                        <Button size="sm" variant="outline" className="h-8" title="Assign strategies" onClick={() => setStratUser(u)}>
                          <Layers /> Strategy
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {q.data ? <Pagination page={list.page} pageSize={list.pageSize} total={q.data.total} onPage={list.setPage} /> : null}
      </Card>
      <AddUserDialog open={addOpen} onOpenChange={setAddOpen} onCreated={(u) => u.role === 'FOLLOWER' && setStratUser(u)} />
      <UserStrategiesDialog user={stratUser} onClose={() => setStratUser(null)} />
      <ReasonDialog
        open={disableUser !== null}
        onOpenChange={(o) => !o && setDisableUser(null)}
        title={`Make ${disableUser?.name ?? ''} inactive?`}
        description="The user is logged out everywhere and all of their auto-trading stops."
        confirmLabel="Make inactive"
        pending={setStatus.isPending}
        onConfirm={(reason) =>
          disableUser &&
          setStatus.mutate(
            { id: disableUser.id, body: { status: 'DISABLED', reason } },
            { onSuccess: () => (toast.success(`${disableUser.name} is inactive`), setDisableUser(null)), onError: (e) => toast.error(e.message) },
          )
        }
      />
      <EditUserDialog user={editUser} onClose={() => setEditUser(null)} />
      <LicenceDialog user={licUser} onClose={() => setLicUser(null)} />
      <LicenceQuotaDialog user={quotaUser} onClose={() => setQuotaUser(null)} />
    </>
  );
}
