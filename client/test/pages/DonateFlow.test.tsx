import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { planPledge } from '@dono/shared';
import type { DraftPledge } from '../../src/context/DraftPledgeContext';
import type { Pledge, PledgeResult, Reward } from '../../src/types';
import Navbar from '../../src/components/Navbar';
import PledgeReturn from '../../src/pages/PledgeReturn';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import DonateFlow, { LegacyIncentiveRedirect } from '../../src/pages/DonateFlow';
import { DraftPledgeProvider as CartProvider } from '../../src/context/DraftPledgeContext';

vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn() }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn() }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn() }));
vi.mock('../../src/api/channels', () => ({ getChannels: vi.fn() }));
vi.mock('../../src/api/events', () => ({ getPublicEvent: vi.fn() }));
vi.mock('../../src/api/pledge', () => ({
  createPledge: vi.fn(),
  getPledge: vi.fn(),
  reconcilePledge: vi.fn(),
  cancelPledge: vi.fn(),
  continuePledge: vi.fn(),
  getDefaultGoalPreview: vi.fn(),
}));
vi.mock('../../src/api/donor', () => ({ getDonor: vi.fn() }));
vi.mock('../../src/api/featureFlags', () => ({ getFeatureFlags: vi.fn().mockResolvedValue({}) }));
import { getRewards } from '../../src/api/rewards';
import { getPolls } from '../../src/api/polls';
import { getGoals } from '../../src/api/goals';
import { getChannels } from '../../src/api/channels';
import {
  getDefaultGoalPreview,
  createPledge,
  reconcilePledge,
  cancelPledge,
  continuePledge,
  getPledge,
} from '../../src/api/pledge';
import { getDonor } from '../../src/api/donor';
import { getPublicEvent } from '../../src/api/events';

function renderAt(path = '/donate?channel=c1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <CartProvider>
        <Navbar />
        <Routes>
          <Route path="/" element={<div>Home page</div>} />
          <Route path="/donate" element={<DonateFlow />} />
          <Route path="/donate/:eventSlug" element={<DonateFlow />} />
          <Route path="/donate/:eventSlug/:channelSlug" element={<DonateFlow />} />
          <Route path="/pledge/:token" element={<PledgeReturn />} />
          <Route path="/wallet" element={<div>Wallet page</div>} />
          <Route path="/rewards" element={<LegacyIncentiveRedirect tab="rewards" />} />
          <Route path="/polls" element={<LegacyIncentiveRedirect tab="polls" />} />
          <Route path="/goals" element={<LegacyIncentiveRedirect tab="goals" />} />
        </Routes>
      </CartProvider>
    </MemoryRouter>,
  );
}

const reward: Reward = {
  id: 'r1',
  title: 'Digital Reward',
  type: 'DIGITAL',
  cost_cents: 500,
  quantity_total: 5,
  quantity_claimed: 0,
  channel_id: null,
  is_active: true,
  image_url: '/reward.png',
};
const channel = { id: 'c1', name: 'Main', slug: 'main', event_id: 'e1', is_active: true };
function saved(overrides: Partial<DraftPledge> = {}): DraftPledge {
  return {
    id: 'draft-one',
    updatedAt: Date.now(),
    amountCents: 1000,
    selections: [],
    channelId: 'c1',
    path: '/donate',
    eventSlug: null,
    comment: '',
    displayName: '',
    lastStep: 'review',
    tab: 'rewards',
    pendingToken: null,
    ...overrides,
  };
}
function save(d: DraftPledge) {
  localStorage.setItem('donation_draft_v1', JSON.stringify(d));
}
function payment(overrides: Partial<PledgeResult> = {}): PledgeResult {
  return {
    format: 'POOLED',
    draft_id: 'draft-one',
    pledge_token: 'pending-one',
    status: 'OPEN',
    payment_state: 'OPEN',
    can_continue: false,
    can_edit: false,
    read_only: true,
    has_checkout: true,
    donate_url: null,
    admin_review_required: false,
    expires_at: '2000-01-01',
    items: [],
    comment: 'Server message',
    display_name: 'Server name',
    channel_id: 'c1',
    pledge_amount_cents: 2500,
    wallet_applied_cents: 0,
    new_money_cents: 2500,
    requires_shipping: false,
    checkout_error: null,
    plan: planPledge({ pledge_amount_cents: 2500, selections: [], available_wallet_cents: null }),
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function externalDraft(d: DraftPledge | null) {
  if (d) save(d);
  else localStorage.removeItem('donation_draft_v1');
  fireEvent(
    window,
    new StorageEvent('storage', {
      key: 'donation_draft_v1',
      newValue: d ? JSON.stringify(d) : null,
      storageArea: localStorage,
    }),
  );
}
async function choose(amount = '$10') {
  fireEvent.click(await screen.findByRole('button', { name: amount }));
  fireEvent.click(screen.getByRole('button', { name: /choose incentives/i }));
  await screen.findByRole('meter', { name: 'reward Pool' });
}

describe('amount-first donate through the routed flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    vi.mocked(getRewards).mockResolvedValue([]);
    vi.mocked(getPolls).mockResolvedValue([]);
    vi.mocked(getGoals).mockResolvedValue([]);
    vi.mocked(getChannels).mockResolvedValue([
      { id: 'c1', name: 'Main', slug: 'main', event_id: 'e1', is_active: true },
    ]);
    vi.mocked(getDefaultGoalPreview).mockResolvedValue({ goal: null });
    vi.mocked(reconcilePledge).mockReset();
    vi.mocked(cancelPledge).mockReset();
    vi.mocked(createPledge).mockReset();
    vi.mocked(continuePledge).mockReset();
    vi.mocked(getPledge).mockReset();
    vi.mocked(getDonor).mockRejectedValue(new Error('No session'));
  });

  it('refreshes the Channel picker when entering donate after a Channel opens', async () => {
    vi.mocked(getChannels)
      .mockResolvedValueOnce([channel])
      .mockResolvedValue([channel, { ...channel, id: 'c2', name: 'New Channel', slug: 'new' }]);
    renderAt('/');
    await waitFor(() => expect(getChannels).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('link', { name: 'contribute' }));
    expect(await screen.findByRole('button', { name: 'New Channel' })).toBeInTheDocument();
  });

  it('confirms an amount before browsing and saves the draft, not the obsolete cart', async () => {
    sessionStorage.setItem('donation_cart_v1', '{"topUp":"99"}');
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: '$10' }));
    fireEvent.click(screen.getByRole('button', { name: /choose incentives/i }));
    expect(await screen.findByText(/No rewards available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /review/i })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /previous|next/i })).not.toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem('donation_draft_v1')).toContain('1000'));
    expect(sessionStorage.getItem('donation_cart_v1')).toBeNull();
  });

  it('requires at least $1 and has a just-donate message exit with retained name/email prefills', async () => {
    localStorage.setItem('last_donor_email', 'donor@example.com');
    localStorage.setItem('last_donor_display_name', 'Reader');
    renderAt();
    const amount = await screen.findByRole('spinbutton', { name: 'Pledge amount ($)' });
    fireEvent.change(amount, { target: { value: '0.99' } });
    expect(screen.getByRole('button', { name: /just donate/i })).toBeDisabled();
    expect(localStorage.getItem('donation_draft_v1')).toBeNull();
    fireEvent.change(amount, { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: /just donate/i }));
    expect(await screen.findByRole('heading', { name: /review/i })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /confirm & pay/i })).toBeEnabled(),
    );
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveAttribute('maxlength', '500');
    expect(screen.getByRole('textbox', { name: 'Display name' })).toHaveValue('Reader');
    expect(screen.getByRole('textbox', { name: 'Email address (optional)' })).toHaveValue(
      'donor@example.com',
    );
    expect(screen.getByText(/Unused poll money: \$1.00/)).toBeInTheDocument();
    expect(screen.queryByText(/Wallet credit returned/i)).not.toBeInTheDocument();
  });

  it('browses tabs freely with three meters, an overage and an explicit raise action', async () => {
    vi.mocked(getRewards).mockResolvedValue([{ ...reward, cost_cents: 2500 }]);
    renderAt();
    await choose('$5');
    expect(screen.getAllByRole('meter')).toHaveLength(3);
    expect(screen.getByRole('img', { name: 'Digital Reward' })).toHaveAttribute(
      'src',
      '/reward.png',
    );
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(await screen.findByRole('button', { name: 'review →' })).toBeDisabled();
    expect(screen.getByRole('meter', { name: 'reward Pool' })).toHaveAttribute(
      'aria-valuenow',
      '2500',
    );
    expect(screen.getByRole('meter', { name: 'reward Pool' })).toHaveStyle({ color: 'var(--red)' });
    fireEvent.click(screen.getByRole('tab', { name: 'goals' }));
    expect(await screen.findByText(/No active fund goals/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /raise my donation to \$25.00/ }));
    expect(await screen.findByRole('button', { name: 'review →' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'review →' }));
    expect(await screen.findByRole('region', { name: 'rewards review' })).toHaveTextContent(
      '$25.00',
    );
  });

  it('shows donor base plus locked proportional auto rows and live default goal preview', async () => {
    save(
      saved({
        selections: [
          {
            kind: 'POLL_VOTE',
            target_id: 'o1',
            poll_id: 'p1',
            label: 'Runner',
            amount_cents: 200,
            insertion_order: 0,
          },
        ],
      }),
    );
    vi.mocked(getPolls).mockResolvedValue([
      {
        id: 'p1',
        title: 'Runner poll',
        total_votes_cents: 0,
        options: [{ id: 'o1', label: 'Runner', votes_cents: 0 }],
      },
    ]);
    vi.mocked(getDefaultGoalPreview).mockResolvedValue({ goal: { id: 'g1', title: 'Glitch run' } });
    renderAt();
    const polls = await screen.findByRole('region', { name: 'polls review' });
    await waitFor(() => expect(polls).toHaveTextContent('$2.00 + $8.00'));
    expect(polls).toHaveTextContent('auto (locked) — topped up in proportion');
    expect(within(polls).queryByRole('button')).not.toBeInTheDocument();
    expect(await screen.findByText(/now: Glitch run/)).toBeInTheDocument();
  });

  it('recalculates Wallet credit on review and separates new money and shipping', async () => {
    localStorage.setItem('donor_session_active', '1');
    vi.mocked(getDonor).mockResolvedValue({
      id: 'donor',
      email: 'owner@example.com',
      balance_remaining: 975,
      total_donated: 1000,
      donations: [],
      reward_claims: [],
      poll_votes: [],
      fund_contributions: [],
      custom_entries: [],
    });
    save(saved());
    renderAt();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'confirm & pay $0.50' })).toBeEnabled(),
    );
    expect(screen.getByText('Wallet credit applied').parentElement).toHaveTextContent('$9.50');
    expect(screen.getByText('New money charged').parentElement).toHaveTextContent('$0.50');
    expect(screen.getByText('Shipping (separate)').parentElement).toHaveTextContent('No shipping');
  });

  it('keeps confirmed physical cost in new money and shows separate shipping', async () => {
    localStorage.setItem('donor_session_active', '1');
    vi.mocked(getDonor).mockResolvedValue({
      id: 'donor',
      email: 'owner@example.com',
      balance_remaining: 2000,
      total_donated: 2000,
      donations: [],
      reward_claims: [],
      poll_votes: [],
      fund_contributions: [],
      custom_entries: [],
    });
    vi.mocked(getRewards).mockResolvedValue([{ ...reward, type: 'PHYSICAL' }]);
    save(
      saved({
        selections: [
          {
            kind: 'REWARD',
            target_id: 'r1',
            amount_cents: 500,
            label: 'Digital Reward',
            unit_price_cents: 500,
            reward_type: 'PHYSICAL',
            insertion_order: 0,
          },
        ],
      }),
    );
    renderAt();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'confirm & pay $5.00 + shipping' })).toBeEnabled(),
    );
    expect(screen.getByText('Wallet credit applied').parentElement).toHaveTextContent('$5.00');
    expect(screen.getByText('New money charged').parentElement).toHaveTextContent('$5.00');
    expect(screen.getByText('Shipping (separate)').parentElement).toHaveTextContent(
      'outside the pledge and Pools',
    );
  });

  it('uses pooled donor plus auto amounts in poll and goal impact previews', async () => {
    save(
      saved({
        lastStep: 'browse',
        tab: 'polls',
        selections: [
          {
            kind: 'POLL_VOTE',
            target_id: 'o1',
            poll_id: 'p1',
            label: 'Runner',
            amount_cents: 200,
            insertion_order: 0,
          },
          {
            kind: 'GOAL',
            target_id: 'g1',
            label: 'Glitch run',
            amount_cents: 200,
            insertion_order: 1,
          },
        ],
      }),
    );
    vi.mocked(getPolls).mockResolvedValue([
      {
        id: 'p1',
        title: 'Poll',
        total_votes_cents: 1000,
        options: [{ id: 'o1', label: 'Runner', votes_cents: 100 }],
      },
    ]);
    vi.mocked(getGoals).mockResolvedValue([
      { id: 'g1', title: 'Glitch run', current_cents: 500, target_cents: 2000 },
    ]);
    renderAt('/donate');
    expect(parseFloat((await screen.findByTestId('progress-preview')).style.width)).toBeCloseTo(55);
    fireEvent.click(screen.getByRole('tab', { name: 'goals' }));
    expect(await screen.findByTestId('progress-preview')).toHaveStyle({ width: '75%' });
  });

  it('includes an auto-approved write-in in the poll impact denominator', async () => {
    save(
      saved({
        lastStep: 'browse',
        tab: 'polls',
        selections: [
          {
            kind: 'POLL_VOTE',
            target_id: 'o1',
            poll_id: 'p1',
            amount_cents: 500,
            insertion_order: 0,
          },
          {
            kind: 'POLL_CUSTOM',
            target_id: 'p1',
            poll_id: 'p1',
            amount_cents: 500,
            insertion_order: 1,
            data: { label: 'Write-in' },
            label: 'Write-in',
          },
        ],
      }),
    );
    vi.mocked(getPolls).mockResolvedValue([
      {
        id: 'p1',
        title: 'Poll',
        total_votes_cents: 1000,
        allow_custom_entries: true,
        auto_approve: true,
        options: [{ id: 'o1', label: 'Runner', votes_cents: 100 }],
      },
    ]);
    renderAt('/donate');
    expect(await screen.findByTestId('progress-preview')).toHaveStyle({ width: '30%' });
  });

  it('requires explicit reconfirmation of a corrected server plan, with no automatic second checkout', async () => {
    save(saved());
    const corrected = planPledge({
      pledge_amount_cents: 1000,
      selections: [],
      available_wallet_cents: 500,
    });
    vi.mocked(createPledge).mockRejectedValueOnce({
      response: {
        status: 409,
        data: {
          error: 'The pledge plan changed. Confirm the corrected review.',
          plan: corrected,
          items: [],
        },
      },
    });
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'confirm & pay $10.00' }));
    expect(
      await screen.findByRole('button', { name: 'confirm corrected review' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'confirm & pay $5.00' })).toBeDisabled();
    expect(createPledge).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'Still confirming' },
    });
    expect(screen.getByRole('button', { name: 'confirm & pay $5.00' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'confirm corrected review' }));
    expect(screen.getByRole('button', { name: 'confirm & pay $5.00' })).toBeEnabled();
    vi.mocked(createPledge).mockResolvedValue(
      payment({
        draft_id: 'draft-one',
        payment_state: 'READY',
        has_checkout: false,
        plan: corrected,
        pledge_amount_cents: 1000,
      }),
    );
    vi.mocked(reconcilePledge).mockResolvedValue(payment({ payment_state: 'READY' }));
    fireEvent.click(screen.getByRole('button', { name: 'confirm & pay $5.00' }));
    expect(await screen.findByRole('heading', { name: /Pending pledge/ })).toBeInTheDocument();
    expect(createPledge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        draft_id: 'draft-one',
        plan: corrected,
        pledge_amount_cents: 1000,
        items: [],
      }),
    );
    expect(localStorage.getItem('donation_draft_v1')).toContain('pending-one');
  });

  it('shows blocked-word validation without deleting the draft, and accepts Anonymous', async () => {
    save(saved());
    vi.mocked(createPledge).mockRejectedValue({
      response: { status: 400, data: { error: 'Entry contains blocked word: "blocked"' } },
    });
    renderAt();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /confirm & pay/i })).toBeEnabled(),
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), {
      target: { value: 'blocked' },
    });
    fireEvent.click(screen.getByRole('button', { name: /confirm & pay/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Entry contains blocked word');
    expect(createPledge).toHaveBeenCalledWith(
      expect.objectContaining({ display_name: undefined, comment: 'blocked' }),
    );
    expect(localStorage.getItem('donation_draft_v1')).toContain('blocked');
  });

  it('restores the last step and Channel from Navbar resume after leaving donate', async () => {
    save(
      saved({
        lastStep: 'browse',
        tab: 'goals',
        path: '/donate/marathon/main',
        eventSlug: 'marathon',
        amountCents: 2500,
      }),
    );
    vi.mocked(getPublicEvent).mockResolvedValue({
      id: 'e1',
      name: 'Marathon',
      slug: 'marathon',
      primary_channel_id: 'c1',
      channels: [channel],
    });
    renderAt('/');
    fireEvent.click(await screen.findByRole('link', { name: 'resume $25.00 donation' }));
    expect(await screen.findByRole('tab', { name: 'goals' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(await screen.findByText(/No active fund goals/)).toBeInTheDocument();
  });

  it.each(['rewards', 'polls', 'goals'] as const)(
    'redirects old %s links with their query to the matching free tab',
    async (tab) => {
      renderAt(`/${tab}?channel=c1&amount=3`);
      await choose();
      expect(await screen.findByRole('tab', { name: tab })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    },
  );

  it('expires an editable draft 24 hours after its last edit, but not a pending payment', async () => {
    save(saved({ updatedAt: Date.now() - 24 * 60 * 60 * 1000 }));
    renderAt();
    expect(await screen.findByRole('button', { name: /choose incentives/ })).toBeInTheDocument();
    expect(localStorage.getItem('donation_draft_v1')).toBeNull();
  });

  it('expires an idle editable draft at its 24-hour deadline while the page remains open', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      save(saved({ lastStep: 'browse', updatedAt: Date.now() - 24 * 60 * 60 * 1000 + 1000 }));
      renderAt('/donate');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(screen.getByRole('button', { name: 'edit amount $10.00' })).toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByRole('button', { name: /choose incentives/ })).toBeInTheDocument();
      expect(localStorage.getItem('donation_draft_v1')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves an expired local pending draft before ANY catalog repair and renders the immutable server message, name and amount', async () => {
    save(
      saved({
        updatedAt: Date.now() - 48 * 60 * 60 * 1000,
        amountCents: 1000,
        comment: 'Local comment',
        displayName: 'Local name',
        pendingToken: 'pending-one',
      }),
    );
    const pending = deferred<Pledge>();
    vi.mocked(reconcilePledge).mockReturnValue(pending.promise);
    renderAt('/donate?channel=c2&reward=deleted');
    expect(screen.getByText(/Checking payment before loading/)).toBeInTheDocument();
    expect(getRewards).not.toHaveBeenCalled();
    expect(getChannels).not.toHaveBeenCalled();
    await act(async () => pending.resolve(payment()));
    expect(await screen.findByText('Display name: Server name')).toBeInTheDocument();
    expect(screen.getByText('Message: Server message')).toBeInTheDocument();
    expect(screen.getByText('Pledge amount').parentElement).toHaveTextContent('$25.00');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(getRewards).not.toHaveBeenCalled();
    expect(localStorage.getItem('donation_draft_v1')).toContain('pending-one');
  });

  it('retains read-only review and blocks new checkout after a failed cancellation; only confirmed NON_PAYMENT permits editing', async () => {
    save(saved({ pendingToken: 'pending-one' }));
    vi.mocked(reconcilePledge).mockResolvedValue(payment({ can_continue: true }));
    vi.mocked(cancelPledge).mockRejectedValueOnce({
      response: { status: 409, data: { error: 'Still open', pledge: payment() } },
    });
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: /edit — cancel/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Still open');
    expect(screen.queryByRole('button', { name: /confirm & pay/ })).not.toBeInTheDocument();
    expect(getRewards).not.toHaveBeenCalled();
    expect(createPledge).not.toHaveBeenCalled();
    vi.mocked(cancelPledge).mockResolvedValue(
      payment({
        status: 'CANCELLED',
        payment_state: 'NON_PAYMENT',
        can_edit: true,
        read_only: false,
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: /edit — cancel/ }));
    expect(await screen.findByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(await screen.findByText(/No payment was taken/)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /confirm & pay/ })).toBeEnabled(),
    );
    expect(localStorage.getItem('donation_draft_v1')).not.toContain('pending-one');
  });

  it('continues only the existing checkout through the continue API, without creating another pledge', async () => {
    save(saved({ pendingToken: 'pending-one' }));
    vi.mocked(reconcilePledge).mockResolvedValue(payment({ can_continue: true }));
    vi.mocked(continuePledge).mockResolvedValue(
      payment({ payment_state: 'PROCESSING', can_continue: false }),
    );
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'continue to payment' }));
    expect(await screen.findByText(/Editing and new checkout are blocked/)).toBeInTheDocument();
    expect(continuePledge).toHaveBeenCalledWith('pending-one');
    expect(createPledge).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'continue to payment' })).not.toBeInTheDocument();
  });

  it.each(['PROCESSING', 'UNKNOWN'] as const)(
    'does not permit a new checkout or Channel switch while %s',
    async (state) => {
      save(saved({ pendingToken: 'pending-one' }));
      vi.mocked(reconcilePledge).mockResolvedValue(payment({ payment_state: state }));
      renderAt();
      expect(await screen.findByText(/Editing and new checkout are blocked/)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Main' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /confirm & pay/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'continue to payment' })).not.toBeInTheDocument();
    },
  );

  it('keeps a pending token read-only on reconciliation errors, rather than repairing or expiring it locally', async () => {
    save(saved({ pendingToken: 'pending-one' }));
    vi.mocked(reconcilePledge).mockRejectedValue(new Error('offline'));
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Editing and new checkout are blocked',
    );
    expect(getRewards).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(localStorage.getItem('donation_draft_v1')).toContain('pending-one');
  });

  it('clears only a matching FULFILLED draft and shows confirmation once when resuming', async () => {
    save(saved({ pendingToken: 'pending-one' }));
    vi.mocked(reconcilePledge).mockResolvedValue(
      payment({ status: 'FULFILLED', payment_state: 'FULFILLED' }),
    );
    const rendered = renderAt();
    expect(await screen.findByText('Your $25.00 donation went through.')).toBeInTheDocument();
    expect(localStorage.getItem('donation_draft_v1')).toBeNull();
    expect(localStorage.getItem('donor_session_active')).toBeNull();
    rendered.unmount();
    renderAt();
    expect(await screen.findByRole('button', { name: /choose incentives/ })).toBeInTheDocument();
    expect(screen.queryByText('Your $25.00 donation went through.')).not.toBeInTheDocument();
  });

  it.each(['PAYMENT_REVIEW', 'LEGACY_PAID'] as const)(
    'preserves the draft and distinguishes %s from original fulfillment',
    async (state) => {
      save(saved({ pendingToken: 'pending-one' }));
      vi.mocked(reconcilePledge).mockResolvedValue(
        state === 'LEGACY_PAID'
          ? {
              ...payment(),
              format: 'LEGACY',
              total_cents: 1000,
              top_up_cents: 0,
              payment_state: state,
              status: state,
            }
          : payment({ payment_state: state, status: state, admin_review_required: true }),
      );
      renderAt();
      expect(await screen.findByText(/original incentives were not fulfilled/)).toBeInTheDocument();
      expect(localStorage.getItem('donation_draft_v1')).toContain('pending-one');
      expect(screen.queryByText(/donation went through/)).not.toBeInTheDocument();
    },
  );

  it('ignores a late fulfilled response after a newer draft or pending token arrives from another tab', async () => {
    save(saved({ pendingToken: 'pending-one' }));
    const old = deferred<Pledge>();
    vi.mocked(reconcilePledge)
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(
        payment({
          draft_id: 'draft-two',
          pledge_token: 'pending-two',
          comment: 'New server message',
        }),
      );
    renderAt();
    externalDraft(
      saved({ id: 'draft-two', updatedAt: Date.now() + 10, pendingToken: 'pending-two' }),
    );
    expect(await screen.findByText('Message: New server message')).toBeInTheDocument();
    await act(async () =>
      old.resolve(payment({ status: 'FULFILLED', payment_state: 'FULFILLED' })),
    );
    expect(localStorage.getItem('donation_draft_v1')).toContain('draft-two');
    expect(screen.getByText('Message: New server message')).toBeInTheDocument();
    expect(screen.queryByText(/donation went through/)).not.toBeInTheDocument();
  });

  it('does not let a delayed initial OPEN reconciliation overwrite a later cancellation outcome', async () => {
    save(saved());
    vi.mocked(createPledge).mockResolvedValue(payment({ pledge_amount_cents: 1000 }));
    const initial = deferred<Pledge>();
    vi.mocked(reconcilePledge).mockReturnValue(initial.promise);
    vi.mocked(cancelPledge).mockResolvedValue(payment({ payment_state: 'PROCESSING' }));
    renderAt();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /confirm & pay/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm & pay/ }));
    fireEvent.click(await screen.findByRole('button', { name: /edit — cancel/ }));
    expect(await screen.findByText(/Editing and new checkout are blocked/)).toBeInTheDocument();
    await act(async () => initial.resolve(payment({ can_continue: true })));
    expect(screen.getByText(/Editing and new checkout are blocked/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'continue to payment' })).not.toBeInTheDocument();
  });

  it('sign-out invalidates deferred create results and never cancels a server payment', async () => {
    save(saved());
    const create = deferred<PledgeResult>();
    vi.mocked(createPledge).mockReturnValue(create.promise);
    renderAt();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /confirm & pay/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm & pay/ }));
    localStorage.removeItem('donor_session_active');
    fireEvent(window, new Event('donor-token-changed'));
    await act(async () => create.resolve(payment()));
    expect(localStorage.getItem('donation_draft_v1')).toBeNull();
    expect(await screen.findByRole('button', { name: /choose incentives/ })).toBeInTheDocument();
    expect(cancelPledge).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: /Pending pledge/ })).not.toBeInTheDocument();
  });

  it('sign-out does not allow a late reconcile response to restore or fulfill the deleted draft', async () => {
    save(saved({ pendingToken: 'pending-one' }));
    const old = deferred<Pledge>();
    vi.mocked(reconcilePledge).mockReturnValue(old.promise);
    renderAt();
    fireEvent(window, new Event('donor-token-changed'));
    await act(async () =>
      old.resolve(payment({ status: 'FULFILLED', payment_state: 'FULFILLED' })),
    );
    expect(localStorage.getItem('donation_draft_v1')).toBeNull();
    expect(await screen.findByRole('button', { name: /choose incentives/ })).toBeInTheDocument();
    expect(screen.queryByText(/donation went through/)).not.toBeInTheDocument();
    expect(cancelPledge).not.toHaveBeenCalled();
  });

  it('clears the matching local pending draft on the payment return without auto-authentication', async () => {
    save(saved({ pendingToken: 'pending-one' }));
    // The provider check remains unresolved; the routed return confirms payment.
    vi.mocked(reconcilePledge).mockReturnValue(new Promise(() => {}));
    vi.mocked(getPledge).mockResolvedValue(
      payment({ status: 'FULFILLED', payment_state: 'FULFILLED' }),
    );
    renderAt('/pledge/pending-one');
    expect(await screen.findByText(/Your pledge has been fulfilled/)).toBeInTheDocument();
    expect(localStorage.getItem('donation_draft_v1')).toBeNull();
    expect(localStorage.getItem('donor_session_active')).toBeNull();
  });

  it('repairs every unavailable editable selection on load, reduces stock, uses current prices and never raises the amount', async () => {
    save(
      saved({
        amountCents: 1000,
        selections: [
          {
            kind: 'REWARD',
            target_id: 'r1',
            label: 'Digital Reward',
            amount_cents: 1500,
            quantity: 3,
            insertion_order: 0,
            unit_price_cents: 500,
            reward_type: 'DIGITAL',
            channel_id: null,
          },
          {
            kind: 'REWARD',
            target_id: 'sold',
            label: 'Sold reward',
            amount_cents: 500,
            insertion_order: 1,
            unit_price_cents: 500,
            reward_type: 'DIGITAL',
          },
          {
            kind: 'REWARD',
            target_id: 'deleted',
            label: 'Deleted reward',
            amount_cents: 500,
            insertion_order: 2,
            unit_price_cents: 500,
            reward_type: 'DIGITAL',
          },
          {
            kind: 'POLL_VOTE',
            target_id: 'reject',
            poll_id: 'p1',
            label: 'Rejected option',
            amount_cents: 500,
            insertion_order: 3,
          },
          {
            kind: 'POLL_VOTE',
            target_id: 'missing',
            poll_id: 'p1',
            label: 'Deleted option',
            amount_cents: 500,
            insertion_order: 4,
          },
          {
            kind: 'POLL_CUSTOM',
            target_id: 'closed',
            poll_id: 'closed',
            label: 'Ended poll',
            amount_cents: 500,
            insertion_order: 5,
          },
          {
            kind: 'GOAL',
            target_id: 'g1',
            label: 'Completed goal',
            amount_cents: 500,
            insertion_order: 6,
          },
          {
            kind: 'GOAL',
            target_id: 'missing',
            label: 'Deleted goal',
            amount_cents: 500,
            insertion_order: 7,
          },
        ],
      }),
    );
    vi.mocked(getRewards).mockResolvedValue([
      { ...reward, cost_cents: 1500, quantity_total: 2, quantity_claimed: 0 },
      { ...reward, id: 'sold', title: 'Sold reward', quantity_claimed: 5 },
    ]);
    vi.mocked(getPolls).mockResolvedValue([
      {
        id: 'p1',
        title: 'Poll',
        options: [{ id: 'reject', label: 'Rejected option', status: 'REJECTED', votes_cents: 0 }],
        total_votes_cents: 0,
      },
      {
        id: 'closed',
        title: 'Ended poll',
        ends_at: '2000-01-01',
        options: [],
        total_votes_cents: 0,
      },
    ]);
    vi.mocked(getGoals).mockResolvedValue([
      {
        id: 'g1',
        title: 'Completed goal',
        current_cents: 500,
        target_cents: 500,
        is_complete: true,
      },
    ]);
    renderAt();
    expect(await screen.findByText('Digital Reward: quantity reduced to 2')).toBeInTheDocument();
    expect(screen.getByText('Digital Reward: current price/type applied')).toBeInTheDocument();
    expect(screen.getByText('Sold reward: Sold out')).toBeInTheDocument();
    expect(screen.getByText('Deleted reward: No longer available')).toBeInTheDocument();
    expect(screen.getByText('Rejected option: Option rejected or deleted')).toBeInTheDocument();
    expect(screen.getByText('Deleted option: Option rejected or deleted')).toBeInTheDocument();
    expect(screen.getByText('Ended poll: Poll closed or deleted')).toBeInTheDocument();
    expect(screen.getByText('Completed goal: Goal closed or deleted')).toBeInTheDocument();
    expect(screen.getByText('Deleted goal: Goal closed or deleted')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'rewards review' })).toHaveTextContent(
      '2× Digital Reward$30.00',
    );
    expect(screen.getByText('Pledge amount').parentElement).toHaveTextContent('$10.00');
    expect(screen.getByRole('button', { name: /confirm & pay/ })).toBeDisabled();
  });

  it('drops an unavailable Channel own item but keeps shared items and amount, reopening the picker even on its saved slug path', async () => {
    save(
      saved({
        path: '/donate/marathon/main',
        eventSlug: 'marathon',
        selections: [
          {
            kind: 'REWARD',
            target_id: 'own',
            label: 'Own item',
            channel_id: 'c1',
            amount_cents: 500,
            insertion_order: 0,
            unit_price_cents: 500,
            reward_type: 'DIGITAL',
          },
          {
            kind: 'REWARD',
            target_id: 'r1',
            label: 'Digital Reward',
            channel_id: null,
            amount_cents: 500,
            insertion_order: 1,
            unit_price_cents: 500,
            reward_type: 'DIGITAL',
          },
        ],
      }),
    );
    vi.mocked(getRewards).mockResolvedValue([reward]);
    vi.mocked(getChannels).mockResolvedValue([
      { ...channel, id: 'c2', name: 'Side', slug: 'side' },
    ]);
    vi.mocked(getPublicEvent).mockResolvedValue({
      id: 'e1',
      name: 'Marathon',
      slug: 'marathon',
      primary_channel_id: 'c2',
      channels: [{ ...channel, id: 'c2', slug: 'side' }],
    });
    renderAt('/donate/marathon/main');
    expect(await screen.findByText(/Channel is no longer available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Side' })).toBeInTheDocument();
    expect(screen.getByText('Pledge amount').parentElement).toHaveTextContent('$10.00');
    expect(screen.getByRole('region', { name: 'rewards review' })).toHaveTextContent(
      'Digital Reward',
    );
    expect(screen.queryByText('Own item')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm & pay/ })).toBeDisabled();
  });

  it('keeps Channel-switch confirmation and shared selections while dropping only the old Channel items', async () => {
    save(
      saved({
        lastStep: 'browse',
        selections: [
          {
            kind: 'REWARD',
            target_id: 'own',
            channel_id: 'c1',
            label: 'Own item',
            amount_cents: 500,
            insertion_order: 0,
            unit_price_cents: 500,
            reward_type: 'DIGITAL',
          },
          {
            kind: 'REWARD',
            target_id: 'r1',
            channel_id: null,
            label: 'Digital Reward',
            amount_cents: 500,
            insertion_order: 1,
            unit_price_cents: 500,
            reward_type: 'DIGITAL',
          },
        ],
      }),
    );
    vi.mocked(getRewards).mockResolvedValue([
      reward,
      { ...reward, id: 'own', title: 'Own item', channel_id: 'c1' },
    ]);
    vi.mocked(getChannels).mockResolvedValue([
      channel,
      { ...channel, id: 'c2', name: 'Side', slug: 'side' },
    ]);
    renderAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Side' }));
    expect(
      await screen.findByText(/Shared selections and your pledge amount stay/),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.getByText('Own item')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Side' }));
    fireEvent.click(screen.getByRole('button', { name: /switch & clear/ }));
    expect(screen.queryByText('Own item')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'increase quantity' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'edit amount $10.00' })).toBeInTheDocument();
  });

  it('repairs at review when a previously displayed goal closes, and retains permalink prefill', async () => {
    vi.mocked(getGoals).mockResolvedValue([
      { id: 'g1', title: 'Glitch run', current_cents: 0, target_cents: 10000 },
    ]);
    renderAt('/goals?goal=g1&amount=3&channel=c1');
    await choose();
    expect(await screen.findByRole('button', { name: 'remove' })).toBeInTheDocument();
    vi.mocked(getGoals).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'review →' }));
    expect(await screen.findByText('Glitch run: Goal closed or deleted')).toBeInTheDocument();
    expect(screen.getByText('Pledge amount').parentElement).toHaveTextContent('$10.00');
    expect(screen.getByRole('region', { name: 'fund goals review' })).not.toHaveTextContent(
      'Glitch run',
    );
  });

  it('blocks payment when authenticated Wallet availability cannot be refreshed, and permits it after a successful retry', async () => {
    localStorage.setItem('donor_session_active', '1');
    save(saved());
    vi.mocked(getDonor).mockRejectedValue(new Error('offline'));
    renderAt();
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh the review');
    expect(screen.getByRole('button', { name: /confirm & pay/ })).toBeDisabled();
    vi.mocked(getDonor).mockResolvedValue({
      id: 'donor',
      email: 'owner@example.com',
      balance_remaining: 500,
      total_donated: 1000,
      donations: [],
      reward_claims: [],
      poll_votes: [],
      fund_contributions: [],
      custom_entries: [],
    });
    fireEvent.click(screen.getByRole('button', { name: 'refresh review' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'confirm & pay $5.00' })).toBeEnabled(),
    );
  });

  it('does not treat a queued old deletion as deletion of the newer durable draft', async () => {
    const d = saved({ lastStep: 'browse' });
    save(d);
    renderAt();
    await screen.findByRole('meter', { name: 'reward Pool' });
    externalDraft({ ...d, amountCents: 5000, updatedAt: d.updatedAt + 100 });
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: 'donation_draft_v1',
        newValue: null,
        storageArea: localStorage,
      }),
    );
    expect(screen.getByRole('button', { name: 'edit amount $50.00' })).toBeInTheDocument();
  });

  it('refreshes the session epoch on cross-tab sign-in and ignores a pre-sign-in create reply', async () => {
    save(saved());
    const old = deferred<PledgeResult>();
    vi.mocked(createPledge).mockReturnValue(old.promise);
    renderAt();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /confirm & pay/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /confirm & pay/ }));
    localStorage.setItem('donor_session_active', '1');
    fireEvent(
      window,
      new StorageEvent('storage', {
        key: 'donor_session_active',
        newValue: '1',
        storageArea: localStorage,
      }),
    );
    await act(async () => old.resolve(payment()));
    expect(localStorage.getItem('donation_draft_v1')).not.toContain('pending-one');
    expect(screen.queryByRole('heading', { name: /Pending pledge/ })).not.toBeInTheDocument();
  });

  it('uses the last edit across tabs, ignoring older changes and accepting deletion', async () => {
    const d = saved({ lastStep: 'browse' });
    save(d);
    renderAt();
    await screen.findByRole('meter', { name: 'reward Pool' });
    externalDraft({ ...d, updatedAt: d.updatedAt + 100, amountCents: 5000 });
    expect(await screen.findByRole('button', { name: 'edit amount $50.00' })).toBeInTheDocument();
    externalDraft({ ...d, updatedAt: d.updatedAt + 1, amountCents: 500 });
    expect(screen.getByRole('button', { name: 'edit amount $50.00' })).toBeInTheDocument();
    expect(localStorage.getItem('donation_draft_v1')).toContain('5000');
    externalDraft(null);
    expect(await screen.findByRole('button', { name: /choose incentives/ })).toBeInTheDocument();
  });
});
