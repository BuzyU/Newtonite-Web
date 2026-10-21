import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { broadcastEvent, sseHandler, dropUserSseClients, closeSseHub } from '../src/sse.js';
import { pool } from '../src/db.js';
import { getTeamBySlug, loginAs, AuthContext } from './helpers.js';

class MockResponse extends EventEmitter {
  public headers: Record<string, string> = {};
  public chunks: string[] = [];
  public finished = false;

  setHeader(name: string, value: string) {
    this.headers[name.toLowerCase()] = value;
  }
  flushHeaders() {}
  write(chunk: string) {
    this.chunks.push(chunk);
    this.emit('data', chunk);
    return true;
  }
  end() {
    this.finished = true;
    this.emit('close');
  }
}

describe('SSE Dynamic Membership Re-check, Scoping, and Lifecycle', () => {
  let adminAuth: AuthContext;
  let memberAuth: AuthContext;
  let team: { id: string; name: string };

  beforeAll(async () => {
    adminAuth = await loginAs('admin@newtonite.local');
    memberAuth = await loginAs('elena.member@newtonite.local');
    team = await getTeamBySlug('operations');
  });

  afterAll(async () => {
    await closeSseHub();
  });

  it('re-checks DB membership on broadcast: a member removed from the team stops receiving subsequent events', async () => {
    // 1. Ensure member is currently in team_memberships
    await pool.query(
      `INSERT INTO team_memberships (user_id, team_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (user_id, team_id) DO NOTHING`,
      [memberAuth.user.id, team.id]
    );

    // 2. Connect mock SSE response
    const mockRes = new MockResponse();
    const mockReq: any = {
      user: {
        id: memberAuth.user.id,
        email: memberAuth.user.email,
        name: memberAuth.user.name,
        isOrgAdmin: false,
        memberships: new Map([[team.id, 'member']]),
      },
      headers: {},
      query: {},
      on: (event: string, cb: () => void) => mockRes.on(event, cb),
    };

    sseHandler(mockReq, mockRes as any);

    // Verify initial handshake
    expect(mockRes.chunks.length).toBeGreaterThan(0);
    expect(mockRes.chunks[0]).toContain('event: connected');

    // 3. Broadcast an event for this team while user IS a member
    mockRes.chunks = [];
    await broadcastEvent({
      id: crypto.randomUUID(),
      event_type: 'item.created',
      team_id: team.id,
      item_id: crypto.randomUUID(),
      version: 1,
    });

    // The active member received the event
    expect(mockRes.chunks.length).toBe(1);
    expect(mockRes.chunks[0]).toContain('event: item_update');

    // 4. Remove member from the team in the database
    await pool.query(
      `DELETE FROM team_memberships WHERE user_id = $1 AND team_id = $2`,
      [memberAuth.user.id, team.id]
    );

    // 5. Broadcast a second event for this team
    mockRes.chunks = [];
    await broadcastEvent({
      id: crypto.randomUUID(),
      event_type: 'item.updated',
      team_id: team.id,
      item_id: crypto.randomUUID(),
      version: 2,
    });

    // CRITICAL PROOF: The removed member DID NOT receive the event!
    expect(mockRes.chunks.length).toBe(0);

    // Cleanup: restore member to operations team and disconnect
    await pool.query(
      `INSERT INTO team_memberships (user_id, team_id, role)
       VALUES ($1, $2, 'member')
       ON CONFLICT (user_id, team_id) DO NOTHING`,
      [memberAuth.user.id, team.id]
    );
    mockRes.end();
  });

  it('scoping: events lacking team_id are only delivered to Org Admins, never to regular members', async () => {
    const adminRes = new MockResponse();
    const memberRes = new MockResponse();

    const adminReq: any = {
      user: {
        id: adminAuth.user.id,
        email: adminAuth.user.email,
        name: adminAuth.user.name,
        isOrgAdmin: true,
        memberships: new Map([[team.id, 'admin']]),
      },
      headers: {},
      query: {},
      on: (event: string, cb: () => void) => adminRes.on(event, cb),
    };

    const memberReq: any = {
      user: {
        id: memberAuth.user.id,
        email: memberAuth.user.email,
        name: memberAuth.user.name,
        isOrgAdmin: false,
        memberships: new Map([[team.id, 'member']]),
      },
      headers: {},
      query: {},
      on: (event: string, cb: () => void) => memberRes.on(event, cb),
    };

    sseHandler(adminReq, adminRes as any);
    sseHandler(memberReq, memberRes as any);

    adminRes.chunks = [];
    memberRes.chunks = [];

    // Broadcast an event without team_id (e.g. system broadcast or dlq notification)
    await broadcastEvent({
      id: crypto.randomUUID(),
      event_type: 'system.maintenance',
      team_id: undefined,
      version: 1,
    });

    // Admin received it
    expect(adminRes.chunks.length).toBe(1);
    expect(adminRes.chunks[0]).toContain('system.maintenance');

    // Regular member did NOT receive it
    expect(memberRes.chunks.length).toBe(0);

    adminRes.end();
    memberRes.end();
  });

  it('handles Last-Event-ID on reconnect by immediately sending a resync signal', () => {
    const mockRes = new MockResponse();
    const mockReq: any = {
      user: {
        id: memberAuth.user.id,
        email: memberAuth.user.email,
        name: memberAuth.user.name,
        isOrgAdmin: false,
        memberships: new Map(),
      },
      headers: {
        'last-event-id': 'evt-12345',
      },
      query: {},
      on: (event: string, cb: () => void) => mockRes.on(event, cb),
    };

    sseHandler(mockReq, mockRes as any);

    // Initial output should have both 'connected' and 'resync'
    const fullOutput = mockRes.chunks.join('');
    expect(fullOutput).toContain('event: connected');
    expect(fullOutput).toContain('event: resync');
    expect(fullOutput).toContain('evt-12345');

    mockRes.end();
  });

  it('dropUserSseClients immediately terminates active SSE connections for that user', () => {
    const mockRes = new MockResponse();
    const testUserId = crypto.randomUUID();
    const mockReq: any = {
      user: {
        id: testUserId,
        email: 'temp@test.com',
        name: 'Temp',
        isOrgAdmin: false,
        memberships: new Map(),
      },
      headers: {},
      query: {},
      on: (event: string, cb: () => void) => mockRes.on(event, cb),
    };

    sseHandler(mockReq, mockRes as any);
    expect(mockRes.finished).toBe(false);

    dropUserSseClients(testUserId);
    expect(mockRes.finished).toBe(true);
  });
});
