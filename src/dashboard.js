'use strict';

/**
 * Dashboard API — Phase 9
 *
 * Exposes trend data for per-client request analytics.
 *
 * Primary path: reads from TimescaleDB continuous aggregates
 *   analytics_by_minute  – per-minute counts (last 24h default)
 *   analytics_by_hour    – per-hour   counts (10/15/30-day views)
 *
 * Fallback path (plain Postgres):
 *   If TimescaleDB is not available (the aggregate views don't exist),
 *   falls back to a direct GROUP BY query on the analytics table using
 *   the analytics_api_key_time index.  Identical response shape; slower
 *   at scale but functionally correct.
 *
 * EXPLAIN (Phase 9): what a continuous aggregate does that a cron rollup does not:
 *   A continuous aggregate tracks a high-watermark of processed time buckets.
 *   On each refresh it recomputes ONLY buckets that received new rows since the
 *   last watermark — O(new rows).  A cron-based rollup recomputes the entire
 *   window every run — O(all rows in the window).  At 1M rows/day over 31 days,
 *   that's 31M rows per cron run vs ~60 rows per continuous-aggregate refresh.
 */

const db = require('./db');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_GRANULARITIES = ['minute', 'hour'];
const VALID_DAYS          = [1, 7, 10, 15, 30, 31];
const MAX_DAYS            = 31;

// ---------------------------------------------------------------------------
// Helper: detect whether TimescaleDB aggregates exist
// ---------------------------------------------------------------------------

let _tsdbAvailable = null; // cached after first check

async function isTimescaleAvailable() {
  if (_tsdbAvailable !== null) return _tsdbAvailable;
  try {
    await db.query(
      `SELECT 1 FROM information_schema.tables
       WHERE table_name = 'analytics_by_hour' AND table_schema = 'public'`,
    );
    _tsdbAvailable = true;
  } catch {
    _tsdbAvailable = false;
  }
  return _tsdbAvailable;
}

// ---------------------------------------------------------------------------
// Primary path — TimescaleDB continuous aggregate
// ---------------------------------------------------------------------------

async function queryFromAggregate(apiKey, days, granularity) {
  const view = granularity === 'minute' ? 'analytics_by_minute' : 'analytics_by_hour';

  const { rows } = await db.query(
    `SELECT
       bucket,
       total_requests,
       allowed_requests,
       denied_requests,
       COALESCE(avg_remaining_tokens, 0) AS avg_remaining_tokens
     FROM ${view}
     WHERE api_key = $1
       AND bucket >= NOW() - INTERVAL '${days} days'
     ORDER BY bucket ASC`,
    [apiKey],
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Fallback path — plain Postgres GROUP BY
// ---------------------------------------------------------------------------

async function queryFromRawTable(apiKey, days, granularity) {
  const truncUnit = granularity === 'minute' ? 'minute' : 'hour';

  const { rows } = await db.query(
    `SELECT
       DATE_TRUNC($1, occurred_at)                  AS bucket,
       COUNT(*)                                      AS total_requests,
       COUNT(*) FILTER (WHERE allowed)               AS allowed_requests,
       COUNT(*) FILTER (WHERE NOT allowed)           AS denied_requests,
       AVG(remaining_tokens)                         AS avg_remaining_tokens
     FROM analytics
     WHERE api_key = $2
       AND occurred_at >= NOW() - ($3 || ' days')::INTERVAL
     GROUP BY DATE_TRUNC($1, occurred_at)
     ORDER BY bucket ASC`,
    [truncUnit, apiKey, String(days)],
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch trend data for a given client.
 *
 * @param {string} apiKey
 * @param {object} opts
 * @param {number} [opts.days=30]           – how many days back to look
 * @param {string} [opts.granularity='hour'] – 'minute' | 'hour'
 * @returns {Promise<{
 *   apiKey: string,
 *   days: number,
 *   granularity: string,
 *   source: 'timescaledb' | 'postgres',
 *   buckets: Array<{
 *     bucket: string,
 *     total_requests: number,
 *     allowed_requests: number,
 *     denied_requests: number,
 *     avg_remaining_tokens: number
 *   }>
 * }>}
 */
async function getTrends(apiKey, opts = {}) {
  const days        = Math.min(parseInt(opts.days ?? 30, 10),  MAX_DAYS);
  const granularity = VALID_GRANULARITIES.includes(opts.granularity)
    ? opts.granularity
    : 'hour';

  let rows;
  let source;

  const tsdb = await isTimescaleAvailable();

  if (tsdb) {
    try {
      rows   = await queryFromAggregate(apiKey, days, granularity);
      source = 'timescaledb';
    } catch (err) {
      // Aggregate query failed — fall back
      console.warn('[dashboard] aggregate query failed, falling back:', err.message);
      rows   = await queryFromRawTable(apiKey, days, granularity);
      source = 'postgres';
    }
  } else {
    rows   = await queryFromRawTable(apiKey, days, granularity);
    source = 'postgres';
  }

  return {
    apiKey,
    days,
    granularity,
    source,
    buckets: rows.map((r) => ({
      bucket:               r.bucket instanceof Date ? r.bucket.toISOString() : r.bucket,
      total_requests:       Number(r.total_requests),
      allowed_requests:     Number(r.allowed_requests),
      denied_requests:      Number(r.denied_requests),
      avg_remaining_tokens: Number(r.avg_remaining_tokens ?? 0),
    })),
  };
}

/**
 * Summary stats for a client over a given window.
 * Used by the /analytics/summary/:apiKey endpoint.
 */
async function getSummary(apiKey, days = 1) {
  const safeDays = Math.min(parseInt(days, 10), MAX_DAYS);

  const { rows } = await db.query(
    `SELECT
       COUNT(*)                              AS total_requests,
       COUNT(*) FILTER (WHERE allowed)       AS allowed_requests,
       COUNT(*) FILTER (WHERE NOT allowed)   AS denied_requests,
       MIN(occurred_at)                      AS first_seen,
       MAX(occurred_at)                      AS last_seen
     FROM analytics
     WHERE api_key = $1
       AND occurred_at >= NOW() - ($2 || ' days')::INTERVAL`,
    [apiKey, String(safeDays)],
  );

  const row = rows[0];
  const total   = Number(row.total_requests   ?? 0);
  const allowed = Number(row.allowed_requests ?? 0);
  const denied  = Number(row.denied_requests  ?? 0);

  return {
    apiKey,
    windowDays:    safeDays,
    totalRequests: total,
    allowedRequests: allowed,
    deniedRequests:  denied,
    allowRate:     total > 0 ? allowed / total : null,
    firstSeen:     row.first_seen,
    lastSeen:      row.last_seen,
  };
}

module.exports = { getTrends, getSummary, isTimescaleAvailable };
