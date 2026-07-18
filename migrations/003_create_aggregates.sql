-- Phase 9: TimescaleDB continuous aggregates for dashboard trends
-- IMPORTANT: Requires TimescaleDB extension.
-- If running plain Postgres (without TimescaleDB), the continuous aggregate
-- blocks will fail.  The app handles this gracefully: Postgres-only installs
-- fall back to the indexed analytics table directly.

-- ── Enable TimescaleDB (no-op if already enabled) ─────────────────────────
-- CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- ── Convert analytics to a hypertable (one-time, safe to skip if exists) ──
-- SELECT create_hypertable('analytics', 'occurred_at', if_not_exists => TRUE);

-- ── Continuous aggregate: per-minute request counts ───────────────────────
-- A continuous aggregate is a materialised view that TimescaleDB refreshes
-- incrementally as new data arrives — only the new time buckets are recomputed,
-- not the entire history.  A cron-based rollup table recomputes the WHOLE window
-- on each run, making it O(total rows) rather than O(new rows).
--
-- This view supports 10/15/30-day trend queries without scanning raw events.
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_by_minute
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', occurred_at) AS bucket,
  api_key,
  COUNT(*)                             AS total_requests,
  COUNT(*) FILTER (WHERE allowed)      AS allowed_requests,
  COUNT(*) FILTER (WHERE NOT allowed)  AS denied_requests,
  AVG(remaining_tokens)                AS avg_remaining_tokens
FROM analytics
GROUP BY bucket, api_key
WITH NO DATA;

-- Refresh policy: keep the last 31 days up-to-date, refresh every minute
SELECT add_continuous_aggregate_policy(
  'analytics_by_minute',
  start_offset  => INTERVAL '31 days',
  end_offset    => INTERVAL '1 minute',
  schedule_interval => INTERVAL '1 minute',
  if_not_exists => TRUE
);

-- ── Hourly aggregate (rolls up the minute aggregate for longer trends) ─────
CREATE MATERIALIZED VIEW IF NOT EXISTS analytics_by_hour
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', occurred_at) AS bucket,
  api_key,
  COUNT(*)                           AS total_requests,
  COUNT(*) FILTER (WHERE allowed)    AS allowed_requests,
  COUNT(*) FILTER (WHERE NOT allowed) AS denied_requests
FROM analytics
GROUP BY bucket, api_key
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
  'analytics_by_hour',
  start_offset  => INTERVAL '31 days',
  end_offset    => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);
