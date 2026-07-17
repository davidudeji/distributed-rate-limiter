const test = require('node:test');
const assert = require('node:assert/strict');
const Redis = require('ioredis');
const { TokenBucketLimiter } = require('../src/rateLimiter');

function createClient() {
  return new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
}

test('concurrent requests at the boundary admit only the configured capacity', async () => {
  const redis = createClient();
  const limiter = new TokenBucketLimiter(redis, { keyPrefix: 'test:boundary' });

  await limiter.reset('client-1');

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      limiter.check('client-1', {
        requested: 1,
        capacity: 1,
        refillRate: 0,
      })
    )
  );

  const allowedCount = results.filter((result) => result.allowed).length;

  assert.equal(allowedCount, 1);
  assert.equal(results[0].remainingTokens, 0);

  await redis.quit();
});
