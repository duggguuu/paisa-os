import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, money, dayLabel } from '../lib';
import { Sheet, useUi } from '../App';

const SOURCE: Record<string, string> = { manual: 'Entered by you', voice: 'Voice', sms: 'From SMS', import: 'Imported', verified: 'Bank-verified', system: 'System' };
const ACTION: Record<string, string> = { create: 'Created', update: 'Edited', void: 'Deleted', restore: 'Restored' };

export function TxnDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const { openAdd, toast } = useUi();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['txn', id], queryFn: () => api<any>(`/api/txns/${id}`) });
  const t = q.data;

  async function act(path: string, method: string, msg: string) {
    setBusy(true); setErr(null);
    try {
      await api(path, { method });
      await qc.invalidateQueries();
      toast(msg);
      if (method === 'DELETE') onClose();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  const amount = t ? t.postings.filter((p: any) => p.amount > 0).reduce((s: number, p: any) => s + p.amount, 0) : 0;
  const editable = t && t.status === 'posted' && ['expense', 'income', 'transfer'].includes(t.kind);

  return (
    <Sheet title="Transaction" onClose={onClose}>
      {!t ? <div className="skeleton" style={{ width: '60%' }} /> : (
        <>
          <div className={t.status === 'void' ? 'void' : ''}>
            <div className="muted small">{dayLabel(t.date)} · {t.kind}</div>
            <div className="hero-num num">{money(amount)}</div>
            <div style={{ fontWeight: 550 }}>{t.merchant ?? t.description ?? '—'}</div>
            {t.note && <p className="muted small" style={{ margin: '6px 0 0' }}>{t.note}</p>}
          </div>
          {t.status === 'void' && <div className="banner warn" style={{ marginTop: 12 }}>Deleted. It no longer counts anywhere.</div>}

          <div className="section-title" style={{ marginTop: 18 }}>Entries</div>
          <div className="list">
            {t.postings.map((p: any, i: number) => (
              <div className="item" key={i} style={{ cursor: 'default' }}>
                <div className="grow">
                  <div className="title">{p.account_name}</div>
                  <div className="sub">{p.kind === 'category' ? (p.class === 'expense' ? 'Spending category' : 'Income category') : p.kind.replace('_', ' ')}{p.memo ? ` · ${p.memo}` : ''}</div>
                </div>
                <div className="amt num">{p.amount > 0 ? '+' : '−'}{money(Math.abs(p.amount))}</div>
              </div>
            ))}
          </div>
          <p className="tiny faint" style={{ margin: '6px 2px 0' }}>Each transaction is two or more entries that add up to zero. This is what keeps every balance exact.</p>

          <div className="section-title" style={{ marginTop: 18 }}>History</div>
          <div className="small muted">
            {t.history.map((h: any, i: number) => (
              <div key={i} className="spread" style={{ padding: '4px 2px' }}>
                <span>{ACTION[h.action] ?? h.action}{i === 0 ? ` · ${SOURCE[t.source] ?? t.source}` : ''}</span>
                <span className="faint">{new Date(h.at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
              </div>
            ))}
          </div>

          {err && <p className="error">{err}</p>}
          <div className="grid2" style={{ marginTop: 18 }}>
            {t.status === 'posted' ? (
              <>
                <button className="btn" disabled={!editable || busy} onClick={() => { onClose(); openAdd({ edit: t }); }}>
                  {editable ? 'Edit' : 'Edit (not for splits)'}
                </button>
                <button className="btn danger" disabled={busy} onClick={() => act(`/api/txns/${id}`, 'DELETE', 'Deleted. You can restore it from Activity.')}>Delete</button>
              </>
            ) : (
              <button className="btn" disabled={busy} onClick={() => act(`/api/txns/${id}/restore`, 'POST', 'Restored')}>Restore</button>
            )}
          </div>
        </>
      )}
    </Sheet>
  );
}
