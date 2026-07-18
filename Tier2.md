# Tier 2 — Analytics Pipeline

> **Prerequisite:** Tier 1 must have a green test suite and a working
> `docker compose up --build` before Tier 2 is started.
> Phases 8–10 add observability without touching the hot path.

---

## Overview

Tier 2 adds three layers of observability **behind** the rate-limit decision:

| Phase | What it adds |
|-------|-------------|
| 8 | Async analytics pipeline (BullMQ → Postgres batch inserts) |
| 9 | Dashboard API (trend endpoints backed by TimescaleDB continuous aggregates) |
| 10 | Health + metrics endpoints (`/health`, `/ready`, `/live`, `/metrics`) |

The guiding principle: **the hot path must never pay the cost of observability**.
Every write to Postgres is asynchronous, every query on the dashboard API
reads pre-computed aggregates rather than raw events.

---

## Phase 8 — Async Analytics (BullMQ → Postgres)

### Architecture

```
Rate-limit decision made (hot path ~1ms)
         │
         │ enqueueEvent() — fire and forget (~0.1ms queue.add)
         │
         ▼
   BullMQ Queue (stored in Redis)
         │
         │ (worker dequeues asynchronously)
         ▼
   Worker process
         │  accumulates up to BATCH_SIZE jobs
         │  OR BATCH_INTERVAL_MS elapses
         ▼
   Postgres analytics table
   (single multi-row INSERT per batch)
```

### Design Decisions

#### 1. Fire-and-forget enqueue

`enqueueEvent()` is called but never `await`-ed on the hot path. The HTTP response
is already on its way to the client before the queue write completes. A queue error
is caught and logged but never thrown back to the HTTP layer.

#### 2. Micro-batch INSERT

Rather than one `INSERT` per event, the worker accumulates jobs in an in-memory
buffer and flushes with a single multi-row `INSERT`:

```sql
INSERT INTO analytics (request_id, api_key, allowed, remaining_tokens, limit_cap, occurred_at)
VALUES (,,,,,), (,,,,,), ...
ON CONFLICT (request_id) DO NOTHING
```

Flush triggers on whichever comes first:
- `BATCH_SIZE` jobs accumulated (default: 100)
- `BATCH_INTERVAL_MS` elapsed since last flush (default: 200ms)

#### 3. Idempotent processing

`request_id` (a UUID generated in the middleware) is used as both the
BullMQ job ID and the Postgres unique constraint. This means:

- BullMQ silently ignores duplicate enqueue calls (same job ID)
- Postgres `ON CONFLICT DO NOTHING` ignores duplicate insert attempts

If a worker crashes mid-batch and BullMQ retries the jobs, the successful
inserts from the first attempt are no-ops — no duplicates, no double-counting.

#### 4. Dead-letter queue (DLQ)

Jobs that exhaust all retry attempts (default: 3, exponential back-off) are
left in BullMQ's `failed` set in Redis. This is the DLQ — no separate
infrastructure needed. Inspect with:

```bash
# Using redis-cli
redis-cli LRANGE bull:analytics:failed 0 -1

# Or programmatically
const failed = await queue.getFailed();
```

#### 5. Poison message detection

The worker validates required fields on every job:

```javascript
if (!job.data.requestId || !job.data.apiKey) {
  throw new Error(Poison message: missing required fields in job );
}
```

A poison message will exhaust its retries and land in the DLQ, where it can be
inspected without blocking healthy jobs.

### EXPLAIN: Latency Impact of Synchronous Analytics

> *What would happen to Phase 5 latency numbers if this were synchronous? Give a rough estimate.*

Current hot-path cost: **Redis Lua round-trip ~1ms** + Fastify overhead ~0.5ms = **p99 ~8ms**

If each admitted request synchronously `await`-ed a Postgres INSERT:

| Metric | Async (current) | Synchronous |
|--------|-----------------|-------------|
| Postgres INSERT latency | ~2ms (local) | ~2ms (local) |
| p99 latency | **8ms** | **~30–50ms** |
| Throughput (50 conns) | **~18,000 req/s** | **~3,000–5,000 req/s** |

The throughput drop comes from Postgres's write serialisation:

- Postgres uses a single WAL (Write-Ahead Log) writer
- Under 50 concurrent INSERT writers, WAL lock contention causes queuing
- Each INSERT waits for the previous one's WAL flush before returning
- The limiter effectively becomes **Postgres-bound**, not Redis-bound

BullMQ + batch inserts sidestep this entirely:
- The hot path pays only `queue.add()` (~0.1ms Redis LPUSH)
- The worker consolidates 100 events into one INSERT — WAL overhead is 1/100th

---

## Phase 9 — Dashboard API

### What it does

Exposes trend endpoints for 10/15/30-day views of per-client request rates.
Reads from **TimescaleDB continuous aggregates** — never from raw `analytics` events.

```
GET /analytics/trends/:apiKey?days=30&granularity=hour
```

### TimescaleDB Continuous Aggregates

The migration (`003_create_aggregates.sql`) creates two materialised views:

```sql
-- Per-minute aggregate (supports short windows)
CREATE MATERIALIZED VIEW analytics_by_minute
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 minute', occurred_at) AS bucket,
  api_key,
  COUNT(*)                              AS total_requests,
  COUNT(*) FILTER (WHERE allowed)       AS allowed_requests,
  COUNT(*) FILTER (WHERE NOT allowed)   AS denied_requests,
  AVG(remaining_tokens)                 AS avg_remaining_tokens
FROM analytics
GROUP BY bucket, api_key
WITH NO DATA;

-- Per-hour aggregate (supports 10/15/30-day trends)
CREATE MATERIALIZED VIEW analytics_by_hour
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', occurred_at) AS bucket,
  api_key,
  COUNT(*) AS total_requests, ...
FROM analytics
GROUP BY bucket, api_key
WITH NO DATA;
```

A refresh policy runs every minute (minute aggregate) and every hour (hour aggregate),
incrementally updating only the new time buckets.

### EXPLAIN: Continuous Aggregates vs Cron-Based Rollup

> *What is a continuous aggregate doing under the hood that a cron-based rollup table does not?*

**Cron-based rollup:**

```
Every hour: DELETE FROM rollup_hourly WHERE bucket = current_hour;
            INSERT INTO rollup_hourly SELECT ... FROM analytics WHERE ...;
```

- Recomputes the **entire window** on every run: O(all rows in the window)
- Two separate writes (DELETE + INSERT) introduce a brief inconsistency window
- Under high insert rates, the cron competes with the application for Postgres I/O

**TimescaleDB continuous aggregate:**

```
Incremental refresh: only buckets with new data are recomputed
Stored as a separate internal hypertable (not a regular materialised view)
Queries are automatically routed to the aggregate — no schema change needed at query time
```

- TimescaleDB tracks the **high-watermark** of processed data per bucket
- On each refresh, only buckets touched since the last watermark are recomputed: O(new rows)
- The refresh is a single atomic transaction — no inconsistency window
- Under a 31-day window with 1M rows/day, a cron recomputes 31M rows every hour;
  a continuous aggregate recomputes only the ~60 new rows from the last minute

This is the fundamental difference: **incremental O(new rows)** vs **full-scan O(all rows)**.

### Fallback (Plain Postgres)

If TimescaleDB is not available (plain Postgres install), `dashboard.js` falls back
to querying the `analytics` table directly with the `analytics_api_key_time` index.
The response is the same shape; only performance differs at scale.

---

## Phase 10 — Monitoring / Health

### Endpoints

| Endpoint | Purpose | When to use |
|----------|---------|-------------|
| `GET /live` | Liveness — process is alive | K8s liveness probe |
| `GET /ready` | Readiness — Redis + Postgres both up | K8s readiness probe |
| `GET /health` | Circuit breaker state + queue depth | Ops dashboards |
| `GET /metrics` | req/s, allowed/blocked, cache hit ratio | Prometheus scrape |

### /live

Always returns 200. Used by orchestrators to decide whether to restart the process.
A 200 means the event loop is not blocked and the process hasn't crashed.

```json
{ "status": "alive" }
```

### /ready

Checks both Redis (`PING`) and Postgres (`SELECT 1`). Returns 503 if either is down.
Used by load balancers to stop routing traffic to an instance that cannot serve requests.

```json
{
  "status": "ready",
  "checks": { "redis": "ok", "postgres": "ok" }
}
```

### /health

Returns the circuit breaker state and analytics queue depth:

```json
{
  "status": "healthy",
  "circuitBreaker": {
    "state": "CLOSED",
    "failureCount": 0,
    "successCount": 0,
    "openedAt": null
  },
  "analytics": { "queueDepth": 42 },
  "uptime": 3600.123
}
```

**Why queue depth?** A growing queue (`queueDepth >> 0`) indicates the worker
is falling behind — either Postgres is slow or the worker is crashed.
A pager alert on `queueDepth > 10000` catches analytics pipeline failures early.

### /metrics

Returns quantitative signal for Prometheus-style scraping:

```json
{
  "requests": {
    "total":   184320,
    "allowed": 176400,
    "blocked":   7920,
    "allowRate": 0.957
  },
  "latency": {
    "note": "See autocannon load test for p50/p95/p99 numbers"
  },
  "cache": {
    "hits":     184000,
    "misses":       320,
    "hitRatio":   0.998
  },
  "circuitBreaker": { "state": "CLOSED" },
  "analytics":      { "queueDepth": 0 },
  "uptime":         3600.123
}
```

**Cache hit ratio** is the fraction of config lookups served from Redis without
touching Postgres. A healthy system should be > 0.99. A ratio dropping toward 0.5
indicates Redis may be evicting keys under memory pressure.

---

## Tier 2 File Map

```
distributed-rate-limiter/
├── src/
│   ├── queue.js           ← Phase 8: BullMQ Queue, enqueueEvent()
│   ├── worker.js          ← Phase 8: BullMQ Worker, micro-batch flush
│   ├── dashboard.js       ← Phase 9: trend query logic (TimescaleDB + fallback)
│   └── server.js          ← Phase 10: /analytics/trends, /metrics routes
├── migrations/
│   ├── 002_create_analytics.sql   ← Phase 8: analytics table + indexes
│   └── 003_create_aggregates.sql  ← Phase 9: continuous aggregate views
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Fire-and-forget enqueue | Analytics must never add latency to the hot path |
| Micro-batch INSERT | Reduces WAL contention; 100× fewer Postgres round-trips |
| Idempotent by `request_id` | Safe to retry jobs without duplicating analytics |
| BullMQ failed set as DLQ | No extra infrastructure; inspectable via redis-cli |
| Continuous aggregates, not cron | Incremental O(new rows) vs full-scan O(all rows) |
| Plain Postgres fallback | Works without TimescaleDB; trades query speed at scale |
| Cache hit ratio in metrics | Early warning for Redis memory pressure |
| `/ready` vs `/live` | Different semantics: readiness gates traffic; liveness gates restarts |
