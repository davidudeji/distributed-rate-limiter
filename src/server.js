'use strict';

/**
 * Fastify application entry point.
 *
 * Routes:
 *   GET  /check          – rate-limit probe (any authenticated client)
 *   GET  /health         – circuit-breaker + Redis status
 *   GET  /ready          – readiness (Postgres + Redis both up)
 *   GET  /live           – liveness (process alive)
 *   PUT  /clients/:key   – update client config (invalidates cache)
 */

const Fastify = require('fastify');
const Redis   = require('ioredis');
const db      = require('./db');
const { startWorker, stopWorker } = require('./worker');
const { getQueue }                = require('./queue');
const { rateLimitPlugin } = require('./middleware/rateLimitMiddleware');


function buildApp(opts = {}) {
  const app = Fastify({
    logger: opts.logger ?? {
      level: process.env.LOG_LEVEL ?? 'info',
      transport: process.env.NODE_ENV === 'development'
        ? { target: 'pino-pretty' }
        : undefined,
    },
  });

  const redis = opts.redis ?? new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    lazyConnect: false,
    enableReadyCheck: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 100, 2000),
  });

  // ── Register rate-limit plugin (applies to all routes via onRequest hook)
  app.register(rateLimitPlugin, { redis });

  // ── Routes ──────────────────────────────────────────────────────────────

  // Primary rate-limit probe endpoint
  app.get('/check', async (request, reply) => {
    return { ok: true, ts: Date.now() };
  });

  // Liveness — always 200 if the process is alive
  app.get('/live', { config: { skipRateLimit: true } }, async () => {
    return { status: 'alive' };
  });

  // Readiness — checks both Redis and Postgres
  app.get('/ready', { config: { skipRateLimit: true } }, async (request, reply) => {
    const checks = {};
    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch (e) {
      checks.redis = 'error';
    }
    try {
      await db.query('SELECT 1');
      checks.postgres = 'ok';
    } catch (e) {
      checks.postgres = 'error';
    }
    const healthy = Object.values(checks).every((v) => v === 'ok');
    return reply.code(healthy ? 200 : 503).send({ status: healthy ? 'ready' : 'degraded', checks });
  });

  // Health — returns circuit breaker state + stats + queue depth
  app.get('/health', { config: { skipRateLimit: true } }, async (request, reply) => {
    const breaker = app.circuitBreaker;
    let queueDepth = null;
    try {
      const q = getQueue(redis);
      queueDepth = await q.getWaitingCount();
    } catch {}
    return {
      status:         breaker?.isClosed ? 'healthy' : 'degraded',
      circuitBreaker: breaker?.stats() ?? null,
      analytics:      { queueDepth },
      uptime:         process.uptime(),
    };
  });

  // Admin: update client config (explicit cache invalidation)
  app.put('/clients/:apiKey', { config: { skipRateLimit: true } }, async (request, reply) => {
    const { apiKey } = request.params;
    const updates    = request.body;
    try {
      const updated = await app.configCache.update(apiKey, updates);
      if (!updated) return reply.code(404).send({ error: 'Client not found' });
      return { ok: true, client: updated };
    } catch (err) {
      request.log.error(err);
      return reply.code(400).send({ error: err.message });
    }
  });

  // Graceful shutdown
  app.addHook('onClose', async () => {
    await stopWorker();
    await redis.quit();
    await db.close();
  });


  return app;
}

// ── Start server when run directly ────────────────────────────────────────

if (require.main === module) {
  (async () => {
    try {
      await db.migrate();
    } catch (err) {
      console.warn('[startup] DB migration skipped (Postgres may not be available):', err.message);
    }

    const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
      maxRetriesPerRequest: 3,
    });

    // Start the analytics worker (Tier 2)
    startWorker(redis);

    const app  = buildApp();
    const port = parseInt(process.env.PORT ?? '3000', 10);
    const host = process.env.HOST ?? '0.0.0.0';

    await app.listen({ port, host });
    console.log(`Server listening on ${host}:${port}`);
  })();
}


module.exports = { buildApp };
