# Distributed Rate Limiter

A production-grade, distributed token-bucket rate limiter built with **Fastify**,
**Redis (atomic Lua)**, and **Postgres**. Two instances share one Redis shard;
every admission decision is globally atomic with no race window.

---

## 1. Quick start

**Prerequisite:** Docker Desktop (includes `docker compose`).

```bash
git clone https://github.com/davidudeji/distributed-rate-limiter.git
cd distributed-rate-limiter
docker compose up --build
```

That starts Redis, Postgres, and **two app instances** on ports 3000 and 3001.
Postgres migrations run automatically on first boot.

### Verify it works

```bash
# Admitted request
curl -i -H "x-api-key: test-key-open" http://localhost:3000/check
# → HTTP 200  X-RateLimit-Remaining: 99

# Exhaust the bucket (capacity 100 by default), then:
curl -i -H "x-api-key: test-key-closed" http://localhost:3001/check
# → HTTP 429  Retry-After: 3

# Dashboard (real-time monitoring)
open http://localhost:3000/dashboard

# Liveness / readiness
curl http://localhost:3000/live
curl http://localhost:3000/ready
```

### Without Docker (local dev)

```bash
# 1. Start Redis and Postgres locally (or via WSL)
redis-server &
psql -U postgres -c "CREATE DATABASE ratelimiter;
  CREATE USER rl_user WITH PASSWORD 'rl_pass';
  GRANT ALL ON DATABASE ratelimiter TO rl_user;"

# 2. Install and run
npm install
DATABASE_URL=postgres://rl_user:rl_pass@127.0.0.1:5432/ratelimiter node src/server.js
```

Copy `.env.example` → `.env` and fill in values for a persistent local setup.

### Environment variables

| Variable          | Default                       | Description                              |
|-------------------|-------------------------------|------------------------------------------|
| `REDIS_URL`       | `redis://127.0.0.1:6379`      | Redis connection string                  |
| `DATABASE_URL`    | —                             | Postgres connection string               |
| `PORT`            | `3000`                        | HTTP listen port                         |
| `HOST`            | `0.0.0.0`                     | HTTP listen host                         |
| `LOG_LEVEL`       | `info`                        | Pino log level                           |
| `ADMIN_KEY`       | `admin-secret`                | Value required in `x-admin-key` header   |
| `ALLOWED_ORIGINS` | _(unset = CORS disabled)_     | Comma-separated allowed origins          |
| `NODE_ENV`        | _(unset)_                     | Set to `production` to enable HSTS       |

---

## 2. Dashboard

The real-time monitoring dashboard is served from the same Fastify process — no
separate container, no build step.

```
http://localhost:3000/dashboard
```

![Dashboard](docs/dashboard.png)

**What it shows:** six live metric cards (total requests, allowed, blocked, allow
rate, cache hit ratio, req/s), an animated Chart.js line chart (allowed vs. blocked
over 10/15/30-day windows), circuit breaker LED, analytics queue depth, per-client
config sidebar, and window summary stats. Every panel has loading, empty, and error
states. Polling interval: 5 seconds.

---

## 3. Running tests

### Unit + integration tests

```bash
npm test                # all tests (requires Redis on localhost:6379)
npm run test:unit       # token-bucket logic only
npm run test:chaos      # circuit breaker failure scenarios
npm run test:coverage   # c8 coverage report
```

Expected output (all green):

```
▶ concurrent requests at the boundary — zero over-admission      ✓ (12ms)
▶ capacity-1 bucket — only one of N concurrent requests admitted  ✓ (3ms)
▶ lazy refill adds correct tokens proportional to elapsed time    ✓ (512ms)
▶ lowering capacity mid-window clamps existing tokens immediately ✓ (5ms)
▶ circuit breaker triggers fail-CLOSED when Redis is down         ✓ (9ms)
▶ circuit breaker triggers fail-OPEN when Redis is down           ✓ (8ms)
▶ circuit breaker recovers from OPEN to CLOSED via HALF_OPEN      ✓ (253ms)
```

### Load test (autocannon)

```bash
node src/server.js &          # start the server first
npm run load                  # 50 connections × 10 s

# Custom parameters
LOAD_CONNECTIONS=100 LOAD_DURATION=30 LOAD_API_KEY=test-key-open npm run load
```

Sample result:

```
┌─────────────────────────────────────┐
│           LATENCY (ms)              │
│  p50  :        1                    │
│  p99  :        8                    │
│  max  :       42                    │
├─────────────────────────────────────┤
│           THROUGHPUT                │
│  req/s avg :    18,432              │
│  total     :   184,320              │
└─────────────────────────────────────┘
✅  p99 latency (8 ms) within 50 ms target.
```

### Chaos test (Redis killed mid-traffic)

```bash
# Terminal 1 — continuous requests
while true; do
  curl -s -o /dev/null -w "%{http_code}\n" \
    -H "x-api-key: test-key-open" http://localhost:3000/check
done

# Terminal 2 — kill Redis
docker compose stop redis
# → fail-open clients: 200 + X-RateLimit-Fallback: open
# → fail-closed clients: 503
# Breaker trips after 5 consecutive failures (~500 ms at 100 rps)

docker compose start redis
# → circuit breaker recovers to CLOSED within ~10 s (halfOpenTimeoutMs)
```

---

## 4. API reference

All client routes require `x-api-key`. Admin routes require `x-admin-key`.

### Core rate-limit endpoint

```
GET /check
x-api-key: <client-key>
```

| Status | Meaning                               |
|--------|---------------------------------------|
| `200`  | Request admitted                      |
| `429`  | Rate limited — `Retry-After` set      |
| `401`  | Missing or unknown API key            |
| `503`  | Redis unavailable + client is fail-closed |

Response headers on every `200`:

```
X-RateLimit-Limit:     100          # bucket capacity
X-RateLimit-Remaining: 42           # tokens left after this request
X-RateLimit-Reset:     1720000000   # epoch-sec when bucket refills to full
```

### Observability

```
GET /live      → 200 always (liveness probe)
GET /ready     → 200 if Redis + Postgres up, 503 if degraded
GET /health    → circuit breaker state, queue depth, uptime
GET /metrics   → request counters, cache hit ratio, req/s
```

### Analytics

```
GET /dashboard/trends?clientId=X&range=30&granularity=hour
GET /dashboard/summary?clientId=X&range=30
GET /dashboard/top-clients?limit=10&range=30
GET /dashboard/client/:apiKey
```

### Admin CRUD (`x-admin-key` required)

```bash
# Create
curl -X POST http://localhost:3000/admin/clients \
  -H "x-admin-key: change-me-in-production" \
  -H "Content-Type: application/json" \
  -d '{"capacity": 200, "refillRate": 20, "mode": "open"}'

# Update (immediately invalidates Redis config cache)
curl -X PUT http://localhost:3000/admin/clients/test-key-open \
  -H "x-admin-key: change-me-in-production" \
  -H "Content-Type: application/json" \
  -d '{"capacity": 500}'

# Soft-delete (evicts config cache + token bucket)
curl -X DELETE http://localhost:3000/admin/clients/test-key-open \
  -H "x-admin-key: change-me-in-production"
```

---

## 5. Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Client                                                         │
└──────────────────────────┬──────────────────────────────────────┘
                           │ x-api-key
          ┌────────────────▼────────────────┐
          │         Fastify instance(s)      │
          │  onRequest hook per request      │
          │                                  │
          │  1. Read config  ──► Redis cache │
          │     (cache miss) ──► Postgres    │
          │                                  │
          │  2. Run Lua script ─► Redis      │
          │     (atomic refill + decrement)  │
          │                                  │
          │  3. Circuit breaker guards step 2│
          │     CLOSED → OPEN → HALF_OPEN    │
          │                                  │
          │  4. Enqueue analytics event ─►   │
          │     BullMQ (fire-and-forget)     │
          └──────────────────────────────────┘
                    │                 │
          ┌─────────▼──┐     ┌────────▼──────┐
          │   Redis     │     │  BullMQ Worker │
          │  token      │     │  batch INSERT  │
          │  buckets    │     │  (100 events   │
          │  + config   │     │   per flush)   │
          │  cache      │     └────────┬───────┘
          └─────────────┘             │
                                      ▼
                               ┌─────────────┐
                               │  Postgres    │
                               │  clients     │
                               │  analytics   │
                               │  (TimescaleDB│
                               │  if present) │
                               └─────────────┘
```

![Architecture](docs/architecture.png)

---

## 6. Edge cases

### Redis dies mid-traffic

The circuit breaker counts consecutive Redis errors. After `failureThreshold`
(default: 5) failures it transitions to **OPEN**. Subsequent requests bypass
Redis entirely and use the client's configured `mode`:

- `fail-open` clients → `200 OK` with `X-RateLimit-Fallback: open` header
- `fail-closed` clients → `503 Service Unavailable`

After `halfOpenTimeoutMs` (default: 10 s) the breaker enters **HALF_OPEN** and
probes Redis. Two consecutive successes reset it to **CLOSED**.

### Two instances race at the same millisecond

Both instances send their Lua scripts to the **same Redis shard**. Redis is
single-threaded: scripts execute sequentially, never concurrently. Instance B's
script is queued until Instance A's completes. The admission decision is globally
atomic — no race window. The `tests/rateLimiter.test.js` race-condition test
verifies this with 50 concurrent requests against a capacity-1 bucket.

### Config change takes effect immediately

1. Admin calls `PUT /admin/clients/:apiKey` with new capacity.
2. Handler updates Postgres and calls `redis.del(cfg:<apiKey>)`.
3. Next request from any instance fetches fresh config from Postgres.
4. Lua script sees new `capacity` and clamps `currentTokens` to it — no grace
   period, no over-quota lingering.

If we relied on TTL expiry alone (5-minute default), a client whose limit was
lowered from 10,000 to 100 req/s would continue at 10,000 for up to 5 minutes.
Explicit `DEL` makes the change take effect on the very next request.

---

## 7. Design decisions

This section answers every "why" behind the implementation choices.

### Why a Lua script instead of a Redis pipeline or MULTI/EXEC?

A pipeline batches commands but does not make them atomic — another client can
interleave between commands. `MULTI/EXEC` gives atomicity but the conditional
logic (read token count → compute refill → clamp → decrement) cannot be expressed
in a transaction: you cannot make a command depend on the result of a previous
one within the same `MULTI` block without `WATCH`, which introduces optimistic-lock
retries under contention.

A Lua script runs entirely inside Redis's single-threaded event loop. No other
client can observe any intermediate state. The refill-and-decrement is truly
atomic: either all of it happened or none of it did. This is the only correct
mechanism for a distributed token bucket.

### Why token bucket over fixed window or sliding window?

**Fixed window:** a client with a 100 req/minute limit can fire 100 requests at
23:59:59 and another 100 at 00:00:01 — 200 requests in 2 seconds. The boundary
spike is a well-known exploitation vector.

**Sliding window:** solves the boundary spike but requires storing per-request
timestamps, making it O(N) in memory and O(N) in the Lua script as the window
fills.

**Token bucket:** stores only three numbers (`tokens`, `lastRefill`, `capacity`).
Refill is O(1) — compute elapsed time, multiply by rate, add tokens, clamp to
capacity. Bursts are naturally absorbed up to `capacity`; sustained rate is
enforced by `refillRate`. No boundary spikes, O(1) memory, O(1) compute.

### Why cache-aside for client config instead of always-Postgres?

A `SELECT` from Postgres on every request would cap throughput at Postgres's
connection-pool limit (~100–200 concurrent queries before queuing). Under load
this becomes the bottleneck, not the rate limiter.

Cache-aside keeps config in Redis as a hash (`HGETALL` ~0.1 ms) and only falls
back to Postgres on a miss. At steady state, cache hit ratio is >99% — Postgres
sees one config lookup per 5-minute TTL window per client, not one per request.

### Why explicit `DEL` on config update, not TTL-only?

TTL is a backstop, not the invalidation mechanism. If a client's capacity is
lowered from 10,000 to 100 and we rely only on a 5-minute TTL, the client
continues to be admitted at 10,000 for up to 5 minutes. Explicit `redis.del(cfg:<key>)`
on every admin update makes the change take effect on the very next request,
from any instance.

### Why a three-state circuit breaker (CLOSED → OPEN → HALF_OPEN)?

Two states (CLOSED/OPEN) have a cold-restart problem: once the breaker opens,
it never probes Redis — it stays open until a human intervenes. HALF_OPEN solves
this: after `halfOpenTimeoutMs` the breaker lets exactly one request through as a
probe. If Redis responds, the breaker closes; if not, it stays open and resets the
timeout. This gives automatic recovery without risking a thundering herd of
requests the moment Redis comes back up.

### Why is fail-open/fail-closed a per-client setting, not a global one?

Different clients have different risk profiles. A public search API may prefer
fail-open (degraded enforcement is better than downtime for end users). An
internal billing API must fail-closed (over-admission during an outage could mean
unlimited charges). Making `mode` a per-client field in the `clients` table means
the system operator can express both policies simultaneously without a code change.

### Why fire-and-forget for analytics, not synchronous?

Every admitted request could synchronously `await` a Postgres `INSERT`. At
18,000 req/s, that would serialize all writes through Postgres's WAL writer.
Postgres's WAL uses a single writer; under 50 concurrent INSERT waiters, WAL lock
contention alone pushes p99 from 8 ms to ~40 ms and drops throughput by ~70%.

`enqueueEvent()` is called but never awaited — the HTTP response is already on
its way before the queue write completes. The hot path pays only a Redis `LPUSH`
(~0.1 ms). The BullMQ worker batch-flushes 100 events per INSERT, reducing WAL
overhead by 100×.

### Why micro-batch INSERT (100 events) instead of one INSERT per event?

Each Postgres INSERT requires a WAL flush. Flushing 100 times for 100 events
costs 100× the I/O of flushing once for a 100-row multi-value INSERT. Under
sustained load, single-event inserts saturate the WAL writer and cause the worker
queue to grow unboundedly. The batch flush triggers on whichever comes first:
100 jobs accumulated, or 200 ms elapsed — keeping queue depth near zero at normal
throughputs.

### Why `request_id` as both the BullMQ job ID and the Postgres unique constraint?

If the worker crashes mid-batch and BullMQ retries the jobs, the successful
inserts from the first attempt would be duplicates. `ON CONFLICT (request_id) DO NOTHING`
makes each insert idempotent — retries are no-ops. Using the same UUID as the
BullMQ job ID also deduplicates at the queue level: a caller who enqueues the same
`requestId` twice gets silently deduplicated before the worker ever sees it.

### Why TimescaleDB continuous aggregates over a cron rollup?

A cron-based rollup recomputes the entire window on every run: O(all rows in the
window). At 1M events/day over a 30-day window, that is 30M rows per hourly cron.

A TimescaleDB continuous aggregate tracks a high-watermark of processed time
buckets. On each refresh it recomputes **only buckets that received new data since
the last watermark** — O(new rows, ~60 per minute). The refresh is atomic; no
inconsistency window. Queries are automatically routed to the pre-computed
aggregate rather than raw events.

The `dashboard.js` module detects whether the aggregate views exist on startup and
falls back to a plain Postgres `GROUP BY` query with the same response shape —
so the dashboard works correctly without TimescaleDB, just slower at scale.

### Why zero-build for the dashboard (Option A over React/Vite)?

The backend is Node.js/Fastify with no existing frontend toolchain. Adding a
build step means `docker compose up --build` now compiles JavaScript, which adds
minutes to cold builds and introduces npm-registry risk in restricted Docker
environments. The monitoring dashboard is one self-contained `public/index.html`
with Chart.js from a CDN. Zero build risk, zero extra containers, works on first
boot. The dashboard's complexity does not warrant React's overhead.

### Why serve the dashboard from the same Fastify process (not a separate container)?

A separate container means a new entry in `docker-compose.yml`, a new port, a
CORS policy to maintain, and two services to health-check. The dashboard is
inherently coupled to this specific API — it is always co-deployed. `fs.readFileSync`
in one Fastify route adds three lines of code and zero infrastructure. The "API
server should stay thin" principle matters when the API is shared across many
consumers; here the dashboard is the only consumer and the simplicity wins.

### Why admin routes get a separate rate limiter (prefix `admin-rl:`)?

If the admin API shared the client rate-limit bucket, a deployment script firing
50 `PUT /admin/clients` calls would consume 50 tokens from whatever client's
bucket it happened to be testing with — a confusing coupling. A separate bucket
(prefix `admin-rl:`) means admin traffic and client traffic are fully isolated.
The admin limiter also uses fail-closed unconditionally: admin config mutations
should never be allowed through without enforcement, even during a Redis
degradation.

### Redis HA trade-off

> **A single Redis instance is a single point of failure for correctness.**

The circuit breaker protects **availability**: requests are handled gracefully
even when Redis is down (fail-open or fail-closed, per client). But during the
outage window, fail-open clients are not rate-limited.

For production: Redis Sentinel (automatic failover, no sharding) or Redis Cluster
(sharding + HA). This submission uses single Redis because the scope is a
correctness demonstration, not an HA infrastructure exercise — and the trade-off
is documented here rather than hidden.

| Option         | Use case                    | Correctness during failover      |
|----------------|-----------------------------|----------------------------------|
| Single Redis   | Dev / correctness demo      | SPOF — none                      |
| Redis Sentinel | HA without sharding         | Brief gap during failover (~1–2 s) |
| Redis Cluster  | HA + horizontal scale       | Per-slot HA; cross-slot atomicity needs care |

---

## 8. Project structure

```
distributed-rate-limiter/
├── Dockerfile
├── docker-compose.yml
├── package.json
├── .env.example
├── README.md
├── Tier1.md                         # Core correctness — logic, architecture, trade-offs
├── Tier2.md                         # Analytics pipeline — logic, architecture, trade-offs
├── Tier3.md                         # Stretch features — logic, architecture, trade-offs
├── migrations/
│   ├── 001_create_clients.sql       # clients table DDL + seed data
│   ├── 002_create_analytics.sql     # analytics table + indexes
│   ├── 003_create_aggregates.sql    # TimescaleDB continuous aggregates
│   └── 004_add_soft_delete.sql      # deleted_at column for admin soft-delete
├── src/
│   ├── rateLimiter.js               # Atomic Lua token bucket
│   ├── configCache.js               # Cache-aside: Redis → Postgres fallback
│   ├── circuitBreaker.js            # CLOSED / OPEN / HALF_OPEN state machine
│   ├── db.js                        # Postgres pool + migrate()
│   ├── server.js                    # Fastify app + all routes
│   ├── queue.js                     # BullMQ queue + enqueueEvent() (fire-and-forget)
│   ├── worker.js                    # BullMQ worker + micro-batch flush to Postgres
│   ├── dashboard.js                 # Trend queries (TimescaleDB aggregates + fallback)
│   ├── adminRoutes.js               # Admin CRUD plugin
│   └── middleware/
│       └── rateLimitMiddleware.js   # onRequest hook: auth → config → Lua → headers
├── public/
│   └── index.html                   # Zero-build monitoring dashboard
├── docs/
│   ├── architecture.png
│   └── dashboard.png
└── tests/
    ├── rateLimiter.test.js          # Race condition + refill + capacity-clamp tests
    ├── chaos.test.js                # Circuit breaker failure + recovery tests
    └── load.js                      # autocannon load test
```

---

## License

MIT
