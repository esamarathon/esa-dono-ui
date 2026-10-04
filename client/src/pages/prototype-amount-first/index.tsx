// PROTOTYPE — throwaway (#157, map #151). Three amount-first variants of the
// /donate page, switchable via ?variant=A|B|C (?variant=current = today's flow).
// No backend writes: pay shows the payload it would POST. Delete before merge.
import { useLocation } from 'react-router-dom';
import { useCart } from '../../context/CartContext';
import { PrototypeSwitcher, StateDump, useProto } from './shared';
import VariantA from './VariantA';
import VariantB from './VariantB';
import VariantC from './VariantC';

export default function AmountFirstPrototype() {
  const variant = new URLSearchParams(useLocation().search).get('variant');
  const { channels, selectedChannelId, selectChannel } = useCart();
  const p = useProto();
  return (
    <div className={`${variant === 'B' ? 'max-w-5xl' : 'max-w-3xl'} mx-auto p-8 pb-24`}>
      {/* Channel picker kept as-is (every pledge routes to one Channel). */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        <span className="font-mono text-xs tracking-widest uppercase text-off-white/50">channel</span>
        {channels.length === 0 && <span className="font-body text-xs text-off-white/40">none open — using fixtures</span>}
        {channels.map((c) => (
          <button
            key={c.id}
            onClick={() => selectChannel(c.id)}
            className={`font-data text-xs uppercase px-3 py-1 rounded-sm ${selectedChannelId === c.id ? 'text-black' : 'text-off-white/60'}`}
            style={{ background: selectedChannelId === c.id ? 'var(--d-yellow)' : 'rgba(239,238,236,.08)' }}
          >
            {c.name}
          </button>
        ))}
      </div>
      {/* key: switching variants resets their step state, not the pledge */}
      {variant === 'A' && <VariantA key="A" p={p} />}
      {variant === 'B' && <VariantB key="B" p={p} />}
      {variant === 'C' && <VariantC key="C" p={p} />}
      <StateDump p={p} />
      <PrototypeSwitcher />
    </div>
  );
}
