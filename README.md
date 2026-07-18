# Distributed Rate Limiter

A production-grade, distributed token-bucket rate limiter built with **Fastify**, **Redis (Lua)**, and **Postgres**. Designed for correctness first: all admission decisions are atomic, per-client config is served from a Redis cache-aside layer, and failure modes are configurable per-client via a three-state circuit breaker.

![Architecture](docs/architecture.png)

---

## Quick start

```bash
# Start everything in one command
docker compose up --build

# The app runs on two instances:
#   http://localhost:3000  (app1)
#   http://localhost:3001  (app2)
```

> **Prerequisite**: Docker and Docker Compose v2+ installed.

---

## How to run

### Development (without Docker)

```bash
# 1. Start Redis and Postgres (e.g. local install or WSL)
redis-server &
psql -U postgres -c "CREATE DATABASE ratelimiter; CREATE USER rl_user WITH PASSWORD 'rl_pass'; GRANT ALL ON DATABASE ratelimiter TO rl_user;"

# 2. Install dependencies
npm install

# 3. Start the server
REDIS_URL=redis://127.0.0.1:6379 \
DATABASE_URL=postgres://rl_user:rl_pass@127.0.0.1:5432/ratelimiter \
node src/server.js
```

### Environment variables

| Variable       | Default                         | Description                    |
|----------------|---------------------------------|--------------------------------|
| `REDIS_URL`    | `redis://127.0.0.1:6379`        | Redis connection string        |
| `DATABASE_URL` | —                               | Postgres connection string     |
| `PORT`         | `3000`                          | HTTP listen port               |
| `HOST`         | `0.0.0.0`                       | HTTP listen host               |
| `LOG_LEVEL`    | `info`                          | Pino log level                 |

---

## API

All routes except `/live`, `/ready`, `/health`, `/metrics`, and `/analytics/*` require an `x-api-key` header.
Admin routes require an `x-admin-key` header (set via `ADMIN_KEY` env var).

### Rate-limited endpoint (Tier 1)

```
GET /check
x-api-key: <your-api-key>
```

**Responses:**

| Status | Meaning                          |
|--------|----------------------------------|
| `200`  | Request admitted                 |
| `429`  | Too many requests (rate limited) |
| `401`  | Missing or unknown API key       |
| `503`  | Redis unavailable (fail-closed)  |

**Headers always returned:**

```
X-RateLimit-Limit:     100        # bucket capacity
X-RateLimit-Remaining: 42         # tokens left after this request
X-RateLimit-Reset:     1720000000 # epoch-sec when bucket refills to full
Retry-After:           3          # seconds to wait (only on 429)
```

### Health + Metrics endpoints (Phase 10)

```
GET /live    → 200 always (liveness probe)
GET /ready   → 200 if Redis + Postgres up, 503 if degraded (readiness probe)
GET /health  → circuit breaker state, queue depth, uptime
GET /metrics → request counters, cache hit ratio, req/s
```

### Analytics / Dashboard (Phase 9)

```bash
# 30-day hourly trend for a client
GET /analytics/trends/test-key-open?days=30&granularity=hour

# 24-hour summary
GET /analytics/summary/test-key-open?days=1
```

### Admin CRUD (Tier 3)

All admin routes require `x-admin-key` header.

```bash
# Create a new client
curl -X POST http://localhost:3000/admin/clients \
  -H "x-admin-key: admin-secret-change-me-in-production" \
  -H "Content-Type: application/json" \
  -d '{"capacity": 200, "refillRate": 20, "mode": "open"}'

# List all clients
curl -H "x-admin-key: admin-secret" http://localhost:3000/admin/clients

# Update a client (immediately invalidates Redis cache)
curl -X PUT http://localhost:3000/admin/clients/test-key-open \
  -H "x-admin-key: admin-secret" \
  -H "Content-Type: application/json" \
  -d '{"capacity": 500, "refillRate": 50}'

# Soft-delete a client (evicts config cache + token bucket)
curl -X DELETE http://localhost:3000/admin/clients/test-key-open \
  -H "x-admin-key: admin-secret"
```

### Swagger UI (Tier 3 — if @fastify/swagger is installed)

```
GET /docs   → Interactive Swagger UI
GET /docs/json → Raw OpenAPI 3.1 JSON schema
```

---

## How to trigger each test type

### Unit + integration tests (requires Redis running)

```bash
# Run all tests
npm test

# Unit tests only (token bucket logic)
npm run test:unit

# Chaos tests only (circuit breaker behavior)
npm run test:chaos
```

Expected output:
```
▶ concurrent requests at the boundary — zero over-admission
  ✓ (12ms)
▶ capacity-1 bucket — only one of N concurrent requests admitted
  ✓ (3ms)
▶ lazy refill adds correct tokens proportional to elapsed time
  ✓ (512ms)
▶ lowering capacity mid-window clamps existing tokens immediately
  ✓ (5ms)
▶ circuit breaker triggers fail-CLOSED when Redis is down
  ✓ (9ms)
▶ circuit breaker triggers fail-OPEN when Redis is down
  ✓ (8ms)
▶ circuit breaker recovers from OPEN to CLOSED via HALF_OPEN
  ✓ (253ms)
```

### Load test

```bash
# Start the server first
node src/server.js &

# Run the load test (10s, 50 concurrent connections)
npm run load

# Custom parameters
LOAD_CONNECTIONS=100 LOAD_DURATION=30 LOAD_API_KEY=test-key-open npm run load
```

Sample output:
```
📊  Distributed Rate Limiter — Load Test
   Target:       http://127.0.0.1:3000
   Connections:  50
   Duration:     10 s

┌─────────────────────────────────────┐
│           LATENCY (ms)              │
│  p50  :        1                   │
│  p75  :        2                   │
│  p90  :        3                   │
│  p99  :        8                   │
│  max  :       42                   │
├─────────────────────────────────────┤
│           THROUGHPUT                │
│  req/s avg :    18432              │
│  total     :   184320              │
│  errors    :        0              │
└─────────────────────────────────────┘
✅  p99 latency (8 ms) within 50 ms target.
```

### Chaos test (Redis kill mid-traffic)

```bash
# In terminal 1: run continuous requests
while true; do curl -s -o /dev/null -w "%{http_code}\n" \
  -H "x-api-key: test-key-open" http://localhost:3000/check; done

# In terminal 2: kill Redis
docker compose stop redis

# Observe: fail-open clients get 200 with header X-RateLimit-Fallback: open
#           fail-closed clients get 503
# Circuit breaker trips within 5 consecutive failures (~500ms at 100rps)

# Restart Redis and observe recovery
docker compose start redis
# Within ~10s (halfOpenTimeoutMs) the circuit breaker recovers to CLOSED
```

---

## Edge Cases

### 1. Redis dies mid-traffic

**What happens:**  
The circuit breaker counts consecutive Redis errors. After `failureThreshold` (default: 5) failures it transitions to **OPEN**. Subsequent requests bypass Redis entirely and use the client's configured `mode`:
- `fail-open` clients → `200 OK` with `X-RateLimit-Fallback: open` header  
- `fail-closed` clients → `503 Service Unavailable`

**Recovery:**  
After `halfOpenTimeoutMs` (default: 10 s), the breaker enters **HALF_OPEN** and allows one probe request through to Redis. If it succeeds, the breaker resets to **CLOSED** after `successThreshold` (default: 2) consecutive successes.

---

### 2. Two instances race at the same millisecond

**What happens:**  
This is the primary correctness guarantee of the system. Both instances send their Lua scripts to the same Redis shard. Redis is **single-threaded**: scripts execute sequentially, never concurrently. Instance B's script is queued until Instance A's script completes. The admission decision is therefore globally atomic — no race window exists.

**Contrast with the broken alternative:**  
If refill and decrement were two separate `HGET`/`HSET` calls, both instances could read the same token count, both decide to admit, and both write back `currentTokens - 1` — resulting in double-spend. The race condition test in `tests/rateLimiter.test.js` verifies this cannot happen.

---

### 3. Client already over quota (stale tokens from a previous config)

**What happens:**  
The Lua script clamps `currentTokens` to the new `capacity` whenever the stored capacity or refill rate differs from the values passed in. This means a client who had 100 tokens under the old config and whose capacity is lowered to 10 will immediately see `currentTokens = 10` on the next request — no grace period, no lingering over-quota state.

---

### 4. Config changes mid-window

**What happens:**  
1. Admin calls `PUT /clients/:apiKey` with new `capacity`/`refillRate`.  
2. The handler updates Postgres and **immediately calls `redis.del(cfg:apiKey)`** to invalidate the cache.  
3. The very next request from any instance fetches the new config from Postgres and writes it back to Redis.  
4. The Lua script sees the new `capacity`/`refillRate` values and applies the clamping rule (edge case 3 above).

**Why TTL-only is insufficient:**  
If we relied on TTL expiry (e.g., 5 minutes) instead of explicit invalidation, the old config would remain in Redis for up to 5 minutes after the admin change. A client whose limit was just lowered from 10,000 to 100 req/s would continue to be admitted at 10,000 req/s for the remainder of the TTL window. Explicit `DEL` on update makes the change take effect immediately.

---

## Redis HA trade-off

> **Important:** A single Redis instance is a **single point of failure for correctness**.

The circuit breaker protects **availability**: when Redis goes down, clients are either allowed through (fail-open) or rejected gracefully (fail-closed) rather than causing a server crash. However, *during the outage period* the rate-limit guarantee is not enforced for fail-open clients — a determined caller could fire unlimited requests.

For a production deployment, Redis Sentinel (automatic failover, no sharding) or Redis Cluster (sharding + partial HA) should be used:

| Option           | Use case                          | Correctness during failover |
|------------------|-----------------------------------|-----------------------------|
| Single Redis     | Development / low-stakes          | SPOF — none                 |
| Redis Sentinel   | HA without sharding               | Brief window during failover (~1–2s) |
| Redis Cluster    | HA + horizontal scale             | Per-slot HA; cross-slot atomicity requires care |

**This submission uses a single Redis instance** because the scope is a correctness demonstration, not an HA infrastructure exercise. The `docker-compose.yml` deliberately documents this trade-off rather than hiding it.

---

## Project structure

```
distributed-rate-limiter/
├── Dockerfile
├── README.md
├── Tier1.md                         # Core correctness — explanation + trade-offs
├── Tier2.md                         # Analytics pipeline — explanation + trade-offs
├── Tier3.md                         # Stretch features — explanation + trade-offs
├── docker-compose.yml
├── package.json
├── .env.example
├── migrations/
│   ├── 001_create_clients.sql       # clients table DDL + seed data
│   ├── 002_create_analytics.sql     # analytics table + indexes
│   ├── 003_create_aggregates.sql    # TimescaleDB continuous aggregates
│   └── 004_add_soft_delete.sql      # deleted_at column for admin CRUD
├── src/
│   ├── rateLimiter.js               # Phase 1: Token bucket + atomic Lua script
│   ├── configCache.js               # Phase 2: cache-aside (Redis → Postgres)
│   ├── circuitBreaker.js            # Phase 3: CLOSED/OPEN/HALF_OPEN machine
│   ├── db.js                        # Postgres pool + migrate()
│   ├── server.js                    # Fastify app factory + all routes
│   ├── queue.js                     # Phase 8: BullMQ Queue + enqueueEvent()
│   ├── worker.js                    # Phase 8: BullMQ Worker + micro-batch flush
│   ├── dashboard.js                 # Phase 9: trend queries (TimescaleDB + fallback)
│   ├── adminRoutes.js               # Tier 3: Admin CRUD plugin
│   └── middleware/
│       └── rateLimitMiddleware.js   # Phase 4: onRequest hook + headers + metrics
├── docs/
│   └── architecture.png             # Phase 6: system architecture diagram
└── tests/
    ├── rateLimiter.test.js          # Phase 5: race + refill + clamp tests
    ├── chaos.test.js                # Phase 5: circuit breaker failure tests
    └── load.js                      # Phase 5: autocannon load test
```

---

## License

MIT
