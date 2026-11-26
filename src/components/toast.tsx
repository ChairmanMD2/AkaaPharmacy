import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertTriangle, Info, X } from 'lucide-react';

type Kind = 'ok' | 'error' | 'info';
interface T { id: number; kind: Kind; text: string }
const Ctx = createContext<(text: string, kind?: Kind) => void>(() => {});
export const useToast = () => useContext(Ctx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<T[]>([]);
  const push = useCallback((text: string, kind: Kind = 'ok') => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, kind, text }]);
    setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 3200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-2 no-print" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className="anim-up flex items-start gap-2 rounded-xl border border-line bg-surface p-3 shadow-card">
            {t.kind === 'ok' && <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-ok" />}
            {t.kind === 'error' && <AlertTriangle size={18} className="mt-0.5 shrink-0 text-bad" />}
            {t.kind === 'info' && <Info size={18} className="mt-0.5 shrink-0 text-info" />}
            <p className="flex-1 text-sm">{t.text}</p>
            <button aria-label="Dismiss" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))} className="text-muted hover:text-fg"><X size={16} /></button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
