import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';

describe('State Machine: Workflow transitions and separation of duties', () => {
  let lead1Auth: AuthContext; // Priya (Lead in Operations)
  let lead2Auth: AuthContext; // Marcus (Lead in Operations)
  let memberAuth: AuthContext; // Elena (Member in Operations)
  let team: { id: string; name: string };

  beforeAll(async () => {
    lead1Auth = await loginAs('priya.lead@newtonite.local');
    lead2Auth = await loginAs('marcus.lead@newtonite.local');
    memberAuth = await loginAs('elena.member@newtonite.local');
    team = await getTeamBySlug('operations');
  });

  it('enforces that moving to in_progress requires an assignee', async () => {
    const client = authenticatedRequest(lead1Auth);

    // Create item in 'new'
    const createRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: 'Unassigned transition test item',
        description: 'Testing in_progress assignee requirement.',
        assigneeId: null,
      });

    const itemId = createRes.body.item.id;

    // Transition new -> triaged
    await client
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'triaged' });

    // Attempt triaged -> in_progress WITHOUT assignee -> 409 INVALID_TRANSITION
    const failRes = await client
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'in_progress', assigneeId: null });

    expect(failRes.status).toBe(409);
    expect(failRes.body.error.code).toBe('INVALID_TRANSITION');
    expect(failRes.body.error.message).toContain('must have an assignee');

    // With assignee -> 200 OK
    const successRes = await client
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'in_progress', assigneeId: memberAuth.user.id });

    expect(successRes.status).toBe(200);
    expect(successRes.body.item.status).toBe('in_progress');
    expect(successRes.body.item.assignee_id).toBe(memberAuth.user.id);
  });

  it('enforces that resolving an item requires a resolution_note', async () => {
    const client = authenticatedRequest(lead1Auth);

    const createRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: 'Resolution note test item',
        description: 'Testing resolution note requirement.',
        assigneeId: memberAuth.user.id,
        requiresApproval: false,
      });

    const itemId = createRes.body.item.id;

    // Move to triaged then in_progress
    await client.post(`/api/v1/items/${itemId}/transition`).set('Idempotency-Key', crypto.randomUUID()).send({ status: 'triaged' });
    await client.post(`/api/v1/items/${itemId}/transition`).set('Idempotency-Key', crypto.randomUUID()).send({ status: 'in_progress' });

    // Attempt to resolve without resolutionNote -> 409
    const noNoteRes = await client
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'resolved', resolutionNote: '' });

    expect(noNoteRes.status).toBe(409);
    expect(noNoteRes.body.error.code).toBe('INVALID_TRANSITION');
    expect(noNoteRes.body.error.message).toContain('resolution_note');

    // With resolution note -> 200 OK
    const withNoteRes = await client
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'resolved', resolutionNote: 'Cleaned up system cache and verified SLA.' });

    expect(withNoteRes.status).toBe(200);
    expect(withNoteRes.body.item.status).toBe('resolved');
  });

  it('separation of duties: reporter and current assignee CANNOT approve an item; only a distinct lead can approve', async () => {
    const lead1Client = authenticatedRequest(lead1Auth); // Priya (Lead 1)
    const lead2Client = authenticatedRequest(lead2Auth); // Marcus (Lead 2)

    // Lead 1 creates an item requiring approval and assigns it to Member
    const createRes = await lead1Client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'compliance_request',
        title: 'Compliance high-risk approval item',
        description: 'Item requiring dual-control separation of duties.',
        assigneeId: memberAuth.user.id,
        requiresApproval: true,
      });

    const itemId = createRes.body.item.id;

    // Advance to awaiting_approval
    await lead1Client.post(`/api/v1/items/${itemId}/transition`).set('Idempotency-Key', crypto.randomUUID()).send({ status: 'triaged' });
    await lead1Client.post(`/api/v1/items/${itemId}/transition`).set('Idempotency-Key', crypto.randomUUID()).send({ status: 'in_progress' });
    const awaitingRes = await lead1Client
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'awaiting_approval' });

    expect(awaitingRes.status).toBe(200);
    expect(awaitingRes.body.item.status).toBe('awaiting_approval');
    expect(awaitingRes.body.item.approval_status).toBe('pending');

    // 1. Separation of duties check: Priya (reporter) tries to approve -> 403 FORBIDDEN
    const selfApproveRes = await lead1Client
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'resolved', action: 'approve', resolutionNote: 'Self-approval attempt' });

    expect(selfApproveRes.status).toBe(403);
    expect(selfApproveRes.body.error.code).toBe('FORBIDDEN');
    expect(selfApproveRes.body.error.message).toContain('reporter cannot approve');

    // 2. Separation of duties check: Assignee (Elena) tries to approve -> 403 FORBIDDEN
    const memberClient = authenticatedRequest(memberAuth);
    const assigneeApproveRes = await memberClient
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'resolved', action: 'approve', resolutionNote: 'Assignee approval attempt' });

    expect(assigneeApproveRes.status).toBe(403);

    // 3. Independent lead Marcus (Lead 2, neither reporter nor assignee) approves -> 200 OK
    const distinctLeadApproveRes = await lead2Client
      .post(`/api/v1/items/${itemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ status: 'resolved', action: 'approve', resolutionNote: 'Reviewed and verified compliance by Marcus.' });

    expect(distinctLeadApproveRes.status).toBe(200);
    expect(distinctLeadApproveRes.body.item.status).toBe('resolved');
    expect(distinctLeadApproveRes.body.item.approval_status).toBe('approved');
    expect(distinctLeadApproveRes.body.item.approved_by).toBe(lead2Auth.user.id);
  });

  it('T2: claiming a new item moves it to triaged; claiming a blocked or awaiting_approval item keeps its status', async () => {
    const client = authenticatedRequest(lead1Auth);
    const memberClient = authenticatedRequest(memberAuth);

    // 1. Create a fresh item in status 'new'
    const createNewRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: 'Fresh new item for claim testing',
        description: 'Verifying claim moves new -> triaged',
        assigneeId: null,
      });
    expect(createNewRes.status).toBe(201);
    expect(createNewRes.body.item.status).toBe('new');
    const newItemId = createNewRes.body.item.id;

    // Member claims the 'new' item
    const claimNewRes = await memberClient
      .post(`/api/v1/items/${newItemId}/claim`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send();

    expect(claimNewRes.status).toBe(200);
    expect(claimNewRes.body.item.assignee_id).toBe(memberAuth.user.id);
    // MUST move to 'triaged' (not 'in_progress'), preserving the state machine
    expect(claimNewRes.body.item.status).toBe('triaged');

    // 2. Create an item, transition it to 'in_progress', then 'blocked', then unassign it (or reassign)
    const createBlockedRes = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: 'Item to be blocked and claimed',
        description: 'Verifying claim on blocked preserves blocked status',
        assigneeId: lead1Auth.user.id,
      });
    const blockedItemId = createBlockedRes.body.item.id;
    let version = createBlockedRes.body.item.version;

    // Move new -> triaged -> in_progress -> blocked
    const triageRes = await client
      .post(`/api/v1/items/${blockedItemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', `"${version}"`)
      .send({ status: 'triaged' });
    version = triageRes.body.item.version;

    const progRes = await client
      .post(`/api/v1/items/${blockedItemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', `"${version}"`)
      .send({ status: 'in_progress' });
    version = progRes.body.item.version;

    const blockRes = await client
      .post(`/api/v1/items/${blockedItemId}/transition`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', `"${version}"`)
      .send({ status: 'blocked' });
    version = blockRes.body.item.version;

    // Unassign so it can be claimed
    const unassignRes = await client
      .patch(`/api/v1/items/${blockedItemId}`)
      .set('Idempotency-Key', crypto.randomUUID())
      .set('If-Match', `"${version}"`)
      .send({ assigneeId: null });
    expect(unassignRes.status).toBe(200);
    expect(unassignRes.body.item.status).toBe('blocked');
    expect(unassignRes.body.item.assignee_id).toBeNull();

    // Member claims the unassigned blocked item
    const claimBlockedRes = await memberClient
      .post(`/api/v1/items/${blockedItemId}/claim`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send();

    expect(claimBlockedRes.status).toBe(200);
    expect(claimBlockedRes.body.item.assignee_id).toBe(memberAuth.user.id);
    // Claiming a blocked item MUST keep its status as 'blocked'
    expect(claimBlockedRes.body.item.status).toBe('blocked');
  });
});

