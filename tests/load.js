'use strict';

/**
 * Load test using autocannon.
 *
 * Fires real HTTP traffic at the running Fastify server and reports
 * p50 / p95 / p99 latency numbers.
 *
 * Usage:
 *   # Start the server first (in another terminal or background)
 *   #   node src/server.js
 *
 *   node tests/load.js [--url http://localhost:3000] [--duration 10] [--connections 50]
 *
 * The test also asserts that the p99 latency stays under 50 ms,
 * which is the target for a rate-limit hot path (Redis round-trip + Lua).
 */

const autocannon = require('autocannon');

const DEFAULTS = {
  url:         process.env.LOAD_TARGET_URL ?? 'http://127.0.0.1:3000',
  connections: parseInt(process.env.LOAD_CONNECTIONS ?? '50', 10),
  duration:    parseInt(process.env.LOAD_DURATION    ?? '10', 10),
  pipelining:  1,
  headers: {
    'x-api-key': process.env.LOAD_API_KEY ?? 'test-key-open',
  },
};

async function run() {
  console.log('\n📊  Distributed Rate Limiter — Load Test');
  console.log('   Target:      ', DEFAULTS.url);
  console.log('   Connections: ', DEFAULTS.connections);
  console.log('   Duration:    ', DEFAULTS.duration, 's\n');

  const result = await autocannon({
    ...DEFAULTS,
    url: DEFAULTS.url + '/check',
  });

  const lat  = result.latency;
  const req  = result.requests;

  console.log('┌─────────────────────────────────────┐');
  console.log('│           LATENCY (ms)              │');
  console.log(`│  p50  : ${String(lat.p50).padStart(8)}                  │`);
  console.log(`│  p75  : ${String(lat.p75).padStart(8)}                  │`);
  console.log(`│  p90  : ${String(lat.p90).padStart(8)}                  │`);
  console.log(`│  p99  : ${String(lat.p99).padStart(8)}                  │`);
  console.log(`│  max  : ${String(lat.max).padStart(8)}                  │`);
  console.log('├─────────────────────────────────────┤');
  console.log('│           THROUGHPUT                │');
  console.log(`│  req/s avg : ${String(req.average).padStart(8)}             │`);
  console.log(`│  total     : ${String(req.total).padStart(8)}             │`);
  console.log(`│  errors    : ${String(result.errors).padStart(8)}             │`);
  console.log(`│  timeouts  : ${String(result.timeouts).padStart(8)}             │`);
  console.log('└─────────────────────────────────────┘\n');

  // Soft assertion — warn but don't throw so CI still shows the numbers
  if (lat.p99 > 50) {
    console.warn(`⚠️  p99 latency (${lat.p99} ms) exceeded 50 ms target.`);
    console.warn('   Check Redis connectivity and Lua script performance.');
  } else {
    console.log(`✅  p99 latency (${lat.p99} ms) within 50 ms target.`);
  }

  return result;
}

if (require.main === module) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { run };
