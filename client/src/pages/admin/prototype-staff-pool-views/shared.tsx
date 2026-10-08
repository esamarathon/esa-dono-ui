// THROWAWAY (#172): small atoms shared by the pages and layout variants.
// Page layouts live in the page and variant files, not here.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import Modal from '../../../components/Modal';
import {
  ChevronsLeftIcon,
  ChevronsRightIcon,
  ClipboardIcon,
  DashboardIcon,
  GiftIcon,
  GoalIcon,
  PlayIcon,
  PollIcon,
  ReceiptIcon,
  UsersIcon,
} from '../../../components/icons';
import {
  ACTION_LABEL,
  NOT_MONEY_NOTE,
  POOL_LABEL,
  disabledReason,
  fmt,
  preview,
  signed,
  type Action,
  type ClaimStatus,
  type Donation,
  type Flag,
  type Source,
  type StaffModel,
  type Status,
  ATTENTION_FLAGS,
} from './model';

export type Variant = 'A' | 'B' | 'C';
export const VARIANTS: Variant[] = ['A', 'B', 'C'];
export const DEFAULT_VARIANT: Variant = 'A';
export const VARIANT_NAMES: Record<Variant, string> = {
  A: 'Stacked sections',
  B: 'Ledger + side rail',
  C: 'Header actions + tabs',
};

// ---- Q1: number labelling --------------------------------------------------

/** Money: amount_cents and raised totals only. Yellow money style. */
export function Money({ cents, big = false }: { cents: number; big?: boolean }) {
  return (
    <span
      className={`${big ? 'font-display text-3xl' : 'font-data font-bold'} text-d-yellow`}
      data-kind="money"
    >
      {fmt(cents)}
      <sup className="number-kind font-mono text-[10px] ml-1 text-d-yellow">money</sup>
    </span>
  );
}

/** Every other number: named, neutral style. Never yellow. */
export function Num({
  cents,
  kind,
  big = false,
  signedValue = false,
}: {
  cents: number;
  kind: string;
  big?: boolean;
  signedValue?: boolean;
}) {
  return (
    <span
      className={`${big ? 'font-display text-3xl' : 'font-data font-bold'} text-off-white`}
      data-kind={kind}
    >
      {signedValue ? signed(cents) : fmt(cents)}
      <sup className="number-kind font-mono text-[10px] ml-1 text-off-white/60">
        not money · {kind}
      </sup>
    </span>
  );
}

export function NotMoneyNote() {
  return (
    <p className="font-body text-xs text-off-white/55 italic" data-testid="not-money-note">
      {NOT_MONEY_NOTE}
    </p>
  );
}

// ---- chips -----------------------------------------------------------------

const STATUS_COLORS: Record<Status, string> = {
  PENDING: 'var(--d-yellow)',
  COMPLETED: 'var(--green)',
  REFUNDED: 'var(--d-yellow)',
  CHARGEBACK: 'var(--red)',
};
export function StatusChip({ status }: { status: Status }) {
  return (
    <span
      className="font-mono text-sm px-2 py-0.5 rounded-sm font-bold tracking-wider uppercase whitespace-nowrap"
      style={{
        background: `color-mix(in srgb, ${STATUS_COLORS[status]} 16%, transparent)`,
        color: STATUS_COLORS[status],
      }}
    >
      {status}
    </span>
  );
}
export function FilterChip({
  label,
  active,
  color,
  onClick,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className="font-mono text-sm px-2 py-1 rounded-sm font-bold tracking-wider uppercase"
      style={{
        background: active ? `color-mix(in srgb, ${color} 16%, transparent)` : 'transparent',
        border: `1px solid ${active ? color : 'rgba(239,238,236,.15)'}`,
        color: active ? color : 'var(--off-white)',
        opacity: active ? 1 : 0.55,
      }}
    >
      {label}
    </button>
  );
}
export { STATUS_COLORS };

const SOURCE_STYLE: Record<Source, { bg: string; fg: string }> = {
  donor: { bg: 'rgba(239,238,236,.10)', fg: 'var(--off-white)' },
  auto: { bg: 'rgba(115,78,158,.30)', fg: '#c9b3e6' },
  moderator: { bg: 'rgba(92,189,125,.16)', fg: 'var(--green)' },
};
export function SourceTag({ source, by }: { source: Source; by?: string }) {
  const s = SOURCE_STYLE[source];
  return (
    <span
      title={by ? `allocated by ${by}` : undefined}
      className="font-mono text-xs px-1.5 py-0.5 rounded-sm font-bold uppercase tracking-wider whitespace-nowrap"
      style={{ background: s.bg, color: s.fg }}
    >
      {source}
    </span>
  );
}

export function ClaimTag({ status, flagged }: { status: ClaimStatus; flagged?: boolean }) {
  const color =
    status === 'FULFILLED'
      ? 'var(--green)'
      : status === 'CANCELLING'
        ? 'var(--d-yellow)'
        : 'var(--off-white)';
  return (
    <span className="inline-flex gap-1 items-center">
      <span
        className="font-mono text-xs px-1.5 py-0.5 rounded-sm font-bold uppercase whitespace-nowrap"
        style={{ background: 'rgba(239,238,236,.06)', color }}
      >
        {status === 'FULFILLED' ? 'fulfilled (shipped)' : status.toLowerCase()}
      </span>
      {flagged && (
        <span
          className="font-mono text-xs px-1.5 py-0.5 rounded-sm font-bold uppercase whitespace-nowrap"
          style={{ background: 'rgba(252,28,103,.18)', color: 'var(--red)' }}
        >
          flagged
        </span>
      )}
    </span>
  );
}

export function FlagChip({ flag }: { flag: Flag }) {
  const attention = ATTENTION_FLAGS.includes(flag);
  return (
    <span
      className="font-mono text-xs px-1.5 py-0.5 rounded-sm font-bold uppercase tracking-wider whitespace-nowrap"
      style={
        attention
          ? { background: 'rgba(252,28,103,.18)', color: 'var(--red)' }
          : { background: 'rgba(239,238,236,.08)', color: 'rgba(239,238,236,.75)' }
      }
    >
      {flag}
    </span>
  );
}

export function ChannelLabel({ d }: { d: Donation }) {
  return (
    <span className="font-data text-off-white/70 whitespace-nowrap">
      {d.channel ?? 'unassigned'}
    </span>
  );
}

/** A visibly marked hole for something #172 has not decided. Never an answer. */
export function Placeholder({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div
      className="rounded-md p-3 font-mono text-xs text-off-white/60"
      style={{ border: '1px dashed rgba(253,187,28,.45)', background: 'rgba(253,187,28,.04)' }}
      data-testid="placeholder"
    >
      <p className="font-bold uppercase tracking-wider text-yellow mb-1">
        Not decided yet · {title}
      </p>
      {children && <div className="space-y-1">{children}</div>}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="font-display text-2xl uppercase mb-3">{children}</h2>;
}

export function TH({ children }: { children: ReactNode }) {
  return (
    <th className="text-left px-3 py-2 font-mono text-sm tracking-wider uppercase text-off-white/55 whitespace-nowrap">
      {children}
    </th>
  );
}

export const POOL_TITLE = POOL_LABEL;

// ---- Q4: action buttons + preview dialog -----------------------------------

export function StatusActions({
  m,
  d,
  compact = false,
}: {
  m: StaffModel;
  d: Donation;
  compact?: boolean;
}) {
  const [open, setOpen] = useState<Action | null>(null);
  const reason = disabledReason(d);
  return (
    <div className="space-y-2">
      <div className={`flex flex-wrap gap-2 ${compact ? '' : ''}`}>
        {(['wallet_refund', 'chargeback'] as Action[]).map((a) => (
          <button
            key={a}
            disabled={!!reason}
            title={reason ?? undefined}
            onClick={() => setOpen(a)}
            className={`btrl-button ${a === 'chargeback' ? 'btrl-button-outline' : ''} text-sm px-4 py-2`}
          >
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {reason && (
        <p className="font-body text-sm text-off-white/60" role="note">
          Disabled: {reason}
        </p>
      )}
      {open && <PreviewDialog m={m} d={d} action={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function PreviewDialog({
  m,
  d,
  action,
  onClose,
}: {
  m: StaffModel;
  d: Donation;
  action: Action;
  onClose: () => void;
}) {
  const p = preview(d, action);
  const where = `${d.event} · ${d.channel ?? 'unassigned'}`;
  return (
    <Modal title={`${ACTION_LABEL[action]}: ${d.donorName}`} onClose={onClose}>
      <div className="space-y-4 font-body text-sm">
        <p className="text-off-white/60 text-xs font-mono">
          Server-computed preview · simulated with fixture data for {d.id}. Nothing has changed yet.
        </p>
        <div>
          <p className="font-data font-bold uppercase tracking-wider text-off-white/70 mb-1">
            Rows reversed ({p.reversed.length})
          </p>
          {p.reversed.length === 0 ? (
            <p className="text-off-white/55">None.</p>
          ) : (
            <ul className="space-y-1">
              {p.reversed.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="text-off-white/60 w-14">{POOL_TITLE[r.category]}</span>
                  <span className="flex-1 min-w-[8rem]">{r.target}</span>
                  <SourceTag source={r.source} />
                  <Num cents={r.cents} kind="allocated" />
                </li>
              ))}
            </ul>
          )}
          {(p.poolCreditCleared.length > 0 || p.unusedCleared.length > 0) && (
            <ul className="mt-2 space-y-1 text-off-white/80">
              {p.poolCreditCleared.map((x) => (
                <li key={`pc-${x.category}`}>
                  {POOL_TITLE[x.category]} Pool credit cleared:{' '}
                  <Num cents={x.cents} kind="Pool credit" />
                </li>
              ))}
              {p.unusedCleared.map((x) => (
                <li key={`u-${x.category}`}>
                  {POOL_TITLE[x.category]} Unused pool money cleared:{' '}
                  <Num cents={x.cents} kind="Unused pool money" />
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="font-data font-bold uppercase tracking-wider text-off-white/70 mb-1">
            Shipped claims that stay ({p.shippedKept.length})
          </p>
          {p.shippedKept.length === 0 ? (
            <p className="text-off-white/55">None.</p>
          ) : (
            <ul className="space-y-1">
              {p.shippedKept.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span className="flex-1">{r.target}</span>
                  <Num cents={r.cents} kind="recorded claim amount" />
                  {action === 'chargeback' && (
                    <span className="font-mono text-xs text-red">will be flagged for an admin</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="btrl-panel p-3">
            <p className="font-data text-off-white/60">Wallet credit change</p>
            <Num cents={p.walletCreditChange} kind="Wallet credit" big signedValue />
            <p className="text-xs text-off-white/55 mt-1">{p.walletExplain}</p>
          </div>
          <div className="btrl-panel p-3">
            <p className="font-data text-off-white/60">Money total change</p>
            <Money cents={p.moneyTotalChange} big />
            <p className="text-xs text-off-white/55 mt-1">{where}</p>
          </div>
        </div>
        {action === 'chargeback' && !d.stripe && (
          <Placeholder title="chargeback on a donation with no Stripe payment">
            <p>
              {d.donorName}&apos;s donation has no payment ({d.origin}). Whether Record chargeback
              is offered here has not been asked.
            </p>
          </Placeholder>
        )}
        <NotMoneyNote />
        <div className="flex flex-wrap gap-2 justify-end pt-2">
          <button className="btrl-button btrl-button-outline text-sm px-4 py-2" onClick={onClose}>
            cancel
          </button>
          <button
            className="btrl-button text-sm px-4 py-2"
            disabled={action === 'chargeback' && !d.stripe}
            title={
              action === 'chargeback' && !d.stripe
                ? 'Preview only: eligibility for this fixture has not been decided.'
                : undefined
            }
            onClick={() => {
              m.apply(d.id, action);
              onClose();
            }}
          >
            {action === 'chargeback' && !d.stripe
              ? 'preview only · not decided'
              : `confirm ${ACTION_LABEL[action]}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---- shell -----------------------------------------------------------------

const NAV: { to: string | null; label: string; icon: (p: { className?: string }) => ReactNode }[] =
  [
    { to: null, label: 'dashboard', icon: DashboardIcon },
    { to: null, label: 'donors', icon: UsersIcon },
    { to: null, label: 'events', icon: PlayIcon },
    { to: null, label: 'channels', icon: PlayIcon },
    { to: null, label: 'rewards', icon: GiftIcon },
    { to: null, label: 'polls', icon: PollIcon },
    { to: null, label: 'goals', icon: GoalIcon },
    { to: '/admin/donations', label: 'donations & claims', icon: ReceiptIcon },
    { to: null, label: 'pledges', icon: ClipboardIcon },
  ];

/** Copy of SidebarLayout's look without its localStorage write. */
export function Shell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 768);
  const search = useLocation().search;
  return (
    <div className="flex h-screen overflow-hidden">
      <aside
        className={`flex flex-col p-4 overflow-y-auto shrink-0 transition-[width] duration-150 ${collapsed ? 'w-16' : 'w-52'}`}
        style={{ background: 'var(--dark-gray)', borderRight: '1px solid rgba(239,238,236,.08)' }}
      >
        <div
          className={`font-display text-2xl mb-6 uppercase text-d-yellow ${collapsed ? 'text-center text-base' : ''}`}
        >
          {collapsed ? 'a' : 'admin'}
        </div>
        <nav className="space-y-1">
          {NAV.map((n) =>
            n.to ? (
              <NavLink
                key={n.label}
                to={`${n.to}${search}`}
                title={collapsed ? n.label : undefined}
                className={({ isActive }) =>
                  `flex items-center gap-2 px-3 py-2 rounded-sm font-data font-bold text-sm tracking-wider uppercase ${collapsed ? 'justify-center' : ''} ${isActive ? 'text-off-white' : 'text-off-white/55 hover:text-off-white'}`
                }
                style={({ isActive }) => (isActive ? { background: 'var(--grad)' } : {})}
              >
                <n.icon className="w-4 h-4 shrink-0" />
                {!collapsed && <span>{n.label}</span>}
              </NavLink>
            ) : (
              <span
                key={n.label}
                title={`${n.label}: not in this prototype`}
                className={`flex items-center gap-2 px-3 py-2 rounded-sm font-data font-bold text-sm tracking-wider uppercase text-off-white/25 cursor-not-allowed ${collapsed ? 'justify-center' : ''}`}
              >
                <n.icon className="w-4 h-4 shrink-0" />
                {!collapsed && <span>{n.label}</span>}
              </span>
            ),
          )}
        </nav>
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? 'expand' : 'collapse'}
          className={`flex items-center gap-2 px-3 py-2 font-mono text-sm tracking-wider uppercase text-off-white/55 hover:text-off-white mt-2 ${collapsed ? 'justify-center' : ''}`}
        >
          {collapsed ? (
            <ChevronsRightIcon className="w-4 h-4" />
          ) : (
            <>
              <ChevronsLeftIcon className="w-4 h-4" />
              <span>collapse</span>
            </>
          )}
        </button>
        {!collapsed && (
          <p className="font-mono text-xs text-off-white/40 mt-4">
            Greyed pages are not in this prototype.
          </p>
        )}
      </aside>
      <main className="flex-1 min-w-0 p-4 md:p-8 pb-40 md:pb-40 overflow-y-auto">{children}</main>
    </div>
  );
}

export function useVariant(): Variant {
  const raw = new URLSearchParams(useLocation().search).get('variant');
  return VARIANTS.find((v) => v === raw) ?? DEFAULT_VARIANT;
}

export function DonationLink({ id, children }: { id: string; children: ReactNode }) {
  const search = useLocation().search;
  return (
    <Link to={`/admin/donations/${id}${search}`} className="text-d-yellow hover:underline">
      {children}
    </Link>
  );
}

// ---- prototype switcher -----------------------------------------------------

export function Switcher({ m }: { m: StaffModel }) {
  const location = useLocation();
  const navigate = useNavigate();
  const variant = useVariant();
  const [tools, setTools] = useState(false);
  const [showState, setShowState] = useState(false);
  const onDetail = /\/admin\/donations\/[^/]+$/.test(location.pathname);
  const go = (offset: number) => {
    const next = VARIANTS[(VARIANTS.indexOf(variant) + offset + VARIANTS.length) % VARIANTS.length];
    const params = new URLSearchParams(location.search);
    params.set('variant', next ?? DEFAULT_VARIANT);
    navigate(`${location.pathname}?${params}`, { replace: true });
  };
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || target.closest('input, textarea, select'))
      )
        return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        goRef.current(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const tool = 'btrl-button btrl-button-outline text-xs px-3 py-1';
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-max max-w-[95vw]">
      {tools && (
        <div
          id="prototype-tools"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-[min(28rem,95vw)] btrl-panel-dark shadow-lg p-3 space-y-2 font-mono text-xs text-off-white/60"
        >
          <div className="flex flex-wrap gap-2">
            <button
              className={tool}
              onClick={() => {
                m.reset();
                setTools(false);
              }}
            >
              reset demo
            </button>
            <button
              className={tool}
              aria-pressed={m.showKinds}
              onClick={() => m.setShowKinds(!m.showKinds)}
            >
              {m.showKinds ? 'hide' : 'show'} number kinds (Q1)
            </button>
            <button
              className={tool}
              aria-pressed={showState}
              onClick={() => setShowState((s) => !s)}
            >
              {showState ? 'hide' : 'show'} demo state
            </button>
          </div>
          <p>
            Number kinds: outlines every number. Yellow = money (amount_cents, raised totals). Grey
            = named, not money.
          </p>
          <p>
            Fixtures: Ana, Ben, Cy, Dee from the handoff. Eve is added to show a REQUESTED Payment
            refund.
          </p>
          {showState && (
            <pre className="max-h-[45vh] overflow-auto p-2 whitespace-pre-wrap">
              {JSON.stringify(
                m.donations.map((d) => ({
                  id: d.id,
                  status: d.status,
                  amount_cents: d.amountCents,
                  pledge: d.pledge,
                  live_rows: d.rows
                    .filter((r) => r.live)
                    .map((r) => `${r.category}:${r.target}:${r.source}:${r.cents}`),
                  log: d.log,
                })),
                null,
                1,
              )}
            </pre>
          )}
        </div>
      )}
      <div className="btrl-panel-dark shadow-lg p-2 flex items-center gap-2">
        <button
          className="btrl-button btrl-button-outline shrink-0 px-3 py-1"
          aria-label="Previous detail layout"
          onClick={() => go(-1)}
        >
          ←
        </button>
        <p className="font-mono text-xs text-d-yellow min-w-0 text-center leading-tight">
          PROTOTYPE · fixtures only · detail layout {variant} / {VARIANTS.length} ·{' '}
          <span className="font-data font-bold text-sm text-off-white">
            {VARIANT_NAMES[variant]}
          </span>
          {!onDetail && (
            <span className="block text-off-white/50">(open a donation to see it)</span>
          )}
        </p>
        <button
          className="shrink-0 font-mono text-xs text-off-white/60 underline px-1"
          aria-expanded={tools}
          aria-controls="prototype-tools"
          onClick={() => setTools((t) => !t)}
        >
          tools
        </button>
        <button
          className="btrl-button shrink-0 px-3 py-1"
          aria-label="Next detail layout"
          onClick={() => go(1)}
        >
          →
        </button>
      </div>
    </div>
  );
}
