/** "Select all · Unselect all" for any list of checkboxes, with a live count. */
export function SelectBar({ total, selected, onAll, onNone, label = 'selected' }: {
  total: number; selected: number; onAll: () => void; onNone: () => void; label?: string;
}) {
  if (total === 0) return null;
  const all = selected >= total, none = selected === 0;
  return (
    <div className="select-bar" role="group" aria-label="Selection">
      <span className="tiny faint num">{selected} of {total} {label}</span>
      <span className="grow" />
      <button type="button" className="btn small" onClick={onAll} disabled={all}>Select all</button>
      <button type="button" className="btn small" onClick={onNone} disabled={none}>Unselect all</button>
    </div>
  );
}
