'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ChecklistItem, ChecklistBoardData } from '@/lib/types';
import { Check, Circle, Clock, Plus, Trash2 } from 'lucide-react';

const STATUS_CYCLE: Record<ChecklistItem['status'], ChecklistItem['status']> = {
  todo: 'in_progress',
  in_progress: 'done',
  done: 'todo',
};

function StatusButton({ status, onClick, busy }: { status: ChecklistItem['status']; onClick: () => void; busy: boolean }) {
  const map = {
    todo: { icon: <Circle className="h-4 w-4" />, cls: 'text-muted-foreground', label: 'To do' },
    in_progress: { icon: <Clock className="h-4 w-4" />, cls: 'text-amber-500', label: 'In progress' },
    done: { icon: <Check className="h-4 w-4" />, cls: 'text-emerald-500', label: 'Done' },
  }[status];
  return (
    <button type="button" disabled={busy} onClick={onClick} title={`${map.label} — click to change`}
      className={`mt-0.5 shrink-0 ${map.cls} hover:opacity-70`}>
      {map.icon}
    </button>
  );
}

export function ManagementChecklist({
  board,
  title,
  description,
}: {
  board: string;
  title: string;
  description: string;
}) {
  const [data, setData] = useState<ChecklistBoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newSection, setNewSection] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setData(await api.billing.managementChecklist(board)); }
    catch (err: any) { toast.error(err.message || 'Failed to load'); }
    finally { setLoading(false); }
  }, [board]);

  useEffect(() => { load(); }, [load]);

  const sections = useMemo(() => {
    const map = new Map<string, ChecklistItem[]>();
    for (const it of data?.items || []) {
      if (!map.has(it.section)) map.set(it.section, []);
      map.get(it.section)!.push(it);
    }
    return Array.from(map.entries());
  }, [data]);

  async function cycleStatus(it: ChecklistItem) {
    setBusyId(it.id);
    try {
      await api.billing.updateManagementChecklistItem(board, it.id, { status: STATUS_CYCLE[it.status] });
      await load();
    } catch (err: any) { toast.error(err.message); }
    finally { setBusyId(null); }
  }

  async function saveNotes(it: ChecklistItem, notes: string) {
    if (notes === (it.notes || '')) return;
    try { await api.billing.updateManagementChecklistItem(board, it.id, { notes }); }
    catch (err: any) { toast.error(err.message); }
  }

  async function removeItem(it: ChecklistItem) {
    if (!(await confirmDialog({ title: 'Delete item', description: `Delete "${it.title}"?`, destructive: true }))) return;
    setBusyId(it.id);
    try { await api.billing.deleteManagementChecklistItem(board, it.id); await load(); }
    catch (err: any) { toast.error(err.message); }
    finally { setBusyId(null); }
  }

  async function addItem() {
    if (!newTitle.trim()) return;
    setAdding(true);
    try {
      await api.billing.addManagementChecklistItem(board, { title: newTitle.trim(), section: newSection.trim() || 'General' });
      setNewTitle(''); setNewSection('');
      await load();
    } catch (err: any) { toast.error(err.message); }
    finally { setAdding(false); }
  }

  if (loading) {
    return <div className="flex justify-center py-10"><div className="h-6 w-6 animate-spin rounded-full border-2 border-muted border-t-foreground" /></div>;
  }
  if (!data) return null;

  const s = data.summary;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {/* Progress */}
      <div className="rounded-lg border p-4">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium">{s.done}/{s.total} done · {s.inProgress} in progress</span>
          <span className="text-muted-foreground">{s.progressPct}%</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${s.progressPct}%` }} />
        </div>
      </div>

      {/* Add item */}
      <div className="flex flex-wrap items-end gap-2 rounded-lg border p-3">
        <div className="flex-1 min-w-[140px]">
          <label className="text-xs text-muted-foreground">Section</label>
          <Input value={newSection} onChange={(e) => setNewSection(e.target.value)} placeholder="General" />
        </div>
        <div className="flex-[2] min-w-[200px]">
          <label className="text-xs text-muted-foreground">New item</label>
          <Input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="Add a strategy / task…"
            onKeyDown={(e) => { if (e.key === 'Enter') addItem(); }} />
        </div>
        <Button onClick={addItem} disabled={adding || !newTitle.trim()}><Plus className="mr-1 h-4 w-4" />Add</Button>
      </div>

      {sections.length === 0 ? (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">No items yet. Add the first one above.</p>
      ) : (
        sections.map(([section, items]) => (
          <section key={section} className="rounded-lg border">
            <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
              <h3 className="text-sm font-semibold">{section}</h3>
              <span className="text-xs text-muted-foreground">{items.filter((i) => i.status === 'done').length}/{items.length}</span>
            </div>
            <ul className="divide-y">
              {items.map((it) => (
                <li key={it.id} className="flex items-start gap-3 px-4 py-3">
                  <StatusButton status={it.status} busy={busyId === it.id} onClick={() => cycleStatus(it)} />
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm ${it.status === 'done' ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{it.title}</p>
                    {it.detail && <p className="mt-0.5 text-xs text-muted-foreground">{it.detail}</p>}
                    <input
                      defaultValue={it.notes || ''}
                      placeholder="Add a note…"
                      onBlur={(e) => saveNotes(it, e.target.value)}
                      className="mt-1.5 w-full rounded border-0 bg-transparent text-xs text-muted-foreground placeholder:text-muted-foreground/50 focus:bg-muted/40 focus:px-2 focus:py-1 focus:outline-none"
                    />
                  </div>
                  <button type="button" disabled={busyId === it.id} onClick={() => removeItem(it)}
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-destructive" title="Delete">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
