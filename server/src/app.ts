import crypto from 'crypto';
import express, { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pool, logger } from './db.js';
import {
  loginHandler,
  logoutHandler,
  meHandler,
  requireAuth,
  csrfProtection,
} from './auth.js';
import {
  listItemsHandler,
  getItemHandler,
  createItemHandler,
  claimItemHandler,
  updateItemHandler,
  transitionItemHandler,
  getItemActivityHandler,
  addCommentHandler,
  getItemCommentsHandler,
  getAttentionDashboardHandler,
} from './items.js';
import { requireIdempotency } from './idempotency.js';
import { sseHandler } from './sse.js';
import {
  listTeamsHandler,
  listTeamMembersHandler,
  listDeadLettersHandler,
  retryDeadLetterHandler,
} from './teams.js';

export function createApp() {
  const app = express();

  // Set trust proxy: Render sits behind Vercel edge reverse proxy
  // 'loopback, linklocal, uniquelocal' or hop count 2
  app.set('trust proxy', 2);

  // 1. Security Headers via Helmet
  app.use(
    helmet({
      contentSecurityPolicy: false, // Managed by Vercel for the web app
      crossOriginEmbedderPolicy: false,
    })
  );

  // 2. Body Parser with strict payload size limit (1MB)
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  // 3. CORS configuration: disabled by default (same-origin via Vercel proxy)
  const allowedOrigin = process.env.APP_ORIGIN;
  if (allowedOrigin) {
    app.use(
      cors({
        origin: allowedOrigin,
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'X-Requested-With', 'Idempotency-Key', 'If-Match'],
        exposedHeaders: ['ETag', 'Retry-After', 'X-Idempotent-Replay'],
      })
    );
  }

  // 4. Request ID & Structured Logging Middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const reqId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    req.requestId = reqId;
    res.setHeader('X-Request-Id', reqId);

    const start = Date.now();
    res.on('finish', () => {
      // Don't spam logs with healthcheck pings
      if (req.path === '/api/v1/health' || req.path === '/api/v1/ready') {
        return;
      }
      logger.info(
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Date.now() - start,
          ip: req.ip,
          requestId: reqId,
        },
        'HTTP request completed'
      );
    });

    next();
  });

  // --------------------------------------------------------------------------
  // Health & Readiness Endpoints (Unauthenticated, no CSRF)
  // --------------------------------------------------------------------------

  // Liveness check: does not touch database
  app.get('/api/v1/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'live', timestamp: new Date().toISOString() });
  });

  // Readiness check: touches database via SELECT 1 (used by keepalive and load balancers)
  app.get('/api/v1/ready', async (req: Request, res: Response) => {
    try {
      await pool.query('SELECT 1');
      res.status(200).json({ status: 'ready', database: 'connected', timestamp: new Date().toISOString() });
    } catch (err: any) {
      logger.error({ err, requestId: req.requestId }, 'Readiness probe failed');
      res.status(503).json({
        status: 'unready',
        error: 'Database connection failed',
        requestId: req.requestId,
      });
    }
  });

  // --------------------------------------------------------------------------
  // Authentication Routes
  // --------------------------------------------------------------------------
  app.post('/api/v1/auth/login', csrfProtection, loginHandler);
  app.post('/api/v1/auth/logout', csrfProtection, logoutHandler);
  app.get('/api/v1/auth/me', requireAuth, meHandler);

  // --------------------------------------------------------------------------
  // Realtime Server-Sent Events (SSE)
  // --------------------------------------------------------------------------
  app.get('/api/v1/events', requireAuth, sseHandler);

  // --------------------------------------------------------------------------
  // Teams & Members
  // --------------------------------------------------------------------------
  app.get('/api/v1/teams', requireAuth, listTeamsHandler);
  app.get('/api/v1/teams/:id/members', requireAuth, listTeamMembersHandler);

  // --------------------------------------------------------------------------
  // Items API
  // --------------------------------------------------------------------------
  app.get('/api/v1/dashboard/attention', requireAuth, getAttentionDashboardHandler);
  app.get('/api/v1/items', requireAuth, listItemsHandler);
  app.get('/api/v1/items/:id', requireAuth, getItemHandler);

  // Mutating endpoints require CSRF defence and Idempotency-Key
  app.post('/api/v1/items', requireAuth, csrfProtection, requireIdempotency, createItemHandler);
  app.post('/api/v1/items/:id/claim', requireAuth, csrfProtection, requireIdempotency, claimItemHandler);
  app.patch('/api/v1/items/:id', requireAuth, csrfProtection, requireIdempotency, updateItemHandler);
  app.post('/api/v1/items/:id/transition', requireAuth, csrfProtection, requireIdempotency, transitionItemHandler);

  // Comments
  app.get('/api/v1/items/:id/comments', requireAuth, getItemCommentsHandler);
  app.post('/api/v1/items/:id/comments', requireAuth, csrfProtection, requireIdempotency, addCommentHandler);

  // Item Activity Timeline
  app.get('/api/v1/items/:id/activity', requireAuth, getItemActivityHandler);

  // --------------------------------------------------------------------------
  // Admin Routes (Dead-Letter Outbox inspection and retry)
  // --------------------------------------------------------------------------
  app.get('/api/v1/admin/dead-letters', requireAuth, listDeadLettersHandler);
  app.post('/api/v1/admin/dead-letters/:id/retry', requireAuth, csrfProtection, retryDeadLetterHandler);

  // --------------------------------------------------------------------------
  // 404 Route Handler
  // --------------------------------------------------------------------------
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `Endpoint ${req.method} ${req.path} not found.`,
        requestId: req.requestId,
      },
    });
  });

  // --------------------------------------------------------------------------
  // Global Error Handler: Never leak stack traces in responses
  // --------------------------------------------------------------------------
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err, requestId: req.requestId }, 'Unhandled server error');

    // Handle database lock/statement timeouts
    if (err.code === '57014' || err.message?.includes('statement timeout') || err.message?.includes('lock timeout')) {
      res.status(503).json({
        error: {
          code: 'DATABASE_TIMEOUT',
          message: 'The requested operation timed out. Please retry.',
          requestId: req.requestId,
        },
      });
      return;
    }

    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected internal error occurred.',
        requestId: req.requestId,
      },
    });
  });

  return app;
}
