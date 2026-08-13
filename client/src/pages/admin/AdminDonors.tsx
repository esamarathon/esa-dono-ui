import { useEffect, useState } from 'react';
import {
  getDonors,
  getDonorWallet,
  revokeDonorToken,
  regenerateDonorToken,
  toggleDonorFreeze,
  adjustDonorBalance,
  reverseDonorSpend,
  setDonorRole,
} from '../../api/admin';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import { apiErrorMessage, type AdminDonorSummary, type AdminDonorWallet } from '../../types';
import { sanitizeMoneyInput } from '../../utils/money';

function fmt(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export default function AdminDonors() {
  const [search, setSearch] = useState('');
  const [donors, setDonors] = useState<AdminDonorSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{ id: string } | null>(null);
  const [wallet, setWallet] = useState<AdminDonorWallet | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [modal, setModal] = useState<{ type: string } | null>(null);
  const [error, setError] = useState('');

  const loadDonors = async (q = '') => {
    setLoading(true);
    try {
      const data = await getDonors(q);
      setDonors(data.donors);
      setTotal(data.total);
    } catch {
      setError('Failed to load donors');
    }
    setLoading(false);
  };

  useEffect(() => {
    loadDonors();
  }, []);

  const searchDonors = () => {
    loadDonors(search);
  };
  const clearSearch = () => {
    setSearch('');
    loadDonors('');
  };

  const openWallet = async (donor: { id: string }) => {
    setSelected(donor);
    setWalletLoading(true);
    setWallet(null);
    try {
      const data = await getDonorWallet(donor.id);
      setWallet(data);
    } catch {
      setError('Failed to load wallet');
    }
    setWalletLoading(false);
  };

  const closeWallet = () => {
    setSelected(null);
    setWallet(null);
  };

  const handleFreeze = async () => {
    await toggleDonorFreeze(selected!.id, !wallet!.is_frozen);
    openWallet({ id: selected!.id });
  };

  const handleRevoke = async () => {
    await revokeDonorToken(selected!.id);
    openWallet({ id: selected!.id });
  };

  const handleRegen = async () => {
    await regenerateDonorToken(selected!.id);
    openWallet({ id: selected!.id });
  };

  const handleAdjust = async (amount_cents: number, reason: string | null, type: string) => {
    await adjustDonorBalance(selected!.id, amount_cents, reason, type);
    setModal(null);
    openWallet({ id: selected!.id });
  };

  const handleReverse = async (spend_type: string, spend_id: string) => {
    if (!window.confirm(`Reverse this ${spend_type}? This restores the balance.`)) return;
    await reverseDonorSpend(selected!.id, spend_type, spend_id);
    openWallet({ id: selected!.id });
  };

  const handleRoleChange = async (role: 'USER' | 'MODERATOR' | 'ADMIN') => {
    await setDonorRole(selected!.id, role);
    openWallet({ id: selected!.id });
  };

  return (
    <div>
      <h1 className="font-display text-4xl lowercase mb-6">donors</h1>

      {error && (
        <p className="mb-4" style={{ color: 'var(--red)' }}>
          {error}
        </p>
      )}

      <div className="flex gap-3 mb-6">
        <input
          className="px-3 py-2 text-sm flex-1"
          placeholder="Search by email..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && searchDonors()}
        />
        <button onClick={searchDonors} className="btrl-button">
          search
        </button>
        {search && (
          <button
            onClick={clearSearch}
            className="font-data text-sm text-off-white/55 hover:text-off-white"
          >
            clear
          </button>
        )}
        <span className="font-data text-sm text-off-white/55 self-center">
          {total} donor{total !== 1 ? 's' : ''}
        </span>
      </div>

      {loading ? (
        <LoadingSpinner />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className={`${selected ? 'hidden lg:block' : ''} lg:col-span-1`}>
            <div className="space-y-2">
              {donors.length === 0 && (
                <p className="font-body text-sm text-off-white/55">No donors found.</p>
              )}
              {donors.map((d) => (
                <button
                  key={d.id}
                  onClick={() => openWallet(d)}
                  className={`w-full text-left btrl-panel p-3 transition ${selected?.id === d.id ? 'ring-2' : ''}`}
                  style={
                    selected?.id === d.id
                      ? ({ ringColor: 'var(--d-yellow)' } as React.CSSProperties)
                      : {}
                  }
                >
                  <p className="font-data font-bold text-sm truncate text-off-white">{d.email}</p>
                  <p className="font-data text-xs text-off-white/55 mt-1">
                    {fmt(d.total_donated)} donated &middot; {fmt(d.balance_remaining)} balance
                  </p>
                  {d.is_frozen && (
                    <span className="font-data text-xs font-bold" style={{ color: 'var(--red)' }}>
                      frozen
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>

          {selected && (
            <div className="lg:col-span-2">
              <div className="flex items-center justify-between mb-4">
                <h2 className="font-display text-3xl lowercase">{wallet?.email || 'Loading...'}</h2>
                <button
                  onClick={closeWallet}
                  className="font-data text-sm text-off-white/55 hover:text-off-white lg:hidden"
                >
                  close
                </button>
              </div>

              {walletLoading ? (
                <LoadingSpinner />
              ) : wallet ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <Card className="text-center">
                      <p className="font-data text-xs text-off-white/55">total donated</p>
                      <p className="font-display text-2xl text-d-yellow">
                        {fmt(wallet.total_donated)}
                      </p>
                    </Card>
                    <Card className="text-center">
                      <p className="font-data text-xs text-off-white/55">balance</p>
                      <p className="font-display text-2xl text-d-yellow">
                        {fmt(wallet.balance_remaining)}
                      </p>
                    </Card>
                    <Card className="text-center">
                      <p className="font-data text-xs text-off-white/55">role</p>
                      <select
                        className="mt-1 px-2 py-1 text-sm w-full text-center"
                        value={wallet.role ?? 'USER'}
                        onChange={(e) =>
                          handleRoleChange(e.target.value as 'USER' | 'MODERATOR' | 'ADMIN')
                        }
                      >
                        <option value="USER">user</option>
                        <option value="MODERATOR">moderator</option>
                        <option value="ADMIN">admin</option>
                      </select>
                    </Card>
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <button
                      onClick={handleFreeze}
                      className="btrl-button"
                      style={{ background: wallet.is_frozen ? 'var(--green)' : 'var(--red)' }}
                    >
                      {wallet.is_frozen ? 'unfreeze' : 'freeze'}
                    </button>
                    <button onClick={handleRevoke} className="btrl-button btrl-button-purple">
                      revoke token
                    </button>
                    <button onClick={handleRegen} className="btrl-button btrl-button-purple">
                      regenerate token
                    </button>
                    <button
                      onClick={() => setModal({ type: 'adjust' })}
                      className="btrl-button btrl-button-accent"
                    >
                      adjust balance
                    </button>
                  </div>

                  <div>
                    <h3 className="font-display text-2xl lowercase mt-6 mb-3">spend history</h3>

                    {(wallet.reward_claims?.length ?? 0) > 0 && (
                      <div className="mb-4">
                        <h4 className="font-data text-sm font-bold text-off-white/55 mb-2">
                          reward claims
                        </h4>
                        <div className="space-y-2">
                          {wallet.reward_claims!.map((c) => (
                            <div
                              key={c.id}
                              className="btrl-panel p-3 flex justify-between items-center text-sm"
                            >
                              <div>
                                <span className="font-data font-bold text-off-white">
                                  {c.reward?.title || 'Unknown'}
                                </span>
                                <span
                                  className={`ml-2 font-mono text-[10px] px-1.5 py-0.5 rounded-sm ${c.status === 'FULFILLED' ? 'text-green' : c.status === 'REVERSED' ? 'text-red' : 'text-d-yellow'}`}
                                  style={{
                                    background:
                                      c.status === 'FULFILLED'
                                        ? 'rgba(92,189,125,.16)'
                                        : c.status === 'REVERSED'
                                          ? 'rgba(252,28,103,.18)'
                                          : 'rgba(208,152,70,.16)',
                                  }}
                                >
                                  {c.status}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="font-data text-off-white/55">
                                  -{fmt(c.reward?.cost_cents || 0)}
                                </span>
                                {c.status !== 'REVERSED' && (
                                  <button
                                    onClick={() => handleReverse('claim', c.id)}
                                    className="font-mono text-[10px] hover:underline"
                                    style={{ color: 'var(--red)' }}
                                  >
                                    reverse
                                  </button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(wallet.poll_votes?.length ?? 0) > 0 && (
                      <div className="mb-4">
                        <h4 className="font-data text-sm font-bold text-off-white/55 mb-2">
                          poll votes
                        </h4>
                        <div className="space-y-2">
                          {wallet.poll_votes!.map((v) => (
                            <div
                              key={v.id}
                              className="btrl-panel p-3 flex justify-between items-center text-sm"
                            >
                              <div>
                                <span className="font-data text-off-white">
                                  vote &middot; {fmt(v.amount_cents)}
                                </span>
                                {v.reversed_at && (
                                  <span
                                    className="ml-2 font-mono text-[10px]"
                                    style={{ color: 'var(--red)' }}
                                  >
                                    (reversed)
                                  </span>
                                )}
                              </div>
                              {!v.reversed_at && (
                                <button
                                  onClick={() => handleReverse('vote', v.id)}
                                  className="font-mono text-[10px] hover:underline"
                                  style={{ color: 'var(--red)' }}
                                >
                                  reverse
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {(wallet.fund_contributions?.length ?? 0) > 0 && (
                      <div className="mb-4">
                        <h4 className="font-data text-sm font-bold text-off-white/55 mb-2">
                          fund contributions
                        </h4>
                        <div className="space-y-2">
                          {wallet.fund_contributions!.map((c) => (
                            <div
                              key={c.id}
                              className="btrl-panel p-3 flex justify-between items-center text-sm"
                            >
                              <div>
                                <span className="font-data text-off-white">
                                  {c.goal?.title || 'Unknown'} &middot; {fmt(c.amount_cents)}
                                </span>
                                {c.reversed_at && (
                                  <span
                                    className="ml-2 font-mono text-[10px]"
                                    style={{ color: 'var(--red)' }}
                                  >
                                    (reversed)
                                  </span>
                                )}
                              </div>
                              {!c.reversed_at && (
                                <button
                                  onClick={() => handleReverse('contribution', c.id)}
                                  className="font-mono text-[10px] hover:underline"
                                  style={{ color: 'var(--red)' }}
                                >
                                  reverse
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {!wallet.reward_claims?.length &&
                      !wallet.poll_votes?.length &&
                      !wallet.fund_contributions?.length && (
                        <p className="font-body text-sm text-off-white/55">No spend history.</p>
                      )}
                  </div>

                  {(wallet.balance_adjustments?.length ?? 0) > 0 && (
                    <div>
                      <h3 className="font-display text-2xl lowercase mt-6 mb-3">
                        balance adjustments
                      </h3>
                      <div className="space-y-2">
                        {wallet.balance_adjustments!.map((a) => (
                          <div
                            key={a.id}
                            className="btrl-panel p-3 flex justify-between items-center text-sm"
                          >
                            <div>
                              <span
                                className="font-data font-bold"
                                style={{
                                  color: a.amount_cents > 0 ? 'var(--green)' : 'var(--red)',
                                }}
                              >
                                {a.amount_cents > 0 ? '+' : ''}
                                {fmt(a.amount_cents)}
                              </span>
                              <span className="ml-2 font-data text-off-white/55">{a.type}</span>
                              {a.reason && (
                                <span className="ml-2 font-body text-off-white/55">
                                  &mdash; {a.reason}
                                </span>
                              )}
                            </div>
                            <span className="font-mono text-xs text-off-white/55">
                              balance: {fmt(a.balance_after_cents)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          )}
        </div>
      )}

      {modal?.type === 'adjust' && (
        <Modal title="adjust balance" onClose={() => setModal(null)}>
          <AdjustBalanceForm onSubmit={handleAdjust} onCancel={() => setModal(null)} />
        </Modal>
      )}
    </div>
  );
}

function AdjustBalanceForm({
  onSubmit,
  onCancel,
}: {
  onSubmit: (cents: number, reason: string | null, type: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [type, setType] = useState('MANUAL');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const submit = async () => {
    const cents = Math.round(parseFloat(amount || '0') * 100);
    if (cents === 0) {
      setErr('Enter a non-zero amount');
      return;
    }
    setSubmitting(true);
    setErr('');
    try {
      await onSubmit(cents, reason || null, type);
    } catch (e) {
      setErr(apiErrorMessage(e, 'Failed to adjust balance'));
    }
    setSubmitting(false);
  };

  return (
    <div className="space-y-3 text-sm">
      <div>
        <label className="block font-data font-bold mb-1 text-off-white">
          amount (dollars, negative for deduction)
        </label>
        <input
          className="px-3 py-2 w-full"
          type="number"
          step="0.01"
          placeholder="e.g. 10.00"
          value={amount}
          onChange={(e) => setAmount(sanitizeMoneyInput(e.target.value, true))}
        />
      </div>
      <div>
        <label className="block font-data font-bold mb-1 text-off-white">type</label>
        <select className="px-3 py-2 w-full" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="MANUAL">Manual</option>
          <option value="REFUND">Refund</option>
          <option value="FREEZE_ZERO">Freeze Zero</option>
          <option value="CHARGEBACK">Chargeback</option>
        </select>
      </div>
      <div>
        <label className="block font-data font-bold mb-1 text-off-white">reason (optional)</label>
        <input
          className="px-3 py-2 w-full"
          placeholder="Why?"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {err && <p style={{ color: 'var(--red)' }}>{err}</p>}
      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="btrl-button btrl-button-outline">
          cancel
        </button>
        <button onClick={submit} disabled={submitting} className="btrl-button">
          {submitting ? 'saving...' : 'save'}
        </button>
      </div>
    </div>
  );
}
