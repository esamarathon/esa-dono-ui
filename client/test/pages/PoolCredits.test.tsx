import { beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { DraftPledgeProvider } from '../../src/context/DraftPledgeContext';
import MyWallet from '../../src/pages/MyWallet';
import type { CreditAmounts, CreditEvent } from '@dono/shared';
vi.mock('../../src/api/donor', () => ({
  getDonor: vi.fn(),
  getPoolCredits: vi.fn(),
  getPoolCreditEvent: vi.fn(),
  applyPoolCredits: vi.fn(),
  requestToken: vi.fn(),
}));
vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/channels', () => ({
  getChannels: vi
    .fn()
    .mockResolvedValue([{ id: 'c1', name: 'Main', slug: 'main', event_id: 'e1', is_active: true }]),
}));
vi.mock('../../src/api/pledge', () => ({
  getDefaultGoalPreview: vi.fn().mockResolvedValue({ goal: null }),
  reconcilePledge: vi.fn(),
}));
vi.mock('../../src/lib/tracing', () => ({ track: vi.fn(), identifyDonor: vi.fn() }));
import {
  getDonor,
  getPoolCredits,
  getPoolCreditEvent,
  applyPoolCredits,
} from '../../src/api/donor';
function creditScenario({
  walletCents,
  outstandingCents,
  availableCents,
  rewardPriceCents,
  rewardStock,
  pollHistoryCents,
}: Readonly<{
  walletCents: number;
  outstandingCents: CreditAmounts;
  availableCents: CreditAmounts;
  rewardPriceCents: number;
  rewardStock: number;
  pollHistoryCents: number;
}>) {
  const event: CreditEvent = {
    event: { id: 'e1', name: 'ESA Summer', slug: 'summer', ended_at: null },
    outstanding_cents: outstandingCents,
    available_cents: availableCents,
    reasons: { reward: null, poll: null, goal: null },
    catalog: {
      rewards: [
        {
          id: 'r1',
          title: 'Digital reward',
          cost_cents: rewardPriceCents,
          type: 'DIGITAL',
          remaining: rewardStock,
          channel: null,
        },
      ],
      polls: [
        {
          id: 'p1',
          title: 'Runner choice',
          channel: { id: 'c2', name: 'Side stream', slug: 'side' },
          total_votes_cents: 0,
          options: [{ id: 'o1', label: 'Glitch', votes_cents: 0 }],
        },
      ],
      goals: [
        { id: 'g1', title: 'Bonus run', channel: null, current_cents: 0, target_cents: 10000 },
      ],
    },
    history:
      pollHistoryCents > 0
        ? [
            {
              id: 'credit1',
              donation_id: 'donation1',
              category: 'poll',
              amount_cents: pollHistoryCents,
              remaining_cents: pollHistoryCents,
              created_at: '2026-01-01',
              cleared_at: null,
              origin: { kind: 'vote', id: 'v1', title: 'Old poll' },
              redemptions: [],
            },
          ]
        : [],
  };
  vi.mocked(getDonor).mockResolvedValue({
    id: 'd1',
    email: 'donor@example.com',
    balance_remaining: walletCents,
    total_donated: 0,
    donations: [],
    reward_claims: [],
    poll_votes: [],
    fund_contributions: [],
    custom_entries: [],
  });
  vi.mocked(getPoolCredits).mockResolvedValue({
    wallet_credit_cents: walletCents,
    events: [event],
  });
  vi.mocked(getPoolCreditEvent).mockResolvedValue(event);
  return event;
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/wallet']}>
      <DraftPledgeProvider>
        <Link to="/away">leave page</Link>
        <Link to="/wallet">credits page</Link>
        <Routes>
          <Route path="/wallet" element={<MyWallet />} />
          <Route path="/away" element={<p>Away</p>} />
        </Routes>
      </DraftPledgeProvider>
    </MemoryRouter>,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(applyPoolCredits).mockReset();
});
it('unconfirmed choices clear on leaving/re-entering under the same real provider', async () => {
  creditScenario({
    walletCents: 0,
    outstandingCents: { reward: 0, poll: 1000, goal: 0 },
    availableCents: { reward: 0, poll: 1000, goal: 0 },
    rewardPriceCents: 1000,
    rewardStock: 1,
    pollHistoryCents: 1000,
  });
  renderPage();
  fireEvent.change(await screen.findByLabelText('Glitch amount'), { target: { value: '0.02' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set Glitch' }));
  fireEvent.click(screen.getByRole('link', { name: 'leave page' }));
  await screen.findByText('Away');
  fireEvent.click(screen.getByRole('link', { name: 'credits page' }));
  expect(await screen.findByLabelText('Glitch amount')).toHaveValue('');
  expect(localStorage.getItem('donation_draft_v1')).toBeNull();
  expect(applyPoolCredits).not.toHaveBeenCalled();
});
it('stale batch error applies nothing in the page and requires a refreshed review', async () => {
  creditScenario({
    walletCents: 0,
    outstandingCents: { reward: 1000, poll: 0, goal: 0 },
    availableCents: { reward: 1000, poll: 0, goal: 0 },
    rewardPriceCents: 1000,
    rewardStock: 1,
    pollHistoryCents: 0,
  });
  vi.mocked(applyPoolCredits).mockRejectedValueOnce({
    response: { status: 409, data: { error: 'Reward price changed; refresh and review' } },
  });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Add Digital reward' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review 1 pick' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply credits' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Reward price changed');
  expect(screen.getByRole('button', { name: 'Apply credits' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh and review again' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Digital reward quantity')).toHaveTextContent('0'),
  );
  expect(screen.queryByRole('button', { name: 'Apply credits' })).not.toBeInTheDocument();
});
it('lost response retains the frozen batch key and choices for a safe retry', async () => {
  creditScenario({
    walletCents: 0,
    outstandingCents: { reward: 1000, poll: 0, goal: 0 },
    availableCents: { reward: 1000, poll: 0, goal: 0 },
    rewardPriceCents: 1000,
    rewardStock: 1,
    pollHistoryCents: 0,
  });
  vi.mocked(applyPoolCredits)
    .mockRejectedValueOnce(new Error('Lost response'))
    .mockResolvedValue({
      batch_id: 'batch1',
      spent_cents: { reward: 1000, poll: 0, goal: 0 },
      claim_ids: ['claim1'],
      vote_ids: [],
      contribution_ids: [],
      donation_ids: ['donation1'],
    });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Add Digital reward' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review 1 pick' }));
  fireEvent.click(screen.getByRole('button', { name: 'Apply credits' }));
  await screen.findByText(/response was not confirmed/);
  expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Apply credits' }));
  await screen.findByText(/Credits applied/);
  expect(vi.mocked(applyPoolCredits).mock.calls[1]).toEqual(
    vi.mocked(applyPoolCredits).mock.calls[0],
  );
});
it('positive credit with no eligible item remains visible with its reason and Wallet stays separate', async () => {
  const event = creditScenario({
    walletCents: 123,
    outstandingCents: { reward: 34, poll: 1000, goal: 0 },
    availableCents: { reward: 34, poll: 1000, goal: 0 },
    rewardPriceCents: 1000,
    rewardStock: 1,
    pollHistoryCents: 1000,
  });
  vi.mocked(getPoolCreditEvent).mockResolvedValue({
    ...event,
    catalog: { rewards: [], polls: [], goals: [] },
    reasons: {
      reward: 'No affordable open non-physical reward; the remainder stays credit.',
      poll: 'No open incentive accepts this category; your credit remains available.',
      goal: null,
    },
  });
  renderPage();
  expect(await screen.findByText(/No affordable open/)).toBeInTheDocument();
  expect(screen.getByLabelText('Mobile credit balances')).toHaveTextContent('Rewards $0.34 left');
  expect(screen.getByText(/Wallet credit \$1.23/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Apply credits' })).not.toBeInTheDocument();
});
it('ended credits show positive recorded amounts and the conversion reason without permitting another spend', async () => {
  const event = creditScenario({
    walletCents: 0,
    outstandingCents: { reward: 1000, poll: 1000, goal: 1000 },
    availableCents: { reward: 0, poll: 0, goal: 0 },
    rewardPriceCents: 1000,
    rewardStock: 1,
    pollHistoryCents: 1000,
  });
  vi.mocked(getPoolCreditEvent).mockResolvedValue({
    ...event,
    event: { ...event.event, ended_at: '2026-01-02' },
    reasons: {
      reward: 'Event ended: reward Pool credit expired.',
      poll: 'Event ended: this Pool credit is now Unused pool money.',
      goal: 'Event ended: this Pool credit is now Unused pool money.',
    },
  });
  renderPage();
  expect(await screen.findByText(/reward Pool credit expired/)).toHaveTextContent(
    '$10.00 recorded Pool credit',
  );
  const button = screen.getByRole('button', { name: 'Add Digital reward' });
  expect(button).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Apply credits' })).not.toBeInTheDocument();
});
it('invalid fractional-cent input and over-budget allocations cannot be reviewed', async () => {
  creditScenario({
    walletCents: 0,
    outstandingCents: { reward: 0, poll: 1000, goal: 0 },
    availableCents: { reward: 0, poll: 1000, goal: 0 },
    rewardPriceCents: 1000,
    rewardStock: 1,
    pollHistoryCents: 1000,
  });
  renderPage();
  const input = await screen.findByLabelText('Glitch amount');
  fireEvent.change(input, { target: { value: '0.001' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set Glitch' }));
  expect(screen.getByRole('alert')).toHaveTextContent('at most two decimal places');
  fireEvent.change(input, { target: { value: '10.01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set Glitch' }));
  expect(screen.getByRole('button', { name: 'Review 1 pick' })).toBeDisabled();
});
it('whole reward minus/plus stops at one unit of stock while credit can fund two', async () => {
  creditScenario({
    walletCents: 0,
    outstandingCents: { reward: 2000, poll: 0, goal: 0 },
    availableCents: { reward: 2000, poll: 0, goal: 0 },
    rewardPriceCents: 1000,
    rewardStock: 1,
    pollHistoryCents: 0,
  });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Add Digital reward' }));
  expect(screen.getByRole('button', { name: 'Add Digital reward' })).toBeDisabled();
  expect(screen.getByLabelText('Digital reward quantity')).toHaveTextContent('1');
  expect(screen.getByLabelText('Mobile credit balances')).toHaveTextContent('Rewards $10.00 left');
  fireEvent.click(screen.getByRole('button', { name: 'Remove Digital reward' }));
  expect(screen.getByLabelText('Digital reward quantity')).toHaveTextContent('0');
  expect(screen.getByRole('button', { name: 'Remove Digital reward' })).toBeDisabled();
});
it('whole reward units stop at category credit while multiple units remain in stock', async () => {
  creditScenario({
    walletCents: 0,
    outstandingCents: { reward: 1000, poll: 0, goal: 0 },
    availableCents: { reward: 1000, poll: 0, goal: 0 },
    rewardPriceCents: 1000,
    rewardStock: 3,
    pollHistoryCents: 0,
  });
  renderPage();
  fireEvent.click(await screen.findByRole('button', { name: 'Add Digital reward' }));
  expect(screen.getByText('3 left')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add Digital reward' })).toBeDisabled();
  expect(screen.getByLabelText('Digital reward quantity')).toHaveTextContent('1');
  expect(screen.getByLabelText('Mobile credit balances')).toHaveTextContent('Rewards $0.00 left');
  fireEvent.click(screen.getByRole('button', { name: 'Remove Digital reward' }));
  expect(screen.getByRole('button', { name: 'Add Digital reward' })).toBeEnabled();
  expect(screen.getByLabelText('Digital reward quantity')).toHaveTextContent('0');
});
it('routed real provider: visible set/max and whole units, one review/apply, history and mobile bar, without changing ordinary draft', async () => {
  creditScenario({
    walletCents: 123,
    outstandingCents: { reward: 1000, poll: 1000, goal: 1000 },
    availableCents: { reward: 1000, poll: 1000, goal: 1000 },
    rewardPriceCents: 1000,
    rewardStock: 1,
    pollHistoryCents: 1000,
  });
  vi.mocked(applyPoolCredits).mockResolvedValue({
    batch_id: 'batch1',
    spent_cents: { reward: 1000, poll: 1, goal: 1000 },
    claim_ids: ['claim1'],
    vote_ids: ['vote1'],
    contribution_ids: ['contribution1'],
    donation_ids: ['donation1'],
  });
  const draft = JSON.stringify({
    id: 'draft-one',
    updatedAt: Date.now(),
    amountCents: 1000,
    selections: [],
    channelId: 'c1',
    eventSlug: null,
    path: '/donate',
    comment: 'Keep draft',
    displayName: 'Name',
    lastStep: 'review',
    tab: 'goals',
    pendingToken: null,
  });
  localStorage.setItem('donation_draft_v1', draft);
  renderPage();
  expect(await screen.findByText('Use your credits')).toBeInTheDocument();
  await screen.findByLabelText('Glitch amount');
  expect(screen.getByLabelText('Mobile credit balances')).toHaveClass('sticky');
  fireEvent.change(screen.getByLabelText('Glitch amount'), { target: { value: '0.01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Set Glitch' }));
  fireEvent.click(screen.getByRole('button', { name: 'Max Bonus run' }));
  fireEvent.click(screen.getByRole('button', { name: 'Add Digital reward' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review 3 picks' }));
  expect(screen.getAllByRole('button', { name: 'Apply credits' })).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Apply credits' }));
  await waitFor(() => expect(applyPoolCredits).toHaveBeenCalledTimes(1));
  const request = vi.mocked(applyPoolCredits).mock.calls[0]![1];
  expect(request.selections).toEqual(
    expect.arrayContaining([
      { kind: 'POLL_VOTE', poll_id: 'p1', target_id: 'o1', amount_cents: 1 },
      { kind: 'GOAL', target_id: 'g1', amount_cents: 1000 },
      {
        kind: 'REWARD',
        target_id: 'r1',
        quantity: 1,
        unit_price_cents: 1000,
        reward_type: 'DIGITAL',
      },
    ]),
  );
  expect(localStorage.getItem('donation_draft_v1')).toBe(draft);
  expect(await screen.findByText(/Credits applied/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Where your credit came from'));
  expect(screen.getByText(/Old poll/)).toBeInTheDocument();
});
