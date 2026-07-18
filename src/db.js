'use strict';

/**
 * Postgres connection pool.
 *
 * Uses the `pg` library (node-postgres).  A single Pool instance is created
 * once and shared across the whole process — this is the idiomatic pattern
 * recommended by pg's maintainer.
 *
 * Environment variables:
 *   DATABASE_URL  – full Postgres connection string (preferred)
 *   PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD – fallback individual vars
 */

const { Pool } = require('pg');
const fs       = require('node:fs');
const path     = require('node:path');

let pool;

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max:              10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });

    pool.on('error', (err) => {
      // Don't crash the process on background pool errors; the next query
      // will fail with a proper error that the caller can handle.
      console.error('[db] pool background error', err.message);
    });
  }
  return pool;
}

/**
 * Run a single query against the pool.
 * @param {string} text - SQL string with $1, $2 … placeholders
 * @param {any[]}  [params]
 */
async function query(text, params) {
  const result = await getPool().query(text, params);
  return result;
}

/**
 * Run the migration file on startup.
 * Idempotent: uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
 */
async function migrate() {
  const sql = fs.readFileSync(
    path.join(__dirname, '..', 'migrations', '001_create_clients.sql'),
    'utf8',
  );
  await query(sql);
  console.log('[db] migration applied');
}

/**
 * Graceful shutdown.
 */
async function close() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

module.exports = { query, migrate, close, getPool };
