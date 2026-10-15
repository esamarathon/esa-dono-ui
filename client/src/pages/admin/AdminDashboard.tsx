import { useEffect, useState } from 'react';
import adminClient from '../../api/admin';
import Card from '../../components/Card';
import LoadingSpinner from '../../components/LoadingSpinner';
import { NotMoneyNote } from '../../components/StaffAmounts';
import { fmt } from '../../utils/money';
import type { AdminStats } from '../../types';
export default function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    adminClient
      .get('/stats')
      .then((r) => setStats(r.data))
      .catch(() => setError('Failed to load stats.'));
  }, []);
  if (error) return <p role="alert">{error}</p>;
  if (!stats) return <LoadingSpinner />;
  const groups = [
    {
      title: 'Money',
      cards: [
        { label: 'total raised', value: fmt(stats.total_raised_cents), money: true },
        { label: 'donors', value: stats.donors },
        { label: 'donations', value: stats.donations },
      ],
    },
    {
      title: 'Needs attention',
      cards: [
        { label: 'Payment refunds requested', value: stats.payment_refunds?.requested ?? 0 },
        { label: 'Payment refunds failed', value: stats.payment_refunds?.failed ?? 0 },
        { label: 'pledges overdue', value: stats.pledges.overdue },
      ],
    },
    {
      title: 'Credits',
      cards: [
        { label: 'Wallet credit available', value: fmt(stats.wallet_credit_cents.available) },
        { label: 'Wallet credit held', value: fmt(stats.wallet_credit_cents.held) },
        { label: 'Pledge amount (not money)', value: fmt(stats.pledged_cents ?? 0) },
        { label: 'reward claims', value: stats.claims },
        { label: 'open pledges', value: stats.pledges.open },
      ],
    },
  ];
  return (
    <div className="space-y-6">
      <h1 className="font-display text-4xl uppercase">dashboard</h1>
      <NotMoneyNote />
      {groups.map((group) => (
        <section key={group.title}>
          <h2 className="font-display text-2xl uppercase mb-3">{group.title}</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {group.cards.map((card) => (
              <Card key={card.label} className="text-center">
                <p className="font-data text-sm text-off-white/55">{card.label}</p>
                <p
                  className={`font-display text-3xl ${'money' in card ? 'text-d-yellow' : 'text-off-white'}`}
                >
                  {card.value}
                </p>
              </Card>
            ))}
          </div>
        </section>
      ))}
      <p className="font-body text-sm">
        <a href="/admin/donations?tab=payment-refunds" className="underline">
          Open Payment refund recovery
        </a>{' '}
        also lists resolved items with unresolved failed shipping.
      </p>
      <section>
        <h2 className="font-display text-2xl uppercase mb-3">Money by Channel</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {['Channel', 'Money raised', 'Donations', 'Pledge amount (not money)'].map((h) => (
                  <th key={h} className="text-left p-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.channels?.map((c) => (
                <tr key={c.id} className="border-t border-off-white/10">
                  <th className="p-3 text-left">{c.name}</th>
                  <td className="text-d-yellow">{fmt(c.raised_cents)}</td>
                  <td>{c.donations}</td>
                  <td>{fmt(c.pledged_cents ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section>
        <h2 className="font-display text-2xl uppercase mb-3">Incentives by Channel (not money)</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                {[
                  'Channel',
                  'Rewards allocated',
                  'Polls allocated',
                  'Goals allocated',
                  'Unused poll / goal',
                  'Pool credit reward / poll / goal',
                ].map((h) => (
                  <th key={h} className="text-left p-3">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {stats.channels?.map((c) => (
                <tr key={c.id} className="border-t border-off-white/10">
                  <th className="p-3 text-left">{c.name}</th>
                  {(['reward', 'poll', 'goal'] as const).map((category) => (
                    <td key={category}>{fmt(c.allocated_cents?.[category] ?? 0)}</td>
                  ))}
                  <td>
                    {fmt(c.unused_pool_cents?.poll ?? 0)} / {fmt(c.unused_pool_cents?.goal ?? 0)}
                  </td>
                  <td>
                    {fmt(c.pool_credit_cents?.reward ?? 0)} / {fmt(c.pool_credit_cents?.poll ?? 0)}{' '}
                    / {fmt(c.pool_credit_cents?.goal ?? 0)}
                  </td>
                </tr>
              ))}
              <tr>
                <th className="text-left p-3">Shared incentives</th>
                {(['reward', 'poll', 'goal'] as const).map((category) => (
                  <td key={category}>{fmt(stats.shared?.allocated_cents[category] ?? 0)}</td>
                ))}
                <td>—</td>
                <td>—</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
