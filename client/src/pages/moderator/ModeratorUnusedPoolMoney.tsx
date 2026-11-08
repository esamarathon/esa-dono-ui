import { useEffect, useRef, useState } from 'react';
import moderatorClient from '../../api/moderator';
import Card from '../../components/Card';
import Modal from '../../components/Modal';
import LoadingSpinner from '../../components/LoadingSpinner';
import { useModeratorChannelFilter } from '../../context/ModeratorChannelFilterContext';
import {
  apiErrorMessage,
  type UnusedCategory,
  type UnusedDonation,
  type UnusedPicker,
} from '../../types';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
export default function ModeratorUnusedPoolMoney() {
  const { channels, selectedChannelId } = useModeratorChannelFilter();
  const [commentsOnly, setCommentsOnly] = useState(true);
  const [showEnded, setShowEnded] = useState(false);
  const [donations, setDonations] = useState<UnusedDonation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [picker, setPicker] = useState<{
    donation: UnusedDonation;
    category: UnusedCategory;
    data: UnusedPicker;
  } | null>(null);
  const [target, setTarget] = useState('');
  const pickerRequest = useRef(0);
  useEffect(() => {
    let current = true;
    pickerRequest.current++;
    setPicker(null);
    setLoading(true);
    moderatorClient
      .get('/unused-pool-money', {
        params: {
          comments_only: commentsOnly,
          show_ended: showEnded,
          channel_id: selectedChannelId ?? undefined,
        },
      })
      .then((r) => {
        if (current) {
          setDonations(r.data);
          setError('');
        }
      })
      .catch((e) => {
        if (current) setError(apiErrorMessage(e, 'Could not load Unused pool money'));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [commentsOnly, showEnded, selectedChannelId, refresh]);

  const openPicker = async (donation: UnusedDonation, category: UnusedCategory) => {
    const request = ++pickerRequest.current;
    setError('');
    setTarget('');
    try {
      const response = await moderatorClient.get(
        `/donations/${donation.id}/unused-pool-money/targets`,
        { params: { category } },
      );
      if (request === pickerRequest.current) setPicker({ donation, category, data: response.data });
    } catch (e) {
      if (request === pickerRequest.current)
        setError(apiErrorMessage(e, 'Could not load eligible targets'));
    }
  };
  const assign = async () => {
    if (!picker || busy) return;
    setBusy(true);
    setError('');
    try {
      await moderatorClient.post(`/donations/${picker.donation.id}/unused-pool-money`, {
        category: picker.category,
        target_id: target,
        expected_amount_cents: picker.data.amount_cents,
      });
      setPicker(null);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(apiErrorMessage(e, 'Assignment failed'));
    } finally {
      setBusy(false);
    }
  };
  const undo = async (category: UnusedCategory, id: string) => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await moderatorClient.post(`/unused-pool-money/${category}/${id}/undo`);
      setRefresh((n) => n + 1);
    } catch (e) {
      setError(apiErrorMessage(e, 'Undo failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div>
      <h1 className="font-display text-4xl uppercase mb-6">Unused pool money</h1>
      <p className="font-body text-sm mb-4">
        Assign all of one category to an open target. Incentive amounts are not money totals.
      </p>
      <div className="flex gap-4 mb-6">
        <label>
          <input
            type="checkbox"
            checked={commentsOnly}
            onChange={(e) => setCommentsOnly(e.target.checked)}
          />{' '}
          comments only
        </label>
        <label>
          <input
            type="checkbox"
            checked={showEnded}
            onChange={(e) => setShowEnded(e.target.checked)}
          />{' '}
          show ended Events
        </label>
      </div>
      {error && !picker && <p role="alert">{error}</p>}
      <button
        className="btrl-button btrl-button-outline mb-4"
        disabled={busy}
        onClick={() => setRefresh((n) => n + 1)}
      >
        reload
      </button>
      {loading ? (
        <LoadingSpinner />
      ) : (
        <div className="space-y-4">
          {donations.map((donation) => (
            <Card key={donation.id}>
              <h2 className="font-data font-bold">{donation.donor_name || 'Anonymous'}</h2>
              <p>{donation.comment}</p>
              <p>
                {donation.channel_id
                  ? (channels.find((c) => c.id === donation.channel_id)?.name ?? 'unknown Channel')
                  : 'unassigned — an admin must route this donation first'}
              </p>
              {donation.event?.ended_at && (
                <p>ended {new Date(donation.event.ended_at).toLocaleDateString()}</p>
              )}
              {(['poll', 'goal'] as const).map(
                (category) =>
                  donation.unused_cents[category] > 0 && (
                    <div key={category}>
                      <span>
                        {category}: {money(donation.unused_cents[category])} Unused pool money{' '}
                      </span>
                      <button
                        disabled={busy || !donation.channel_id}
                        onClick={() => openPicker(donation, category)}
                        className="btrl-button btrl-button-outline"
                      >
                        assign {category}…
                      </button>
                    </div>
                  ),
              )}
              {donation.assignments.map((row) => (
                <div key={row.id}>
                  <span>
                    {row.label}: {money(row.amount_cents)} · moderator
                    {row.allocated_at
                      ? ` · ${new Date(row.allocated_at).toLocaleString()}`
                      : ''}{' '}
                  </span>
                  <button
                    disabled={busy || !row.can_undo}
                    onClick={() => undo(row.category, row.id)}
                    aria-label={`undo ${row.label}`}
                  >
                    undo
                  </button>
                  {!row.can_undo && <span> target is closed</span>}
                </div>
              ))}
            </Card>
          ))}
          {!donations.length && <p>No Unused pool money matches these filters.</p>}
        </div>
      )}
      {picker && (
        <Modal
          title={`assign ${picker.category} Unused pool money`}
          onClose={() => {
            if (!busy) setPicker(null);
          }}
        >
          <p>
            Assign all {money(picker.data.amount_cents)}. Impact is computed by the server and
            checked again on assignment.
          </p>
          {picker.data.targets.map((item) => (
            <label key={item.id} className="block my-3">
              <input
                type="radio"
                name="unused-target"
                value={item.id}
                checked={target === item.id}
                onChange={() => setTarget(item.id)}
              />{' '}
              {item.label}
              <span className="block">
                {money(item.before_cents)} → {money(item.after_cents)}
                {item.target_cents === null ? '' : ` of ${money(item.target_cents)}`} ·{' '}
                {item.channel_id
                  ? (channels.find((c) => c.id === item.channel_id)?.name ?? 'own Channel')
                  : 'shared'}
              </span>
            </label>
          ))}
          {!picker.data.targets.length && <p>No eligible targets. The money stays unused.</p>}
          {error && <p role="alert">{error}</p>}
          <button
            className="btrl-button"
            disabled={busy || !target || picker.data.amount_cents <= 0}
            onClick={assign}
          >
            assign all {money(picker.data.amount_cents)}
          </button>
        </Modal>
      )}
    </div>
  );
}
