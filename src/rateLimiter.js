'use strict';

/**
 * Token-bucket rate limiter backed by a single atomic Redis Lua script.
 *
 * All state (capacity, refillRate, currentTokens, lastRefillTime) lives in a
 * Redis hash.  The Lua script performs refill + admission check + decrement in
 * one round-trip, so no distributed lock is needed and no race window exists.
 *
 * Fields stored per client key:
 *   capacity        – maximum tokens the bucket can hold
 *   refillRate      – tokens added per second (can be fractional)
 *   currentTokens   – tokens available right now
 *   lastRefillTime  – epoch-ms of the last lazy refill
 */

// ---------------------------------------------------------------------------
// Lua script — runs atomically inside Redis (single-threaded command queue).
// KEYS[1]  = hash key for this client
// ARGV[1]  = capacity      (number)
// ARGV[2]  = refillRate    (tokens / second, number)
// ARGV[3]  = now           (epoch ms, number)
// ARGV[4]  = requested     (tokens to consume, default 1)
//
// Returns: {allowed(0|1), remainingTokens, retryAfterMs, capacity}
// ---------------------------------------------------------------------------
const REDIS_SCRIPT = `
local key            = KEYS[1]
local capacity       = tonumber(ARGV[1])
local refillRate     = tonumber(ARGV[2])
local now            = tonumber(ARGV[3])
local requested      = tonumber(ARGV[4])

-- Single round-trip to read all four fields
local data          = redis.call('HMGET', key, 'currentTokens', 'lastRefillTime', 'capacity', 'refillRate')
local currentTokens = tonumber(data[1])
local lastRefillTime= tonumber(data[2])
local storedCap     = tonumber(data[3])
local storedRate    = tonumber(data[4])

-- First-ever request: initialise bucket to full capacity
if not currentTokens  then currentTokens  = capacity   end
if not lastRefillTime then lastRefillTime = now         end
if not storedCap      then storedCap      = capacity   end
if not storedRate     then storedRate     = refillRate  end

-- Config changed (admin lowered/raised limits): adopt new values immediately.
-- Clamp existing tokens so they never exceed the new, possibly lower, capacity.
if storedCap ~= capacity or storedRate ~= refillRate then
  storedCap  = capacity
  storedRate = refillRate
  currentTokens = math.min(currentTokens, storedCap)
end

-- Lazy refill: add tokens proportional to wall-clock time elapsed.
local elapsedMs    = math.max(0, now - lastRefillTime)
local refillAmount = elapsedMs * storedRate / 1000
currentTokens      = math.min(storedCap, currentTokens + refillAmount)

-- Admission decision
local allowed      = 0
local retryAfterMs = 0

if currentTokens >= requested then
  allowed       = 1
  currentTokens = currentTokens - requested
else
  if storedRate > 0 then
    -- Ceiling ms until enough tokens have accumulated
    retryAfterMs = math.ceil((requested - currentTokens) / storedRate * 1000)
  else
    retryAfterMs = -1   -- rate is 0; bucket will never refill
  end
end

-- Persist updated state
redis.call('HSET', key,
  'capacity',       storedCap,
  'refillRate',     storedRate,
  'currentTokens',  currentTokens,
  'lastRefillTime', now
)

-- Auto-expire idle keys: 2× the fill-up time so memory never grows unbounded.
local ttlSec = math.max(60, math.ceil(storedCap / math.max(storedRate, 0.001)) * 2)
redis.call('EXPIRE', key, ttlSec)

return {allowed, currentTokens, retryAfterMs, storedCap}
`;

// ---------------------------------------------------------------------------

class TokenBucketLimiter {
  /**
   * @param {import('ioredis').Redis} redis   - ioredis client (already connected)
   * @param {object}  [options]
   * @param {string}  [options.keyPrefix='rate-limit']  - Redis key namespace
   */
  constructor(redis, options = {}) {
    this.redis = redis;
    this.keyPrefix = options.keyPrefix ?? 'rate-limit';
    this._initialized = false;
  }

  /**
   * Register the Lua script with ioredis.
   * `defineCommand` mutates the redis instance: it adds a method named
   * `tokenBucketScript` that handles EVALSHA caching automatically.
   * It does NOT return a value — calling it on an already-initialised
   * instance is harmless (ioredis ignores duplicate definitions).
   */
  async init() {
    if (this._initialized) return;
    this.redis.defineCommand('tokenBucketScript', {
      numberOfKeys: 1,
      lua: REDIS_SCRIPT,
    });
    this._initialized = true;
  }

  /** Remove all state for a client (useful in tests). */
  async reset(clientId) {
    await this.redis.del(this.getKey(clientId));
  }

  getKey(clientId) {
    return `${this.keyPrefix}:${clientId}`;
  }

  /**
   * Atomically check + consume tokens for a client.
   *
   * @param {string} clientId
   * @param {object} config
   * @param {number} config.capacity    – bucket maximum
   * @param {number} config.refillRate  – tokens per second
   * @param {number} [config.requested=1] – tokens to consume
   * @returns {Promise<{allowed: boolean, remainingTokens: number, retryAfterMs: number, limit: number}>}
   */
  async check(clientId, config) {
    if (!this._initialized) await this.init();

    const now = Date.now();
    const result = await this.redis.tokenBucketScript(
      this.getKey(clientId),
      config.capacity,
      config.refillRate,
      now,
      config.requested ?? 1,
    );

    return {
      allowed:         result[0] === 1,
      remainingTokens: result[1],
      retryAfterMs:    result[2],
      limit:           result[3],
    };
  }
}

module.exports = { TokenBucketLimiter };
