// THROWAWAY UI (#166): one credits page (/wallet or /donate with ?prototype=pool-credit).
// Category credit is combined across all the donor's active donations in the current Event
// and spent on that Event's incentives in one review. Four layouts via ?variant=A|B|C|D share
// one state hook (./model), so the rules are identical and picks survive a layout switch.
// Fixtures only; no auth, API, checkout or storage. Reload resets everything.
import { useLocation } from 'react-router-dom';
import { VARIANTS, useCreditModel, type Variant } from './model';
import { DemoState, ExtraPanel, History, Navbar, Switcher } from './shared';
import VariantA from './VariantA';
import VariantB from './VariantB';
import VariantC from './VariantC';
import VariantD from './VariantD';

const LAYOUTS = { A: VariantA, B: VariantB, C: VariantC, D: VariantD };

export default function WalletCreditPrototype({ standalone = false }: { standalone?: boolean }) {
  const preview = import.meta.env.DEV || standalone;
  const m = useCreditModel();
  const raw = new URLSearchParams(useLocation().search).get('variant');
  const variant: Variant = VARIANTS.find((v) => v === raw) ?? 'A';
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
      <div
        className={`${variant === 'B' || variant === 'D' ? 'max-w-6xl' : 'max-w-5xl'} mx-auto px-4 md:px-8 pt-6`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 mb-6 font-mono text-xs text-d-yellow">
          <p>THROWAWAY · FIXTURES ONLY · NO PAYMENT OR STORAGE</p>
          <button className="btrl-button btrl-button-outline text-sm" onClick={m.reset}>
            reset demo
          </button>
        </div>
        <ExtraPanel m={m} />
        {m.notice && (
          <div role="status" className="btrl-panel p-4 mb-6 text-green font-body text-sm">
            {m.notice}
          </div>
        )}
        {/* Remounts after apply/reset so per-layout tab/step state starts over. */}
        <Layout key={m.round} m={m} preview={preview} />
        <History m={m} />
        <DemoState m={m} variant={variant} />
      </div>
      {preview && <Switcher variant={variant} />}
    </div>
  );
}
