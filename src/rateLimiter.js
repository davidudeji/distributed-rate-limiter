const REDIS_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local mode = ARGV[5]

local currentTokens = tonumber(redis.call('HGET', key, 'currentTokens'))
local lastRefillTime = tonumber(redis.call('HGET', key, 'lastRefillTime'))
local storedCapacity = tonumber(redis.call('HGET', key, 'capacity'))
local storedRefillRate = tonumber(redis.call('HGET', key, 'refillRate'))

if not currentTokens then
  currentTokens = capacity
end
if not lastRefillTime then
  lastRefillTime = now
end
if not storedCapacity then
  storedCapacity = capacity
end
if not storedRefillRate then
  storedRefillRate = refillRate
end

if storedCapacity ~= capacity or storedRefillRate ~= refillRate then
  currentTokens = math.min(storedCapacity, currentTokens)
end

local elapsedMs = math.max(0, now - lastRefillTime)
local refillAmount = elapsedMs * storedRefillRate / 1000
local newTokens = math.min(storedCapacity, currentTokens + refillAmount)

local allowed = newTokens >= requested
local nextTokens = allowed and (newTokens - requested) or newTokens

redis.call('HSET', key, 'capacity', storedCapacity, 'refillRate', storedRefillRate, 'currentTokens', nextTokens, 'lastRefillTime', now)

return {allowed and 1 or 0, nextTokens, math.max(0, storedCapacity - nextTokens)}
`;

class TokenBucketLimiter {
  constructor(redis, options = {}) {
    this.redis = redis;
    this.options = Object.assign({ keyPrefix: 'rate-limit' }, options);
    this.script = null;
  }

  async init() {
    this.script = await this.redis.defineCommand('tokenBucketScript', {
      numberOfKeys: 1,
      lua: REDIS_SCRIPT,
    });
  }

  async reset(clientId) {
    const key = this.getKey(clientId);
    await this.redis.del(key);
  }

  getKey(clientId) {
    return `${this.options.keyPrefix}:${clientId}`;
  }

  async check(clientId, config) {
    if (!this.script) {
      await this.init();
    }
    const now = Date.now();
    const result = await this.script(
      this.getKey(clientId),
      config.capacity,
      config.refillRate,
      now,
      config.requested || 1,
      config.mode || 'closed'
    );

    return {
      allowed: result[0] === 1,
      remainingTokens: result[1],
      limit: result[2],
      currentTokens: result[1],
    };
  }
}

module.exports = { TokenBucketLimiter };
