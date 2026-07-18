'use strict';

/**
 * BullMQ queue instance for the analytics pipeline.
 *
 * Producers (the rate-limit middleware) call enqueueEvent() after each
 * admission decision.  The job is added asynchronously — the HTTP response
 * is already on its way to the client by then.
 *
 * Job schema:
 *   requestId      – UUID (used as the BullMQ jobId → idempotent enqueue)
 *   apiKey         – identifies the client
 *   allowed        – true / false
 *   remainingTokens
 *   limit          – bucket capacity
 *   occurredAt     – ISO timestamp (set by the producer, not the worker)
 *
 * Default job options:
 *   attempts: 3 with exponential back-off   → transient DB failures are retried
 *   removeOnComplete: keep last 1 000       → bounded memory
 *   removeOnFail: keep last 500             → these are the dead-letter queue;
 *                                              inspect with bull-board or redis-cli
 */

const { Queue } = require('bullmq');

const QUEUE_NAME = 'analytics';

let _queue = null;

/**
 * Lazily create and return the shared Queue instance.
 * @param {import('ioredis').Redis} redisConnection
 */
function getQueue(redisConnection) {
  if (!_queue) {
    _queue = new Queue(QUEUE_NAME, {
      connection: redisConnection,
      defaultJobOptions: {
        attempts:         3,
        backoff:          { type: 'exponential', delay: 1_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail:     { count: 500 },
      },
    });
  }
  return _queue;
}

/**
 * Enqueue a single analytics event.
 * Fire-and-forget from the caller's perspective: errors are caught and logged
 * but never thrown back to the HTTP layer.
 *
 * Using the requestId as the BullMQ jobId makes enqueuing idempotent:
 * if the middleware accidentally calls this twice for the same request
 * (e.g., retry logic) BullMQ silently ignores the duplicate.
 *
 * @param {import('ioredis').Redis} redis
 * @param {{ requestId: string, apiKey: string, allowed: boolean,
 *           remainingTokens: number, limit: number }} data
 */
async function enqueueEvent(redis, data) {
  try {
    const q = getQueue(redis);
    await q.add('request', {
      ...data,
      occurredAt: new Date().toISOString(),
    }, {
      jobId: data.requestId,   // idempotent enqueue
    });
  } catch (err) {
    // Never let queue errors bleed into the HTTP response
    console.error('[analytics-queue] enqueue error:', err.message);
  }
}

/**
 * Graceful shutdown: drain and close the queue.
 */
async function closeQueue() {
  if (_queue) {
    await _queue.close();
    _queue = null;
  }
}

module.exports = { getQueue, enqueueEvent, closeQueue, QUEUE_NAME };
