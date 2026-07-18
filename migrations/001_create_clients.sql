-- Phase 2: clients table
-- Stores per-client rate-limit configuration.
-- The hot path (rate-limit check) NEVER reads from this table directly;
-- it reads from the Redis cache.  This table is the source of truth that
-- feeds the cache, and the destination for explicit cache-invalidation on update.

CREATE TABLE IF NOT EXISTS clients (
  id          SERIAL       PRIMARY KEY,
  api_key     TEXT         NOT NULL UNIQUE,
  capacity    INTEGER      NOT NULL CHECK (capacity > 0),
  refill_rate NUMERIC(10,4) NOT NULL CHECK (refill_rate >= 0),
  -- mode: 'open'   = fail-open  (allow requests when Redis is down)
  --        'closed' = fail-closed (deny requests when Redis is down)
  mode        TEXT         NOT NULL DEFAULT 'closed' CHECK (mode IN ('open', 'closed')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Trigger to keep updated_at current
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS clients_set_updated_at ON clients;
CREATE TRIGGER clients_set_updated_at
  BEFORE UPDATE ON clients
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed some test clients (idempotent via ON CONFLICT DO NOTHING)
INSERT INTO clients (api_key, capacity, refill_rate, mode) VALUES
  ('test-key-open',   100, 10,  'open'),
  ('test-key-closed', 50,  5,   'closed'),
  ('test-key-burst',  200, 0,   'closed')   -- static bucket, no refill
ON CONFLICT (api_key) DO NOTHING;
