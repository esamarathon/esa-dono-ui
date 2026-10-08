// THROWAWAY UI (#172): admin staff views of pooled donations, fixtures only.
// Routes: /admin/donations (list, Q3) and /admin/donations/:id (detail, Q2) with three
// detail layouts via ?variant=A|B|C. Q1 (labelling) and Q4 (Wallet refund / Record
// chargeback with preview) appear on both. No auth, API, storage or providers.
import { type ComponentType } from 'react';
import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import DetailA from './DetailA';
import DetailB from './DetailB';
import DetailC from './DetailC';
import DonationsList from './DonationsList';
import { useStaffModel, type Donation, type StaffModel } from './model';
import { Shell, Switcher, useVariant, type Variant } from './shared';

const LAYOUTS: Record<Variant, ComponentType<{ m: StaffModel; d: Donation }>> = {
  A: DetailA,
  B: DetailB,
  C: DetailC,
};

function Detail({ m }: { m: StaffModel }) {
  const { id } = useParams();
  const variant = useVariant();
  const d = m.donations.find((x) => x.id === id);
  if (!d) return <p className="font-body">No donation {id} in the fixtures.</p>;
  const Layout = LAYOUTS[variant];
  return <Layout m={m} d={d} />;
}

export default function StaffPoolViewsPrototype() {
  const m = useStaffModel();
  return (
    <div className={m.showKinds ? 'show-number-kinds' : ''}>
      <style>{`
        .number-kind { display: none; }
        .show-number-kinds .number-kind { display: inline; }
        .show-number-kinds [data-kind] { outline: 1px dashed #efeeec66; outline-offset: 2px; }
        .show-number-kinds [data-kind="money"] { outline-color: #d09846; }
      `}</style>
      <Shell>
        <Routes>
          <Route path="/admin/donations" element={<DonationsList m={m} />} />
          <Route path="/admin/donations/:id" element={<Detail m={m} />} />
          <Route path="*" element={<Navigate to="/admin/donations" replace />} />
        </Routes>
      </Shell>
      {(import.meta.env.DEV || import.meta.env.STAFF_PROTOTYPE) && <Switcher m={m} />}
    </div>
  );
}
