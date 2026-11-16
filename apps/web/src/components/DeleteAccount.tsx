import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib';
import { Sheet, useUi } from '../App';

type Preview = {
  id: string; name: string; transactions: number; hasOpening: boolean; recurring: number;
  otherAccounts: { name: string; n: number }[];
  confirmWith: 'pin' | 'password'; pinLength: number | null; pinBlocked: boolean;
};

/**
 * Permanently delete an account (or FD): shows exactly what goes with it, then asks for the app PIN
 * (or the login password when no PIN is set). "Hide" is offered as the safer choice.
 */
export function DeleteAccountSheet({ accountId, onClose, onDeleted, onHide }: { accountId: string; onClose: () => void; onDeleted?: () => void; onHide?: () => void }) {
  const qc = useQueryClient();
  const { toast } = useUi();
  const q = useQuery({ queryKey: ['delete-preview', accountId], queryFn: () => api<Preview>(`/api/accounts/${accountId}/delete`), gcTime: 0 });
  const [secret, setSecret] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = q.data;

  async function del() {
    if (!p || !secret) return;
    setErr(null); setBusy(true);
    try {
      await api(`/api/accounts/${accountId}/delete`, { method: 'POST', body: p.confirmWith === 'pin' ? { pin: secret } : { password: secret } });
      await qc.invalidateQueries();
      toast(`${p.name} deleted`);
      onDeleted?.();
      onClose();
    } catch (e: any) {
      setErr(e.message); setSecret('');
      if (/Too many wrong PINs/.test(e.message)) q.refetch();
    } finally { setBusy(false); }
  }

  return (
    <Sheet title={p ? `Delete ${p.name}?` : 'Delete account'} onClose={onClose}>
      {q.error ? <p className="error">{(q.error as Error).message}</p> : !p ? <div className="skeleton" /> : (
        <>
          <div className="delete-warn">
            <b>This can't be undone.</b>
            <ul>
              <li>{p.name} is removed{p.transactions > 0 ? <>, with its <b>{p.transactions}</b> transaction{p.transactions === 1 ? '' : 's'}</> : ''}{p.hasOpening ? (p.transactions ? ' and its opening balance' : ', with its opening balance') : ''}.</li>
              {p.otherAccounts.length > 0 && (
                <li>Transfers with other accounts go too, so these balances will change: {p.otherAccounts.map((o) => `${o.name} (${o.n})`).join(', ')}.</li>
              )}
              {p.recurring > 0 && <li>{p.recurring} bill{p.recurring === 1 ? '' : 's'}/recurring payment{p.recurring === 1 ? '' : 's'} using it will be deleted.</li>}
            </ul>
            {onHide && <p className="small" style={{ margin: '8px 0 0' }}>Just want it out of sight? <button className="link-btn" onClick={() => { onClose(); onHide(); }}>Hide it instead</button>; its history stays.</p>}
          </div>
          <div className="field">
            <label>{p.confirmWith === 'pin' ? 'Enter your app PIN to confirm' : p.pinBlocked ? 'Too many wrong PINs: enter your login password' : 'Enter your login password to confirm'}</label>
            <input className="input" autoFocus type="password" autoComplete={p.confirmWith === 'pin' ? 'off' : 'current-password'}
              inputMode={p.confirmWith === 'pin' ? 'numeric' : undefined} maxLength={p.confirmWith === 'pin' ? (p.pinLength ?? 6) : 200}
              value={secret} onChange={(e) => setSecret(p.confirmWith === 'pin' ? e.target.value.replace(/\D/g, '') : e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') del(); }} />
            {p.confirmWith === 'password' && !p.pinBlocked && <span className="tiny faint">No app PIN is set. Set one in Settings → Security → App PIN to use it here instead.</span>}
          </div>
          {err && <p className="error" role="alert">{err}</p>}
          <button className="btn danger block" disabled={busy || !secret || (p.confirmWith === 'pin' && secret.length < (p.pinLength ?? 4))} onClick={del}>{busy ? 'Deleting…' : 'Delete permanently'}</button>
          <button className="btn block" style={{ marginTop: 8 }} onClick={onClose}>Cancel</button>
        </>
      )}
    </Sheet>
  );
}
