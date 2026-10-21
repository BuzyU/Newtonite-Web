import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { apiFetch, api } from '../src/api';
import { ItemDetail } from '../src/pages/ItemDetail';
import { AuthContext } from '../src/AuthContext';

describe('CONC-02: Client Idempotency & Double-Click Protection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('apiFetch: reuses the exact same Idempotency-Key on automatic retries of a failed submit, and generates a new one for a new submit', async () => {
    const sentKeys: string[] = [];
    let callCount = 0;

    // Mock global fetch to fail once with 503, then succeed on retry
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init: any) => {
      callCount++;
      const headers = new Headers(init.headers);
      const key = headers.get('Idempotency-Key');
      if (key) sentKeys.push(key);

      if (callCount === 1) {
        // First attempt fails with 503 Service Unavailable (transient DB timeout)
        return new Response(JSON.stringify({ error: { code: 'DATABASE_TIMEOUT', message: 'DB busy' } }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Retry succeeds
      return new Response(JSON.stringify({ success: true, item: { id: 'item-123' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    vi.stubGlobal('fetch', mockFetch);

    // Call apiFetch with automatic retry enabled
    const res1 = await apiFetch('/items/item-123/claim', {
      method: 'POST',
      maxRetries: 1,
    });

    expect(res1.data).toEqual({ success: true, item: { id: 'item-123' } });
    expect(callCount).toBe(2);
    expect(sentKeys).toHaveLength(2);
    // Key MUST be identical on automatic retry
    expect(sentKeys[0]).toBe(sentKeys[1]);

    // Now user initiates a NEW intent (second submit)
    const res2 = await apiFetch('/items/item-123/claim', {
      method: 'POST',
      maxRetries: 1,
    });

    expect(res2.data).toEqual({ success: true, item: { id: 'item-123' } });
    expect(sentKeys).toHaveLength(3);
    // New intent MUST have a different key from the first intent
    expect(sentKeys[2]).not.toBe(sentKeys[0]);
  });

  it('double-click protection: button disables while pending, preventing duplicate requests', async () => {
    let claimCalls = 0;
    vi.spyOn(api, 'post').mockImplementation(async () => {
      claimCalls++;
      // Simulate network latency so button stays disabled
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { success: true };
    });

    vi.spyOn(api, 'get').mockResolvedValue({
      item: {
        id: 'item-456',
        short_ref: 'OPS-456',
        team_id: 'team-1',
        type: 'operational_task',
        title: 'Double-click protection item',
        description: 'Test item',
        status: 'new',
        priority: 'medium',
        reporter_id: 'user-1',
        assignee_id: null,
        requires_approval: false,
        version: 1,
      },
      activity: [],
      comments: [],
      computed_next: 'Triage item',
      permissions: { can_edit: true, can_claim: true, can_change_status: true, can_comment: true, can_approve: false },
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const mockAuth = {
      user: { id: 'user-1', name: 'Tester', email: 'tester@newtonite.local', is_org_admin: false, memberships: [] },
      isLoading: false,
      login: vi.fn(),
      logout: vi.fn(),
    };

    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={mockAuth as any}>
          <MemoryRouter initialEntries={['/items/item-456']}>
            <Routes>
              <Route path="/items/:id" element={<ItemDetail />} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>
    );

    // Wait for item to render
    const claimBtn = await screen.findByRole('button', { name: /Claim This Item/i });
    expect(claimBtn).not.toBeDisabled();

    // Rapid double-click on claim button
    fireEvent.click(claimBtn);
    fireEvent.click(claimBtn);

    // Button should immediately become disabled while pending
    await waitFor(() => {
      expect(claimBtn).toBeDisabled();
    });

    // Wait for mutation to complete
    await waitFor(() => {
      expect(claimCalls).toBe(1);
    });

    // Exactly 1 call was fired, the second click was prevented!
    expect(claimCalls).toBe(1);
  });
});
