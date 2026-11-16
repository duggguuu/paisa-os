import { useRef, type ReactNode } from 'react';
import { animate, motion, useMotionValue, useTransform } from 'motion/react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib';
import { useUi } from '../App';
import { reducedMotion } from '../motion';

const TRIGGER = 88; // px of drag that commits the action

/**
 * A transaction row you can swipe: left to delete (with Undo), right to edit.
 * Taps still open the row as before; a drag never counts as a tap.
 */
export function SwipeTxn({ t, children }: { t: any; children: ReactNode }) {
  const qc = useQueryClient();
  const { toast, openAdd, openTxn } = useUi();
  const x = useMotionValue(0);
  const dragged = useRef(false);
  const delOpacity = useTransform(x, [-TRIGGER, -24, 0], [1, 0.35, 0]);
  const editOpacity = useTransform(x, [0, 24, TRIGGER], [0, 0.35, 1]);
  const delScale = useTransform(x, [-TRIGGER * 1.4, -TRIGGER, 0], [1.15, 1, 0.8]);
  const editScale = useTransform(x, [0, TRIGGER, TRIGGER * 1.4], [0.8, 1, 1.15]);
  const swipeable = t.status === 'posted' && t.kind !== 'opening' && t.kind !== 'adjustment';
  const editable = t.status === 'posted' && ['expense', 'income', 'transfer'].includes(t.kind);

  if (!swipeable) return <>{children}</>;

  async function remove() {
    try {
      await api(`/api/txns/${t.id}`, { method: 'DELETE' });
      await qc.invalidateQueries();
      toast('Deleted', { label: 'Undo', run: async () => { await api(`/api/txns/${t.id}/restore`, { method: 'POST' }); await qc.invalidateQueries(); toast('Restored'); } });
    } catch (e: any) { toast(e.message); animate(x, 0, { type: 'spring', stiffness: 500, damping: 34 }); }
  }

  async function edit() {
    animate(x, 0, { type: 'spring', stiffness: 520, damping: 30 });
    if (!editable) { openTxn(t.id); return; }
    try { openAdd({ edit: await api<any>(`/api/txns/${t.id}`) }); } catch (e: any) { toast(e.message); }
  }

  return (
    <div className="swipe-row" onClickCapture={(e) => { if (dragged.current) { e.stopPropagation(); e.preventDefault(); dragged.current = false; } }}>
      <div className="swipe-bg" aria-hidden>
        <motion.span className="swipe-edit" style={{ opacity: editOpacity, scale: editScale }}>✎ Edit</motion.span>
        <motion.span className="swipe-del" style={{ opacity: delOpacity, scale: delScale }}>Delete 🗑</motion.span>
      </div>
      <motion.div
        className="swipe-fg"
        style={{ x }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={{ left: 0.7, right: 0.55 }}
        dragTransition={{ bounceStiffness: 520, bounceDamping: 32 }}
        onDragStart={() => { dragged.current = true; }}
        onDragEnd={(_, info) => {
          const dx = info.offset.x + info.velocity.x * 0.12;
          if (dx < -TRIGGER) {
            const w = (document.querySelector('.main') as HTMLElement | null)?.clientWidth ?? 400;
            if (reducedMotion()) remove();
            else animate(x, -w, { duration: 0.22, ease: [0.4, 0, 1, 1] }).then(remove);
          } else if (dx > TRIGGER) edit();
          setTimeout(() => { dragged.current = false; }, 60);
        }}
      >
        {children}
      </motion.div>
    </div>
  );
}
