-- Phase 8: analytics table
-- Every admitted (and denied) request is logged here asynchronously via BullMQ.
-- The hot path NEVER writes to this table; only the background worker does.
--
-- request_id is a client-generated UUID used for idempotent inserts:
--   ON CONFLICT (request_id) DO NOTHING
-- If a worker retries a job after a transient DB failure, the second insert
-- is a no-op — the row is not duplicated.

CREATE TABLE IF NOT EXISTS analytics (
  id               BIGSERIAL    PRIMARY KEY,
  request_id       TEXT         NOT NULL UNIQUE,   -- UUID from the app layer
  api_key          TEXT         NOT NULL,
  allowed          BOOLEAN      NOT NULL,
  remaining_tokens NUMERIC      NOT NULL,
  limit_cap        INTEGER      NOT NULL,
  occurred_at      TIMESTAMPTZ  NOT NULL
);

-- Index for the dashboard API (Phase 9) — queries by api_key + time range
CREATE INDEX IF NOT EXISTS analytics_api_key_time
  ON analytics (api_key, occurred_at DESC);

-- Index for time-range scans across all clients
CREATE INDEX IF NOT EXISTS analytics_occurred_at
  ON analytics (occurred_at DESC);
