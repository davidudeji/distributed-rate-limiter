'use strict';

/**
 * Cache-aside layer for client rate-limit config.
 *
 * Hot path (every request):
 *   1. Look up config in Redis (O(1) HGETALL)
 *   2. On hit  → return immediately, never touch Postgres
 *   3. On miss → fetch from Postgres, write to Redis, return
 *
 * Config updates (admin path, infrequent):
 *   1. Write new config to Postgres
 *   2. Explicitly delete the Redis key (invalidate cache)
 *   3. Next hot-path request repopulates the cache
 *
 * Why explicit invalidation instead of TTL-only?
 *   If you rely solely on TTL and an admin lowers a client's capacity, the
 *   old (higher) limit stays in Redis until the TTL expires.  During that
 *   window every instance continues to admit up to the old, higher limit —
 *   a client you just throttled keeps getting their old quota.  Explicit
 *   DEL makes the change take effect on the very next request.
 */

const db = require('./db');

// How long to cache client config in Redis (seconds).
// Acts as a backstop for any invalidation miss; not the primary mechanism.
const CACHE_TTL_SEC = 300; // 5 minutes

const CONFIG_PREFIX = 'cfg';

class ConfigCache {
  /**
   * @param {import('ioredis').Redis} redis
   */
  constructor(redis) {
    this.redis = redis;
  }

  _key(apiKey) {
    return `${CONFIG_PREFIX}:${apiKey}`;
  }

  /**
   * Get client config — cache-aside read.
   * Returns null if the API key is not found in either store.
   *
   * @param {string} apiKey
   * @returns {Promise<{id:number, apiKey:string, capacity:number, refillRate:number, mode:string}|null>}
   */
  async get(apiKey) {
    const cacheKey = this._key(apiKey);

    // 1. Try Redis first
    const cached = await this.redis.hgetall(cacheKey);
    if (cached && cached.capacity) {
      return {
        id:         parseInt(cached.id, 10),
        apiKey:     cached.apiKey,
        capacity:   parseInt(cached.capacity, 10),
        refillRate: parseFloat(cached.refillRate),
        mode:       cached.mode,
      };
    }

    // 2. Cache miss — fetch from Postgres
    const { rows } = await db.query(
      'SELECT id, api_key, capacity, refill_rate, mode FROM clients WHERE api_key = $1',
      [apiKey],
    );

    if (rows.length === 0) return null;

    const row = rows[0];
    const config = {
      id:         row.id,
      apiKey:     row.api_key,
      capacity:   row.capacity,
      refillRate: parseFloat(row.refill_rate),
      mode:       row.mode,
    };

    // 3. Populate the cache
    await this.redis.hset(cacheKey,
      'id',         config.id,
      'apiKey',     config.apiKey,
      'capacity',   config.capacity,
      'refillRate', config.refillRate,
      'mode',       config.mode,
    );
    await this.redis.expire(cacheKey, CACHE_TTL_SEC);

    return config;
  }

  /**
   * Update a client's config in Postgres and immediately invalidate the cache.
   * The next call to get() will repopulate from the new Postgres values.
   *
   * @param {string} apiKey
   * @param {{ capacity?: number, refillRate?: number, mode?: string }} updates
   * @returns {Promise<object|null>} the updated row, or null if not found
   */
  async update(apiKey, updates) {
    const fields  = [];
    const values  = [];
    let   idx     = 1;

    if (updates.capacity   !== undefined) { fields.push(`capacity = $${idx++}`);    values.push(updates.capacity); }
    if (updates.refillRate !== undefined) { fields.push(`refill_rate = $${idx++}`); values.push(updates.refillRate); }
    if (updates.mode       !== undefined) { fields.push(`mode = $${idx++}`);        values.push(updates.mode); }

    if (fields.length === 0) throw new Error('No fields to update');

    values.push(apiKey);
    const { rows } = await db.query(
      `UPDATE clients SET ${fields.join(', ')} WHERE api_key = $${idx} RETURNING *`,
      values,
    );

    if (rows.length === 0) return null;

    // Explicit cache invalidation — not just TTL expiry
    await this.redis.del(this._key(apiKey));

    return rows[0];
  }

  /**
   * Register a brand-new client in Postgres (no pre-existing Redis key,
   * so no invalidation needed).
   */
  async create(apiKey, { capacity, refillRate, mode = 'closed' }) {
    const { rows } = await db.query(
      'INSERT INTO clients (api_key, capacity, refill_rate, mode) VALUES ($1, $2, $3, $4) RETURNING *',
      [apiKey, capacity, refillRate, mode],
    );
    return rows[0];
  }

  /** Manually evict a key from the cache (useful in tests). */
  async invalidate(apiKey) {
    await this.redis.del(this._key(apiKey));
  }
}

module.exports = { ConfigCache };
