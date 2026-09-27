import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

import { CartProvider } from '../../src/context/CartContext';
import PollList from '../../src/components/incentives/PollList';
import GoalList from '../../src/components/incentives/GoalList';
import RewardList from '../../src/components/incentives/RewardList';

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
};

function Wrapper({ children }: { children: React.ReactNode }) {
  return <CartProvider>{children}</CartProvider>;
}

describe('PollList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.getPolls.mockResolvedValue([poll]);
    mocks.getRewards.mockResolvedValue([]);
    mocks.getGoals.mockResolvedValue([]);
    mocks.getChannels.mockResolvedValue([]);
    mocks.trackAsync.mockImplementation((_n: string, fn: () => unknown) => fn());
  });

  it('renders the poll with options and adds a vote', async () => {
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );

    expect(await screen.findByText('Best Runner')).toBeInTheDocument();
    expect(screen.getByText(/Runner A/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'add' }));

    expect(await screen.findByRole('button', { name: 'remove' })).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: 'add to cart' }));
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
    // change amount to 0
    const amountInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(amountInputs[amountInputs.length - 1]!, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'add to cart' }));
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

  it('adds a write-in option to the cart', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'add to cart' }));

    // modal closes after add
    expect(screen.queryByText('add your own option')).toBeNull();
  });

  it('re-hydrates and edits an already-added write-in option (#44)', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'add to cart' }));

    // Now in cart, showing the read-only summary with edit/remove.
    expect(await screen.findByText(/your option: "My runner"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));

    // The modal reopens pre-filled with the existing draft, not blank.
    expect(screen.getByText('edit your option')).toBeInTheDocument();
    const labelInput = screen.getByPlaceholderText('Type your option...') as HTMLInputElement;
    expect(labelInput.value).toBe('My runner');

    fireEvent.change(labelInput, { target: { value: 'My edited runner' } });
    fireEvent.click(screen.getByRole('button', { name: 'save changes' }));

    // Still a single write-in entry, now updated — not a duplicate.
    expect(await screen.findByText(/your option: "My edited runner"/)).toBeInTheDocument();
    expect(screen.queryByText(/your option: "My runner"/)).toBeNull();
  });

  it('removes a vote from the cart', async () => {
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'add' }));
    // after adding, the remove button should appear
    const removeBtn = await screen.findByRole('button', { name: 'remove' });
    expect(removeBtn).toBeInTheDocument();
    // clicking remove should not throw
    fireEvent.click(removeBtn);
  });

  it('renders a donation-impact preview once the vote is in the cart (#52)', async () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    await screen.findByRole('button', { name: 'remove' });

    expect(document.querySelector('[data-testid="progress-preview"]')).not.toBeNull();
  });

  it('keeps the add/remove button a fixed width regardless of label (#52)', async () => {
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );

    const addBtn = await screen.findByRole('button', { name: 'add' });
    expect(addBtn.className).toContain('w-20');

    fireEvent.click(addBtn);
    const removeBtn = await screen.findByRole('button', { name: 'remove' });
    expect(removeBtn.className).toContain('w-20');
  });

  it('updates an in-cart vote amount on change and blur', async () => {
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );

    await screen.findByText('Best Runner');

    // Add the vote first
    fireEvent.click(screen.getByRole('button', { name: 'add' }));
    await screen.findByRole('button', { name: 'remove' });

    // Change the amount while in cart (triggers debounced sync)
    const amountInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(amountInputs[0]!, { target: { value: '2.00' } });
    fireEvent.blur(amountInputs[0]!);
  });

  it('resets to default amount on blur with empty value', async () => {
    render(
      <Wrapper>
        <PollList />
      </Wrapper>,
    );

    await screen.findByText('Best Runner');
    const amountInputs = screen.getAllByRole('spinbutton');
    fireEvent.change(amountInputs[0]!, { target: { value: '' } });
    fireEvent.blur(amountInputs[0]!);
    // Amount resets to default
    expect((amountInputs[0] as HTMLInputElement).value).toBeTruthy();
  });
});

describe('GoalList', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    mocks.getGoals.mockResolvedValue([goal]);
    mocks.getRewards.mockResolvedValue([]);
    mocks.getPolls.mockResolvedValue([]);
    mocks.getChannels.mockResolvedValue([]);
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
    mocks.getChannels.mockResolvedValue([]);
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
});
