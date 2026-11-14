import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import FeedbackButton from '../../src/components/FeedbackButton';
import { DraftPledgeProvider as CartProvider } from '../../src/context/DraftPledgeContext';

vi.mock('../../src/api/rewards', () => ({ getRewards: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/polls', () => ({ getPolls: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/goals', () => ({ getGoals: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/channels', () => ({ getChannels: vi.fn().mockResolvedValue([]) }));
vi.mock('../../src/api/donor', () => ({ getDonor: vi.fn(), getSession: vi.fn() }));
vi.mock('../../src/api/featureFlags', () => ({ getFeatureFlags: vi.fn() }));
vi.mock('../../src/api/feedback', () => ({ sendFeedback: vi.fn() }));
// html2canvas-pro, not html2canvas 1.4.1: the original misplaces text and
// boxes (the crew-corner "Screenshot fidelity" lesson).
vi.mock('html2canvas-pro', () => ({
  default: vi.fn().mockResolvedValue({
    width: 100,
    height: 100,
    toBlob: (cb: (blob: Blob | null) => void) => cb(new Blob(['fake'], { type: 'image/jpeg' })),
  }),
}));

import { getFeatureFlags } from '../../src/api/featureFlags';
import { sendFeedback } from '../../src/api/feedback';
import { getSession } from '../../src/api/donor';
import html2canvas from 'html2canvas-pro';
import { FEEDBACK_BUTTON_ID } from '../../src/lib/feedback/capture';

function renderButton() {
  return render(
    <CartProvider>
      <FeedbackButton />
    </CartProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
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

  it('captures the whole page from its top, laid out at the real window height', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: true });
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    await screen.findByPlaceholderText("What's going on?");
    expect(html2canvas).toHaveBeenCalledWith(
      document.body,
      expect.objectContaining({
        scrollX: 0,
        scrollY: 0,
        windowHeight: window.innerHeight,
        height: Math.min(document.body.scrollHeight, 4000),
        ignoreElements: expect.any(Function),
        onclone: expect.any(Function),
      }),
    );
  });

  it('excludes the widget and the modal overlay from the capture', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: true });
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    await screen.findByPlaceholderText("What's going on?");
    const options = vi.mocked(html2canvas).mock.calls[0]![1];
    const matches = options!.ignoreElements! as (el: Element) => boolean;
    expect(matches(document.getElementById(FEEDBACK_BUTTON_ID)!)).toBe(true);
    expect(matches(document.body)).toBe(false);
    expect(matches(document.querySelector('[data-feedback-overlay]')!)).toBe(true);
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

  it('never shows the captured screenshot to the sender — text box and submit only', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: true });
    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));
    await screen.findByPlaceholderText("What's going on?");
    // The capture happened (and is attached on send), but the sender's dialog
    // carries no image of their screen.
    expect(html2canvas).toHaveBeenCalled();
    expect(document.querySelector('[data-feedback-overlay] img')).toBeNull();
    expect(screen.queryByAltText('Screenshot preview')).toBeNull();
  });

  it('sends text, metadata, the scroll position, the snapshot and the diagnostics payload', async () => {
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: true });
    vi.mocked(sendFeedback).mockResolvedValue({ success: true });

    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));

    const textarea = await screen.findByPlaceholderText("What's going on?");
    fireEvent.change(textarea, { target: { value: 'Great site!' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    expect(await screen.findByText('Thanks — feedback sent!')).toBeInTheDocument();
    expect(sendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Great site!',
        scrollY: 0,
        screenshot: expect.any(Blob),
        snapshot: expect.any(Blob),
        diagnostics: expect.stringMatching(/^\{"build":"unknown","entries":/),
        metadata: expect.objectContaining({
          url: window.location.href,
          donor_id: null,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          cart_summary: 'empty',
        }),
      }),
    );
  });

  it('sends feedback without a donor when the session probe reports no session', async () => {
    // Stale local session marker: the probe answers 200 {authenticated:false}
    // (issue #135) — the logged-out state is expected, not an error.
    localStorage.setItem('donor_session_active', '1');
    vi.mocked(getSession).mockResolvedValue({ authenticated: false });
    vi.mocked(getFeatureFlags).mockResolvedValue({ feedback: true });
    vi.mocked(sendFeedback).mockResolvedValue({ success: true });

    renderButton();
    fireEvent.click(await screen.findByRole('button', { name: 'Send feedback' }));

    const textarea = await screen.findByPlaceholderText("What's going on?");
    fireEvent.change(textarea, { target: { value: 'Anon report' } });
    fireEvent.click(screen.getByRole('button', { name: 'send' }));

    expect(await screen.findByText('Thanks — feedback sent!')).toBeInTheDocument();
    expect(screen.queryByText('Failed to send feedback')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'retry' })).not.toBeInTheDocument();
    expect(sendFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ donor_id: null }),
      }),
    );
  });
});
