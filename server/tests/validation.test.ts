import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';

describe('T5: Input Validation & Hardening', () => {
  let memberAuth: AuthContext;
  let reporterLead: AuthContext;
  let approverLead: AuthContext;
  let team: { id: string; name: string };

  beforeAll(async () => {
    memberAuth = await loginAs('elena.member@newtonite.local');
    reporterLead = await loginAs('priya.lead@newtonite.local');
    approverLead = await loginAs('marcus.lead@newtonite.local');
    team = await getTeamBySlug('operations');
  });

  // 1. UUID validations
  it('returns 422 VALIDATION_ERROR for invalid team_id UUID', async () => {
    const client = authenticatedRequest(memberAuth);
    const res = await client.get('/api/v1/items?team_id=not-a-valid-uuid');
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(res.body.error?.message).toContain('team_id');
  });

  it('returns 422 VALIDATION_ERROR for invalid assignee UUID', async () => {
    const client = authenticatedRequest(memberAuth);
    const res = await client.get('/api/v1/items?assignee=not-a-valid-uuid');
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(res.body.error?.message).toContain('assignee');
  });

  it('returns 422 VALIDATION_ERROR for malformed cursor / invalid cursor id', async () => {
    const client = authenticatedRequest(memberAuth);
    // Malformed base64 cursor
    const res1 = await client.get('/api/v1/items?cursor=invalid-cursor');
    expect(res1.status).toBe(422);
    expect(res1.body.error?.code).toBe('VALIDATION_ERROR');

    // Base64 with non-uuid id
    const badCursor = Buffer.from(JSON.stringify({ t: new Date().toISOString(), id: 'not-a-uuid' })).toString('base64url');
    const res2 = await client.get(`/api/v1/items?cursor=${badCursor}`);
    expect(res2.status).toBe(422);
    expect(res2.body.error?.code).toBe('VALIDATION_ERROR');
  });

  // 2. Enum validations
  it('returns 422 VALIDATION_ERROR for invalid status enum', async () => {
    const client = authenticatedRequest(memberAuth);
    const res = await client.get('/api/v1/items?status=bogus_status');
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(res.body.error?.message).toContain('status');
  });

  it('returns 422 VALIDATION_ERROR for invalid priority enum', async () => {
    const client = authenticatedRequest(memberAuth);
    const res = await client.get('/api/v1/items?priority=ultra_urgent');
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(res.body.error?.message).toContain('priority');
  });

  it('returns 422 VALIDATION_ERROR for invalid type enum', async () => {
    const client = authenticatedRequest(memberAuth);
    const res = await client.get('/api/v1/items?type=random_unsupported_type');
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');
    expect(res.body.error?.message).toContain('type');
  });

  // 3. Separation of duties for reject_item
  it('enforces separation of duties on reject: reporter cannot reject their own item', async () => {
    // Create an item requiring approval reported by Priya (lead)
    const client = authenticatedRequest(reporterLead);
    const createRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'compliance_request',
        title: `Compliance Item ${crypto.randomUUID().slice(0, 8)}`,
        description: 'Requires approval',
        assigneeId: approverLead.user.id,
        requiresApproval: true,
      });
    expect(createRes.status).toBe(201);
    const item = createRes.body.item;

    await client
      .post(`/api/v1/items/${item.id}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'triaged' });
    await client
      .post(`/api/v1/items/${item.id}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'in_progress' });
    await client
      .post(`/api/v1/items/${item.id}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'awaiting_approval' });

    // Reporter (Priya) tries to reject her own item
    const rejectRes = await client
      .post(`/api/v1/items/${item.id}/reject`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ note: 'Reporter attempting self-rejection' });

    expect(rejectRes.status).toBe(403);
    expect(rejectRes.body.error?.code).toBe('FORBIDDEN');
    expect(rejectRes.body.error?.message).toContain('reporter cannot reject');
  });

  // 4. Attention dashboard totals
  it('returns total count per section in getAttentionDashboardHandler', async () => {
    const client = authenticatedRequest(reporterLead);
    const res = await client.get('/api/v1/attention');

    expect(res.status).toBe(200);
    expect(res.body.totals).toBeDefined();
    expect(typeof res.body.totals.awaiting_approval).toBe('number');
    expect(typeof res.body.totals.mine_due_soon).toBe('number');
    expect(typeof res.body.totals.urgent_unassigned).toBe('number');
    expect(typeof res.body.totals.mentions).toBe('number');
    expect(typeof res.body.totals.gone_quiet).toBe('number');
  });
});
