'use strict';

/**
 * Rate-limit middleware for Fastify.
 *
 * Wires together:
 *   1. ConfigCache  – resolves the client's capacity/refillRate/mode from Redis (or Postgres)
 *   2. CircuitBreaker – guards Redis; applies fail-open/fail-closed per client
 *   3. TokenBucketLimiter – runs the atomic Lua admission decision
 *
 * Response headers set on every request (spec Phase 4):
 *   X-RateLimit-Limit       – bucket capacity
 *   X-RateLimit-Remaining   – tokens left after this request
 *   X-RateLimit-Reset       – epoch-seconds when the bucket will be full again
 *   Retry-After             – seconds to wait before retrying (on 429 only)
 *
 * Why these headers matter for the caller (not just logging):
 *   Clients use X-RateLimit-Remaining to implement proactive back-off before
 *   hitting 429.  Retry-After tells automated clients exactly how long to
 *   sleep — without it they have to guess (random back-off), which causes
 *   thundering-herd re-tries.  X-RateLimit-Reset lets dashboards show when
 *   quota refreshes.  Together they turn rate-limiting from an opaque wall
 *   into a cooperative protocol.
 */

const { randomUUID }         = require('node:crypto');
const { TokenBucketLimiter } = require('../rateLimiter');
const { CircuitBreaker }     = require('../circuitBreaker');
const { ConfigCache }        = require('../configCache');
const { enqueueEvent, closeQueue } = require('../queue');

// Phase 10: metrics helper — gracefully handles the global not existing yet
function incMetric(key) {
  if (global.__rlMetrics) global.__rlMetrics[key]++;
}


/**
 * @param {import('fastify').FastifyInstance} fastify
 * @param {object} opts
 * @param {import('ioredis').Redis} opts.redis
 * @param {string} [opts.apiKeyHeader='x-api-key']
 */
async function rateLimitPlugin(fastify, opts) {
  const redis    = opts.redis;
  const header   = opts.apiKeyHeader ?? 'x-api-key';

  const limiter  = new TokenBucketLimiter(redis, { keyPrefix: 'rl' });
  const cache    = new ConfigCache(redis);
  const breaker  = new CircuitBreaker({
    failureThreshold:  5,
    successThreshold:  2,
    halfOpenTimeoutMs: 10_000,
    healthCheck: () => redis.ping(),
  });

  // Expose internal components for tests and the /health route
  fastify.decorate('rateLimiter',    limiter);
  fastify.decorate('configCache',    cache);
  fastify.decorate('circuitBreaker', breaker);

  fastify.addHook('onRequest', async (request, reply) => {
    // Allow health/liveness/readiness routes to bypass rate limiting
    if (request.routeOptions?.config?.skipRateLimit) return;

    const apiKey = request.headers[header];

    if (!apiKey) {
      return reply.code(401).send({ error: 'Missing API key', header });
    }

    // ── 1. Resolve client config (cache-aside, never touches Postgres on cache hit)
    //    We do a single HGETALL to determine hit/miss for metrics AND get the config.
    //    This is the same call cache.get() would make internally, so we skip the wrapper
    //    when the cache is warm, and fall back to cache.get() only on a miss to get
    //    Postgres + re-population in one place.
    let config;
    try {
      const cacheKey  = `cfg:${apiKey}`;
      const cached    = await redis.hgetall(cacheKey);
      const isCacheHit = cached && cached.capacity;
      if (isCacheHit) {
        incMetric('cacheHits');
        config = {
          id:         parseInt(cached.id, 10),
          apiKey:     cached.apiKey,
          capacity:   parseInt(cached.capacity, 10),
          refillRate: parseFloat(cached.refillRate),
          mode:       cached.mode,
        };
      } else {
        incMetric('cacheMisses');
        config = await cache.get(apiKey); // Postgres fetch + Redis repopulate
      }
    } catch (err) {
      request.log.error({ err }, 'config-cache error');
      // If we cannot look up the client at all, fail safely
      return reply.code(503).send({ error: 'Service temporarily unavailable' });
    }

    if (!config) {
      return reply.code(401).send({ error: 'Unknown API key' });
    }

    // ── 2. Circuit-breaker guarded admission check
    const { result, fallback, failMode } = await breaker.exec(
      () => limiter.check(apiKey, {
        capacity:   config.capacity,
        refillRate: config.refillRate,
        requested:  1,
      }),
      config.mode,
    );

    // ── 3. Fallback path (Redis down)
    if (fallback) {
      if (config.mode === 'open') {
        // Fail-open: allow the request but signal degraded mode
        request.log.warn({ apiKey }, 'rate-limiter: Redis down, failing OPEN');
        reply.header('X-RateLimit-Fallback', 'open');
        return; // continue to route handler
      } else {
        // Fail-closed: deny the request
        request.log.warn({ apiKey }, 'rate-limiter: Redis down, failing CLOSED');
        return reply.code(503).send({
          error: 'Rate limiter unavailable',
          retryAfter: 5,
        });
      }
    }

    // ── 4. Set standard rate-limit headers on every response
    const resetEpochSec = result.refillRate > 0
      ? Math.ceil(Date.now() / 1000 + result.remainingTokens / result.refillRate)
      : 0;

    reply.header('X-RateLimit-Limit',     result.limit);
    reply.header('X-RateLimit-Remaining', Math.max(0, Math.floor(result.remainingTokens)));
    reply.header('X-RateLimit-Reset',     resetEpochSec);

    // ── 5. Deny if not admitted
    const requestId = randomUUID();
    if (!result.allowed) {
      incMetric('blockedRequests');
      const retryAfterSec = result.retryAfterMs > 0
        ? Math.ceil(result.retryAfterMs / 1000)
        : null;

      if (retryAfterSec !== null) {
        reply.header('Retry-After', retryAfterSec);
      }

      // Log denial asynchronously — never await on the hot path
      enqueueEvent(opts.redis, {
        requestId,
        apiKey,
        allowed:          false,
        remainingTokens:  result.remainingTokens,
        limit:            result.limit,
      }).catch(() => {});

      return reply.code(429).send({
        error:           'Too Many Requests',
        limit:           result.limit,
        remainingTokens: 0,
        retryAfterMs:    result.retryAfterMs,
      });
    }

    // ── 6. Admitted — log asynchronously and continue to route handler
    incMetric('allowedRequests');
    enqueueEvent(opts.redis, {
      requestId,
      apiKey,
      allowed:         true,
      remainingTokens: result.remainingTokens,
      limit:           result.limit,
    }).catch(() => {});
  });

  // Clean up on server close
  fastify.addHook('onClose', async () => {
    breaker.destroy();
    await closeQueue();
  });
}

module.exports = { rateLimitPlugin };
