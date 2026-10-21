import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';

describe('Rate Limiting & Abuse Prevention', () => {
  const app = createApp();

  it('rate limits login attempts per IP: returns 429 RATE_LIMIT_EXCEEDED after 5 failed attempts', async () => {
    const client = request(app);

    // Send 5 rapid failed login attempts
    for (let i = 0; i < 5; i++) {
      const res = await client
        .post('/api/v1/auth/login')
        .set('X-Requested-With', 'XMLHttpRequest')
        .set('X-Forwarded-For', '198.51.100.42')
        .send({
          email: 'nonexistent@newtonite.local',
          password: 'wrong-password',
        });
      // The first 5 will get 401 (invalid credentials)
      expect(res.status).toBe(401);
    }

    // The 6th attempt should trigger 429
    const blockedRes = await client
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-Forwarded-For', '198.51.100.42')
      .send({
        email: 'nonexistent@newtonite.local',
        password: 'wrong-password',
      });

    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(blockedRes.headers['retry-after']).toBeDefined();
  });

  it('rate limits mutating writes when WRITE_RATE_LIMIT threshold is reached', async () => {
    process.env.WRITE_RATE_LIMIT = '3';
    const client = request(app);

    // Attempt 3 mutating POST requests with random fake IP
    const testIp = '203.0.113.88';
    for (let i = 0; i < 3; i++) {
      const res = await client
        .post('/api/v1/auth/login')
        .set('X-Requested-With', 'XMLHttpRequest')
        .set('X-Forwarded-For', testIp)
        .send({ email: `user${i}@newtonite.local`, password: 'wrong' });
      // status is 401 (credentials check) not 429
      expect(res.status).toBe(401);
    }

    // 4th request from same IP should be blocked by writeRateLimiter with 429
    const blockedRes = await client
      .post('/api/v1/auth/login')
      .set('X-Requested-With', 'XMLHttpRequest')
      .set('X-Forwarded-For', testIp)
      .send({ email: 'user99@newtonite.local', password: 'wrong' });

    expect(blockedRes.status).toBe(429);
    expect(blockedRes.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(blockedRes.headers['retry-after']).toBeDefined();

    // Reset env
    delete process.env.WRITE_RATE_LIMIT;
  });
});


