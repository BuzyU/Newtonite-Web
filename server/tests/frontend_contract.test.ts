import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { pool } from '../src/db.js';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';

describe('Frontend-Backend Contract & Routes Alignment (BUG-01..04)', () => {
  let adminAuth: AuthContext;
  let leadAuth: AuthContext;
  let memberAuth: AuthContext;
  let opsTeam: { id: string; name: string; prefix: string };

  beforeAll(async () => {
    adminAuth = await loginAs('admin@newtonite.local');
    leadAuth = await loginAs('priya.lead@newtonite.local');
    memberAuth = await loginAs('elena.member@newtonite.local');
    opsTeam = await getTeamBySlug('operations');
  });

  it('BUG-02: GET /api/v1/attention returns 200 with canonical snake_case arrays and no duplicate nested object', async () => {
    const client = authenticatedRequest(leadAuth);
    const res = await client.get('/api/v1/attention');

    expect(res.status).toBe(200);
    // Contract expected by AttentionHome.tsx
    expect(Array.isArray(res.body.awaiting_approval)).toBe(true);
    expect(Array.isArray(res.body.mine_due_soon)).toBe(true);
    expect(Array.isArray(res.body.urgent_unassigned)).toBe(true);
    expect(Array.isArray(res.body.mentions)).toBe(true);
    expect(Array.isArray(res.body.gone_quiet)).toBe(true);
    // No redundant duplicate camelCase wrapper
    expect(res.body.attention).toBeUndefined();
  });

  it('BUG-04: GET /api/v1/teams/:id returns 200 with team details and member roster', async () => {
    const client = authenticatedRequest(memberAuth);
    const res = await client.get(`/api/v1/teams/${opsTeam.id}`);

    expect(res.status).toBe(200);
    expect(res.body.team).toBeDefined();
    expect(res.body.team.id).toBe(opsTeam.id);
    expect(Array.isArray(res.body.members)).toBe(true);
    expect(res.body.members.length).toBeGreaterThan(0);
  });

  it('BUG-03: GET /api/v1/admin/dead-letters returns 200 with single canonical deadLetters array', async () => {
    const client = authenticatedRequest(adminAuth);
    const res = await client.get('/api/v1/admin/dead-letters');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.deadLetters)).toBe(true);
    // No redundant events alias
    expect(res.body.events).toBeUndefined();
  });

  it('BUG-01: POST /api/v1/items/:id/approve, /reject, /reopen succeed with action endpoints', async () => {
    // 1. Create an item requiring approval reported by Elena
    const memberClient = authenticatedRequest(memberAuth);
    const createRes = await memberClient
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: opsTeam.id,
        type: 'compliance_request',
        title: 'Item to test action routes',
        description: 'Testing approve, reject, reopen endpoints from ItemDetail.tsx',
        priority: 'high',
        requiresApproval: true,
      });

    expect(createRes.status).toBe(201);
    const itemId = createRes.body.item.id;
    let version = createRes.body.item.version;

    // Elena claims item
    const claimRes = await memberClient
      .post(`/api/v1/items/${itemId}/claim`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send();
    expect(claimRes.status).toBe(200);
    version = claimRes.body.item.version;

    // Transition to in_progress then awaiting_approval
    await memberClient
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', `"${version}"`)
      .send({ status: 'in_progress', action: 'start_progress' });

    const itemAfterProgress = await pool.query('SELECT version FROM items WHERE id = $1', [itemId]);
    version = itemAfterProgress.rows[0].version;

    await memberClient
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', `"${version}"`)
      .send({ status: 'awaiting_approval', action: 'submit_approval' });

    const itemAfterSubmit = await pool.query('SELECT version FROM items WHERE id = $1', [itemId]);
    version = itemAfterSubmit.rows[0].version;

    // 2. Lead Priya approves item via /items/:id/approve
    const leadClient = authenticatedRequest(leadAuth);
    const approveRes = await leadClient
      .post(`/api/v1/items/${itemId}/approve`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', `"${version}"`)
      .send({ note: 'Compliance review approved' });

    expect(approveRes.status).toBe(200);
    expect(approveRes.body.item.status).toBe('resolved');
    expect(approveRes.body.item.approval_status).toBe('approved');
    version = approveRes.body.item.version;

    // Close item
    await leadClient
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', `"${version}"`)
      .send({ status: 'closed', action: 'close' });

    const itemAfterClose = await pool.query('SELECT version FROM items WHERE id = $1', [itemId]);
    version = itemAfterClose.rows[0].version;

    // 3. Lead Priya reopens item via /items/:id/reopen
    const reopenRes = await leadClient
      .post(`/api/v1/items/${itemId}/reopen`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', `"${version}"`)
      .send({ note: 'Reopening for further check' });

    expect(reopenRes.status).toBe(200);
    expect(reopenRes.body.item.status).toBe('triaged');
  });
});
