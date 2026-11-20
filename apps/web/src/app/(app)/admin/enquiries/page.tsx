'use client';

import { useState } from 'react';
import { Download, Mail, Phone } from 'lucide-react';
import { toast } from 'sonner';
import type { EnquiryView } from '@ctp/types';
import { Field, FilterBar } from '@/components/filter-bar';
import { PageHeader } from '@/components/page-header';
import { Pagination } from '@/components/pagination';
import { TableEmpty, TableError, TableLoading } from '@/components/table-states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useAdminAction, useAdminEnquiries } from '@/lib/queries';
import { istDayEndExclusive, istDayStart, useListState } from '@/lib/use-list-state';
import { cn } from '@/lib/utils';

type Kind = 'CLIENT' | 'PARTNER';
type Status = EnquiryView['status'];

const LABELS: Record<string, string> = {
  TRADING_PLAN: 'Automated trading plan',
  MULTI_ACCOUNT: 'Multi-account execution',
  COPY_TRADING: 'Trading account',
  ALGO_AUTOMATION: 'Algo automation',
  TRADINGVIEW_AUTOMATION: 'TradingView automation',
  STRATEGY_SUBSCRIPTION: 'Strategy plans and pricing',
  DEMO: 'Free demo',
  OTHER: 'Other',
  WHITE_LABEL: 'White label solution',
  CUSTOM_DEVELOPMENT: 'Custom development',
  BROKER: 'Broker',
  SUB_BROKER_AP: 'Sub-broker / AP',
  ADVISOR_RA: 'Advisor / RA',
  FINTECH: 'Fintech',
  TRADER_EDUCATOR: 'Trader / educator',
  UNDER_50: 'Under 50 clients',
  '50_500': '50–500 clients',
  '500_5000': '500–5,000 clients',
  OVER_5000: '5,000+ clients',
  ALGO_STRATEGY: 'Algo strategies',
  TRADINGVIEW_WEBHOOK: 'TradingView webhook',
  OPTION_CHAIN_TOOLS: 'Option chain tools',
  BACKTESTING: 'Backtesting',
  BROKER_INTEGRATION: 'Broker integration',
  MOBILE_APP: 'Mobile app',
  ADMIN_CRM: 'Admin / CRM',
  PAYMENTS_BILLING: 'Payments & billing',
  RISK_MANAGEMENT: 'Risk management',
};
const label = (v: string | undefined | null) => (v ? (LABELS[v] ?? v) : '');

const INTERESTS: Record<Kind, string[]> = {
  CLIENT: ['TRADING_PLAN', 'ALGO_AUTOMATION', 'TRADINGVIEW_AUTOMATION', 'STRATEGY_SUBSCRIPTION', 'DEMO', 'OTHER'],
  PARTNER: ['WHITE_LABEL', 'CUSTOM_DEVELOPMENT'],
};
const STATUS_TONE: Record<Status, 'warning' | 'default' | 'secondary'> = { NEW: 'warning', CONTACTED: 'default', CLOSED: 'secondary' };
const STATUS_LABEL: Record<Status, string> = { NEW: 'New', CONTACTED: 'Contacted', CLOSED: 'Closed' };

const COLS = 7;

function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function AdminEnquiriesPage() {
  const [kind, setKind] = useState<Kind>('CLIENT');
  const list = useListState({ q: '', status: '', interest: '', from: '', to: '' }, 25);
  const { from, to, ...rest } = list.params as Record<string, string | number>;
  const params = { ...rest, kind, from: istDayStart(String(from ?? '')), to: istDayEndExclusive(String(to ?? '')) };
  const q = useAdminEnquiries(params);
  const [open, setOpen] = useState<EnquiryView | null>(null);
  const [exporting, setExporting] = useState(false);

  const switchKind = (k: Kind) => {
    setKind(k);
    list.reset();
  };

  async function exportCsv() {
    setExporting(true);
    try {
      const all: EnquiryView[] = [];
      for (let page = 1; page <= 50; page++) {
        const r = await api<{ items: EnquiryView[]; total: number }>('/admin/enquiries', { query: { ...params, page, pageSize: 100 } });
        all.push(...r.items);
        if (all.length >= r.total || !r.items.length) break;
      }
      const head = ['Received', 'Status', 'Name', 'Email', 'Phone', 'Company', 'City', 'Interest', 'Partner type', 'Clients', 'Modules', 'Message', 'Note'];
      const rows = all.map((e) =>
        [
          formatDateTime(e.createdAt),
          STATUS_LABEL[e.status],
          e.name,
          e.email,
          e.phone,
          e.company,
          e.city,
          label(e.interest),
          label(e.details?.partnerType),
          label(e.details?.clients),
          (e.details?.modules ?? []).map(label).join('; '),
          e.message,
          e.note,
        ]
          .map(csvCell)
          .join(','),
      );
      const blob = new Blob([[head.join(','), ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${kind === 'CLIENT' ? 'client-enquiries' : 'partner-requests'}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  const counts = q.data?.counts;

  return (
    <>
      <PageHeader
        title="Website enquiries"
        description="Forms sent from sanchaytechnologies.com. Client enquiries and partner requests are kept apart."
        actions={
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting || !q.data?.total}>
            <Download /> {exporting ? 'Exporting…' : 'Download CSV'}
          </Button>
        }
      />

      <div className="mb-4 inline-flex rounded-lg border bg-card p-1" role="tablist">
        {(['CLIENT', 'PARTNER'] as const).map((k) => (
          <button
            key={k}
            role="tab"
            aria-selected={kind === k}
            onClick={() => switchKind(k)}
            className={cn(
              'flex items-center gap-2 rounded-md px-4 py-1.5 text-sm font-medium transition-colors',
              kind === k ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {k === 'CLIENT' ? 'Client enquiries' : 'Partner requests'}
            {counts?.[k] ? (
              <span className={cn('rounded-full px-1.5 text-[11px] tabular-nums', kind === k ? 'bg-primary-foreground/20' : 'bg-warning/20 text-foreground')}>{counts[k]} new</span>
            ) : null}
          </button>
        ))}
      </div>

      <Card className="overflow-hidden">
        <FilterBar onReset={list.reset} active={list.active}>
          <Field label="Search" className="grid w-60 gap-1.5">
            <Input placeholder="Name, email, phone, company, city" value={list.filters.q} onChange={(e) => list.setFilter('q', e.target.value)} />
          </Field>
          <Field label="Status">
            <Select value={list.filters.status} onChange={(e) => list.setFilter('status', e.target.value)}>
              <option value="">All</option>
              <option value="NEW">New</option>
              <option value="CONTACTED">Contacted</option>
              <option value="CLOSED">Closed</option>
            </Select>
          </Field>
          <Field label={kind === 'CLIENT' ? 'Looking for' : 'Partnership'} className="grid w-52 gap-1.5">
            <Select value={list.filters.interest} onChange={(e) => list.setFilter('interest', e.target.value)}>
              <option value="">All</option>
              {INTERESTS[kind].map((i) => (
                <option key={i} value={i}>
                  {label(i)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From">
            <Input type="date" value={list.filters.from} onChange={(e) => list.setFilter('from', e.target.value)} />
          </Field>
          <Field label="To">
            <Input type="date" value={list.filters.to} onChange={(e) => list.setFilter('to', e.target.value)} />
          </Field>
        </FilterBar>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Received</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Contact</TableHead>
              <TableHead>{kind === 'CLIENT' ? 'Company / city' : 'Business'}</TableHead>
              <TableHead>{kind === 'CLIENT' ? 'Looking for' : 'Partnership'}</TableHead>
              <TableHead>Message</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.isLoading ? (
              <TableLoading cols={COLS} />
            ) : q.error ? (
              <TableError cols={COLS} error={q.error} />
            ) : !q.data?.items.length ? (
              <TableEmpty cols={COLS} message={list.active ? 'Nothing matches these filters.' : kind === 'CLIENT' ? 'No client enquiries yet.' : 'No partner requests yet.'} />
            ) : (
              q.data.items.map((e) => (
                <TableRow key={e.id} className="cursor-pointer align-top" onClick={() => setOpen(e)}>
                  <TableCell className="whitespace-nowrap text-muted-foreground">{formatDateTime(e.createdAt)}</TableCell>
                  <TableCell className="font-medium">{e.name}</TableCell>
                  <TableCell className="text-sm">
                    <div>{e.email}</div>
                    <div className="font-mono text-xs text-muted-foreground">{e.phone}</div>
                  </TableCell>
                  <TableCell className="text-sm">
                    {e.company ?? <span className="text-muted-foreground">—</span>}
                    {kind === 'PARTNER' && e.details?.partnerType ? <div className="text-xs text-muted-foreground">{label(e.details.partnerType)}</div> : null}
                    {e.city ? <div className="text-xs text-muted-foreground">{e.city}</div> : null}
                  </TableCell>
                  <TableCell className="text-sm">
                    {label(e.interest)}
                    {e.details?.clients ? <div className="text-xs text-muted-foreground">{label(e.details.clients)}</div> : null}
                    {e.details?.modules?.length ? <div className="text-xs text-muted-foreground">{e.details.modules.length} modules</div> : null}
                  </TableCell>
                  <TableCell className="max-w-xs text-sm text-muted-foreground">
                    <span className="line-clamp-2">{e.message ?? '—'}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_TONE[e.status]}>{STATUS_LABEL[e.status]}</Badge>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {q.data ? <Pagination page={list.page} pageSize={list.pageSize} total={q.data.total} onPage={list.setPage} /> : null}
      </Card>

      <EnquiryDialog enquiry={open} onClose={() => setOpen(null)} />
    </>
  );
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-3 border-b py-2 text-sm last:border-0">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function EnquiryDialog({ enquiry, onClose }: { enquiry: EnquiryView | null; onClose: () => void }) {
  const save = useAdminAction<{ status?: Status; note?: string }, EnquiryView>('PATCH', (id) => `/admin/enquiries/${id}`);
  const [status, setStatus] = useState<Status>('NEW');
  const [note, setNote] = useState('');
  const [forId, setForId] = useState<string | null>(null);
  if (enquiry && forId !== enquiry.id) {
    setForId(enquiry.id);
    setStatus(enquiry.status);
    setNote(enquiry.note ?? '');
  }
  const e = enquiry;

  return (
    <Dialog open={Boolean(e)} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {e ? (
          <>
            <DialogHeader>
              <DialogTitle>{e.name}</DialogTitle>
              <DialogDescription>
                {e.kind === 'CLIENT' ? 'Client enquiry' : 'Partner request'} · {formatDateTime(e.createdAt)}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline" size="sm">
                <a href={`tel:${e.phone}`}>
                  <Phone /> {e.phone}
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={`mailto:${e.email}`}>
                  <Mail /> {e.email}
                </a>
              </Button>
              <Button asChild variant="outline" size="sm">
                <a href={`https://wa.me/${e.phone.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1')}`} target="_blank" rel="noreferrer">
                  WhatsApp
                </a>
              </Button>
            </div>
            <dl>
              <Row k={e.kind === 'CLIENT' ? 'Looking for' : 'Partnership'}>{label(e.interest)}</Row>
              {e.details?.partnerType ? <Row k="Business type">{label(e.details.partnerType)}</Row> : null}
              {e.details?.clients ? <Row k="Client base">{label(e.details.clients)}</Row> : null}
              {e.details?.modules?.length ? <Row k="Needs">{e.details.modules.map(label).join(', ')}</Row> : null}
              <Row k="Company">{e.company ?? '—'}</Row>
              <Row k="City">{e.city ?? '—'}</Row>
              <Row k="Message">
                <span className="whitespace-pre-wrap">{e.message ?? '—'}</span>
              </Row>
              <Row k="Sent from">
                <span className="text-xs text-muted-foreground">
                  {e.page ?? 'website'}
                  {e.ip ? ` · ${e.ip}` : ''}
                </span>
              </Row>
            </dl>
            <div className="grid gap-3">
              <Field label="Status" className="grid gap-1.5">
                <Select value={status} onChange={(ev) => setStatus(ev.target.value as Status)}>
                  <option value="NEW">New</option>
                  <option value="CONTACTED">Contacted</option>
                  <option value="CLOSED">Closed</option>
                </Select>
              </Field>
              <Field label="Your note (only admins see this)" className="grid gap-1.5">
                <Textarea rows={3} maxLength={1000} value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="Called on 20 Nov, wants a demo next week" />
              </Field>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={onClose}>
                Close
              </Button>
              <Button
                disabled={save.isPending}
                onClick={() =>
                  save.mutate(
                    { id: e.id, body: { status, note } },
                    {
                      onSuccess: () => {
                        toast.success('Saved');
                        onClose();
                      },
                      onError: (err) => toast.error(err.message),
                    },
                  )
                }
              >
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
