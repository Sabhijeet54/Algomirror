'use client';

import { Check, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AllocationFields, type AllocState, allocToInput, defaultAlloc } from '@/components/allocation-fields';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { type DirectoryClient, useAssignClient, useClientDirectory } from '@/lib/trading';
import { cn } from '@/lib/utils';
import { toastResized } from '@/lib/resize-toast';

/**
 * Assign a client to a strategy: pick the client from a searchable list (no typing emails), set the lot
 * multiplier, optionally start copying. Used by the admin Strategies page and the master Strategies page.
 */
export function AssignClientDialog({
  strategy,
  scope,
  open,
  onOpenChange,
}: {
  strategy: { id: string; name: string } | null;
  scope: 'master' | 'admin';
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const assign = useAssignClient(strategy?.id ?? '', scope);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<DirectoryClient | null>(null);
  const [alloc, setAlloc] = useState<AllocState>(defaultAlloc());
  const [startCopy, setStartCopy] = useState(true);
  const dir = useClientDirectory(scope, search, strategy?.id ?? null, open && !!strategy);
  useEffect(() => {
    if (!open) return;
    setSearch('');
    setPicked(null);
    setAlloc(defaultAlloc());
    setStartCopy(true);
  }, [open]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!strategy) return;
    if (!picked) return void toast.error('Select a client');
    const body = allocToInput(alloc);
    if (typeof body === 'string') return void toast.error(body);
    assign.mutate(
      { ...body, email: picked.email, startCopy },
      {
        onSuccess: (r) => {
          if (r.warning) toast.warning(r.warning);
          else toast.success(`${picked.name} → ${strategy.name}`);
          toastResized(r.resized);
          onOpenChange(false);
        },
        onError: (err) => toast.error(err.message),
      },
    );
  };

  const list = dir.data ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Assign client · {strategy?.name}</DialogTitle>
            <DialogDescription>Pick a client — only assigned clients can see and copy this strategy.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="ac-search">Client</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input id="ac-search" className="pl-8" placeholder="Search name, email or mobile" autoComplete="off" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="max-h-56 overflow-y-auto rounded-md border" role="listbox" aria-label="Clients">
              {list.length === 0 ? (
                <p className="p-3 text-sm text-muted-foreground">{dir.isLoading ? 'Loading…' : 'No clients found'}</p>
              ) : (
                list.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={picked?.id === c.id}
                    onClick={() => setPicked(c)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-muted',
                      picked?.id === c.id && 'bg-primary/10',
                    )}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {c.email}
                        {c.mobile ? ` · ${c.mobile}` : ''}
                      </span>
                    </span>
                    {picked?.id === c.id ? (
                      <Check className="size-4 shrink-0 text-primary" />
                    ) : c.assigned ? (
                      <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">Assigned</span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
            {picked?.assigned ? <p className="text-xs text-muted-foreground">Already assigned — saving updates the lot multiplier.</p> : null}
          </div>
          <AllocationFields id="ac" value={alloc} onChange={setAlloc} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4" checked={startCopy} onChange={(e) => setStartCopy(e.target.checked)} />
            Start auto-trading now (only if the client&apos;s broker is connected)
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={assign.isPending || !picked}>
              {assign.isPending ? 'Assigning…' : 'Assign client'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
