import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ItemDetail } from '../src/pages/ItemDetail';
import { api, ApiError } from '../src/api';
import { AuthContext } from '../src/AuthContext';

vi.mock('../src/api', async (importOriginal) => {
  const actual: any = await importOriginal();
  return {
    ...actual,
    api: {
      get: vi.fn(),
      patch: vi.fn(),
      post: vi.fn(),
    },
    isServerWaking: {
      subscribe: vi.fn(() => () => {}),
    },
  };
});

const mockUser = {
  id: 'user-1',
  email: 'priya@newtonite.internal',
  name: 'Priya Patel',
  is_org_admin: false,
};

const mockUnassignedItem = {
  item: {
    id: '22222222-2222-2222-2222-222222222222',
    short_ref: 'OPS-200',
    team_id: 'team-1',
    team_name: 'Operations',
    type: 'operational_task',
    title: 'Urgent Server Failure',
    description: 'Server unreachable in prod',
    status: 'new',
    priority: 'urgent',
    reporter_id: 'user-3',
    reporter_name: 'Reporter',
    assignee_id: null,
    assignee_name: null,
    due_at: null,
    requires_approval: false,
    approval_status: 'not_required',
    approved_by: null,
    approved_by_name: null,
    resolution_note: null,
    tags: [],
    version: 1,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    last_activity_at: '2026-01-01T00:00:00Z',
    closed_at: null,
    archived_at: null,
  },
  comments: [],
  activity: [],
  computed_next: 'Unassigned',
  permissions: {
    can_edit: true,
    can_claim: true,
    can_change_status: true,
    can_comment: true,
    can_approve: false,
  },
};

describe('ItemDetail Optimistic Claim Race & Reconciliation', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  it('handles 409 ALREADY_CLAIMED gracefully and displays winner without crashing', async () => {
    (api.get as any).mockResolvedValue(mockUnassignedItem);
    (api.post as any).mockRejectedValue(
      new ApiError(
        409,
        {
          code: 'ALREADY_CLAIMED',
          message: 'Item has already been claimed by another user',
          details: {
            current_assignee: {
              id: 'user-99',
              name: 'Elena Rostova',
            },
          },
        },
        new Headers()
      )
    );

    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider
          value={{
            user: mockUser,
            isLoading: false,
            loading: false,
            login: vi.fn(),
            registerOrg: vi.fn(),
            logout: vi.fn(),
            refreshUser: vi.fn(),
            theme: 'light',
            toggleTheme: vi.fn(),
          }}
        >
          <MemoryRouter initialEntries={['/items/22222222-2222-2222-2222-222222222222']}>
            <Routes>
              <Route path="/items/:id" element={<ItemDetail />} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    );

    // Wait for item to render
    await waitFor(() => {
      expect(screen.getByText('Urgent Server Failure')).toBeInTheDocument();
      expect(screen.getByText('Nobody owns this yet')).toBeInTheDocument();
    });

    // Find and click the Claim button
    const claimBtn = screen.getByRole('button', { name: /Claim This Item/i });
    fireEvent.click(claimBtn);

    // Assert that the race loser sees the winner's name in error message
    await waitFor(() => {
      expect(screen.getByText(/Already claimed by Elena Rostova/i)).toBeInTheDocument();
    });
  });
});
