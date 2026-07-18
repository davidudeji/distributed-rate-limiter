'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const Redis  = require('ioredis');
const { TokenBucketLimiter } = require('../src/rateLimiter');

function createClient() {
  return new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    lazyConnect: false,
    enableReadyCheck: true,
  });
}

// ---------------------------------------------------------------------------
// Race condition test: N concurrent requests at the boundary
//
// The spec asks: fire N concurrent requests at a client sitting exactly at
// their limit boundary and assert zero over-admission.
//
// Strategy:
//   capacity = 5, requested = 1 each, 20 concurrent requests.
//   Exactly 5 must be admitted; 15 must be denied.
//   Any over-admission (> 5 allowed) proves a race existed.
// ---------------------------------------------------------------------------
test('concurrent requests at the boundary — zero over-admission', async (t) => {
  const redis  = createClient();
  const limiter = new TokenBucketLimiter(redis, { keyPrefix: 'test:boundary' });
  const CLIENT  = 'client-race-1';
  const CAPACITY = 5;
  const BURST    = 20;   // requests fired simultaneously

  await limiter.reset(CLIENT);

  const results = await Promise.all(
    Array.from({ length: BURST }, () =>
      limiter.check(CLIENT, {
        capacity:   CAPACITY,
        refillRate: 0,       // no refill — makes counting exact
        requested:  1,
      }),
    ),
  );

  const allowed = results.filter((r) => r.allowed);
  const denied  = results.filter((r) => !r.allowed);

  // Exactly CAPACITY requests must be allowed — no more, no fewer
  assert.equal(allowed.length, CAPACITY, `Over-admission! Got ${allowed.length} allowed, expected ${CAPACITY}`);
  assert.equal(denied.length, BURST - CAPACITY);

  // The allowed requests must report 0 remaining only on the last one.
  // All allowed results must report a non-negative remainder < CAPACITY.
  for (const r of allowed) {
    assert.ok(r.remainingTokens >= 0, 'remaining tokens must not go negative');
    assert.ok(r.remainingTokens < CAPACITY, 'remaining tokens must be below capacity');
  }

  // Denied requests: retryAfterMs must be positive (rate=0 → -1 means never)
  // With refillRate=0 the script returns -1 to mean "never". Check that.
  for (const r of denied) {
    assert.ok(!r.allowed, 'denied result must not be allowed');
    assert.equal(r.retryAfterMs, -1, 'with refillRate=0, retry is -1 (never)');
  }

  await redis.quit();
});

// ---------------------------------------------------------------------------
// Minimal capacity-1 boundary (existing test, kept for regression)
// ---------------------------------------------------------------------------
test('capacity-1 bucket — only one of N concurrent requests admitted', async (t) => {
  const redis  = createClient();
  const limiter = new TokenBucketLimiter(redis, { keyPrefix: 'test:boundary' });
  const CLIENT  = 'client-race-2';

  await limiter.reset(CLIENT);

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      limiter.check(CLIENT, { capacity: 1, refillRate: 0, requested: 1 }),
    ),
  );

  const allowedCount = results.filter((r) => r.allowed).length;
  assert.equal(allowedCount, 1, 'exactly 1 of 10 must be admitted for capacity=1');

  // The single allowed result must show 0 tokens remaining
  const admittedResult = results.find((r) => r.allowed);
  assert.equal(admittedResult.remainingTokens, 0);

  await redis.quit();
});

// ---------------------------------------------------------------------------
// Refill correctness: tokens accumulate over time
// ---------------------------------------------------------------------------
test('lazy refill adds correct tokens proportional to elapsed time', async (t) => {
  const redis  = createClient();
  const limiter = new TokenBucketLimiter(redis, { keyPrefix: 'test:refill' });
  const CLIENT  = 'client-refill-1';

  await limiter.reset(CLIENT);

  // Drain the bucket completely
  const drain = await limiter.check(CLIENT, { capacity: 10, refillRate: 10, requested: 10 });
  assert.ok(drain.allowed, 'initial drain must succeed');
  assert.ok(drain.remainingTokens < 1, 'bucket should be nearly empty after drain');

  // Wait 500 ms — at 10 tokens/sec we expect ~5 tokens refilled
  await new Promise((res) => setTimeout(res, 500));

  const after = await limiter.check(CLIENT, { capacity: 10, refillRate: 10, requested: 1 });
  assert.ok(after.allowed, 'request after partial refill must succeed');
  // Expect between 3 and 7 tokens remaining (timing is imprecise in test env)
  assert.ok(after.remainingTokens >= 3, `expected ≥3 remaining, got ${after.remainingTokens}`);
  assert.ok(after.remainingTokens < 10, 'bucket must not over-fill');

  await redis.quit();
});

// ---------------------------------------------------------------------------
// Config-change clamping: lowering capacity mid-window clamps current tokens
// ---------------------------------------------------------------------------
test('lowering capacity mid-window clamps existing tokens immediately', async (t) => {
  const redis  = createClient();
  const limiter = new TokenBucketLimiter(redis, { keyPrefix: 'test:config' });
  const CLIENT  = 'client-config-1';

  await limiter.reset(CLIENT);

  // Fill bucket at capacity=100
  await limiter.check(CLIENT, { capacity: 100, refillRate: 0, requested: 0 });

  // Now lower capacity to 5 — next check must clamp tokens to 5
  const result = await limiter.check(CLIENT, { capacity: 5, refillRate: 0, requested: 1 });
  assert.ok(result.allowed);
  // After consuming 1 from a clamped-to-5 bucket: 4 remaining
  assert.equal(result.remainingTokens, 4);

  await redis.quit();
});
