'use client';

import { Unplug } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';
import { BrokerAccountStatus, BrokerName } from '@ctp/types';
import { EnumSelect } from '@/components/enum-select';
import { Field, FilterBar } from '@/components/filter-bar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { ReasonDialog } from '@/components/reason-dialog';
import { StatusBadge } from '@/components/status-badge';
import { TableEmpty, TableError, TableLoading } from '@/components/table-states';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { brokerLabel, formatDateTime } from '@/lib/format';
import { useAdminAction, useAdminBrokerAccounts } from '@/lib/queries';
import { useListState } from '@/lib/use-list-state';

const COLS = 9;

export default function AdminBrokersPage() {
  const list = useListState({ broker: '', status: '' });
  const q = useAdminBrokerAccounts(list.params);
  const disconnect = useAdminAction<{ reason: string }>('POST', (id) => `/admin/broker-accounts/${id}/disconnect`);
  const [target, setTarget] = useState<{ id: string; label: string } | null>(null);

  return (
    <>
      <PageHeader
        title="Broker accounts"
        description="Connections between platform users and their broker accounts. Tokens are encrypted and never displayed."
        actions={
          <Button size="sm" variant={list.filters.status === 'CONNECTED' ? 'default' : 'outline'} onClick={() => list.setFilter('status', list.filters.status === 'CONNECTED' ? '' : 'CONNECTED')}>
            {list.filters.status === 'CONNECTED' ? 'Show all' : 'Connected now'}
          </Button>
        }
      />
      <Card className="overflow-hidden">
        <FilterBar onReset={list.reset} active={list.active}>
          <Field label="Broker">
            <EnumSelect value={list.filters.broker} onChange={(v) => list.setFilter('broker', v)} options={Object.values(BrokerName).filter((b) => b !== 'ZERODHA')} labels={brokerLabel} />
          </Field>
          <Field label="Status">
            <EnumSelect value={list.filters.status} onChange={(v) => list.setFilter('status', v)} options={Object.values(BrokerAccountStatus)} />
          </Field>
        </FilterBar>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Broker</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Token</TableHead>
              <TableHead>Token expiry</TableHead>
              <TableHead>Last connected / reason</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              <TableLoading cols={COLS} />
            ) : q.error ? (
              <TableError cols={COLS} error={q.error} />
            ) : !q.data?.items.length ? (
              <TableEmpty cols={COLS} message="No broker accounts match these filters." />
            ) : (
              q.data.items.map((a) => (
                <TableRow key={a.id}>
                  <TableCell>
                    <Link href={`/admin/users/${a.userId}`} className="font-medium hover:underline">
                      {a.userName}
                    </Link>
                    <div className="text-xs text-muted-foreground">{a.userEmail}</div>
                  </TableCell>
                  <TableCell>{brokerLabel(a.broker)}</TableCell>
                  <TableCell className="font-mono text-xs">{a.brokerClientId ?? '—'}</TableCell>
                  <TableCell>
                    <StatusBadge value={a.status} />
                  </TableCell>
                  <TableCell className="text-xs">{a.mode === 'DATA_ONLY' ? 'Master (data)' : 'Client'}</TableCell>
                  <TableCell>
                    <StatusBadge value={a.tokenStatus} />
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{a.isPaper ? 'n/a (paper)' : formatDateTime(a.tokenExpiresAt)}</TableCell>
                  <TableCell className="text-muted-foreground">
                    <div className="whitespace-nowrap">{formatDateTime(a.lastConnectedAt)}</div>
                    {a.status !== 'CONNECTED' && a.disconnectReason ? <div className="max-w-56 text-xs text-destructive">{a.disconnectReason}</div> : null}
                  </TableCell>
                  <TableCell className="text-right">
                    {a.status !== 'DISCONNECTED' ? (
                      <Button size="sm" variant="outline" onClick={() => setTarget({ id: a.id, label: `${a.userName} · ${brokerLabel(a.broker)}` })}>
                        <Unplug /> Force Disconnect
                      </Button>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {q.data ? <Pagination page={list.page} pageSize={list.pageSize} total={q.data.total} onPage={list.setPage} /> : null}
      </Card>
      <ReasonDialog
        open={target !== null}
        onOpenChange={(o) => !o && setTarget(null)}
        title={`Force disconnect ${target?.label ?? ''}?`}
        description="Logs out the broker session, deletes the stored token, stops auto-trading through this account and notifies the user."
        confirmLabel="Force Disconnect"
        pending={disconnect.isPending}
        onConfirm={(reason) =>
          target &&
          disconnect.mutate(
            { id: target.id, body: { reason } },
            { onSuccess: () => (toast.success('Broker account disconnected'), setTarget(null)), onError: (e) => toast.error(e.message) },
          )
        }
      />
    </>
  );
}
