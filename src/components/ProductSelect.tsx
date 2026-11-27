import { useEffect, useMemo, useState } from 'react';
import type { Drug } from '../lib/types';
import { Input } from './ui';

/** Type-ahead product picker over the local (offline) catalogue. */
export function ProductSelect({ drugs, value, onPick, placeholder = 'Search product…' }: { drugs: Drug[]; value: Drug | null; onPick: (d: Drug | null) => void; placeholder?: string }) {
  const [q, setQ] = useState(value?.name ?? '');
  const [open, setOpen] = useState(false);
  useEffect(() => { if (value) setQ(value.name); }, [value?.id]);   // show the chosen product, also when it is set from outside
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!open || !s) return [];
    return drugs.filter((d) => d.is_active && (d.name.toLowerCase().includes(s) || d.generic_name?.toLowerCase().includes(s) || d.barcode === q.trim())).slice(0, 8);
  }, [drugs, q, open]);
  return (
    <div className="relative">
      <Input value={q} placeholder={placeholder} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); if (value) onPick(null); }} />
      {hits.length > 0 && (
        <ul className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-line bg-surface shadow-lift">
          {hits.map((d) => <li key={d.id}><button type="button" className="flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-surface2" onMouseDown={() => { onPick(d); setQ(d.name); setOpen(false); }}><span>{d.name}</span><span className="text-xs text-muted">{d.unit_type}</span></button></li>)}
        </ul>
      )}
    </div>
  );
}
