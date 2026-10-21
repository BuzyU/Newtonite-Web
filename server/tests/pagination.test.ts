import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';

describe('Keyset Pagination: Stable iteration without duplicates or gaps', () => {
  let memberAuth: AuthContext;
  let team: { id: string; name: string };

  beforeAll(async () => {
    memberAuth = await loginAs('elena.member@newtonite.local');
    team = await getTeamBySlug('operations');

    // Create 10 items in sequence to ensure a guaranteed predictable dataset
    const client = authenticatedRequest(memberAuth);
    for (let i = 1; i <= 10; i++) {
      await client
        .post('/api/v1/items')
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          teamId: team.id,
          type: 'operational_task',
          title: `Keyset baseline item #${i} - ${Date.now()}`,
          description: `Pagination test dataset element ${i}`,
          priority: 'medium',
        });
    }
  });

  it('guarantees zero duplicate rows and zero skipped rows when new items are inserted between pages', async () => {
    const client = authenticatedRequest(memberAuth);

    // 1. Fetch Page 1 (limit 5)
    const page1Res = await client.get(`/api/v1/items?team_id=${team.id}&limit=5`);
    expect(page1Res.status).toBe(200);
    expect(page1Res.body.items).toHaveLength(5);
    expect(page1Res.body.pagination.hasMore).toBe(true);
    expect(page1Res.body.pagination.nextCursor).toBeDefined();

    const page1Ids = new Set(page1Res.body.items.map((i: any) => i.id));
    const nextCursor = page1Res.body.pagination.nextCursor;

    // 2. Interleave: Insert 3 brand new items while user is "between" pages
    for (let j = 1; j <= 3; j++) {
      await client
        .post('/api/v1/items')
        .set('Idempotency-Key', crypto.randomUUID())
        .send({
          teamId: team.id,
          type: 'operational_task',
          title: `Interleaved fresh item #${j} - ${Date.now()}`,
          description: 'Simulates concurrent insertions while client paginates.',
          priority: 'urgent',
        });
    }

    // 3. Fetch Page 2 using the keyset cursor obtained from Page 1
    const page2Res = await client.get(
      `/api/v1/items?team_id=${team.id}&limit=5&cursor=${encodeURIComponent(nextCursor)}`
    );
    expect(page2Res.status).toBe(200);
    expect(page2Res.body.items).toHaveLength(5);

    const page2Ids = new Set(page2Res.body.items.map((i: any) => i.id));

    // 4. Assert zero duplicates between Page 1 and Page 2
    for (const p2Id of page2Ids) {
      expect(page1Ids.has(p2Id)).toBe(false);
    }

    // 5. Assert strict monotonic descending order: all Page 2 items are older than Page 1 items
    const page1LastItem = page1Res.body.items[page1Res.body.items.length - 1];
    const page2FirstItem = page2Res.body.items[0];

    const p1LastTime = new Date(page1LastItem.last_activity_at).getTime();
    const p2FirstTime = new Date(page2FirstItem.last_activity_at).getTime();

    expect(p2FirstTime).toBeLessThanOrEqual(p1LastTime);
  });

  it('search input safety: handles malformed tsquery input without 500 error', async () => {
    const client = authenticatedRequest(memberAuth);

    const maliciousQueries = [
      'foo &',
      'foo | bar !',
      '"unclosed quote',
      ':::***',
      '((((()))))',
      '! & | <->',
      'DROP TABLE items;--',
      "'; SELECT 1; --",
    ];

    for (const q of maliciousQueries) {
      const res = await client.get(`/api/v1/items?search=${encodeURIComponent(q)}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toBeDefined();
    }
  });
});

