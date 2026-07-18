'use strict';

/**
 * dev-server.js — starts the rate-limiter with in-memory Redis + Postgres mocks.
 *
 * Usage:  node dev-server.js
 *
 * This lets you preview the full dashboard UI (http://localhost:3000/dashboard)
 * without Docker, Redis, or Postgres installed.  All data is in-memory and
 * resets on every restart.
 *
 * NOT for production — only for local preview / demos.
 */

const { RedisMock } = require('ioredis-mock');

// ── Monkey-patch ioredis before anything else loads it ──────────────────────
//
// We replace the ioredis constructor with the mock so that every module that
// does `new Redis(...)` gets the in-memory emulator instead.
//
const ioredis = require('ioredis');
const OriginalRedis = ioredis;

// ioredis exports the class as the default; we wrap the require cache entry.
require.cache[require.resolve('ioredis')].exports = RedisMock;

// ── In-memory Postgres stub ─────────────────────────────────────────────────
//
// We create a thin stub for ./db that returns pre-seeded data.  Real queries
// from dashboard.js fall through to this stub and get realistic mock data.
//
const CLIENTS = [
  { id: 1, api_key: 'test-key-open',   capacity: 100, refill_rate: 10, mode: 'open',   created_at: new Date(), updated_at: new Date(), deleted_at: null },
  { id: 2, api_key: 'test-key-closed', capacity: 50,  refill_rate: 5,  mode: 'closed', created_at: new Date(), updated_at: new Date(), deleted_at: null },
];

const ANALYTICS = (() => {
  const rows = [];
  const now  = Date.now();
  for (let i = 0; i < 720; i++) {   // 30 days × 24 hours
    const bucket  = new Date(now - i * 3_600_000);
    const allowed = Math.floor(Math.random() * 4500) + 500;
    const denied  = Math.floor(Math.random() * 200);
    rows.push({
      bucket,
      allowed_requests: allowed,
      denied_requests:  denied,
      total_requests:   allowed + denied,
    });
  }
  return rows.reverse();
})();

// Stub db module
const dbStub = {
  async query(sql, params = []) {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();

    // clients table queries
    if (s.includes('from clients') && s.includes('api_key = $1')) {
      const key = params[0];
      return { rows: CLIENTS.filter(c => c.api_key === key && !c.deleted_at) };
    }
    if (s.includes('from clients') && !s.includes('where api_key')) {
      return { rows: CLIENTS.filter(c => !c.deleted_at) };
    }
    // INSERT client
    if (s.startsWith('insert into clients')) {
      const [api_key, capacity, refill_rate, mode] = params;
      const row = { id: CLIENTS.length + 1, api_key, capacity, refill_rate, mode, created_at: new Date(), updated_at: new Date(), deleted_at: null };
      CLIENTS.push(row);
      return { rows: [row] };
    }
    // UPDATE client
    if (s.startsWith('update clients')) {
      const keyParam = params[params.length - 1];
      const idx = CLIENTS.findIndex(c => c.api_key === keyParam);
      if (idx !== -1) {
        if (params[0] && s.includes('capacity')) CLIENTS[idx].capacity   = params[0];
        CLIENTS[idx].updated_at = new Date();
        return { rows: [CLIENTS[idx]] };
      }
      return { rows: [] };
    }
    // DELETE (soft)
    if (s.startsWith('update clients set deleted_at')) {
      const key = params[0];
      const c = CLIENTS.find(x => x.api_key === key);
      if (c) c.deleted_at = new Date();
      return { rows: c ? [c] : [] };
    }
    // analytics / trends
    if (s.includes('from analytics') || s.includes('hourly_request_counts') || s.includes('minute_request_counts')) {
      const clientId = params[0];
      // Return mock trend data for whatever clientId is asked
      return { rows: ANALYTICS };
    }
    // TimescaleDB feature detection
    if (s.includes('timescaledb') || s.includes('pg_extension')) {
      return { rows: [] };
    }
    // information_schema / pg_matviews
    if (s.includes('information_schema') || s.includes('pg_matviews') || s.includes('pg_class')) {
      return { rows: [] };
    }
    // migrate / DDL — silently ignore
    if (s.startsWith('create') || s.startsWith('alter') || s.startsWith('insert into schema_migrations') || s.startsWith('select version from')) {
      return { rows: [] };
    }
    console.warn('[dev-server] Unhandled query:', sql.slice(0, 120));
    return { rows: [] };
  },
  pool: { end: async () => {} },
};

// Override the db module
require.cache[require.resolve('./src/db')] = {
  id:       require.resolve('./src/db'),
  filename: require.resolve('./src/db'),
  loaded:   true,
  exports:  dbStub,
};

// ── Set env defaults ────────────────────────────────────────────────────────
process.env.REDIS_URL    = process.env.REDIS_URL    || 'redis://127.0.0.1:6379';  // ignored by mock
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://mock';          // ignored by stub
process.env.PORT         = process.env.PORT         || '3000';
process.env.ADMIN_KEY    = process.env.ADMIN_KEY    || 'demo-admin-key';
process.env.LOG_LEVEL    = process.env.LOG_LEVEL    || 'warn';  // quieter output

// ── Pre-seed Redis mock with client configs + token buckets ─────────────────
async function seedRedis() {
  const Redis = require('ioredis');
  const redis = new Redis();
  for (const c of CLIENTS) {
    await redis.hset(`cfg:${c.api_key}`,
      'id',         c.id,
      'apiKey',     c.api_key,
      'capacity',   c.capacity,
      'refillRate', c.refill_rate,
      'mode',       c.mode,
    );
  }
  await redis.quit();
}

// ── Patch migrate() to be a no-op then start the real server ───────────────
async function main() {
  await seedRedis();
  console.log('\n  ⚡  Rate Limiter — Dev Preview Mode\n');
  console.log('  Redis:    in-memory mock (ioredis-mock)');
  console.log('  Postgres: in-memory stub (no install needed)');
  console.log('\n  Dashboard →  http://localhost:3000/dashboard');
  console.log('  Swagger   →  http://localhost:3000/docs  (if swagger installed)');
  console.log('  Health    →  http://localhost:3000/health\n');

  // Load the real server — it will use our patched modules
  const { buildServer } = require('./src/server');
  const app = await buildServer();
  const port = parseInt(process.env.PORT, 10);
  await app.listen({ port, host: '0.0.0.0' });
  console.log(`\n  Server listening on http://localhost:${port}`);
  console.log('  Press Ctrl+C to stop.\n');
}

main().catch(err => {
  console.error('Startup failed:', err.message);
  process.exit(1);
});
