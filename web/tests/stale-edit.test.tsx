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

const mockItemData = {
  item: {
    id: '11111111-1111-1111-1111-111111111111',
    short_ref: 'OPS-100',
    team_id: 'team-1',
    team_name: 'Operations',
    type: 'operational_task',
    title: 'Initial Title',
    description: 'Initial Description',
    status: 'in_progress',
    priority: 'medium',
    reporter_id: 'user-1',
    reporter_name: 'Priya Patel',
    assignee_id: 'user-1',
    assignee_name: 'Priya Patel',
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
  computed_next: 'Work in progress',
  permissions: {
    can_edit: true,
    can_claim: false,
    can_change_status: true,
    can_comment: true,
    can_approve: false,
  },
};

describe('ItemDetail Stale Edit Conflict Panel', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  it('renders conflict resolution panel when server returns 412 STALE_VERSION', async () => {
    (api.get as any).mockResolvedValue(mockItemData);
    (api.patch as any).mockRejectedValue(
      new ApiError(
        412,
        {
          code: 'STALE_VERSION',
          message: 'Stale version: target has been modified',
          details: {
            current_item: {
              id: '11111111-1111-1111-1111-111111111111',
              title: 'Modified by Colleague',
              priority: 'urgent',
              version: 2,
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
          <MemoryRouter initialEntries={['/items/11111111-1111-1111-1111-111111111111']}>
            <Routes>
              <Route path="/items/:id" element={<ItemDetail />} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    );

    // Wait for item to load
    await waitFor(() => {
      expect(screen.getByText('Initial Title')).toBeInTheDocument();
    });

    // Click "Edit Details"
    const editBtn = screen.getByRole('button', { name: /Edit Details/i });
    fireEvent.click(editBtn);

    // Save changes
    const saveBtn = screen.getByRole('button', { name: /Save/i });
    fireEvent.click(saveBtn);

    // Stale conflict panel must be rendered
    await waitFor(() => {
      expect(screen.getByText(/Concurrency Conflict/i)).toBeInTheDocument();
      expect(screen.getByText(/Modified by Colleague/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Re-apply my edits to latest/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Discard my edits & load latest/i })).toBeInTheDocument();
    });
  });
});
