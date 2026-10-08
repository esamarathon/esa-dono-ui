// THROWAWAY (#172) variant A: one column, sections stacked top to bottom.
import { Link, useLocation } from 'react-router-dom';
import { flags, type Donation, type StaffModel } from './model';
import {
  EndedTargets,
  Facts,
  FlaggedClaims,
  Identity,
  NoPools,
  PaymentRefunds,
  PoolBlock,
  Q5Placeholder,
  categoriesWithPools,
} from './parts';
import { FlagChip, NotMoneyNote, SectionTitle, StatusActions, StatusChip } from './shared';

export default function DetailA({ m, d }: { m: StaffModel; d: Donation }) {
  const search = useLocation().search;
  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <Link to={`/admin/donations${search}`} className="font-mono text-sm text-off-white/55">
          ← donations
        </Link>
        <div className="flex flex-wrap items-center gap-3 mt-2">
          <h1 className="font-display text-4xl uppercase">donation · {d.donorName}</h1>
          <StatusChip status={d.status} />
          {flags(d).map((f) => (
            <FlagChip key={f} flag={f} />
          ))}
        </div>
      </div>

      <div className="btrl-panel p-4">
        <Identity d={d} />
      </div>

      <section>
        <Facts d={d} />
      </section>

      <section>
        <SectionTitle>Pools</SectionTitle>
        {d.pledge ? (
          <>
            <div className="mb-3">
              <NotMoneyNote />
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {categoriesWithPools(d).map((c) => (
                <PoolBlock key={c} d={d} c={c} />
              ))}
            </div>
          </>
        ) : (
          <NoPools d={d} />
        )}
      </section>

      <section>
        <SectionTitle>Payment refunds</SectionTitle>
        <PaymentRefunds d={d} />
      </section>

      <section>
        <SectionTitle>Ended targets whose totals changed</SectionTitle>
        <EndedTargets d={d} />
      </section>

      <section>
        <SectionTitle>Flagged shipped claims</SectionTitle>
        <FlaggedClaims d={d} />
      </section>

      <section>
        <SectionTitle>Actions</SectionTitle>
        <div className="space-y-3">
          <StatusActions m={m} d={d} />
          <Q5Placeholder />
        </div>
      </section>
    </div>
  );
}
