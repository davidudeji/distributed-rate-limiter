# Tier 1 — Core Correctness

> **Priority:** This tier is graded. It must be flawless before any Tier 2 work begins.
> Phases 1–7 produce a working, tested, documented rate limiter that runs with a single
> `docker compose up --build`.

---

## Overview

Tier 1 implements a **production-grade distributed token-bucket rate limiter** with:

- Atomic admission decisions via a Redis Lua script (zero race window)
- Per-client configuration served from a Redis cache (Postgres is the source of truth)
- A three-state circuit breaker with per-client fail policy
- Standard rate-limit response headers (`X-RateLimit-*`, `Retry-After`)
- A race-condition test, chaos test, and autocannon load test
- A real architecture diagram
- Docker Compose that starts the full stack in one command

---

## Phase 1 — Token Bucket in Redis Lua

### What it does

Every rate-limit decision runs inside a single **Redis Lua script**. The script:

1. Reads all four bucket fields in one `HMGET` call: `currentTokens`, `lastRefillTime`, `capacity`, `refillRate`
2. Initialises a new bucket to full capacity on first use
3. Detects config changes (admin lowered/raised limits) and clamps existing tokens
4. **Lazy refill**: computes how many tokens have accumulated since `lastRefillTime` based on wall-clock elapsed time — no background job needed
5. Admits or denies the request
6. Writes back updated state with `HSET`
7. Sets an `EXPIRE` to auto-clean idle clients

### Lua Script Internals

```lua
-- Single round-trip to read all four fields
local data = redis.call('HMGET', key, 'currentTokens', 'lastRefillTime', 'capacity', 'refillRate')

-- Lazy refill: add tokens proportional to wall-clock time elapsed
local elapsedMs    = math.max(0, now - lastRefillTime)
local refillAmount = elapsedMs * storedRate / 1000
currentTokens      = math.min(storedCap, currentTokens + refillAmount)

-- Admission decision
if currentTokens >= requested then
  allowed       = 1
  currentTokens = currentTokens - requested
else
  retryAfterMs = math.ceil((requested - currentTokens) / storedRate * 1000)
end

-- Persist + auto-expire
redis.call('HSET', key, 'capacity', storedCap, 'currentTokens', currentTokens, ...)
redis.call('EXPIRE', key, ttlSec)
```

### EXPLAIN: The Race Condition (Two Separate Redis Calls)

> *Walk through the exact race condition if refill and decrement were two separate Redis
> calls from Node, with a concrete two-instance timeline.*

Suppose `capacity = 1` and the bucket currently has 1 token. Two app instances handle concurrent requests:

```
Time → T0          T1          T2          T3

Instance A: HGET currentTokens = 1   (sees 1 token)
Instance B:              HGET currentTokens = 1   (also sees 1 token!)

Instance A:                   admits → HSET currentTokens = 0
Instance B:                                  admits → HSET currentTokens = 0
```

**Result:** Both instances admitted the request. The client got **2 requests through** when only 1 was allowed. This is a **double-spend** race.

The window exists because `HGET` and `HSET` are two separate commands — another command (from another client/instance) can execute between them. With the Lua script, the entire read-modify-write is one atomic unit in Redis's single-threaded command queue.

**Key insight:** Redis is single-threaded but the Node.js event loop is concurrent. Multiple instances can fire commands at Redis simultaneously; Redis serialises them. The Lua script guarantees the triple is one indivisible operation.

---

## Phase 2 — Per-Client Config + Cache-Aside

### Cache-Aside Pattern

```
Every request (hot path):
  Redis HGETALL cfg:<apiKey>
    ├─ HIT  → use cached config (sub-millisecond)
    └─ MISS → query Postgres → populate Redis → use config

Config update (admin):
  UPDATE clients SET ...
  redis.del(cfg:<apiKey>)   ← explicit invalidation
```

### EXPLAIN: What Breaks With TTL-Only Invalidation

> *What breaks if you rely on TTL alone and an admin lowers a client's limit mid-window?*

Suppose `client-X` has `capacity = 10,000` cached with a 5-minute TTL. Admin lowers it to `100`:

```
T=0:00  Admin updates Postgres → capacity = 100
T=0:01  Redis still has old config: capacity = 10,000  ← STILL IN CACHE
T=4:59  Redis still has old config: capacity = 10,000  ← 5 min of abuse possible
T=5:00  TTL expires → fetches new value from Postgres
```

During those 5 minutes the client continues at 10,000 req/s. With explicit `DEL`:

```
T=0:00  Admin updates Postgres → capacity = 100
T=0:00  redis.del(cfg:client-X)        ← immediate invalidation
T=0:01  Next request → cache miss → fetches 100 from Postgres ✅
```

The TTL still exists as a backstop, but explicit `DEL` is the primary mechanism.

---

## Phase 3 — Fail-Safe / Circuit Breaker

### State Machine

```
CLOSED ──(failureThreshold reached)──► OPEN
  ▲                                       │
  │                                       ▼ (halfOpenTimeoutMs elapsed)
  └──(successThreshold probe hits)── HALF_OPEN
```

| State | Behaviour |
|-------|-----------|
| **CLOSED** | Normal — all requests attempt Redis |
| **OPEN** | Redis presumed down — skip Redis, apply failMode |
| **HALF_OPEN** | One probe allowed; success → CLOSED, failure → OPEN |

### EXPLAIN: Fail-Open vs Fail-Closed Client Types

> *Give one real client type that would demand fail-closed and one that would demand
> fail-open, and justify each.*

**Fail-closed: a payment gateway or fraud detection API**

When your system says "allow this transaction" under degraded conditions, you risk processing fraudulent or over-limit charges that cannot be reversed. A 503 tells the calling system "retry later" safely. **Correctness > availability.**

**Fail-open: a public CDN or read-only analytics API**

A CDN rate-limiter protects against abuse, but if the limiter goes down, the worst case is some clients get more reads than their quota — no irreversible harm. A 503 would degrade the service for *all* legitimate users. **Availability > strict enforcement during outage.**

### Why In-Process State

State is held **in-process**, not in Redis. Using Redis to store circuit-breaker state would mean the guard relies on what it guards. If Redis goes down, an in-process breaker still trips correctly.

---

## Phase 4 — Fastify Middleware + Response Headers

### Request Lifecycle

```
onRequest hook fires (before route handler)
  │
  ├─ No x-api-key header?          → 401
  ├─ Unknown API key?               → 401
  ├─ Redis down + mode=closed?      → 503
  ├─ Redis down + mode=open?        → 200 + X-RateLimit-Fallback: open
  ├─ Tokens exhausted?              → 429 + Retry-After
  └─ Admitted?                      → set headers + continue + enqueue analytics
```

### Response Headers

```
X-RateLimit-Limit:     100        # bucket capacity
X-RateLimit-Remaining: 42         # tokens remaining after this request
X-RateLimit-Reset:     1720000000 # epoch-sec when bucket refills to full
Retry-After:           3          # only on 429: seconds until enough tokens exist
```

### EXPLAIN: Why These Headers Matter for Callers

> *Why do these headers matter for the client calling you, not just for your own logging?*

Without headers, rate limiting is an **opaque wall**. With them it becomes a **cooperative protocol**:

- **`X-RateLimit-Remaining`**: Clients implement *proactive back-off* — slowing down before hitting the limit rather than hammering until 429
- **`Retry-After`**: Automated clients sleep for exactly this duration, eliminating the **thundering herd** (all retrying at once when the window resets)
- **`X-RateLimit-Reset`**: Dashboards show users "quota resets at 14:30:00" — a predictable UX
- **`X-RateLimit-Limit`**: Clients know their total budget for client-side throttling without a separate config call

These headers follow [RFC 6585](https://datatracker.ietf.org/doc/html/rfc6585) and the emerging RateLimit header fields draft. GitHub, Stripe, and Twilio all implement them.

---

## Phase 5 — Tests

### Race Condition Test

- `capacity = 5`, `refillRate = 0` (no refill — makes counting exact), 20 concurrent requests via `Promise.all`
- **Asserts:** exactly 5 admitted, 15 denied. Any other number proves a race

### Why Test at the Exact Boundary

- **Well below:** always passes; proves nothing about limit enforcement
- **Well above:** insensitive to off-by-one errors (`>=` vs `>`)
- **Exact boundary:** any atomicity bug, comparison error, or rounding issue produces the wrong integer count — immediately caught

### Chaos Test

Three scenarios: fail-closed, fail-open, and recovery (OPEN → HALF_OPEN → CLOSED). Uses a dead Redis port (19999) to force failures without root access.

### Load Test (autocannon)

50 concurrent connections, 10 seconds. **Asserts p99 < 50ms**. Achievable because the hot path is one Redis round-trip (~1ms local) + Lua overhead (~0.1ms).

---

## Phase 6 — Architecture Diagram

`docs/architecture.png` shows the full system:

- Client → Load balancer → Fastify instances (hot path)
- Fastify → Redis (token bucket + config cache) → Postgres (on cache miss)
- Fastify → BullMQ queue → Worker → Postgres (async analytics)
- Failure path (Redis down) → Circuit breaker OPEN → failMode applied

---

## Phase 7 — Docker + README

### docker-compose.yml Services

| Service | Image | Port |
|---------|-------|------|
| `redis` | `redis:7-alpine` | 6379 |
| `postgres` | `postgres:16-alpine` | 5432 |
| `app1` | `Dockerfile` | 3000 |
| `app2` | `Dockerfile` | 3001 |

Both app instances share Redis and Postgres — demonstrating distributed correctness.

### README Edge Cases

| Scenario | Mechanism |
|----------|-----------|
| Redis dies mid-traffic | Circuit breaker trips → failMode applied |
| Two instances race same millisecond | Lua atomicity in Redis single-threaded queue |
| Client already over quota | Lua clamps `currentTokens` to new `capacity` |
| Config changes mid-window | Explicit `redis.del` on admin update |

### Redis HA Trade-off

> A single Redis instance is a **single point of failure for correctness**. The circuit breaker protects *availability* (no crash, graceful fallback), but during an outage fail-open clients bypass rate-limiting entirely. Redis Sentinel or Redis Cluster is the production fix — out of scope for this submission.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Lua script (not MULTI/EXEC) | Atomic without watch-retry loop; simpler and faster |
| Lazy refill (not background job) | No SPOF, no idle work, no clock-skew window |
| In-process circuit breaker | Cannot use Redis to guard Redis |
| Explicit cache invalidation | TTL-only leaves an enforcement window |
| Per-client failMode | Payment processors need fail-closed; CDNs need fail-open |
| Boundary-exact test | Maximum sensitivity to off-by-one and atomicity bugs |
| Single Redis (documented SPOF) | Honest scope — correctness demo, not HA exercise |
