import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { loginAs, authenticatedRequest, getTeamBySlug, AuthContext } from './helpers.js';

describe('T3: Search Index Utilization and Matching Precision', () => {
  let leadAuth: AuthContext;
  let team: { id: string; name: string };
  let itemExactRef: string;
  let wildcardItemId: string;
  let nonWildcardItemId: string;

  beforeAll(async () => {
    leadAuth = await loginAs('priya.lead@newtonite.local');
    team = await getTeamBySlug('operations');
    const client = authenticatedRequest(leadAuth);

    // Create item 1: for ref and full-text test
    const res1 = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'operational_task',
        title: 'Reconciliation database latency spike',
        description: 'Detailed analysis of payment webhook failures.',
        assigneeId: null,
      });
    expect(res1.status).toBe(201);
    itemExactRef = res1.body.item.short_ref;

    // Create item 2: for literal wildcard test (contains literal '%' and '_')
    const res2 = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'compliance_request',
        title: 'Target 99.9% uptime code_alpha release',
        description: 'Verify SLA uptime commitments for Q3.',
        assigneeId: null,
      });
    expect(res2.status).toBe(201);
    wildcardItemId = res2.body.item.id;

    // Create item 3: decoy that would match unescaped wildcard (codeXalpha where _ matches X)
    const res3 = await client
      .post('/api/v1/items')
      .set('Idempotency-Key', crypto.randomUUID())
      .send({
        teamId: team.id,
        type: 'compliance_request',
        title: 'Target 9909 uptime codeXalpha release',
        description: 'Decoy item for unescaped wildcard testing.',
        assigneeId: null,
      });
    expect(res3.status).toBe(201);
    nonWildcardItemId = res3.body.item.id;
  });

  it('finds items by exact short_ref', async () => {
    const client = authenticatedRequest(leadAuth);
    const res = await client.get(`/api/v1/items?search=${itemExactRef}`);
    expect(res.status).toBe(200);
    const found = res.body.items.some((i: any) => i.short_ref === itemExactRef);
    expect(found).toBe(true);
  });

  it('finds items by partial short_ref prefix', async () => {
    const client = authenticatedRequest(leadAuth);
    const prefix = itemExactRef.substring(0, 5); // e.g. "OPS-1"
    const res = await client.get(`/api/v1/items?search=${prefix}`);
    expect(res.status).toBe(200);
    const found = res.body.items.some((i: any) => i.short_ref === itemExactRef);
    expect(found).toBe(true);
  });

  it('finds items by title substring', async () => {
    const client = authenticatedRequest(leadAuth);
    const res = await client.get('/api/v1/items?search=latency spike');
    expect(res.status).toBe(200);
    const found = res.body.items.some((i: any) => i.short_ref === itemExactRef);
    expect(found).toBe(true);
  });

  it('finds items by full-text keyword', async () => {
    const client = authenticatedRequest(leadAuth);
    const res = await client.get('/api/v1/items?search=reconciliation');
    expect(res.status).toBe(200);
    const found = res.body.items.some((i: any) => i.short_ref === itemExactRef);
    expect(found).toBe(true);
  });

  it('escapes % and _ wildcards so literal search matches only literal characters', async () => {
    const client = authenticatedRequest(leadAuth);

    // Searching for "code_alpha" with escaped _ must match the item with literal '_', NOT 'X'
    const resUnderscore = await client.get('/api/v1/items?search=code_alpha');
    expect(resUnderscore.status).toBe(200);
    const matchesUnderscore = resUnderscore.body.items.filter((i: any) => i.id === wildcardItemId);
    const matchesDecoy = resUnderscore.body.items.filter((i: any) => i.id === nonWildcardItemId);
    expect(matchesUnderscore.length).toBe(1);
    expect(matchesDecoy.length).toBe(0);

    // Searching for "99.9%" with escaped % must match the literal % item
    const resPercent = await client.get('/api/v1/items?search=99.9%');
    expect(resPercent.status).toBe(200);
    const matchesPercent = resPercent.body.items.filter((i: any) => i.id === wildcardItemId);
    expect(matchesPercent.length).toBe(1);
  });
});
