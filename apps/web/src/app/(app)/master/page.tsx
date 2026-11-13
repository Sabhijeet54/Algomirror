'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { StrategyView } from '@ctp/types';
import { FollowersCard, PaperModeNotice, StrategiesCard, StrategyDialog } from '@/components/master-desk';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { useMasterStrategies } from '@/lib/trading';

export default function MasterStrategiesPage() {
  const strategies = useMasterStrategies();
  const [edit, setEdit] = useState<{ open: boolean; s?: StrategyView | null }>({ open: false });
  const [selected, setSelected] = useState<string | null>(null);
  const list = strategies.data ?? [];
  const sel = list.find((s) => s.id === selected) ?? list[0];

  return (
    <>
      <PageHeader
        title="Strategies"
        description="Create strategies and decide which client gets which strategy."
        actions={
          <Button onClick={() => setEdit({ open: true, s: null })}>
            <Plus /> New strategy
          </Button>
        }
      />
      <PaperModeNotice />
      <div className="grid gap-4">
        <StrategiesCard list={list} loading={strategies.isLoading} selectedId={sel?.id} onSelect={setSelected} onEdit={(s) => setEdit({ open: true, s })} />
        {sel ? <FollowersCard strategy={sel} /> : null}
      </div>
      <StrategyDialog open={edit.open} strategy={edit.s} onOpenChange={(o) => setEdit((p) => ({ ...p, open: o }))} />
    </>
  );
}
