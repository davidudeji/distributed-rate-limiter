'use strict';

/**
 * Circuit Breaker — three-state machine per client.
 *
 * States:
 *   CLOSED    – normal operation; errors are counted
 *   OPEN      – Redis is presumed down; requests use the configured fallback
 *   HALF_OPEN – test probe; one request is allowed through; if it succeeds
 *               the breaker resets to CLOSED; if it fails it returns to OPEN
 *
 * Per-client fail mode (from client config):
 *   'open'   – when the breaker is OPEN, ALLOW the request (fail-open)
 *   'closed' – when the breaker is OPEN, DENY  the request (fail-closed)
 *
 * Design decisions:
 *   • State is held in-process (not in Redis) because the breaker guards
 *     against Redis being unavailable.  Using Redis to store circuit-breaker
 *     state would mean the guard relies on what it guards.
 *   • Each Fastify instance has its own breaker.  That's correct — partial
 *     failures (one instance's connection dying) should be caught per-instance.
 *   • The health-check timer uses setInterval.  The server clears it on shutdown.
 */

const STATES = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });

class CircuitBreaker {
  /**
   * @param {object} options
   * @param {number} [options.failureThreshold=5]     – consecutive failures to trip
   * @param {number} [options.successThreshold=2]     – consecutive successes to reset
   * @param {number} [options.halfOpenTimeoutMs=10000] – ms in OPEN before probe
   * @param {Function} [options.healthCheck]           – async fn that returns true if healthy
   */
  constructor(options = {}) {
    this.failureThreshold  = options.failureThreshold  ?? 5;
    this.successThreshold  = options.successThreshold  ?? 2;
    this.halfOpenTimeoutMs = options.halfOpenTimeoutMs ?? 10_000;
    this.healthCheck       = options.healthCheck       ?? null;

    this._state          = STATES.CLOSED;
    this._failureCount   = 0;
    this._successCount   = 0;
    this._openedAt       = null;
    this._halfOpenTimer  = null;
    this._probeInFlight  = false;
  }

  get state() { return this._state; }
  get isOpen()     { return this._state === STATES.OPEN; }
  get isHalfOpen() { return this._state === STATES.HALF_OPEN; }
  get isClosed()   { return this._state === STATES.CLOSED; }

  /**
   * Record that a Redis operation succeeded.
   */
  onSuccess() {
    this._failureCount = 0;
    this._probeInFlight = false;

    if (this._state === STATES.HALF_OPEN) {
      this._successCount++;
      if (this._successCount >= this.successThreshold) {
        this._reset();
      }
    }
  }

  /**
   * Record that a Redis operation failed.
   */
  onFailure() {
    this._failureCount++;
    this._successCount = 0;
    this._probeInFlight = false;

    if (this._state === STATES.HALF_OPEN) {
      // One failure in half-open → back to OPEN immediately
      this._trip();
      return;
    }

    if (this._state === STATES.CLOSED && this._failureCount >= this.failureThreshold) {
      this._trip();
    }
  }

  /**
   * Determine whether a request should be allowed through to Redis.
   * Call this BEFORE attempting the Redis operation.
   *
   * @returns {{ allow: boolean, isProbe: boolean }}
   *   allow   – true if the caller should attempt the Redis call
   *   isProbe – true if this is the half-open test probe
   */
  allowRequest() {
    if (this._state === STATES.CLOSED) {
      return { allow: true, isProbe: false };
    }

    if (this._state === STATES.OPEN) {
      // Check if the half-open timeout has elapsed
      if (Date.now() - this._openedAt >= this.halfOpenTimeoutMs) {
        this._transitionToHalfOpen();
        if (!this._probeInFlight) {
          this._probeInFlight = true;
          return { allow: true, isProbe: true };
        }
      }
      return { allow: false, isProbe: false };
    }

    // HALF_OPEN — only let the probe through
    if (!this._probeInFlight) {
      this._probeInFlight = true;
      return { allow: true, isProbe: true };
    }
    return { allow: false, isProbe: false };
  }

  /**
   * Wrap a Redis operation with circuit-breaker logic.
   *
   * @param {Function} fn         – async function that calls Redis
   * @param {string}   failMode   – 'open' | 'closed' (client's fail preference)
   * @returns {Promise<{result: any, fallback: boolean}>}
   *   result   – the fn return value, or null on fallback
   *   fallback – true if the circuit was open and we used the fallback
   */
  async exec(fn, failMode = 'closed') {
    const { allow } = this.allowRequest();

    if (!allow) {
      // Circuit is open — apply the configured fallback
      return { result: null, fallback: true, failMode };
    }

    try {
      const result = await fn();
      this.onSuccess();
      return { result, fallback: false, failMode };
    } catch (err) {
      this.onFailure();
      // If this was the first failure that tripped the breaker, use fallback
      return { result: null, fallback: true, failMode, error: err };
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  _trip() {
    this._state    = STATES.OPEN;
    this._openedAt = Date.now();
    this._successCount  = 0;
    this._probeInFlight = false;
    console.warn(`[circuit-breaker] tripped → OPEN (failures: ${this._failureCount})`);

    // If a healthCheck function is provided, start polling
    if (this.healthCheck && !this._halfOpenTimer) {
      this._halfOpenTimer = setInterval(async () => {
        if (this._state !== STATES.OPEN) {
          clearInterval(this._halfOpenTimer);
          this._halfOpenTimer = null;
          return;
        }
        try {
          await this.healthCheck();
          this._transitionToHalfOpen();
        } catch {
          // still down — remain OPEN
        }
      }, this.halfOpenTimeoutMs);
      // Don't keep the process alive just for the timer
      if (this._halfOpenTimer.unref) this._halfOpenTimer.unref();
    }
  }

  _transitionToHalfOpen() {
    console.info('[circuit-breaker] OPEN → HALF_OPEN (probe allowed)');
    this._state        = STATES.HALF_OPEN;
    this._probeInFlight = false;
    if (this._halfOpenTimer) {
      clearInterval(this._halfOpenTimer);
      this._halfOpenTimer = null;
    }
  }

  _reset() {
    console.info('[circuit-breaker] HALF_OPEN → CLOSED (recovered)');
    this._state        = STATES.CLOSED;
    this._failureCount = 0;
    this._successCount = 0;
    this._probeInFlight = false;
    this._openedAt     = null;
    if (this._halfOpenTimer) {
      clearInterval(this._halfOpenTimer);
      this._halfOpenTimer = null;
    }
  }

  /** Stats for /health endpoint (Phase 10). */
  stats() {
    return {
      state:        this._state,
      failureCount: this._failureCount,
      successCount: this._successCount,
      openedAt:     this._openedAt,
    };
  }

  /** Clean up any background timer. Call on server shutdown. */
  destroy() {
    if (this._halfOpenTimer) {
      clearInterval(this._halfOpenTimer);
      this._halfOpenTimer = null;
    }
  }
}

module.exports = { CircuitBreaker, STATES };
