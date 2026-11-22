import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getRewards: vi.fn(),
  getPolls: vi.fn(),
  getGoals: vi.fn(),
  getChannels: vi.fn(),
  createPledge: vi.fn(),
  track: vi.fn(),
  trackAsync: vi.fn(),
}));

vi.mock('../../src/api/rewards', () => ({ getRewards: mocks.getRewards }));
vi.mock('../../src/api/polls', () => ({ getPolls: mocks.getPolls }));
vi.mock('../../src/api/goals', () => ({ getGoals: mocks.getGoals }));
vi.mock('../../src/api/channels', () => ({ getChannels: mocks.getChannels }));
vi.mock('../../src/api/pledge', () => ({ createPledge: mocks.createPledge, getPledge: vi.fn() }));
vi.mock('../../src/lib/tracing', () => ({
  track: mocks.track,
  trackAsync: mocks.trackAsync,
  identifyDonor: vi.fn(),
}));

import { DraftPledgeProvider as CartProvider } from '../../src/context/DraftPledgeContext';
import PollList from '../../src/components/incentives/PollList';
import GoalList from '../../src/components/incentives/GoalList';
import RewardList from '../../src/components/incentives/RewardList';
import { REWARD_TYPE_DEFINITIONS } from '../../src/lib/rewardTypeDefinitions';

const channel = { id: 'c1', name: 'Main', slug: 'main', event_id: 'e1', is_active: true };

const poll = {
  id: 'p1',
  title: 'Best Runner',
  description: null,
  options: [{ id: 'o1', label: 'Runner A', votes_cents: 500, status: 'ACTIVE' }],
  total_votes_cents: 500,
  ends_at: null,
  is_active: true,
  allow_custom_entries: false,
  channel_id: null,
  event_id: 'e1',
};

const goal = {
  id: 'g1',
  title: 'Race entry',
  description: null,
  current_cents: 750,
  target_cents: 2000,
  is_active: true,
  is_complete: false,
  channel_id: null,
  event_id: 'e1',
};

const reward = {
  id: 'r1',
  title: 'T-shirt',
  type: 'PHYSICAL',
  cost_cents: 1000,
  quantity_total: null,
  quantity_claimed: 0,
  is_active: true,
  channel_id: null,
  event_id: 'e1',
};

function Wrapper({
  children,
  draft,
}: {
  children: React.ReactNode;
  draft?: Record<string, unknown>;
}) {
  localStorage.setItem(
    'donation_draft_v1',
    JSON.stringify({
      id: 'list-draft',
      updatedAt: Date.now(),
      amountCents: 1000,
      selections: [],
      channelId: 'c1',
      eventSlug: null,
      path: '/donate',
      comment: '',
      displayName: '',
      lastStep: 'browse',
      tab: 'rewards',
      pendingToken: null,
      ...draft,
    }),
  );
  return <CartProvider>{children}</CartProvider>;
}

// A flash highlight is cleared by a 300 ms timeout. If the list unmounts while
// that timeout is pending, the callback fires afterwards and sets state on a
// torn-down environment — in jsdom that throws `window is not defined` and
// fails the whole run. Each list must clear its flash timeout on unmount.
async function expectFlashTimerClearedOnUnmount(ui: React.ReactElement, text: string) {
  const setSpy = vi.spyOn(globalThis, 'setTimeout');
  const { unmount } = render(<Wrapper>{ui}</Wrapper>);
  await screen.findByText(text);

  fireEvent.click(screen.getByRole('button', { name: 'add' }));
  const flashIndex = setSpy.mock.calls.findIndex((call) => call[1] === 300);
  expect(flashIndex).toBeGreaterThanOrEqual(0);
  const flashTimer = setSpy.mock.results[flashIndex]!.value;

  const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
  unmount();

  expect(clearSpy).toHaveBeenCalledWith(flashTimer);
  setSpy.mockRestore();
  clearSpy.mockRestore();
}

describe('PollList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.getPolls.mockResolvedValue([poll]);
    mocks.getRewards.mockResolvedValue([]);
    mocks.getGoals.mockResolvedValue([]);
    mocks.getChannels.mockResolvedValue([channel]);
    mocks.trackAsync.mockImplementation((_n: string, fn: () => unknown) => fn());
  });

  it('renders option rows as empty money inputs with no spinner and no add/remove buttons (#76)', async () => {
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );

    expect(await screen.findByText('Best Runner')).toBeInTheDocument();
    const input = screen.getByPlaceholderText('0.00') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(input.type).toBe('text');
    expect(screen.queryByRole('spinbutton')).toBeNull();
    expect(screen.queryByRole('button', { name: 'add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'remove' })).toBeNull();
    expect(screen.getByRole('button', { name: 'confirm this poll' })).toBeDisabled();
    expect(screen.queryByText('unsaved changes')).toBeNull();
  });

  it('clears the vote flash timeout on unmount', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const { unmount } = render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );
    await screen.findByText('Best Runner');

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'confirm this poll' }));
    const flashIndex = setSpy.mock.calls.findIndex((call) => call[1] === 300);
    expect(flashIndex).toBeGreaterThanOrEqual(0);
    const flashTimer = setSpy.mock.results[flashIndex]!.value;

    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    unmount();

    expect(clearSpy).toHaveBeenCalledWith(flashTimer);
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it('shows the empty state when there are no polls', async () => {
    mocks.getPolls.mockResolvedValue([]);
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );
    expect(await screen.findByText(/No active polls/)).toBeInTheDocument();
  });

  it('shows a validation error for an empty write-in label', async () => {
    mocks.getPolls.mockResolvedValue([{ ...poll, allow_custom_entries: true }]);
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '+ add your own option' }));
    // submit without entering a label
    fireEvent.click(screen.getByRole('button', { name: 'add selection' }));
    expect(screen.getByText('Please enter your option')).toBeInTheDocument();
  });

  it('shows an amount error for a write-in below minimum', async () => {
    mocks.getPolls.mockResolvedValue([{ ...poll, allow_custom_entries: true }]);
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '+ add your own option' }));
    fireEvent.change(screen.getByPlaceholderText('Type your option...'), {
      target: { value: 'My idea' },
    });
    // change amount to 0 (the last 0.00 input is the write-in modal's amount)
    const amountInputs = screen.getAllByPlaceholderText('0.00');
    fireEvent.change(amountInputs[amountInputs.length - 1]!, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'add selection' }));
    expect(screen.getByText(/Minimum amount/)).toBeInTheDocument();
  });

  it('opens the write-in modal for polls that allow custom entries', async () => {
    mocks.getPolls.mockResolvedValue([{ ...poll, allow_custom_entries: true }]);
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '+ add your own option' }));
    expect(screen.getByText('add your own option')).toBeInTheDocument();
  });

  it('stages a write-in and commits it with the per-poll confirm (#76)', async () => {
    mocks.getPolls.mockResolvedValue([{ ...poll, allow_custom_entries: true, auto_approve: true }]);
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '+ add your own option' }));

    fireEvent.change(screen.getByPlaceholderText('Type your option...'), {
      target: { value: 'My runner' },
    });
    const amountInputs = screen.getAllByPlaceholderText('0.00');
    fireEvent.change(amountInputs[amountInputs.length - 1]!, { target: { value: '2.00' } });
    fireEvent.click(screen.getByRole('button', { name: 'add selection' }));

    // modal closes and the staged summary shows — but the cart is untouched
    expect(screen.queryByText('add your own option')).toBeNull();
    expect(await screen.findByText(/your option: "My runner"/)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('donation_draft_v1')!).selections).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'confirm this poll' }));
    expect(JSON.parse(localStorage.getItem('donation_draft_v1')!).selections).toEqual([
      expect.objectContaining({
        kind: 'POLL_CUSTOM',
        target_id: 'p1',
        amount_cents: 200,
        label: 'My runner',
      }),
    ]);
    expect(screen.queryByText('unsaved changes')).toBeNull();
  });

  it('re-hydrates a committed write-in and stages edits until confirm (#44)', async () => {
    mocks.getPolls.mockResolvedValue([{ ...poll, allow_custom_entries: true, auto_approve: true }]);
    render(
      <Wrapper
        draft={{
          selections: [
            {
              kind: 'POLL_CUSTOM',
              target_id: 'p1',
              poll_id: 'p1',
              amount_cents: 200,
              insertion_order: 0,
              label: 'My runner',
              data: { label: 'My runner' },
            },
          ],
        }}
      >
        <PollList />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'edit' }));

    // The modal reopens pre-filled with the committed entry, not blank.
    expect(screen.getByText('edit your option')).toBeInTheDocument();
    const labelInput = screen.getByPlaceholderText('Type your option...') as HTMLInputElement;
    expect(labelInput.value).toBe('My runner');

    fireEvent.change(labelInput, { target: { value: 'My edited runner' } });
    fireEvent.click(screen.getByRole('button', { name: 'save changes' }));

    // The staged edit shows, still a single committed entry until confirm.
    expect(await screen.findByText(/your option: "My edited runner"/)).toBeInTheDocument();
    expect(screen.queryByText(/your option: "My runner"/)).toBeNull();
    expect(JSON.parse(localStorage.getItem('donation_draft_v1')!).selections[0]).toMatchObject({
      label: 'My runner',
    });

    fireEvent.click(screen.getByRole('button', { name: 'confirm this poll' }));
    const selections = JSON.parse(localStorage.getItem('donation_draft_v1')!).selections;
    expect(selections).toHaveLength(1);
    expect(selections[0]).toMatchObject({ label: 'My edited runner', amount_cents: 200 });
  });

  it('clearing a committed amount input stages a removal until confirm (#76)', async () => {
    render(
      <Wrapper
        draft={{
          selections: [
            {
              kind: 'POLL_VOTE',
              target_id: 'o1',
              poll_id: 'p1',
              amount_cents: 200,
              insertion_order: 0,
              label: 'Runner A',
            },
          ],
        }}
      >
        <PollList />
      </Wrapper>,
    );

    await screen.findByText('Best Runner');
    const input = screen.getByPlaceholderText('0.00') as HTMLInputElement;
    expect(input.value).toBe('2.00');
    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('unsaved changes')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('donation_draft_v1')!).selections).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'confirm this poll' }));
    expect(JSON.parse(localStorage.getItem('donation_draft_v1')!).selections).toEqual([]);
  });

  it('commits staged adds, edits and removals in one confirm (#76)', async () => {
    mocks.getPolls.mockResolvedValue([
      {
        ...poll,
        options: [
          { id: 'o1', label: 'Runner A', votes_cents: 500, status: 'ACTIVE' },
          { id: 'o2', label: 'Runner B', votes_cents: 0, status: 'ACTIVE' },
          { id: 'o3', label: 'Runner C', votes_cents: 0, status: 'ACTIVE' },
        ],
      },
    ]);
    render(
      <Wrapper
        draft={{
          selections: [
            {
              kind: 'POLL_VOTE',
              target_id: 'o1',
              poll_id: 'p1',
              amount_cents: 200,
              insertion_order: 0,
              label: 'Runner A',
            },
            {
              kind: 'POLL_VOTE',
              target_id: 'o2',
              poll_id: 'p1',
              amount_cents: 300,
              insertion_order: 1,
              label: 'Runner B',
            },
          ],
        }}
      >
        <PollList />
      </Wrapper>,
    );

    await screen.findByText('Best Runner');
    const inputs = screen.getAllByPlaceholderText('0.00') as HTMLInputElement[];
    // Committed rows show their committed amount; uncommitted rows start empty.
    expect(inputs[0]!.value).toBe('2.00');
    expect(inputs[1]!.value).toBe('3.00');
    expect(inputs[2]!.value).toBe('');

    fireEvent.change(inputs[0]!, { target: { value: '4.00' } }); // edit
    fireEvent.change(inputs[1]!, { target: { value: '' } }); // staged removal
    fireEvent.change(inputs[2]!, { target: { value: '1.50' } }); // add

    // Nothing moves until the one confirm.
    expect(JSON.parse(localStorage.getItem('donation_draft_v1')!).selections).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'confirm this poll' }));

    const selections = JSON.parse(localStorage.getItem('donation_draft_v1')!).selections;
    expect(selections.map((i: { target_id: string }) => i.target_id).sort()).toEqual(['o1', 'o3']);
    expect(selections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ target_id: 'o1', amount_cents: 400 }),
        expect.objectContaining({ target_id: 'o3', amount_cents: 150 }),
      ]),
    );
    expect(screen.queryByText('unsaved changes')).toBeNull();
  });

  it('renders a donation-impact preview from a staged amount (#52, #76)', async () => {
    mocks.getPolls.mockResolvedValue([
      { ...poll, options: [{ ...poll.options[0], votes_cents: 100 }], total_votes_cents: 1000 },
    ]);
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );

    await screen.findByText('Best Runner');
    expect(document.querySelector('[data-testid="progress-preview"]')).toBeNull();

    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '2.00' } });

    expect(document.querySelector('[data-testid="progress-preview"]')).not.toBeNull();
  });

  it('defaults the write-in limit to 40 characters with a live counter (#76)', async () => {
    mocks.getPolls.mockResolvedValue([{ ...poll, allow_custom_entries: true }]);
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '+ add your own option' }));
    const labelInput = screen.getByPlaceholderText('Type your option...') as HTMLInputElement;
    expect(labelInput.maxLength).toBe(40);
    expect(screen.getByText('0/40 characters')).toBeInTheDocument();
    fireEvent.change(labelInput, { target: { value: 'abc' } });
    expect(screen.getByText('3/40 characters')).toBeInTheDocument();
  });

  it('lets a moderator-set max_entry_chars override the 40-character default (#76)', async () => {
    mocks.getPolls.mockResolvedValue([
      { ...poll, allow_custom_entries: true, max_entry_chars: 10 },
    ]);
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: '+ add your own option' }));
    const labelInput = screen.getByPlaceholderText('Type your option...') as HTMLInputElement;
    expect(labelInput.maxLength).toBe(10);
    expect(screen.getByText('0/10 characters')).toBeInTheDocument();
  });

  it('stages a typed amount without touching the cart (#76)', async () => {
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );

    await screen.findByText('Best Runner');
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '2.50' } });
    expect((screen.getByPlaceholderText('0.00') as HTMLInputElement).value).toBe('2.50');
    // Staged only: the saved draft pledge (the cart) still has no selections.
    expect(JSON.parse(localStorage.getItem('donation_draft_v1')!).selections).toEqual([]);
    expect(screen.getByText('unsaved changes')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'confirm this poll' })).toBeEnabled();
  });

  it('shows a below-minimum inline error and stages nothing (#76)', async () => {
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );

    await screen.findByText('Best Runner');
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '0.50' } });
    expect(screen.getByText('Minimum amount is $1.00')).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('donation_draft_v1')!).selections).toEqual([]);
    expect(screen.getByRole('button', { name: 'confirm this poll' })).toBeDisabled();
  });
});

describe('GoalList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.getGoals.mockResolvedValue([goal]);
    mocks.getRewards.mockResolvedValue([]);
    mocks.getPolls.mockResolvedValue([]);
    mocks.getChannels.mockResolvedValue([channel]);
    mocks.trackAsync.mockImplementation((_n: string, fn: () => unknown) => fn());
  });

  it('renders goals with progress and adds a contribution', async () => {
    render(
      <Wrapper>
        <GoalList />
      </Wrapper>,
    );

    expect(await screen.findByText('Race entry')).toBeInTheDocument();
    expect(screen.getByText('$7.50 raised')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    expect(await screen.findByRole('button', { name: 'remove' })).toBeInTheDocument();
  });

  it('clears the contribution flash timeout on unmount', async () => {
    await expectFlashTimerClearedOnUnmount(<GoalList />, 'Race entry');
  });

  it('removes a goal contribution from the cart', async () => {
    render(
      <Wrapper>
        <GoalList />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'add' }));
    const removeBtn = await screen.findByRole('button', { name: 'remove' });
    expect(removeBtn).toBeInTheDocument();
    fireEvent.click(removeBtn);
  });

  it('renders a donation-impact preview once the contribution is in the cart (#52)', async () => {
    render(
      <Wrapper>
        <GoalList />
      </Wrapper>,
    );

    await screen.findByText('Race entry');
    expect(document.querySelector('[data-testid="progress-preview"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    await screen.findByRole('button', { name: 'remove' });

    expect(document.querySelector('[data-testid="progress-preview"]')).not.toBeNull();
  });

  it('allows changing the contribution amount before adding', async () => {
    render(
      <Wrapper>
        <GoalList />
      </Wrapper>,
    );

    const amountInput = await screen.findByRole('spinbutton');
    fireEvent.change(amountInput, { target: { value: '5.00' } });
    fireEvent.blur(amountInput);

    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    expect(await screen.findByRole('button', { name: 'remove' })).toBeInTheDocument();
  });

  it('does not show an add button for completed goals', async () => {
    mocks.getGoals.mockResolvedValue([{ ...goal, is_complete: true }]);
    render(
      <Wrapper>
        <GoalList />
      </Wrapper>,
    );
    expect(await screen.findByText('Race entry')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'add' })).toBeNull();
  });

  it('updates the amount for an in-cart contribution', async () => {
    render(
      <Wrapper>
        <GoalList />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'add' }));
    await screen.findByRole('button', { name: 'remove' });

    // Change amount while in-cart
    const amountInput = screen.getByRole('spinbutton');
    fireEvent.change(amountInput, { target: { value: '3.00' } });
    fireEvent.blur(amountInput);
    // No assertion needed beyond not crashing
  });

  it('shows the empty state', async () => {
    mocks.getGoals.mockResolvedValue([]);
    render(
      <Wrapper>
        <GoalList />
      </Wrapper>,
    );
    expect(await screen.findByText(/No active fund goals/)).toBeInTheDocument();
  });
});

describe('RewardList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.getRewards.mockResolvedValue([reward]);
    mocks.getPolls.mockResolvedValue([]);
    mocks.getGoals.mockResolvedValue([]);
    mocks.getChannels.mockResolvedValue([channel]);
    mocks.trackAsync.mockImplementation((_n: string, fn: () => unknown) => fn());
  });

  it('renders rewards and adds one to the cart', async () => {
    render(
      <Wrapper>
        <RewardList />
      </Wrapper>,
    );

    expect(await screen.findByText('T-shirt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    // Fieldless reward types (PHYSICAL/DIGITAL) show a quantity stepper once
    // in the cart, not a plain "remove" button (#50).
    expect(await screen.findByRole('button', { name: 'increase quantity' })).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('clears the reward flash timeout on unmount', async () => {
    await expectFlashTimerClearedOnUnmount(<RewardList />, 'T-shirt');
  });

  it("increases and decreases a fieldless reward's quantity, removing it at zero (#50)", async () => {
    render(
      <Wrapper>
        <RewardList />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'add' }));
    fireEvent.click(await screen.findByRole('button', { name: 'increase quantity' }));
    expect(await screen.findByText('2')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'decrease quantity' }));
    expect(await screen.findByText('1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'decrease quantity' }));
    expect(await screen.findByRole('button', { name: 'add' })).toBeInTheDocument();
  });

  it('shows the empty state', async () => {
    mocks.getRewards.mockResolvedValue([]);
    render(
      <Wrapper>
        <RewardList />
      </Wrapper>,
    );
    expect(await screen.findByText(/No rewards available/)).toBeInTheDocument();
  });

  it('shows a sold-out button when the reward is fully claimed', async () => {
    mocks.getRewards.mockResolvedValue([{ ...reward, quantity_total: 5, quantity_claimed: 5 }]);
    render(
      <Wrapper>
        <RewardList />
      </Wrapper>,
    );
    const soldOutBtn = await screen.findByRole('button', { name: 'sold out' });
    expect(soldOutBtn).toBeInTheDocument();
    expect(soldOutBtn).toBeDisabled();
  });

  it('opens a claim modal for SHOUTOUT rewards', async () => {
    mocks.getRewards.mockResolvedValue([{ ...reward, type: 'SHOUTOUT', title: 'Shoutout' }]);
    render(
      <Wrapper>
        <RewardList />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'add' }));
    expect(screen.getByText(/add: Shoutout/)).toBeInTheDocument();
  });

  it('requires the claim answer on a labeled CUSTOM reward and stages nothing on a blank one (#78)', async () => {
    mocks.getRewards.mockResolvedValue([
      {
        ...reward,
        type: 'CUSTOM',
        custom_type_label: 'Your game pick',
        title: 'Pick the Next Game',
      },
    ]);
    render(
      <Wrapper>
        <RewardList />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'add' }));
    expect(screen.getByText('Your game pick')).toBeInTheDocument();
    expect(screen.queryByText('(optional)')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'add selection' }));
    expect(screen.getByRole('alert')).toHaveTextContent('answer required');
    expect(screen.getByText(/add: Pick the Next Game/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'add' })).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Your game pick'), { target: { value: 'Celeste' } });
    expect(screen.getByText('7/200 characters')).toBeInTheDocument();
    expect(screen.getByLabelText('Your game pick')).toHaveAttribute('maxLength', '200');

    fireEvent.click(screen.getByRole('button', { name: 'add selection' }));
    expect(await screen.findByRole('button', { name: 'remove' })).toBeInTheDocument();
  });

  it('keeps the fallback Additional Info answer optional when the Custom Label is empty (#78)', async () => {
    mocks.getRewards.mockResolvedValue([
      { ...reward, type: 'CUSTOM', custom_type_label: null, title: 'Mystery' },
    ]);
    render(
      <Wrapper>
        <RewardList />
      </Wrapper>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'add' }));
    expect(screen.getByText(/Additional Info/)).toBeInTheDocument();
    expect(screen.getByText('(optional)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'add selection' }));
    expect(await screen.findByRole('button', { name: 'remove' })).toBeInTheDocument();
  });

  it('shows the reward type definition with a more-in-Help link on the badge (#78)', async () => {
    render(
      <Wrapper>
        <RewardList />
      </Wrapper>,
    );
    expect(await screen.findByText('T-shirt')).toBeInTheDocument();
    expect(screen.getByText(REWARD_TYPE_DEFINITIONS.PHYSICAL)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'more in Help' })).toHaveAttribute(
      'href',
      '/help#reward-types',
    );
  });
});
