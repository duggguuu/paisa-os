import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icons';
import { AppearanceButtons, ThemeList, ModeSeg } from '../components/Appearance';
import { useUi } from '../App';

const ITEMS: [string, string, string, string][] = [
  ['/stuff', 'wallet', 'Stuff', 'What you own, want and asked about; log buys and sales'],
  ['/salary', 'wallet', 'Salary & tax', 'Payslip, monthly credit, New Regime tax simulator'],
  ['/debts', 'users', 'Owe & owed', 'Owed to me, I owe, lent, loans & EMIs'],
  ['/fds', 'wallet', 'Fixed deposits', 'FDs by bank, maturity dates and interest'],
  ['/goals', 'target', 'Goals', 'Savings goals and finish dates'],
  ['/budgets', 'pie', 'Budget Planner', 'Budgets, overview and health score'],
  ['/recurring', 'repeat', 'Bills & recurring', 'Rent, SIPs, subscriptions, salary'],
  ['/copilot', 'sparkle', 'AI Copilot', 'Ask anything about your money'],
  ['/insights', 'spark', 'Insights', 'Patterns and reminders'],
  ['/import', 'upload', 'Import', 'Bank statements and mutual funds (CAS)'],
  ['/splitwise', 'users', 'Splitwise', 'Shared expenses'],
  ['/mandates', 'repeat', 'Mandates & subscriptions', 'Auto-debits, renewals and their reminders'],
  ['/categories', 'pie', 'Categories', 'Add and edit expense & income categories'],
  ['/settings', 'settings', 'Settings', 'Face ID, Zerodha, sample data, export'],
];

export function More() {
  const { book } = useUi();
  const [themes, setThemes] = useState(false);
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">More</h1>
        <AppearanceButtons onPalette={() => setThemes((t) => !t)} />
      </div>
      {themes && (
        <div className="card" style={{ marginBottom: 14 }}>
          <ModeSeg />
          <ThemeList />
        </div>
      )}
      <div className="list">
        {ITEMS.map(([to, icon, title, sub]) => (
          <Link key={to} to={to} className="item">
            <span className="menu-ico"><Icon name={icon} /></span>
            <div className="grow"><div className="title">{title}</div><div className="sub">{sub}</div></div>
            <span className="faint"><Icon name="chevron" /></span>
          </Link>
        ))}
      </div>
      <p className="tiny faint" style={{ textAlign: 'center', marginTop: 16 }}>{book === 'demo' ? 'Viewing sample data' : 'Your private ledger'} · Paisa OS</p>
    </>
  );
}
