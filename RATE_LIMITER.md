# Distributed Rate Limiter — Spec v3 (Tiered + Teaching Mode)

Act as a senior backend engineer. Build this in the phase order below.
**After every phase: stop, explain the decision(s) marked "EXPLAIN:", and wait
for me to say "continue" before writing the next phase's code.** Do not batch
phases together even if it seems more efficient.

Priority is explicit: **TIER 1 must be flawless. TIER 2 only after TIER 1 is
tested and working. TIER 3 only if time remains.** If running low on time,
stop after Tier 1/2 with a working, tested, documented core rather than a
half-built Tier 3 feature.

---

## TIER 1 — Core correctness (this is what gets graded)

### Phase 1: Token bucket in Redis Lua
- Fields per client: `capacity`, `refillRate`, `currentTokens`, `lastRefillTime`.
- Refill is lazy: computed from elapsed time on each check, not a background job.
- Entire admission decision (refill + check + decrement) happens atomically in
  one Lua script.
- EXPLAIN: walk through the exact race condition that occurs if refill and
  decrement were two separate Redis calls from Node, with a concrete
  two-instance timeline.

### Phase 2: Per-client config + cache-aside
- Config lives in Postgres (`clients` table: id, apiKey, capacity, refillRate,
  mode). Redis caches it.
- Hot path never touches Postgres.
- Explicit cache invalidation on config update (not just TTL expiry).
- EXPLAIN: what breaks if you rely on TTL alone and an admin lowers a
  client's limit mid-window?

### Phase 3: Fail-safe / circuit breaker
- Three states: closed → open → half-open, with automatic recovery via
  health check.
- Fail-open vs fail-closed is configurable **per client**, not global.
- EXPLAIN: give me one real client type that would demand fail-closed and
  one that would demand fail-open, and justify each.

### Phase 4: Fastify middleware + response headers
- `429` with `Retry-After`, `Remaining-Tokens`, `Limit`, `Reset-Time`.
- EXPLAIN: why do these headers matter for the *client calling you*, not just
  for your own logging?

### Phase 5: Tests (this is the tier-1 deliverable that most differentiates you)
- **Race condition test**: fire N concurrent requests at a client sitting
  exactly at their limit boundary, assert zero over-admission.
- **Chaos test**: kill Redis mid-load-test, assert the configured
  fail-open/fail-closed behavior actually triggers within a bounded time.
- **Load test** (k6 or autocannon): real p50/p95/p99 numbers, not estimates.
- EXPLAIN: why test exactly at the boundary instead of well above/below it?

### Phase 6: Architecture diagram (actual image file, not markdown ASCII)
- Generate a real PNG/JPG showing: client → Fastify instances → Redis (hot
  path) → async logging path → Postgres. Include the failure path (Redis
  down) as a separate branch, not an afterthought.
- This is an explicit graded deliverable in the brief — do not substitute a
  text description for it.

### Phase 7: Docker + README
- `docker compose up --build` starts everything in one command.
- README covers: how to run, how to trigger each test type, and an
  "Edge Cases" section (Redis dies mid-traffic, two instances race at the
  same millisecond, client already over quota, config changes mid-window).
- README explicitly states the Redis-HA trade-off: a single Redis instance
  is a SPOF for correctness even though the circuit breaker protects
  *availability*; note Redis Sentinel/Cluster as the production fix and why
  it's out of scope for this submission.

---

## TIER 2 — Only after Tier 1 is fully tested

### Phase 8: Async analytics (BullMQ → Postgres/TimescaleDB)
- Approved requests logged via queue, never synchronously.
- Worker batches inserts, retries on failure, dead-letter queue for
  poison messages, idempotent processing.
- EXPLAIN: what would happen to your Phase 5 latency numbers if this were
  synchronous instead? Give a rough estimate, not just "it'd be slower."

### Phase 9: Dashboard API
- TimescaleDB continuous aggregates for 10/15/30-day trends.
- Never query raw events for the trend endpoints.
- EXPLAIN: what is a continuous aggregate doing under the hood that a
  cron-based rollup table doesn't?

### Phase 10: Monitoring/health
- `/health`, `/ready`, `/live`.
- Basic metrics: requests/sec, allowed/blocked, cache hit ratio, queue depth.

---

## TIER 3 — Stretch, only if time remains

- Admin CRUD API for client management
- API key auth with Redis-cached lookups
- OpenAPI/Swagger docs
- Helmet/CORS/separate admin rate limiting
- >90% coverage target

Do not start Tier 3 until Tier 1 has a green test suite and a working
`docker compose up --build`. A judge scoring this task rewards a correct,
well-tested core far more than a broad but shallow feature set.

---

