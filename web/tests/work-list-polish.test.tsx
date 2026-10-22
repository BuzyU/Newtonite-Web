import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AllWorkList } from '../src/pages/AllWorkList';
import { api } from '../src/api';

vi.mock('../src/api', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    api: {
      get: vi.fn(),
      post: vi.fn(),
    },
  };
});

describe('T7: Work-list UI Polish', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    (api.get as any).mockImplementation((url: string) => {
      if (url.startsWith('/teams')) {
        return Promise.resolve({ teams: [{ id: 't1', name: 'Operations', slug: 'operations' }] });
      }
      if (url.startsWith('/items')) {
        return Promise.resolve({
          items: [
            {
              id: 'item-1',
              short_ref: 'OPS-101',
              team_id: 't1',
              team_name: 'Operations',
              type: 'operational_task',
              title: 'Critical Outage Investigation',
              status: 'in_progress',
              priority: 'urgent',
              assignee_id: 'user-1',
              assignee_name: 'Elena Rostova',
              due_at: '2020-01-01T00:00:00.000Z', // In the past -> Overdue!
              last_activity_at: '2026-10-21T12:00:00.000Z',
              tags: ['prod'],
            },
            {
              id: 'item-2',
              short_ref: 'OPS-102',
              team_id: 't1',
              team_name: 'Operations',
              type: 'operational_task',
              title: 'Routine Health Check',
              status: 'triaged',
              priority: 'medium',
              assignee_id: null,
              assignee_name: null,
              due_at: null,
              last_activity_at: '2026-10-21T12:00:00.000Z',
              tags: [],
            },
          ],
          has_more: true,
          next_cursor: 'cursor-abc',
          pagination: {
            limit: 50,
            hasMore: true,
            nextCursor: 'cursor-abc',
          },
        });
      }
      return Promise.reject(new Error(`Unhandled mock for ${url}`));
    });
  });

  it('renders status and priority as badges, and shows overdue indicator on past due items', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <AllWorkList />
        </MemoryRouter>
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByText('Critical Outage Investigation')).toBeInTheDocument();
    });

    // 1. Status and priority badges
    const inProgressBadge = screen.getByText('in progress');
    expect(inProgressBadge.className).toContain('badge-status-in_progress');

    const urgentBadge = screen.getByText('urgent');
    expect(urgentBadge.className).toContain('badge-priority-urgent');

    // 2. Overdue indicator
    const overdueIndicator = screen.getByText(/overdue/i);
    expect(overdueIndicator).toBeInTheDocument();
    expect(overdueIndicator.className).toContain('badge-overdue');

    // 3. Count indicator ("loaded, more available")
    expect(screen.getByText(/2 loaded, more available/i)).toBeInTheDocument();
  });
});
