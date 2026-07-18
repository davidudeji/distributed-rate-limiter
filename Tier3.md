# Tier 3 — Stretch Features

> **Prerequisite:** Tier 3 is only started after Tier 1 has a green test suite
> and a working `docker compose up --build`. A judge rewards a correct,
> well-tested core far more than a broad but shallow feature set.

---

## Overview

Tier 3 adds production-hardening features that a real API platform needs but
that are not part of the core rate-limiting guarantee:

| Feature | What it adds |
|---------|-------------|
| Admin CRUD API | Full lifecycle management for client API keys |
| API key auth | Secure lookup of client identity |
| OpenAPI / Swagger | Auto-generated, browsable API documentation |
| Helmet / CORS | Security headers and cross-origin policy |
| Separate admin rate limiting | Prevents the admin API from being used as a DoS vector |
| >90% test coverage target | Catches regressions across all tiers |

---

## Admin CRUD API

### Why a Separate Admin Router

The existing `PUT /clients/:apiKey` route was a single-endpoint shortcut.
A real API platform needs full lifecycle management:

```
POST   /admin/clients           → create a new client + generate API key
GET    /admin/clients           → list all clients (paginated)
GET    /admin/clients/:apiKey   → get one client's config and stats
PUT    /admin/clients/:apiKey   → update config (invalidates cache)
DELETE /admin/clients/:apiKey   → soft-delete (removes from Postgres + evicts Redis cache)
```

All admin routes are:

1. **Protected by a separate admin API key** (`x-admin-key` header)
2. **Rate-limited independently** from client traffic — an admin can't lock themselves out, and a compromised admin key can't DoS the system
3. **Isolated in their own Fastify plugin** — adding admin routes does not touch the hot-path plugin

### Admin Rate Limiter Trade-off

The admin API uses its own `TokenBucketLimiter` instance with a separate
Redis key prefix (`admin-rl:`). This means:

- Admin and client rate limits are completely independent
- A burst of admin API calls (e.g., a misconfigured deployment script) does not consume client quota
- The admin limiter also goes through the circuit breaker — if Redis is down, the admin falls back to fail-closed (admin actions should never be allowed through without enforcement)

### Cache Invalidation on DELETE

When a client is deleted:

1. Postgres row is soft-deleted (`deleted_at = NOW()`)
2. Redis config cache is explicitly evicted (`redis.del(cfg:<apiKey>)`)
3. Redis token bucket is explicitly evicted (`redis.del(rl:<apiKey>)`)

Next request with that API key → cache miss → Postgres returns no row → 401 Unauthorized.

---

## API Key Auth

### Current Implementation

The current system trusts any string in the `x-api-key` header and validates it
against the Postgres `clients` table (via cache-aside). This is correct for the
core rate-limiting problem.

### Tier 3 Enhancement

For a production system, API keys should be:

1. **Cryptographically random**: `crypto.randomBytes(32).toString('hex')` — not sequential IDs
2. **Hashed at rest**: Store `sha256(apiKey)` in Postgres, not the raw key (same principle as password hashing)
3. **Cached by hash**: Redis caches by `sha256(apiKey)` — the raw key never touches Postgres or Redis

```
Client sends: x-api-key: abc123plaintext

Server:
  hash = sha256('abc123plaintext')         → 'e3b0c44...'
  redis.hgetall('cfg:e3b0c44...')          → lookup by hash
    ├─ HIT  → config found, proceed
    └─ MISS → SELECT * FROM clients WHERE key_hash = 'e3b0c44...'
```

**Trade-off:** Adding hashing adds ~0.05ms per request (SHA-256 is fast in Node.js).
The security benefit is that a Redis dump or a Postgres backup does not expose
raw API keys.

### Why Not JWT

JWTs are stateless — they carry their own claims and don't require a database lookup.
This sounds appealing but has two problems for a rate limiter:

1. **Revocation is hard**: a JWT with a 5-minute TTL is valid for 5 minutes even after the user is deleted; a rate-limit exemption can't be revoked immediately
2. **Config changes**: JWT payloads are signed at issuance; you can't lower a client's `capacity` mid-token without issuing a new JWT

API keys + cache-aside give immediate, explicit revocation and immediate config propagation.

---

## OpenAPI / Swagger Documentation

### What it generates

Using `@fastify/swagger` + `@fastify/swagger-ui`:

- **`GET /docs/json`** — raw OpenAPI 3.1 JSON schema
- **`GET /docs`** — interactive Swagger UI (browser-based)

Every route is annotated with:

```javascript
{
  schema: {
    description: 'Check rate limit for the authenticated client',
    tags: ['rate-limit'],
    headers: {
      type: 'object',
      required: ['x-api-key'],
      properties: {
        'x-api-key': { type: 'string', description: 'Client API key' }
      }
    },
    response: {
      200: { ... },
      429: { ... },
      401: { ... },
      503: { ... }
    }
  }
}
```

### Why Auto-Generated Docs Beat Hand-Written Docs

- **Always in sync with the code**: the schema is the source of truth for both validation and documentation
- **Interactive**: developers can test endpoints directly from the browser (no Postman needed)
- **Machine-readable**: the OpenAPI JSON can be imported into API gateways (Kong, AWS API Gateway) for automatic routing and upstream rate limiting

### Trade-off: Schema Verbosity

Adding full Fastify JSON schemas to every route adds ~20 lines per route.
The payoff is: validation errors are returned as structured JSON (not raw Fastify errors),
and the docs are always accurate.

---

## Helmet / CORS / Security Headers

### @fastify/helmet

Sets security-critical HTTP response headers on every response:

| Header | Value | Purpose |
|--------|-------|---------|
| `Content-Security-Policy` | default-src 'none' | Prevents XSS if ever served to a browser |
| `X-Content-Type-Options` | nosniff | Prevents MIME sniffing |
| `X-Frame-Options` | DENY | Prevents clickjacking |
| `Strict-Transport-Security` | max-age=31536000 | Forces HTTPS |
| `X-DNS-Prefetch-Control` | off | Reduces information leakage |

**Trade-off:** `Strict-Transport-Security` should only be set if TLS is guaranteed.
For local development (HTTP), Helmet is configured to omit HSTS.

### @fastify/cors

Configures Cross-Origin Resource Sharing:

```javascript
fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? false,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'x-api-key', 'x-admin-key'],
});
```

**Why not `origin: '*'`?**

Wildcard CORS allows any website to make authenticated requests to your API from
a visitor's browser. For an API with API-key auth, this means a malicious website
could embed a user's API key (if they can get it) and silently drain their quota.
Explicit origin allowlisting prevents this.

**Trade-off:** CORS configuration requires knowing the allowed origins at deploy time.
For a purely server-to-server API (no browser clients), CORS can be disabled entirely.

### Separate Admin Rate Limiting

The admin API is rate-limited with a dedicated limiter instance:

```
Admin requests → admin TokenBucketLimiter (prefix: admin-rl:)
                  capacity:   100/min (generous for scripts)
                  failMode:   closed (admin must not bypass limits)

Client requests → client TokenBucketLimiter (prefix: rl:)
                  capacity:   per-client config
```

This prevents:
- A misbehaving deployment script from consuming client rate-limit quota
- The admin API from being used to enumerate valid API keys at high speed
- Admin operations from being affected by client traffic spikes

---

## >90% Coverage Target

### Strategy

```bash
npm install --save-dev c8   # V8 native coverage (no instrumentation overhead)
c8 --reporter=lcov --reporter=text node --test tests/*.test.js
```

Coverage gates:

| Layer | Target | Why |
|-------|--------|-----|
| `rateLimiter.js` | 100% | Core correctness; every branch is a potential race |
| `circuitBreaker.js` | 100% | Every state transition must be tested |
| `configCache.js` | 95% | Hit and miss paths; error path harder to trigger |
| `middleware/` | 90% | All HTTP status codes covered |
| `worker.js` | 85% | Batch flush timing is hard to unit test precisely |
| `dashboard.js` | 80% | TimescaleDB fallback path needs a plain-Postgres test |

### What 90% Means (and Doesn't Mean)

90% line coverage means 10% of lines are never executed by tests.
It does **not** mean the system is 90% correct — coverage measures execution, not correctness.

The race condition test and chaos test are more valuable than line coverage because
they test **concurrent** and **failure** behaviors that line coverage cannot capture.
Coverage is a floor, not a ceiling.

---

## Tier 3 File Map

```
distributed-rate-limiter/
├── src/
│   ├── adminRoutes.js       ← Admin CRUD plugin
│   └── server.js            ← Registers Swagger, Helmet, CORS, adminRoutes
├── tests/
│   ├── rateLimiter.test.js  ← Existing (regression)
│   ├── chaos.test.js        ← Existing (regression)
│   ├── admin.test.js        ← NEW: Admin CRUD endpoint tests
│   └── coverage/            ← c8 output (gitignored)
├── package.json             ← +@fastify/swagger, +@fastify/helmet, +@fastify/cors, +c8
```

---

## Trade-offs: Tier 3 vs Earlier Tiers

| Concern | Tier 3 choice | Alternative | Why this choice |
|---------|--------------|-------------|----------------|
| Docs | Auto-generated via schema | Hand-written OpenAPI YAML | Schema = source of truth; always in sync |
| Auth | API key + SHA-256 hash | JWT | Immediate revocation; supports config updates mid-token |
| CORS | Explicit allowlist | Wildcard `*` | Prevents cross-site credential abuse |
| Admin isolation | Separate plugin + separate rate limiter | Shared plugin | Admin traffic must not affect client hot path |
| Coverage | c8 (V8 native) | Istanbul/nyc | Zero instrumentation overhead; accurate async coverage |

---

## Why Tier 3 Is Last

The spec is explicit: **a correct, well-tested core is worth more than a broad, shallow feature set.**

Swagger docs on a broken rate limiter are worthless. Helmet headers on a server that allows double-spend are security theater. CORS on an endpoint that can't handle concurrent load is cosmetic.

Tier 3 features are **multipliers**: they make a working system more secure, more observable, and more developer-friendly. They are not substitutes for correctness.
