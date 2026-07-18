-- Phase (Tier 3): add soft-delete support to clients table
-- Idempotent: ADD COLUMN IF NOT EXISTS is safe to run multiple times

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ DEFAULT NULL;

-- Index to filter deleted rows efficiently in list queries
CREATE INDEX IF NOT EXISTS clients_deleted_at
  ON clients (deleted_at)
  WHERE deleted_at IS NULL;
