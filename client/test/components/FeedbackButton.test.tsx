import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FeedbackButton from '../../src/components/FeedbackButton';
import { CartProvider } from '../../src/context/CartContext';

vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/channels', () => ({ getChannels: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/donor', () => ({ getDonor: vi.fn() }));
vi.mock('../../src/api/featureFlags', () => ({ getFeatureFlags: vi.fn() }));
vi.mock('../../src/api/feedback', () => ({ sendFeedback: vi.fn() }));
vi.mock('html2canvas', () => ({
  default: vi.fn().mockResolvedValue({
    width: 100,
    height: 100,
    toBlob: (cb: (blob: Blob | null) => void) => cb(new Blob(['fake'], { type: 'image/jpeg' })),
  }),
}));

import { getFeatureFlags } from '../../src/api/featureFlags';
import { sendFeedback } from '../../src/api/feedback';
import html2canvas from 'html2canvas';

function renderButton() {
  return render(
    <CartProvider>
      <FeedbackButton />
    </CartProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
});

describe('FeedbackButton', () => {
  it('does not render when the feedback flag is off', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: false });
    renderButton();
    await waitFor(() => expect(getFeatureFlags).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: 'Send feedback' })).not.toBeInTheDocument();
  });

  it('renders the floating button when the flag is on', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: true });
    renderButton();
    expect(await screen.findByRole('button', { name: 'Send feedback' })).toBeInTheDocument();
  });

  it('captures only the visible viewport', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: true });
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    await screen.findByPlaceholderText("What's going on?");
    expect(html2canvas).toHaveBeenCalledWith(
      document.body,
      expect.objectContaining({
        x: window.scrollX,
        y: window.scrollY,
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  });

  it('retains the text and shows a retry button when submission fails', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: true });
    vi.mocked(sendFeedback).mockRejectedValue({
      response: { data: { error: 'Feedback is not enabled' } },
    });

    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));

    const textarea = await screen.findByPlaceholderText("What's going on?");
    fireEvent.change(textarea, { target: { value: 'This page is broken' } });

    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    expect(await screen.findByText('Feedback is not enabled')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'retry' })).toBeInTheDocument();
    expect(textarea).toHaveValue('This page is broken');
  });

  it('shows a success confirmation on a successful submit', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: true });
    vi.mocked(sendFeedback).mockResolvedValue({ success: true });

    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));

    const textarea = await screen.findByPlaceholderText("What's going on?");
    fireEvent.change(textarea, { target: { value: 'Great site!' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    expect(await screen.findByText('Thanks — feedback sent!')).toBeInTheDocument();
    expect(sendFeedback).toHaveBeenCalledWith(expect.objectContaining({ text: 'Great site!' }));
  });
});
