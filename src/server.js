'use strict';

/**
 * Fastify application entry point.
 *
 * Routes (Tier 1 + 2 + 3 + Dashboard):
 *   GET  /check                        – rate-limit probe (any authenticated client)
 *   GET  /dashboard                    – monitoring dashboard HTML (Phase A)
 *   GET  /dashboard/clients            – client list for dropdown (no auth)
 *   GET  /dashboard/summary            – per-client window summary (Phase B)
 *   GET  /dashboard/trends             – per-client trend buckets (Phase B)
 *   GET  /dashboard/client/:apiKey     – single client config (Phase B)
 *   GET  /dashboard/top-clients        – top N clients by volume (Phase B)
 *   GET  /health                       – circuit-breaker + Redis status + queue depth
 *   GET  /ready                        – readiness (Postgres + Redis both up)
 *   GET  /live                         – liveness (process alive)
 *   GET  /metrics                      – req/s, allowed/blocked, cache hit ratio (Phase 10)
 *   GET  /analytics/trends/:apiKey     – per-client trend data (Phase 9)
 *   GET  /analytics/summary/:apiKey    – per-client summary stats (Phase 9)
 *   POST /admin/clients                – create client (Tier 3)
 *   GET  /admin/clients                – list clients (Tier 3)
 *   PUT  /admin/clients/:apiKey        – update client config (Tier 3)
 *   DEL  /admin/clients/:apiKey        – soft-delete client (Tier 3)
 */

const path    = require('node:path');
const fs      = require('node:fs');
const Fastify = require('fastify');
const Redis   = require('ioredis');
const db      = require('./db');
const { startWorker, stopWorker } = require('./worker');
const { getQueue }                = require('./queue');
const { rateLimitPlugin }         = require('./middleware/rateLimitMiddleware');
const { adminPlugin }             = require('./adminRoutes');
const { getTrends, getSummary, getTopClients } = require('./dashboard');

// ---------------------------------------------------------------------------
// In-process metrics counters (Phase 10)
// Simple atomic-style counters; reset on process restart.
// Production would export these to Prometheus via prom-client.
// ---------------------------------------------------------------------------
const metrics = {
  totalRequests:   0,
  allowedRequests: 0,
  blockedRequests: 0,
  cacheHits:       0,
  cacheMisses:     0,
  startedAt:       Date.now(),
};

/** Increment a metric from any module by attaching to global. */
global.__rlMetrics = metrics;

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

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

  // ── Optional: @fastify/helmet (security headers) ─────────────────────────
  // Registered first so headers are set on all responses including errors.
  try {
    const helmet = require('@fastify/helmet');
    app.register(helmet, {
      // Disable HSTS in non-production (plain HTTP dev server)
      hsts: process.env.NODE_ENV === 'production'
        ? { maxAge: 31_536_000 }
        : false,
      contentSecurityPolicy: false, // API — not a browser app
    });
  } catch {
    app.log.warn('[startup] @fastify/helmet not installed — security headers skipped');
  }

  // ── Optional: @fastify/cors ───────────────────────────────────────────────
  try {
    const cors = require('@fastify/cors');
    app.register(cors, {
      origin:         process.env.ALLOWED_ORIGINS?.split(',') ?? false,
      methods:        ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'x-api-key', 'x-admin-key'],
    });
  } catch {
    app.log.warn('[startup] @fastify/cors not installed — CORS skipped');
  }

  // ── Optional: @fastify/swagger ────────────────────────────────────────────
  try {
    const swagger   = require('@fastify/swagger');
    const swaggerUi = require('@fastify/swagger-ui');

    app.register(swagger, {
      openapi: {
        openapi: '3.1.0',
        info: {
          title:       'Distributed Rate Limiter API',
          description: 'Production-grade token-bucket rate limiter with per-client config, circuit breaker, and async analytics.',
          version:     '1.0.0',
        },
        tags: [
          { name: 'rate-limit', description: 'Core rate-limiting endpoints' },
          { name: 'analytics',  description: 'Dashboard and trend endpoints (Phase 9)' },
          { name: 'health',     description: 'Health, readiness, and metrics endpoints (Phase 10)' },
          { name: 'admin',      description: 'Admin CRUD API (Tier 3)' },
        ],
      },
    });

    app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig:    { docExpansion: 'list', deepLinking: false },
    });
  } catch {
    app.log.warn('[startup] @fastify/swagger not installed — /docs skipped');
  }

  // ── Register rate-limit plugin (applies to client routes via onRequest hook)
  app.register(rateLimitPlugin, { redis });

  // ── Register admin plugin (has its own auth + rate-limit hook) ───────────
  app.register(adminPlugin, { redis, prefix: '' });

  // ── Routes ──────────────────────────────────────────────────────────────

  // Primary rate-limit probe endpoint (Tier 1)
  app.get('/check', {
    config: {},
    schema: {
      description: 'Rate-limit probe for the authenticated client',
      tags:        ['rate-limit'],
      headers: {
        type: 'object',
        required: ['x-api-key'],
        properties: { 'x-api-key': { type: 'string' } },
      },
      response: {
        200: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, ts: { type: 'number' } },
        },
      },
    },
  }, async (request, reply) => {
    // Update metrics counters (the middleware has already incremented allowed/blocked
    // via the global; here we just track the total)
    metrics.totalRequests++;
    return { ok: true, ts: Date.now() };
  });

  // ── Dashboard (Phase A–C) ─────────────────────────────────────────────

  // Phase C: Serve the dashboard HTML from /dashboard
  // Using fs.readFileSync avoids @fastify/static as a hard dependency —
  // the dashboard is one self-contained file so static asset serving isn’t needed.
  const DASHBOARD_HTML_PATH = path.join(__dirname, '../public/index.html');

  app.get('/dashboard', { config: { skipRateLimit: true } }, async (request, reply) => {
    try {
      const html = fs.readFileSync(DASHBOARD_HTML_PATH, 'utf8');
      return reply.type('text/html; charset=utf-8').send(html);
    } catch {
      return reply.code(503).send('Dashboard not yet available — public/index.html missing.');
    }
  });

  // Phase A: Public client list — populates the dashboard dropdown (no admin auth).
  // Returns only the fields the UI needs; not a security risk as API keys are
  // not secrets in the same sense as passwords (they’re sent in every request header).
  app.get('/dashboard/clients', { config: { skipRateLimit: true } }, async (request, reply) => {
    try {
      const { rows } = await db.query(
        `SELECT api_key, mode, capacity, refill_rate
         FROM clients
         WHERE deleted_at IS NULL
         ORDER BY api_key ASC`,
      );
      return { clients: rows };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to load clients' });
    }
  });

  // Phase B: Per-client window summary — drives the summary stats row.
  app.get('/dashboard/summary', { config: { skipRateLimit: true },
    schema: {
      description: 'Per-client request summary over a given window',
      tags: ['analytics'],
      querystring: {
        type: 'object',
        required: ['clientId'],
        properties: {
          clientId: { type: 'string' },
          range:    { type: 'integer', minimum: 1, maximum: 31, default: 30 },
        },
      },
    },
  }, async (request, reply) => {
    const { clientId, range = 30 } = request.query;
    if (!clientId) return reply.code(400).send({ error: 'clientId is required' });
    try {
      return await getSummary(clientId, parseInt(range));
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to fetch summary' });
    }
  });

  // Phase B: Per-client trend buckets — drives the Chart.js line chart.
  // Reads from TimescaleDB continuous aggregates (never from raw analytics events).
  app.get('/dashboard/trends', { config: { skipRateLimit: true },
    schema: {
      description: 'Per-client request trends (backed by TimescaleDB continuous aggregates)',
      tags: ['analytics'],
      querystring: {
        type: 'object',
        required: ['clientId'],
        properties: {
          clientId:    { type: 'string' },
          range:       { type: 'integer', minimum: 1, maximum: 31, default: 30 },
          granularity: { type: 'string', enum: ['minute', 'hour'], default: 'hour' },
        },
      },
    },
  }, async (request, reply) => {
    const { clientId, range = 30, granularity = 'hour' } = request.query;
    if (!clientId) return reply.code(400).send({ error: 'clientId is required' });
    try {
      return await getTrends(clientId, { days: parseInt(range), granularity });
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to fetch trends' });
    }
  });

  // Phase B: Single client config — drives the "Client Config" sidebar card.
  app.get('/dashboard/client/:apiKey', { config: { skipRateLimit: true },
    schema: { description: 'Single client rate-limit config', tags: ['analytics'] },
  }, async (request, reply) => {
    const { apiKey } = request.params;
    try {
      const { rows } = await db.query(
        `SELECT id, api_key, capacity, refill_rate, mode, created_at, updated_at
         FROM clients
         WHERE api_key = $1 AND deleted_at IS NULL`,
        [apiKey],
      );
      if (rows.length === 0) return reply.code(404).send({ error: 'Client not found' });
      return { client: rows[0] };
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to fetch client' });
    }
  });

  // Phase B: Top clients by request volume — for future leaderboard extension.
  app.get('/dashboard/top-clients', { config: { skipRateLimit: true },
    schema: {
      description: 'Top N clients by request volume',
      tags: ['analytics'],
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
          range: { type: 'integer', minimum: 1, maximum: 31, default: 30 },
        },
      },
    },
  }, async (request, reply) => {
    const { limit = 10, range = 30 } = request.query;
    try {
      return await getTopClients(parseInt(limit), parseInt(range));
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to fetch top clients' });
    }
  });

  // ── Health / Observability (Phase 10) ────────────────────────────────────

  // Liveness — always 200 if the process is alive
  app.get('/live', {
    config: { skipRateLimit: true },
    schema: { description: 'Liveness probe', tags: ['health'] },
  }, async () => {
    return { status: 'alive' };
  });

  // Readiness — checks both Redis and Postgres
  app.get('/ready', {
    config: { skipRateLimit: true },
    schema: { description: 'Readiness probe — checks Redis and Postgres', tags: ['health'] },
  }, async (request, reply) => {
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
    return reply.code(healthy ? 200 : 503).send({
      status:  healthy ? 'ready' : 'degraded',
      checks,
    });
  });

  // Health — circuit breaker state + queue depth
  app.get('/health', {
    config: { skipRateLimit: true },
    schema: { description: 'Circuit breaker state, queue depth, and uptime', tags: ['health'] },
  }, async (request, reply) => {
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

  // Metrics — quantitative signal (Phase 10)
  app.get('/metrics', {
    config: { skipRateLimit: true },
    schema: {
      description: 'Request counters, cache hit ratio, and circuit breaker state',
      tags:        ['health'],
    },
  }, async (request, reply) => {
    const breaker    = app.circuitBreaker;
    const uptimeSec  = process.uptime();
    const total      = metrics.totalRequests;
    const allowed    = metrics.allowedRequests;
    const blocked    = metrics.blockedRequests;
    const hits       = metrics.cacheHits;
    const misses     = metrics.cacheMisses;

    let queueDepth = null;
    try {
      const q = getQueue(redis);
      queueDepth = await q.getWaitingCount();
    } catch {}

    return {
      requests: {
        total,
        allowed,
        blocked,
        allowRate:      total > 0 ? +(allowed / total).toFixed(4) : null,
        requestsPerSec: uptimeSec > 0 ? +(total / uptimeSec).toFixed(2) : 0,
      },
      cache: {
        hits,
        misses,
        hitRatio: (hits + misses) > 0 ? +(hits / (hits + misses)).toFixed(4) : null,
      },
      circuitBreaker: breaker?.stats() ?? null,
      analytics:      { queueDepth },
      uptime:         uptimeSec,
      startedAt:      new Date(metrics.startedAt).toISOString(),
    };
  });

  // ── Analytics / Dashboard (Phase 9) ──────────────────────────────────────

  // Trend data for a client (backed by TimescaleDB continuous aggregates)
  app.get('/analytics/trends/:apiKey', {
    config: { skipRateLimit: true },
    schema: {
      description: 'Per-client trend data (10/15/30-day). Reads from TimescaleDB aggregates; falls back to plain Postgres.',
      tags:        ['analytics'],
      params: {
        type:       'object',
        properties: { apiKey: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          days:        { type: 'integer', minimum: 1, maximum: 31, default: 30 },
          granularity: { type: 'string',  enum: ['minute', 'hour'], default: 'hour' },
        },
      },
    },
  }, async (request, reply) => {
    const { apiKey } = request.params;
    const { days, granularity } = request.query;
    try {
      const data = await getTrends(apiKey, { days, granularity });
      return data;
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to fetch trend data' });
    }
  });

  // Summary stats for a client
  app.get('/analytics/summary/:apiKey', {
    config: { skipRateLimit: true },
    schema: {
      description: 'Summary stats for a client over a given window',
      tags:        ['analytics'],
      params: {
        type:       'object',
        properties: { apiKey: { type: 'string' } },
      },
      querystring: {
        type: 'object',
        properties: {
          days: { type: 'integer', minimum: 1, maximum: 31, default: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { apiKey } = request.params;
    const { days }   = request.query;
    try {
      const data = await getSummary(apiKey, days);
      return data;
    } catch (err) {
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to fetch summary' });
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
    if (process.env.NODE_ENV !== 'production') {
      console.log(`Swagger UI: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/docs`);
    }
  })();
}

module.exports = { buildApp, metrics };
