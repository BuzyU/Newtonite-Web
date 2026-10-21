import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';

describe('SEC-01: Insecure unverified auth endpoint removal', () => {
  it('rejects unauthenticated attempts and confirms /auth/firebase endpoint is removed (404)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/firebase')
      .set('X-Requested-With', 'XMLHttpRequest')
      .send({
        email: 'admin@newtonite.local',
        uid: 'attacker-uid',
      });

    // Must return 404 Not Found (endpoint eradicated)
    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('ROUTE_NOT_FOUND');
  });
});
