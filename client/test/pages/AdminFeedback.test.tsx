import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getFeedbackQueue: vi.fn(),
  getFeedbackItem: vi.fn(),
  markFeedbackSeen: vi.fn(),
  updateFeedback: vi.fn(),
  getFeedbackScreenshot: vi.fn(),
  getFeedbackSnapshot: vi.fn(),
}));

vi.mock('../../src/api/admin', () => ({
  default: { get: vi.fn(), patch: vi.fn(), post: vi.fn() },
  getFeedbackQueue: mocks.getFeedbackQueue,
  getFeedbackItem: mocks.getFeedbackItem,
  markFeedbackSeen: mocks.markFeedbackSeen,
  updateFeedback: mocks.updateFeedback,
  getFeedbackScreenshot: mocks.getFeedbackScreenshot,
  getFeedbackSnapshot: mocks.getFeedbackSnapshot,
}));

import AdminFeedback from '../../src/pages/admin/AdminFeedback';

const item = {
  id: '11111111-2222-4333-8444-555555555555',
  ref: 'FB-11111111',
  message: 'The counter is stuck',
  page_url: 'http://localhost:3001/donate',
  route: '/donate',
  viewport: '1600x900',
  scroll_y: 0,
  status: 'NEW',
  created_at: '2026-11-13T00:00:00.000Z',
  sender: { id: 'd1', email: 'donor@example.com' },
  has_screenshot: true,
  has_snapshot: false,
  diagnostics_error_count: 2,
  resolution_note: '',
  resolution_pr: '',
  resolved_by: null,
  resolved_at: null,
};

function mockQueue(items = [item], open_count = 1) {
  mocks.getFeedbackQueue.mockResolvedValue({ open_count, items });
}

describe('AdminFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockQueue();
    mocks.getFeedbackItem.mockResolvedValue({
      ...item,
      user_agent: 'TestAgent/1.0',
      diagnostics: null,
    });
    mocks.getFeedbackScreenshot.mockResolvedValue(new Blob(['png']));
    mocks.getFeedbackSnapshot.mockResolvedValue('<html></html>');
  });

  it('lists open reports with the open count and the diagnostics error pill', async () => {
    render(<AdminFeedback />);
    expect(await screen.findByText('FB-11111111')).toBeInTheDocument();
    expect(screen.getByText('1 open')).toBeInTheDocument();
    expect(screen.getByText(/The counter is stuck/)).toBeInTheDocument();
    expect(screen.getByText(/donor@example.com/)).toBeInTheDocument();
    expect(screen.getByText('2 client errors')).toBeInTheDocument();
  });

  it('switches filters and shows the empty state', async () => {
    render(<AdminFeedback />);
    fireEvent.click(await screen.findByRole('button', { name: 'answered' }));
    await waitFor(() => expect(mocks.getFeedbackQueue).toHaveBeenCalledWith('done'));
    mocks.getFeedbackQueue.mockResolvedValue({ open_count: 0, items: [] });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    await waitFor(() => expect(mocks.getFeedbackQueue).toHaveBeenCalledWith('all'));
    expect(await screen.findByText('No all reports.')).toBeInTheDocument();
  });

  it('opens a NEW report, marks it seen, and offers the evidence links', async () => {
    const stubOpen = vi.fn();
    vi.stubGlobal('open', stubOpen);
    render(<AdminFeedback />);
    fireEvent.click(await screen.findByRole('button', { name: 'open', expanded: false }));
    await waitFor(() => expect(mocks.getFeedbackItem).toHaveBeenCalledWith(item.id));
    await waitFor(() => expect(mocks.markFeedbackSeen).toHaveBeenCalledWith(item.id));

    expect(screen.getByRole('button', { name: 'screenshot' })).toBeInTheDocument();
    // No DOM snapshot on this report, so only the screenshot link shows.
    expect(screen.queryByRole('button', { name: 'DOM snapshot' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'screenshot' }));
    await waitFor(() => expect(stubOpen).toHaveBeenCalled());

    // The handle form is there with the shared status options.
    expect(screen.getByLabelText('Status')).toBeInTheDocument();
    expect(screen.getByLabelText('Resolution note')).toBeInTheDocument();
    expect(screen.getByLabelText('PR link')).toBeInTheDocument();
  });

  it('saves the answer through the shared update path', async () => {
    mocks.updateFeedback.mockResolvedValue({ success: true, status: 'DONE' });
    render(<AdminFeedback />);
    fireEvent.click(await screen.findByRole('button', { name: 'open', expanded: false }));
    await waitFor(() => expect(mocks.getFeedbackItem).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText('Resolution note'), {
      target: { value: 'Fixed in #200' },
    });
    fireEvent.change(screen.getByLabelText('PR link'), {
      target: { value: 'https://github.com/esamarathon/esa-dono-ui/pull/200' },
    });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'DONE' } });
    fireEvent.click(screen.getByRole('button', { name: 'save' }));

    await waitFor(() =>
      expect(mocks.updateFeedback).toHaveBeenCalledWith(item.id, {
        status: 'DONE',
        resolution_note: 'Fixed in #200',
        resolution_pr: 'https://github.com/esamarathon/esa-dono-ui/pull/200',
      }),
    );
    expect(await screen.findByRole('button', { name: 'saved' })).toBeInTheDocument();
  });

  it('shows the failed state when saving is refused', async () => {
    mocks.updateFeedback.mockRejectedValue({ response: { data: { error: 'Bad request' } } });
    render(<AdminFeedback />);
    fireEvent.click(await screen.findByRole('button', { name: 'open', expanded: false }));
    await waitFor(() => expect(mocks.getFeedbackItem).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'save' }));
    expect(await screen.findByText('Bad request')).toBeInTheDocument();
  });
});
