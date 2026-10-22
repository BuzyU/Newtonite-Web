import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { api } from '../src/api';
import { ItemDetail } from '../src/pages/ItemDetail';
import { AuthContext } from '../src/AuthContext';

describe('ItemDetail: regression test for undefined activity/length', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders item cleanly when activity is undefined without throwing Cannot read properties of undefined (reading length)', async () => {
    const mockItem = {
      id: 'c8f1f72e-3d12-4f3a-9e5b-6a1e8a9f0001',
      short_ref: 'OPS-101',
      team_id: 't-1',
      team_name: 'Platform Engineering',
      type: 'incident',
      title: 'Database connection pool exhausted',
      description: 'The connection pool has been exhausted under high load.',
      status: 'in_progress',
      priority: 'high',
      reporter_id: 'u-1',
      reporter_name: 'Alice Admin',
      assignee_id: 'u-1',
      assignee_name: 'Alice Admin',
      due_at: null,
      requires_approval: false,
      approval_status: 'none',
      approved_by: null,
      approved_by_name: null,
      resolution_note: null,
      tags: ['database', 'production'],
      version: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_activity_at: new Date().toISOString(),
      closed_at: null,
      archived_at: null,
    };

    // Notice: activity is omitted / undefined
    const mockResponse = {
      item: mockItem,
      comments: [],
      // activity is undefined!
      computed_next: 'Active operator handling investigation',
      permissions: {
        can_edit: true,
        can_claim: true,
        can_change_status: true,
        can_comment: true,
        can_approve: false,
      },
    };

    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path.includes('/items/')) {
        return mockResponse as any;
      }
      return {} as any;
    });

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    const mockAuthContext: any = {
      user: {
        id: 'u-1',
        name: 'Alice Admin',
        email: 'alice@example.com',
        role: 'org_admin',
        isOrgAdmin: true,
        activeTeamId: 't-1',
        teams: [{ id: 't-1', name: 'Platform Engineering', role: 'lead' }],
      },
    };

    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={mockAuthContext}>
          <MemoryRouter initialEntries={[`/items/${mockItem.id}`]}>
            <Routes>
              <Route path="/items/:id" element={<ItemDetail />} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    );

    // Wait and check if item title rendered without crashing on undefined.length
    await waitFor(() => {
      expect(screen.getByText('Database connection pool exhausted')).toBeInTheDocument();
    });

    expect(screen.queryByText(/Work item not found or access denied/i)).toBeNull();
  });
});
