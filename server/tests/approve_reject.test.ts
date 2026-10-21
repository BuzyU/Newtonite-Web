import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';
import { pool } from '../src/db.js';

describe('Approve, Reject, and Reopen Endpoints: Authz, Separation of Duties, OCC, Idempotency, and Auditability', () => {
  let reporterLead: AuthContext; // Priya (Lead in Operations)
  let approverLead: AuthContext; // Marcus (Distinct Lead in Operations)
  let member: AuthContext; // Elena (Member in Operations)
  let viewer: AuthContext; // Sarah (Viewer in Operations)
  let team: { id: string; name: string };

  beforeAll(async () => {
    reporterLead = await loginAs('priya.lead@newtonite.local');
    approverLead = await loginAs('marcus.lead@newtonite.local');
    member = await loginAs('elena.member@newtonite.local');
    viewer = await loginAs('sarah.viewer@newtonite.local');
    team = await getTeamBySlug('operations');
  });

  async function createAwaitingApprovalItem(reporter: AuthContext, assignee: AuthContext) {
    const client = authenticatedRequest(reporter);
    const createRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'compliance_request',
        title: `Compliance Item ${crypto.randomUUID().slice(0, 8)}`,
        description: 'Requires approval',
        assigneeId: assignee.user.id,
        requiresApproval: true,
      });

    expect(createRes.status).toBe(201);
    const item = createRes.body.item;

    // Transition: new -> triaged -> in_progress -> awaiting_approval
    await client
      .post(`/api/v1/items/${item.id}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'triaged' });

    await client
      .post(`/api/v1/items/${item.id}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'in_progress' });

    const awaitRes = await client
      .post(`/api/v1/items/${item.id}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'awaiting_approval' });

    expect(awaitRes.status).toBe(200);
    return awaitRes.body.item;
  }

  // --------------------------------------------------------------------------
  // 1. Role enforcement
  // --------------------------------------------------------------------------
  it('enforces role: members and viewers cannot approve, reject, or reopen items', async () => {
    const item = await createAwaitingApprovalItem(reporterLead, member);

    // Member attempts approve -> 403
    const memApprove = await authenticatedRequest(member)
      .post(`/api/v1/items/${item.id}/approve`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ note: 'Member trying to approve' });
    expect(memApprove.status).toBe(403);
    expect(memApprove.body.error.code).toBe('FORBIDDEN');

    // Member attempts reject -> 403
    const memReject = await authenticatedRequest(member)
      .post(`/api/v1/items/${item.id}/reject`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ note: 'Member trying to reject' });
    expect(memReject.status).toBe(403);
    expect(memReject.body.error.code).toBe('FORBIDDEN');

    // Viewer attempts approve -> 403
    const viewApprove = await authenticatedRequest(viewer)
      .post(`/api/v1/items/${item.id}/approve`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ note: 'Viewer trying to approve' });
    expect(viewApprove.status).toBe(403);

    // Viewer attempts reject -> 403
    const viewReject = await authenticatedRequest(viewer)
      .post(`/api/v1/items/${item.id}/reject`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ note: 'Viewer trying to reject' });
    expect(viewReject.status).toBe(403);

    // Member attempts reopen on a closed item -> 403
    const memReopen = await authenticatedRequest(member)
      .post(`/api/v1/items/${item.id}/reopen`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ note: 'Member trying to reopen' });
    expect(memReopen.status).toBe(403);
  });

  // --------------------------------------------------------------------------
  // 2. Separation of duties: Creator != Approver
  // --------------------------------------------------------------------------
  it('enforces creator != approver: the item reporter cannot approve their own item', async () => {
    const item = await createAwaitingApprovalItem(reporterLead, member);

    // Priya is the creator/reporter and also a lead
    const selfApprove = await authenticatedRequest(reporterLead)
      .post(`/api/v1/items/${item.id}/approve`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ note: 'Self-approval attempt by creator' });

    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.error.code).toBe('FORBIDDEN');
    expect(selfApprove.body.error.message).toContain('reporter cannot approve');
  });

  // --------------------------------------------------------------------------
  // 3. If-Match OCC validation
  // --------------------------------------------------------------------------
  it('enforces If-Match header version check (stale version returns 412 STALE_VERSION)', async () => {
    const item = await createAwaitingApprovalItem(reporterLead, member);
    const staleVersion = (item.version - 1).toString();

    // Stale version on approve
    const staleApprove = await authenticatedRequest(approverLead)
      .post(`/api/v1/items/${item.id}/approve`)
      .set('If-Match', `"${staleVersion}"`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ note: 'Approving with stale version' });

    expect(staleApprove.status).toBe(412);
    expect(staleApprove.body.error.code).toBe('STALE_VERSION');

    // Stale version on reject
    const staleReject = await authenticatedRequest(approverLead)
      .post(`/api/v1/items/${item.id}/reject`)
      .set('If-Match', `"${staleVersion}"`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ note: 'Rejecting with stale version' });

    expect(staleReject.status).toBe(412);
    expect(staleReject.body.error.code).toBe('STALE_VERSION');
  });

  // --------------------------------------------------------------------------
  // 4. Approve flow: Idempotency, Activity Row, Outbox Event
  // --------------------------------------------------------------------------
  it('approve endpoint enforces idempotency, writes activity row, and enqueues outbox event', async () => {
    const item = await createAwaitingApprovalItem(reporterLead, member);
    const key = crypto.randomUUID();

    // First call: approve
    const res1 = await authenticatedRequest(approverLead)
      .post(`/api/v1/items/${item.id}/approve`)
      .set('If-Match', `"${item.version}"`)
      .set('Idempotency-Key', key)
      .send({ note: 'Compliance verified by independent lead Marcus' });

    expect(res1.status).toBe(200);
    expect(res1.body.item.status).toBe('resolved');
    expect(res1.body.item.approval_status).toBe('approved');
    expect(res1.body.item.approved_by).toBe(approverLead.user.id);

    // Second call: retry with same Idempotency-Key -> 200 with identical cached body
    const res2 = await authenticatedRequest(approverLead)
      .post(`/api/v1/items/${item.id}/approve`)
      .set('If-Match', `"${item.version}"`)
      .set('Idempotency-Key', key)
      .send({ note: 'Compliance verified by independent lead Marcus' });

    expect(res2.status).toBe(200);
    expect(res2.body.item.id).toBe(res1.body.item.id);

    // Verify exactly ONE activity_log row was written for this approval
    const actCheck = await pool.query(
      `SELECT action, actor_id, note FROM activity_log WHERE item_id = $1 AND action = 'approved'`,
      [item.id]
    );
    expect(actCheck.rows).toHaveLength(1);
    expect(actCheck.rows[0].actor_id).toBe(approverLead.user.id);
    expect(actCheck.rows[0].note).toContain('Compliance verified');

    // Verify outbox_events row was enqueued with item.transitioned
    const outboxCheck = await pool.query(
      `SELECT event_type, payload FROM outbox_events WHERE payload->>'itemId' = $1 AND payload->>'newStatus' = 'resolved'`,
      [item.id]
    );
    expect(outboxCheck.rows.length).toBeGreaterThanOrEqual(1);
    expect(outboxCheck.rows[0].event_type).toBe('item.transitioned');
  });

  // --------------------------------------------------------------------------
  // 5. Reject flow: Idempotency, Activity Row, Outbox Event
  // --------------------------------------------------------------------------
  it('reject endpoint enforces idempotency, writes activity row, and enqueues outbox event', async () => {
    const item = await createAwaitingApprovalItem(reporterLead, member);
    const key = crypto.randomUUID();

    // First call: reject
    const res1 = await authenticatedRequest(approverLead)
      .post(`/api/v1/items/${item.id}/reject`)
      .set('If-Match', `"${item.version}"`)
      .set('Idempotency-Key', key)
      .send({ note: 'Insufficient documentation provided' });

    expect(res1.status).toBe(200);
    expect(res1.body.item.status).toBe('in_progress');
    expect(res1.body.item.approval_status).toBe('rejected');

    // Retry with same Idempotency-Key
    const res2 = await authenticatedRequest(approverLead)
      .post(`/api/v1/items/${item.id}/reject`)
      .set('If-Match', `"${item.version}"`)
      .set('Idempotency-Key', key)
      .send({ note: 'Insufficient documentation provided' });

    expect(res2.status).toBe(200);

    // Verify activity_log row
    const actCheck = await pool.query(
      `SELECT action, actor_id, note FROM activity_log WHERE item_id = $1 AND action = 'rejected'`,
      [item.id]
    );
    expect(actCheck.rows).toHaveLength(1);
    expect(actCheck.rows[0].actor_id).toBe(approverLead.user.id);
    expect(actCheck.rows[0].note).toContain('Insufficient documentation');

    // Verify outbox_events row
    const outboxCheck = await pool.query(
      `SELECT event_type, payload FROM outbox_events WHERE payload->>'itemId' = $1 AND payload->>'newStatus' = 'in_progress'`,
      [item.id]
    );
    expect(outboxCheck.rows.length).toBeGreaterThanOrEqual(1);
    expect(outboxCheck.rows[0].event_type).toBe('item.transitioned');
  });

  // --------------------------------------------------------------------------
  // 6. Reopen flow: Idempotency, Activity Row, Outbox Event
  // --------------------------------------------------------------------------
  it('reopen endpoint enforces idempotency, writes activity row, and enqueues outbox event', async () => {
    // Create an item and close it
    const client = authenticatedRequest(reporterLead);
    const createRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: 'Task to be closed and reopened',
        description: 'Reopen test',
        assigneeId: member.user.id,
        requiresApproval: false,
      });

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
      .send({ status: 'resolved', resolutionNote: 'Resolved initially' });

    const closeRes = await client
      .post(`/api/v1/items/${item.id}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'closed' });

    expect(closeRes.status).toBe(200);
    const closedItem = closeRes.body.item;

    // Now test Reopen endpoint
    const reopenKey = crypto.randomUUID();
    const reopenRes1 = await authenticatedRequest(reporterLead)
      .post(`/api/v1/items/${item.id}/reopen`)
      .set('If-Match', `"${closedItem.version}"`)
      .set('Idempotency-Key', reopenKey)
      .send({ note: 'Reopening due to regression in production' });

    expect(reopenRes1.status).toBe(200);
    expect(reopenRes1.body.item.status).toBe('triaged');
    expect(reopenRes1.body.item.closed_at).toBeNull();

    // Idempotent retry
    const reopenRes2 = await authenticatedRequest(reporterLead)
      .post(`/api/v1/items/${item.id}/reopen`)
      .set('If-Match', `"${closedItem.version}"`)
      .set('Idempotency-Key', reopenKey)
      .send({ note: 'Reopening due to regression in production' });

    expect(reopenRes2.status).toBe(200);

    // Verify activity_log
    const actCheck = await pool.query(
      `SELECT action, actor_id, note FROM activity_log WHERE item_id = $1 AND action = 'reopened'`,
      [item.id]
    );
    expect(actCheck.rows).toHaveLength(1);
    expect(actCheck.rows[0].actor_id).toBe(reporterLead.user.id);

    // Verify outbox_events
    const outboxCheck = await pool.query(
      `SELECT event_type, payload FROM outbox_events WHERE payload->>'itemId' = $1 AND payload->>'newStatus' = 'triaged'`,
      [item.id]
    );
    expect(outboxCheck.rows.length).toBeGreaterThanOrEqual(1);
    expect(outboxCheck.rows[0].event_type).toBe('item.transitioned');
  });
});
