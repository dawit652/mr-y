/**
 * server.js – mr-y Casino API
 * ---------------------------------------------------------------------------
 *   GET /play/:uuid   -> { success, playUrl }      (X-Cache: HIT | MISS)
 *   GET /health       -> Redis, queue and worker status
 *   GET /health?deep  -> also asks a worker to check every Narobet session
 *
 * Request path: Redis cache (launch URLs are reused for 4 minutes) -> on a
 * miss, enqueue a BullMQ `play` job and wait for queue-worker.js to finish it.
 * Requests for the same game at the same time share one job. The API process
 * never starts Chrome, so it stays small no matter how many requests wait.
 *
 * Backpressure: once MAX_WAITING jobs are queued, new misses get 503 with
 * Retry-After. A request that waits longer than REQUEST_TIMEOUT_MS gets 504,
 * but its job keeps running and caches the result, so a retry is a cache hit.
 *
 *   node server.js           (needs Redis; start queue-worker.js too; env vars: src/casino/config.js)
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { CacheManager } from './src/casino/cache-manager.js';
import { ApiError, UUID_RE, handleShutdown, isMainModule, stampLog, withDeadline } from './src/casino/common.js';
import { JOB_CHECK_SESSIONS, JOB_PLAY, loadConfig, redactUrl, redisOptions } from './src/casino/config.js';

/** Starts the API; resolves to { server, url, queue, cache, close }. */
export async function startServer(config = loadConfig(), { log = console.log } = {}) {
  const connection = redisOptions(config.redisUrl);
  const redis = new Redis({ ...connection, lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 2_000 });
  redis.on('error', () => {}); // reconnects on its own; failed commands surface where they're used
  const queue = new Queue(config.queueName, {
    connection,
    prefix: config.prefix,
    defaultJobOptions: {
      attempts: 1, // the worker retries internally (with session rotation)
      // Finished jobs linger briefly so near-simultaneous requests can join them;
      // after that the Redis cache answers.
      removeOnComplete: { age: 5 },
      removeOnFail: { age: 5 },
    },
  });
  const events = new QueueEvents(config.queueName, { connection, prefix: config.prefix });
  // Every waiting request adds a listener to both (BullMQ's waitUntilFinished),
  // so hundreds of concurrent waiters are normal, not a leak.
  queue.setMaxListeners(0);
  events.setMaxListeners(0);
  queue.on('error', (err) => log(`Queue error: ${err.message}`));
  events.on('error', (err) => log(`Queue events error: ${err.message}`));
  const cache = new CacheManager(redis, { prefix: config.prefix, ttlSec: config.cacheTtlSec, log });

  // BullMQ's close() never settles if Redis was never reachable, so every step is bounded.
  const shutdownRedis = async () => {
    const bounded = (fn) => withDeadline(Promise.resolve().then(fn), 3_000, 'close timed out').catch(() => {});
    await Promise.all([bounded(() => events.close()), bounded(() => queue.close())]);
    if (redis.status === 'ready') await bounded(() => redis.quit());
    redis.disconnect();
  };

  try {
    await withDeadline(
      Promise.all([redis.connect(), queue.waitUntilReady(), events.waitUntilReady()]),
      10_000,
      'no answer within 10s',
    );
  } catch (err) {
    await shutdownRedis();
    throw new Error(`Cannot reach Redis at ${redactUrl(config.redisUrl)}: ${err.message}`);
  }

  let closing = false;
  const app = createApp({ config, queue, events, cache, isClosing: () => closing, log });

  const server = http.createServer(app);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          err.message = `Port ${config.port} is already in use – is the API already running? `
            + `Check http://${config.host}:${config.port}/health, stop the other instance, or set PORT.`;
        }
        reject(err);
      });
      // A deep accept backlog so a burst of new connections queues instead of being
      // refused (Node's default is 511; client editions of Windows cap it lower anyway).
      server.listen({ port: config.port, host: config.host, backlog: config.listenBacklog }, resolve);
    });
  } catch (err) {
    await shutdownRedis();
    throw err;
  }
  const url = `http://${config.host}:${server.address().port}`;

  queue.getWorkersCount()
    .then((n) => { if (!n) log('Warning: no queue workers are running yet – start queue-worker.js or requests will time out.'); })
    .catch(() => {});

  const close = async () => {
    if (closing) return;
    closing = true; // new cache misses get 503 from here on
    const closed = new Promise((r) => server.close(() => r()));
    server.closeIdleConnections?.();
    // In-flight requests get a grace period to finish; then their sockets are dropped.
    await withDeadline(closed, config.shutdownGraceMs, 'grace period over').catch(() => {
      server.closeAllConnections?.();
      return closed;
    });
    await shutdownRedis();
  };

  return { server, url, queue, cache, close };
}

/** Builds the Express app around a queue + cache. */
export function createApp({ config, queue, events, cache, isClosing = () => false, log = console.log }) {
  const app = express();
  app.use(cors());

  const sendError = (res, err) => {
    const status = err instanceof ApiError ? err.status : 500;
    const body = { success: false, error: err.message || 'Internal Server Error' };
    if (err.details !== undefined) body.details = err.details;
    if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
    if (!res.headersSent) res.status(status).json(body);
  };

  // With CACHE_TTL_SEC=0 launch links are treated as single-use: every request
  // gets its own job and its own link, never one fetched for someone else.
  const shareLinks = config.cacheTtlSec > 0;

  /** Cache, else queue + wait. Returns { playUrl, cache: 'HIT' | 'MISS' | 'OFF' }. */
  async function getPlayUrl(uuid) {
    const hit = shareLinks ? await cache.get(uuid) : null;
    if (hit) return { playUrl: hit.playUrl, cache: 'HIT' };

    if (isClosing()) throw new ApiError(503, 'Server is shutting down', undefined, { retryAfterSec: 5 });
    // BullMQ commands wait for a reconnect while Redis is down; never let a request hang on that.
    const queueCall = (fn) => withDeadline(fn(), 5_000, 'Redis did not answer within 5s')
      .catch((err) => { throw new ApiError(503, 'Queue unavailable', err.message, { retryAfterSec: 5 }); });
    const waiting = await queueCall(() => queue.getWaitingCount());
    if (waiting >= config.maxWaiting) {
      throw new ApiError(503, 'Too many requests queued, try again shortly', { waiting }, { retryAfterSec: 5 });
    }

    // Shared links: the same game at the same time -> the same job (BullMQ dedupes by id).
    // Single-use links: BullMQ assigns a unique id, so nothing is shared.
    const jobOpts = shareLinks ? { jobId: `play-${uuid.toLowerCase()}` } : {};
    for (let attempt = 0; ; attempt++) {
      const job = await queueCall(() => queue.add(JOB_PLAY, { uuid, shareable: shareLinks }, jobOpts));
      let result;
      try {
        result = await job.waitUntilFinished(events, config.requestTimeoutMs);
      } catch (err) {
        // The job may have finished and been cleaned up before we started listening.
        const late = shareLinks ? await cache.get(uuid) : null;
        if (late) return { playUrl: late.playUrl, cache: 'HIT' };
        if (/timed out/i.test(err.message)) {
          throw new ApiError(504, 'Timed out waiting for a worker',
            shareLinks
              ? 'The request is still being processed; retry shortly and it will be answered from cache.'
              : 'The queue is busy; retry shortly.',
            { retryAfterSec: 5 });
        }
        if (isClosing()) throw new ApiError(503, 'Server is shutting down', undefined, { retryAfterSec: 5 });
        if (attempt === 0) continue; // job vanished (e.g. cleaned up after a failure): enqueue once more
        throw new ApiError(502, 'Worker failed while handling the request', err.message);
      }
      if (!result || typeof result !== 'object') throw new ApiError(502, 'Worker returned no result');
      if (!result.ok) {
        throw new ApiError(result.status || 502, result.error || 'Worker failed', result.details,
          { retryAfterSec: result.retryAfterSec });
      }
      return { playUrl: result.playUrl, cache: shareLinks ? 'MISS' : 'OFF' };
    }
  }

  // Simultaneous deep health checks share one in-flight session check; a later
  // call always starts a fresh one (never a cached result).
  let sessionCheck = null;
  function checkSessions() {
    sessionCheck ??= queue.add(JOB_CHECK_SESSIONS, {})
      .then((job) => job.waitUntilFinished(events, config.requestTimeoutMs))
      .finally(() => { sessionCheck = null; });
    return sessionCheck;
  }

  app.get('/play/:uuid', async (req, res) => {
    const uuid = String(req.params.uuid || '').trim();
    if (!UUID_RE.test(uuid)) {
      return sendError(res, new ApiError(400, 'Invalid game UUID', 'Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'));
    }
    try {
      const { playUrl, cache: cacheState } = await getPlayUrl(uuid);
      res.set('X-Cache', cacheState).json({ success: true, playUrl });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status >= 500) log(`FAIL ${uuid}: ${err.message}`);
      sendError(res, err);
    }
  });

  app.get('/health', async (req, res) => {
    const out = { ok: true, cache: cache.stats() };
    try {
      out.queue = await withDeadline(queue.getJobCounts('waiting', 'active', 'delayed', 'failed'), 3_000, 'Redis did not answer within 3s');
      out.redis = 'ok';
    } catch (err) {
      out.ok = false;
      out.redis = 'down';
      out.error = err.message;
    }
    if (out.ok) {
      out.workers = await queue.getWorkersCount().catch(() => null); // null: Redis doesn't allow CLIENT LIST
      if (out.workers === 0) {
        out.ok = false;
        out.error = 'No queue workers running – start queue-worker.js';
      }
    }
    if (out.ok && req.query.deep !== undefined) {
      try {
        const result = await checkSessions();
        out.sessions = result.sessions;
        out.loggedIn = result.sessions.some((s) => s.loggedIn === true);
        out.ok = out.loggedIn;
        if (!out.ok) out.error = 'No Narobet session is logged in';
      } catch (err) {
        out.ok = false;
        out.error = err.message;
      }
    }
    res.status(out.ok ? 200 : 503).json(out);
  });

  app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => sendError(res, err));
  return app;
}

if (isMainModule(import.meta.url)) {
  const config = loadConfig();
  let started;
  try {
    started = await startServer(config, { log: stampLog });
  } catch (err) {
    stampLog(`Failed to start: ${err.message}`);
    process.exit(1);
  }
  stampLog(`mr-y Casino API running on ${started.url}  (GET /play/:uuid, GET /health?deep) – `
    + `queue "${config.queueName}" on ${redactUrl(config.redisUrl)}`);
  handleShutdown(started.close, { log: stampLog, forceAfterMs: config.shutdownGraceMs + 5_000 });
}
