import http from 'http';
import { createApp } from './app.js';
import { pool, logger } from './db.js';
import { initSseListener, closeSseHub } from './sse.js';
import { OutboxWorker } from './worker.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = '0.0.0.0';

const app = createApp();
const server = http.createServer(app);

let worker: OutboxWorker | null = null;

async function bootstrap() {
  // 1. Initialize dedicated SSE LISTEN client
  try {
    await initSseListener();
  } catch (sseErr) {
    logger.warn({ err: sseErr }, 'Initial SSE listener start failed; reconnect loop will retry in background');
  }

  // 2. Start in-process outbox worker if configured (used on Render free tier)
  if (process.env.RUN_WORKER_IN_API === 'true') {
    logger.info('RUN_WORKER_IN_API=true: starting OutboxWorker inside API process');
    worker = new OutboxWorker();
    await worker.start();
  }

  // 3. Start listening
  server.listen(PORT, HOST, () => {
    logger.info({ port: PORT, host: HOST, env: process.env.NODE_ENV }, 'Newtonite API server listening');
  });
}

// Graceful Shutdown Handler
let isShuttingDown = false;

async function handleShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Shutdown signal received. Commencing graceful shutdown...');

  // Set timeout to force exit if graceful shutdown hangs
  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out after 10s. Forcing exit.');
    process.exit(1);
  }, 10000);

  try {
    // 1. Stop accepting new HTTP requests
    server.close(() => {
      logger.info('HTTP server closed; no longer accepting requests.');
    });

    // 2. Close active SSE streams and LISTEN client
    await closeSseHub();
    logger.info('SSE connections closed.');

    // 3. Stop background worker if running in-process
    if (worker) {
      worker.stop();
      logger.info('In-process OutboxWorker stopped.');
    }

    // 4. Drain database connection pool
    await pool.end();
    logger.info('Database pool drained and closed.');

    clearTimeout(forceExitTimer);
    logger.info('Graceful shutdown complete.');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

bootstrap().catch((err) => {
  logger.fatal({ err }, 'Fatal error during server bootstrap');
  process.exit(1);
});
