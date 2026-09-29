import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const moderatorClient = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock('../../src/api/moderator', () => ({ default: moderatorClient }));

import {
  ModeratorChannelFilterProvider,
  useModeratorChannelFilter,
} from '../../src/context/ModeratorChannelFilterContext';

describe('ModeratorChannelFilterContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('loads channels and persists the selection', async () => {
    moderatorClient.get.mockResolvedValue({ data: [{ id: 'c1', name: 'Main', is_active: true }] });

    const wrapper = ({ children }: { children: ReactNode }) => (
      <ModeratorChannelFilterProvider>{children}</ModeratorChannelFilterProvider>
    );
    const { result } = renderHook(() => useModeratorChannelFilter(), { wrapper });

    await waitFor(() => expect(result.current.channels).toHaveLength(1));

    act(() => result.current.setSelectedChannelId('c1'));
    expect(localStorage.getItem('moderator_channel_filter')).toBe('c1');
  });
});
