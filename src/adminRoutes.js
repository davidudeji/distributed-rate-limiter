'use strict';

/**
 * Admin CRUD API — Tier 3
 *
 * Full lifecycle management for API clients.
 * Registered as a Fastify plugin with:
 *   - Its own admin-key authentication (x-admin-key header)
 *   - Its own rate-limit bucket (prefix: admin-rl:) — isolated from client traffic
 *   - Fail-closed: admin operations are denied if Redis is down
 *
 * Routes:
 *   POST   /admin/clients           – create a new client
 *   GET    /admin/clients           – list all clients (paginated)
 *   GET    /admin/clients/:apiKey   – get one client
 *   PUT    /admin/clients/:apiKey   – update config (invalidates cache)
 *   DELETE /admin/clients/:apiKey   – delete client (evicts cache + bucket)
 *
 * Security design:
 *   - Admin key is separate from client keys (x-admin-key vs x-api-key)
 *   - Admin rate limiter uses a dedicated Redis key prefix so admin calls
 *     never consume or affect client quota
 *   - Admin limiter is fail-closed: if Redis is down, admin writes are blocked
 *     to prevent accidental config mutations in a degraded state
 *
 * Trade-off: API key hashing
 *   Production hardening would store sha256(apiKey) in Postgres rather than
 *   the raw key, so a DB dump doesn't expose credentials.  This implementation
 *   stores the raw key to keep the core logic readable; the hashing layer
 *   is documented in Tier3.md as the production upgrade path.
 */

const { randomBytes }        = require('node:crypto');
const { TokenBucketLimiter } = require('./rateLimiter');
const { CircuitBreaker }     = require('./circuitBreaker');
const db                     = require('./db');

// ---------------------------------------------------------------------------
// Admin rate-limit config (separate from client limits)
// ---------------------------------------------------------------------------

const ADMIN_RATE_LIMIT = {
  capacity:   100,    // 100 admin requests per window
  refillRate: 1,      // 1 token/second ≈ 60/min sustained
  requested:  1,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} opts
 * @param {import('ioredis').Redis} opts.redis
 * @param {string} [opts.adminKeyHeader='x-admin-key']
 */
async function adminPlugin(fastify, opts) {
  const redis       = opts.redis;
  const adminHeader = opts.adminKeyHeader ?? 'x-admin-key';
  const ADMIN_KEY   = process.env.ADMIN_KEY ?? 'admin-secret';

  // Admin-specific rate limiter (prefix keeps it isolated from client buckets)
  const adminLimiter  = new TokenBucketLimiter(redis, { keyPrefix: 'admin-rl' });
  const adminBreaker  = new CircuitBreaker({
    failureThreshold:  3,
    successThreshold:  1,
    halfOpenTimeoutMs: 10_000,
    healthCheck: () => redis.ping(),
  });

  // ── Admin auth + rate-limit hook ───────────────────────────────────────
  fastify.addHook('onRequest', async (request, reply) => {
    // 1. Authenticate
    const key = request.headers[adminHeader];
    if (!key || key !== ADMIN_KEY) {
      return reply.code(401).send({ error: 'Invalid or missing admin key', header: adminHeader });
    }

    // 2. Admin rate limit (fail-closed always)
    const { result, fallback } = await adminBreaker.exec(
      () => adminLimiter.check('admin', ADMIN_RATE_LIMIT),
      'closed',
    );

    if (fallback || !result?.allowed) {
      return reply.code(429).send({
        error:        'Admin rate limit exceeded',
        retryAfterMs: result?.retryAfterMs ?? null,
      });
    }

    reply.header('X-Admin-RateLimit-Remaining', Math.floor(result.remainingTokens));
  });

  // ── POST /admin/clients ─────────────────────────────────────────────────
  fastify.post('/admin/clients', {
    schema: {
      description: 'Create a new API client',
      tags:        ['admin'],
      body: {
        type:     'object',
        required: ['capacity', 'refillRate'],
        properties: {
          apiKey:     { type: 'string',  description: 'Custom API key (auto-generated if omitted)' },
          capacity:   { type: 'integer', minimum: 1,   description: 'Max tokens in bucket' },
          refillRate: { type: 'number',  minimum: 0,   description: 'Tokens per second (0 = no refill)' },
          mode:       { type: 'string',  enum: ['open', 'closed'], default: 'closed' },
        },
      },
    },
  }, async (request, reply) => {
    const { capacity, refillRate, mode = 'closed' } = request.body;
    const apiKey = request.body.apiKey ?? randomBytes(16).toString('hex');

    try {
      const { rows } = await db.query(
        `INSERT INTO clients (api_key, capacity, refill_rate, mode)
         VALUES ($1, $2, $3, $4)
         RETURNING id, api_key, capacity, refill_rate, mode, created_at`,
        [apiKey, capacity, refillRate, mode],
      );
      return reply.code(201).send({ ok: true, client: rows[0] });
    } catch (err) {
      if (err.code === '23505') { // unique_violation
        return reply.code(409).send({ error: 'API key already exists' });
      }
      request.log.error(err);
      return reply.code(500).send({ error: 'Failed to create client' });
    }
  });

  // ── GET /admin/clients ──────────────────────────────────────────────────
  fastify.get('/admin/clients', {
    schema: {
      description: 'List all API clients (paginated)',
      tags:        ['admin'],
      querystring: {
        type: 'object',
        properties: {
          page:  { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const page  = parseInt(request.query.page  ?? 1,  10);
    const limit = parseInt(request.query.limit ?? 20, 10);
    const offset = (page - 1) * limit;

    const [{ rows: clients }, { rows: [{ count }] }] = await Promise.all([
      db.query(
        `SELECT id, api_key, capacity, refill_rate, mode, created_at, updated_at
         FROM clients
         WHERE deleted_at IS NULL
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset],
      ),
      db.query(`SELECT COUNT(*) FROM clients WHERE deleted_at IS NULL`),
    ]);

    return {
      clients,
      pagination: {
        page,
        limit,
        total: parseInt(count, 10),
        pages: Math.ceil(parseInt(count, 10) / limit),
      },
    };
  });

  // ── GET /admin/clients/:apiKey ──────────────────────────────────────────
  fastify.get('/admin/clients/:apiKey', {
    schema: {
      description: 'Get a single client by API key',
      tags:        ['admin'],
    },
  }, async (request, reply) => {
    const { apiKey } = request.params;

    const { rows } = await db.query(
      `SELECT id, api_key, capacity, refill_rate, mode, created_at, updated_at
       FROM clients
       WHERE api_key = $1 AND deleted_at IS NULL`,
      [apiKey],
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Client not found' });
    }
    return { client: rows[0] };
  });

  // ── PUT /admin/clients/:apiKey ──────────────────────────────────────────
  fastify.put('/admin/clients/:apiKey', {
    schema: {
      description: 'Update a client\'s rate-limit config (immediately invalidates Redis cache)',
      tags:        ['admin'],
      body: {
        type: 'object',
        minProperties: 1,
        properties: {
          capacity:   { type: 'integer', minimum: 1 },
          refillRate: { type: 'number',  minimum: 0 },
          mode:       { type: 'string',  enum: ['open', 'closed'] },
        },
      },
    },
  }, async (request, reply) => {
    const { apiKey } = request.params;
    const updates    = request.body;

    const fields = [];
    const values = [];
    let   idx    = 1;

    if (updates.capacity   !== undefined) { fields.push(`capacity = $${idx++}`);    values.push(updates.capacity); }
    if (updates.refillRate !== undefined) { fields.push(`refill_rate = $${idx++}`); values.push(updates.refillRate); }
    if (updates.mode       !== undefined) { fields.push(`mode = $${idx++}`);        values.push(updates.mode); }

    if (fields.length === 0) {
      return reply.code(400).send({ error: 'No valid fields to update' });
    }

    values.push(apiKey);
    const { rows } = await db.query(
      `UPDATE clients
       SET ${fields.join(', ')}
       WHERE api_key = $${idx} AND deleted_at IS NULL
       RETURNING id, api_key, capacity, refill_rate, mode, updated_at`,
      values,
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    // Explicit cache invalidation — change takes effect on the next request
    await redis.del(`cfg:${apiKey}`);

    return { ok: true, client: rows[0] };
  });

  // ── DELETE /admin/clients/:apiKey ───────────────────────────────────────
  fastify.delete('/admin/clients/:apiKey', {
    schema: {
      description: 'Soft-delete a client (evicts config cache + token bucket)',
      tags:        ['admin'],
    },
  }, async (request, reply) => {
    const { apiKey } = request.params;

    const { rows } = await db.query(
      `UPDATE clients
       SET deleted_at = NOW()
       WHERE api_key = $1 AND deleted_at IS NULL
       RETURNING id, api_key`,
      [apiKey],
    );

    if (rows.length === 0) {
      return reply.code(404).send({ error: 'Client not found' });
    }

    // Evict both the config cache and the token bucket so the next request
    // gets a 401 immediately (cache miss → Postgres returns no row → unknown key)
    await Promise.all([
      redis.del(`cfg:${apiKey}`),   // config cache
      redis.del(`rl:${apiKey}`),    // token bucket
    ]);

    return { ok: true, deleted: rows[0].api_key };
  });

  // Clean up on shutdown
  fastify.addHook('onClose', async () => {
    adminBreaker.destroy();
  });
}

module.exports = { adminPlugin };
