// THROWAWAY UI (#166): one credits page (/wallet or /donate with ?prototype=pool-credit).
// Category credit is combined across all the donor's active donations in the current Event
// and spent on that Event's incentives in one review. Four layouts via ?variant=B|B2|B3|A2
// share one state hook (./model), so the rules are identical and picks survive a layout
// switch. Fixtures only; no auth, API, checkout or storage. Reload resets everything.
import { type ComponentType } from 'react';
import { useLocation } from 'react-router-dom';
import { VARIANTS, useCreditModel, type CreditModel, type Variant } from './model';
import { ExtraPanel, History, Navbar, Switcher } from './shared';
import VariantA2 from './VariantA2';
import VariantB from './VariantB';
import VariantB2 from './VariantB2';
import VariantB3 from './VariantB3';

const LAYOUTS: Record<Variant, ComponentType<{ m: CreditModel; preview: boolean }>> = {
  B: VariantB,
  B2: VariantB2,
  B3: VariantB3,
  A2: VariantA2,
};
const WIDTH: Record<Variant, string> = {
  B: 'max-w-6xl',
  B2: 'max-w-5xl',
  B3: 'max-w-5xl',
  A2: 'max-w-3xl',
};

export default function WalletCreditPrototype({ standalone = false }: { standalone?: boolean }) {
  const preview = import.meta.env.DEV || standalone;
  const m = useCreditModel();
  const raw = new URLSearchParams(useLocation().search).get('variant');
  const variant: Variant = VARIANTS.find((v) => v === raw) ?? 'B2';
  const Layout = LAYOUTS[variant];

  return (
    <div className={`min-h-screen overflow-x-clip ${preview ? 'pb-32' : 'pb-16'}`}>
      {preview && (
        <style>{`
        @font-face { font-family: 'Bebas Neue Pro'; src: url('${import.meta.env.BASE_URL}fonts/BebasNeuePro.otf') format('opentype'); font-weight: 800; font-style: normal; font-display: swap; }
        @font-face { font-family: 'Cabin BTRL'; src: url('${import.meta.env.BASE_URL}fonts/Cabin-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }
        @font-face { font-family: 'Barlow Condensed BTRL'; src: url('${import.meta.env.BASE_URL}fonts/BarlowCondensed-Regular.ttf') format('truetype'); font-weight: 400; font-style: normal; font-display: swap; }
        @font-face { font-family: 'Barlow Condensed BTRL'; src: url('${import.meta.env.BASE_URL}fonts/BarlowCondensed-Bold.ttf') format('truetype'); font-weight: 700; font-style: normal; font-display: swap; }
      `}</style>
      )}
      <Navbar m={m} />
      <div className={`${WIDTH[variant]} mx-auto px-4 md:px-8 pt-6`}>
        <ExtraPanel m={m} />
        {m.notice && (
          <p role="status" className="font-body text-sm text-green mb-6">
            {m.notice}
          </p>
        )}
        {/* Remounts after apply/reset so per-layout tab/editor state starts over. */}
        <Layout key={m.round} m={m} preview={preview} />
        <History m={m} />
      </div>
      {preview && <Switcher m={m} variant={variant} />}
    </div>
  );
}
