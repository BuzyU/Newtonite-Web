import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';

describe('Authorization: Role x Action Matrix and SQL Resource Scoping', () => {
  let priyaAuth: AuthContext; // Lead in Operations, Viewer in Engineering, Not in Payments
  let elenaAuth: AuthContext; // Member in Operations
  let sarahAuth: AuthContext; // Viewer in Operations
  let opsTeam: { id: string; name: string };
  let engTeam: { id: string; name: string };
  let payTeam: { id: string; name: string };

  let opsItemId: string;
  let engItemId: string;
  let payItemId: string;

  beforeAll(async () => {
    priyaAuth = await loginAs('priya.lead@newtonite.local');
    elenaAuth = await loginAs('elena.member@newtonite.local');
    sarahAuth = await loginAs('sarah.viewer@newtonite.local');

    opsTeam = await getTeamBySlug('operations');
    engTeam = await getTeamBySlug('engineering');
    payTeam = await getTeamBySlug('payments');

    // Create an item in Operations
    const elenaClient = authenticatedRequest(elenaAuth);
    const opsRes = await elenaClient
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: opsTeam.id,
        type: 'operational_task',
        title: 'Operations team secret task',
        description: 'Should be visible only to operations members.',
        priority: 'medium',
      });
    opsItemId = opsRes.body.item.id;

    // Create an item in Engineering
    const arjunAuth = await loginAs('arjun.lead@newtonite.local');
    const arjunClient = authenticatedRequest(arjunAuth);
    const engRes = await arjunClient
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: engTeam.id,
        type: 'engineering_problem',
        title: 'Engineering backend architecture redesign',
        description: 'Priya is viewer here.',
        priority: 'high',
      });
    engItemId = engRes.body.item.id;

    // Create an item in Payments
    const sofiaAuth = await loginAs('sofia.lead@newtonite.local');
    const sofiaClient = authenticatedRequest(sofiaAuth);
    const payRes = await sofiaClient
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: payTeam.id,
        type: 'payment_investigation',
        title: 'Payments transaction reconciliation anomaly',
        description: 'Priya does not belong to payments at all.',
        priority: 'urgent',
      });
    payItemId = payRes.body.item.id;
  });

  it('items of teams user does not belong to return 404 NOT FOUND (never 403)', async () => {
    const priyaClient = authenticatedRequest(priyaAuth);

    // Priya is NOT in Payments team. Accessing payItemId must return 404, NOT 403!
    const res = await priyaClient.get(`/api/v1/items/${payItemId}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ITEM_NOT_FOUND');
  });

  it('items of other teams never appear in list items or search', async () => {
    const priyaClient = authenticatedRequest(priyaAuth);

    // Search for payment anomaly text
    const listRes = await priyaClient.get('/api/v1/items?search=reconciliation+anomaly');
    expect(listRes.status).toBe(200);
    const foundIds = listRes.body.items.map((i: any) => i.id);
    expect(foundIds).not.toContain(payItemId);
  });

  it('viewer role can view visible items, but gets 403 FORBIDDEN when attempting mutations', async () => {
    const sarahClient = authenticatedRequest(sarahAuth); // Viewer in operations

    // Can view
    const viewRes = await sarahClient.get(`/api/v1/items/${opsItemId}`);
    expect(viewRes.status).toBe(200);

    // Cannot create item -> 403
    const createRes = await sarahClient
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: opsTeam.id,
        type: 'operational_task',
        title: 'Viewer creating an item',
        description: 'Should fail with 403.',
      });
    expect(createRes.status).toBe(403);
    expect(createRes.body.error.code).toBe('FORBIDDEN');

    // Cannot comment -> 403
    const commentRes = await sarahClient
      .post(`/api/v1/items/${opsItemId}/comments`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ content: 'Viewer comment attempt' });
    expect(commentRes.status).toBe(403);
    expect(commentRes.body.error.code).toBe('FORBIDDEN');
  });

  it('cross-team user (Priya: Lead in Ops, Viewer in Eng) has Lead permissions in Ops but only Viewer in Eng', async () => {
    const priyaClient = authenticatedRequest(priyaAuth);

    // In Operations (Lead): Can change priority
    const opsItemRes = await priyaClient.get(`/api/v1/items/${opsItemId}`);
    const currentVersion = opsItemRes.body.item.version;

    const opsPrioRes = await priyaClient
      .patch(`/api/v1/items/${opsItemId}`)
      .set('If-Match', `"${currentVersion}"`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ priority: 'urgent' });
    expect(opsPrioRes.status).toBe(200);
    expect(opsPrioRes.body.item.priority).toBe('urgent');

    // In Engineering (Viewer): Can view
    const engViewRes = await priyaClient.get(`/api/v1/items/${engItemId}`);
    expect(engViewRes.status).toBe(200);

    // In Engineering (Viewer): Attempting to change priority returns 403 FORBIDDEN
    const engVersion = engViewRes.body.item.version;
    const engPrioRes = await priyaClient
      .patch(`/api/v1/items/${engItemId}`)
      .set('If-Match', `"${engVersion}"`)
      .set('Idempotency-Key', crypto.randomUUID())
      .send({ priority: 'low' });
    expect(engPrioRes.status).toBe(403);
    expect(engPrioRes.body.error.code).toBe('FORBIDDEN');
  });
});
