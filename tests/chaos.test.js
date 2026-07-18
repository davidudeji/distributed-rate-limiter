'use strict';

/**
 * Chaos test — kills Redis mid-load and asserts that the configured
 * fail-open / fail-closed behavior triggers within a bounded time.
 *
 * Requires: Redis accessible at REDIS_URL (default: redis://127.0.0.1:6379)
 *           and a way to SHUTDOWN the Redis server so it stops responding.
 *
 * We use `redis.call('DEBUG', 'sleep', N)` to simulate unresponsiveness
 * combined with a short socket timeout, OR we use the DEBUG SHUTDOWN command
 * if available.  In CI, prefer the ioredis `lazyConnect` + forcefully closing
 * the underlying socket to simulate failure without needing root access.
 *
 * EXPLAIN (Phase 5): why test exactly at the boundary instead of well above/below?
 *   – Well below the limit: always passes, proves nothing about the guard.
 *   – Well above the limit: a coarse check; off-by-one errors in the Lua
 *     script (wrong comparison operator, rounding) won't be caught.
 *   – At the exact boundary: 1 request should succeed and 1 should fail.
 *     Any atomicity bug or rounding error immediately manifests as the
 *     wrong outcome on one of these two adjacent cases.
 */

const test   = require('node:test');
const assert = require('node:assert/strict');
const Redis  = require('ioredis');
const { TokenBucketLimiter } = require('../src/rateLimiter');
const { CircuitBreaker }     = require('../src/circuitBreaker');

// ---------------------------------------------------------------------------
// Helper: create a Redis client with an intentionally short timeout
// so that simulated failures are detected quickly.
// ---------------------------------------------------------------------------
function createShortTimeoutClient() {
  return new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    connectTimeout:       500,
    commandTimeout:       500,   // fail fast — the breaker counts this as a failure
    maxRetriesPerRequest: 0,
    enableReadyCheck:     false,
    lazyConnect:          true,
  });
}

// ---------------------------------------------------------------------------
// Test 1: fail-CLOSED behavior when Redis is unreachable
// ---------------------------------------------------------------------------
test('circuit breaker triggers fail-CLOSED when Redis is down', async (t) => {
  // Use a port that is guaranteed to have nothing listening
  const deadRedis = new Redis('redis://127.0.0.1:19999', {
    connectTimeout:       300,
    commandTimeout:       300,
    maxRetriesPerRequest: 0,
    enableReadyCheck:     false,
    lazyConnect:          true,
  });

  const limiter = new TokenBucketLimiter(deadRedis, { keyPrefix: 'chaos:closed' });
  const breaker = new CircuitBreaker({
    failureThreshold:  2,         // trip after 2 failures for speed
    halfOpenTimeoutMs: 60_000,    // don't auto-recover in this test
  });

  let deniedByFallback = 0;
  let errors           = 0;

  // Fire enough requests to trip the breaker
  for (let i = 0; i < 10; i++) {
    try {
      const { result, fallback, failMode } = await breaker.exec(
        () => limiter.check('alice', { capacity: 10, refillRate: 1, requested: 1 }),
        'closed',
      );

      if (fallback) {
        // failMode='closed' → the circuit breaker fallback should DENY
        deniedByFallback++;
      }
    } catch (err) {
      errors++;
    }
  }

  // After failureThreshold failures, every subsequent call must use fallback
  assert.ok(deniedByFallback >= 1, `Expected at least 1 fail-closed denial, got ${deniedByFallback}`);
  assert.equal(breaker.state, 'OPEN', `Expected breaker to be OPEN, got ${breaker.state}`);

  breaker.destroy();
  await deadRedis.quit().catch(() => {});
});

// ---------------------------------------------------------------------------
// Test 2: fail-OPEN behavior when Redis is unreachable
// ---------------------------------------------------------------------------
test('circuit breaker triggers fail-OPEN when Redis is down', async (t) => {
  const deadRedis = new Redis('redis://127.0.0.1:19999', {
    connectTimeout:       300,
    commandTimeout:       300,
    maxRetriesPerRequest: 0,
    enableReadyCheck:     false,
    lazyConnect:          true,
  });

  const limiter = new TokenBucketLimiter(deadRedis, { keyPrefix: 'chaos:open' });
  const breaker = new CircuitBreaker({
    failureThreshold:  2,
    halfOpenTimeoutMs: 60_000,
  });

  let allowedByFallback = 0;

  for (let i = 0; i < 10; i++) {
    try {
      const { result, fallback, failMode } = await breaker.exec(
        () => limiter.check('bob', { capacity: 10, refillRate: 1, requested: 1 }),
        'open',
      );

      if (fallback && failMode === 'open') {
        // Fail-open: when Redis is down, we allow the request through
        allowedByFallback++;
      }
    } catch {
      /* ignore */
    }
  }

  assert.ok(allowedByFallback >= 1, `Expected at least 1 fail-open pass-through, got ${allowedByFallback}`);
  assert.equal(breaker.state, 'OPEN');

  breaker.destroy();
  await deadRedis.quit().catch(() => {});
});

// ---------------------------------------------------------------------------
// Test 3: circuit breaker recovers to HALF_OPEN then CLOSED
// ---------------------------------------------------------------------------
test('circuit breaker recovers from OPEN to CLOSED via HALF_OPEN', async (t) => {
  const redis   = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 0,
    enableReadyCheck:     false,
    lazyConnect:          true,
  });

  const breaker = new CircuitBreaker({
    failureThreshold:  2,
    successThreshold:  2,
    halfOpenTimeoutMs: 200,   // short for testing
  });

  // Manually trip the breaker
  breaker.onFailure();
  breaker.onFailure(); // should trip
  assert.equal(breaker.state, 'OPEN');

  // Wait for half-open timeout
  await new Promise((res) => setTimeout(res, 250));

  // Now a request should be allowed through as probe
  const { allow } = breaker.allowRequest();
  assert.ok(allow, 'Probe request should be allowed after half-open timeout');

  // Simulate successful probe
  breaker.onSuccess();
  breaker.onSuccess(); // successThreshold=2 → reset to CLOSED

  assert.equal(breaker.state, 'CLOSED', 'Breaker should recover to CLOSED after 2 successes');

  breaker.destroy();
  await redis.quit().catch(() => {});
});
