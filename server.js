/**
 * server.js – mr-y Casino API
 * ---------------------------------------------------------------------------
 *   GET /play/:uuid   -> { success, playUrl }      (X-Cache: HIT | MISS | OFF)
 *   GET /health       -> Redis, queue, worker and capacity status
 *   GET /health?deep  -> also asks a worker to check every Narobet session
 *
 * Request path: cache (this process's memory, then Redis; launch URLs are
 * reused for 4 minutes) -> on a miss, a BullMQ `play` job run by
 * queue-worker.js. Requests for the same game at the same time share one
 * lookup and one job. With CACHE_TTL_SEC=0 links are single-use: no cache, no
 * sharing, one job per request. The API never starts Chrome.
 *
 * Admission control: workers report how long jobs take, so the API knows how
 * many queued jobs can still finish within REQUEST_TIMEOUT_MS. Past that a
 * request is not queued: it gets 503 at once, with a Retry-After that says
 * when there will be room. Admitted requests stay fast, and a burst of
 * thousands is shed cheaply instead of piling up. MAX_WAITING is a hard cap on
 * top. A request that still waits longer than REQUEST_TIMEOUT_MS gets 504; its
 * job keeps running (with caching on, a retry is then a cache hit).
 *
 *   node server.js           (needs Redis; start queue-worker.js too; env vars: src/casino/config.js)
 */

import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Queue, QueueEvents } from 'bullmq';
import { Redis } from 'ioredis';
import { CacheManager } from './src/casino/cache-manager.js';
import { CapacityEstimator } from './src/casino/capacity.js';
import { ApiError, UUID_RE, handleShutdown, isMainModule, stampLog, withDeadline } from './src/casino/common.js';
import { JOB_CHECK_SESSIONS, JOB_PLAY, loadConfig, redactUrl, redisOptions } from './src/casino/config.js';

const JOB_TRACK_CEILING_MS = 10 * 60_000; // an admitted job is tracked at most this long
const PLAY_PATH = /^\/play\/([^/?#]*)\/?(?:[?#].*)?$/;

/** Starts the API; resolves to { server, url, queue, cache, launcher, close }. */
export async function startServer(config = loadConfig(), { log = console.log } = {}) {
  const connection = redisOptions(config.redisUrl);
  const redis = new Redis({ ...connection, lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 2_000 });
  redis.on('error', () => {}); // reconnects on its own; failed commands surface where they're used
  const queue = new Queue(config.queueName, {
    connection,
    prefix: config.prefix,
    streams: { events: { maxLen: config.eventsMaxLen } },
    defaultJobOptions: {
      attempts: 1, // the worker retries internally (with session rotation)
      // Finished jobs linger briefly so near-simultaneous requests can join them;
      // after that the cache answers.
      removeOnComplete: { age: 5 },
      removeOnFail: { age: 5 },
    },
  });
  const events = new QueueEvents(config.queueName, { connection, prefix: config.prefix });
  // Every job being waited on adds listeners to both (BullMQ's waitUntilFinished),
  // so thousands of them are normal under load, not a leak.
  queue.setMaxListeners(0);
  events.setMaxListeners(0);
  queue.on('error', (err) => log(`Queue error: ${err.message}`));
  events.on('error', (err) => log(`Queue events error: ${err.message}`));
  const cache = new CacheManager(redis, {
    prefix: config.prefix, ttlSec: config.cacheTtlSec, memoryEntries: config.memoryCacheEntries, log,
  });

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
  const launcher = createLauncher({ config, queue, events, cache, isClosing: () => closing });
  const handlePlay = createPlayHandler({ launcher, log });
  const app = createApp({ config, queue, events, cache, launcher, handlePlay, log });

  const server = http.createServer((req, res) => {
    // Hot path: GET /play/:uuid skips Express's router and middleware. During a
    // big burst every bit of event-loop time counts, because new connections
    // are only accepted while the loop is free.
    if (req.method === 'GET') {
      const m = PLAY_PATH.exec(req.url);
      if (m) return handlePlay(req, res, m[1]);
    }
    return app(req, res);
  });
  server.keepAliveTimeout = config.keepAliveTimeoutMs;
  server.headersTimeout = Math.max(server.headersTimeout, config.keepAliveTimeoutMs + 1_000);
  server.maxConnections = config.maxConnections; // beyond this, new sockets are dropped instead of exhausting memory
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

  return { server, url, queue, cache, launcher, close };
}

/**
 * Turns "launch URL for game X" into cache lookups and queued jobs, with
 * request sharing and admission control (see the file header).
 */
export function createLauncher({ config, queue, events, cache, isClosing = () => false }) {
  const shareLinks = config.cacheTtlSec > 0;
  const capacity = new CapacityEstimator({
    slots: config.globalConcurrency > 0 ? config.globalConcurrency : config.concurrency,
    timeoutMs: config.requestTimeoutMs,
    safety: config.capacitySafety,
    initialJobMs: config.initialJobMs,
  });
  // Workers report each job's duration; answers served from cache say nothing about Narobet's speed.
  events.on('completed', ({ returnvalue }) => {
    if (returnvalue && typeof returnvalue === 'object' && returnvalue.cached !== true) capacity.record(returnvalue.durationMs);
  });

  let ownJobs = 0;      // jobs this process queued that have not finished yet
  let otherJobs = 0;    // other API processes' jobs, refreshed from Redis
  let otherJobsAt = 0;
  const pending = new Map(); // shared links: game -> its in-flight lookup
  const stats = { served: 0, shed: 0, timedOut: 0, joined: 0 };

  const queueCall = (fn) => withDeadline(fn(), 5_000, 'Redis did not answer within 5s')
    .catch((err) => { throw new ApiError(503, 'Queue unavailable', err.message, { retryAfterSec: 5 }); });

  async function refreshOtherJobs() {
    if (Date.now() - otherJobsAt < 500) return;
    otherJobsAt = Date.now();
    try {
      const c = await withDeadline(queue.getJobCounts('waiting', 'active', 'prioritized'), 2_000, 'job counts');
      otherJobs = Math.max(0, (c.waiting || 0) + (c.active || 0) + (c.prioritized || 0) - ownJobs);
    } catch { /* keep the last estimate */ }
  }

  /** Queues one job; resolves to { playUrl, cache } when it finishes, or throws an ApiError. */
  function runJob(uuid) {
    ownJobs++; // synchronously, right after the admission check
    const done = (async () => {
      const jobOpts = shareLinks ? { jobId: `play-${uuid.toLowerCase()}` } : {};
      for (let attempt = 0; ; attempt++) {
        const job = await queueCall(() => queue.add(JOB_PLAY, { uuid, shareable: shareLinks }, jobOpts));
        let result;
        try {
          result = await job.waitUntilFinished(events, JOB_TRACK_CEILING_MS);
        } catch (err) {
          // The job may have finished and been cleaned up before we started listening.
          const late = shareLinks ? await cache.get(uuid) : null;
          if (late) return { playUrl: late.playUrl, cache: 'HIT' };
          if (isClosing()) throw new ApiError(503, 'Server is shutting down', undefined, { retryAfterSec: 5 });
          if (/timed out/i.test(err.message)) throw new ApiError(504, 'The job did not finish', err.message, { retryAfterSec: 5 });
          if (attempt === 0) continue; // job vanished (e.g. cleaned up after a failure): enqueue once more
          throw new ApiError(502, 'Worker failed while handling the request', err.message);
        }
        if (!result || typeof result !== 'object') throw new ApiError(502, 'Worker returned no result');
        if (!result.ok) {
          throw new ApiError(result.status || 502, result.error || 'Worker failed', result.details,
            { retryAfterSec: result.retryAfterSec });
        }
        if (shareLinks) cache.remember(uuid, result);
        return { playUrl: result.playUrl, cache: shareLinks ? 'MISS' : 'OFF' };
      }
    })();
    const finished = () => { ownJobs--; };
    done.then(finished, finished);
    return done;
  }

  /** Queues a job if it can finish in time; otherwise 503 with a Retry-After saying when there will be room. */
  async function admitAndRun(uuid) {
    if (isClosing()) throw new ApiError(503, 'Server is shutting down', undefined, { retryAfterSec: 5 });
    await refreshOtherJobs();
    // No await between this check and runJob(), so a burst cannot over-admit.
    const queued = ownJobs + otherJobs;
    const limit = Math.min(capacity.safeQueue(), config.maxWaiting);
    if (queued >= limit) {
      stats.shed++;
      capacity.noteShed();
      throw new ApiError(503, 'Busy: too many requests ahead of this one, try again shortly',
        { queued, limit }, { retryAfterSec: capacity.retryAfterSec(queued) });
    }
    return runJob(uuid);
  }

  /** One lookup per game at a time when links may be shared; one job per request when not. */
  function lookup(uuid) {
    if (!shareLinks) return admitAndRun(uuid);
    const id = uuid.toLowerCase();
    const existing = pending.get(id);
    if (existing) {
      stats.joined++;
      return existing;
    }
    const p = (async () => {
      const hit = await cache.get(uuid);
      if (hit) return { playUrl: hit.playUrl, cache: 'HIT' };
      return admitAndRun(uuid);
    })();
    pending.set(id, p);
    const clear = () => { if (pending.get(id) === p) pending.delete(id); };
    p.then(clear, clear);
    return p;
  }

  /** What one HTTP request awaits: the lookup, but never longer than REQUEST_TIMEOUT_MS. */
  async function getPlayUrl(uuid) {
    const mem = shareLinks ? cache.peek(uuid) : null;
    if (mem) {
      stats.served++;
      return { playUrl: mem.playUrl, cache: 'HIT' };
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(504, 'Timed out waiting for a worker',
        shareLinks
          ? 'The request is still being processed; retry shortly and it will be answered from cache.'
          : 'The queue is busy; retry shortly.',
        { retryAfterSec: capacity.retryAfterSec(ownJobs + otherJobs) })), config.requestTimeoutMs);
    });
    try {
      const result = await Promise.race([lookup(uuid), timeout]);
      stats.served++;
      return result;
    } catch (err) {
      if (err.status === 504) stats.timedOut++;
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  function status() {
    return {
      ...capacity.snapshot(),
      queued: ownJobs + otherJobs,
      limit: Math.min(capacity.safeQueue(), config.maxWaiting),
      shareLinks,
      pendingGames: pending.size,
      requests: { ...stats },
    };
  }

  return { getPlayUrl, status, capacity };
}

/**
 * Handles GET /play/:uuid with plain Node response calls (no Express), so the
 * hottest endpoint stays cheap. Same responses as the rest of the API, with
 * the CORS header the cors() middleware would add.
 */
export function createPlayHandler({ launcher, log = console.log }) {
  const send = (res, status, body, headers) => {
    if (res.headersSent) return;
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(json),
      'Access-Control-Allow-Origin': '*',
      ...headers,
    });
    res.end(json);
  };

  return async function handlePlay(req, res, rawUuid) {
    const uuid = String(rawUuid || '').trim();
    if (!UUID_RE.test(uuid)) {
      return send(res, 400, { success: false, error: 'Invalid game UUID', details: 'Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx' });
    }
    try {
      const { playUrl, cache: cacheState } = await launcher.getPlayUrl(uuid);
      send(res, 200, { success: true, playUrl }, { 'X-Cache': cacheState });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      // 503/504 under load are expected and counted in /health; log only real failures.
      if (status >= 500 && status !== 503 && status !== 504) log(`FAIL ${uuid}: ${err.message}`);
      const body = { success: false, error: err.message || 'Internal Server Error' };
      if (err.details !== undefined) body.details = err.details;
      send(res, status, body, err.retryAfterSec ? { 'Retry-After': String(err.retryAfterSec) } : {});
    }
  };
}

/** Builds the Express app (health checks, CORS preflight, 404s) around the launcher. */
export function createApp({ config, queue, events, cache, launcher, handlePlay, log = console.log }) {
  const app = express();
  app.use(cors());

  const sendError = (res, err) => {
    const status = err instanceof ApiError ? err.status : 500;
    const body = { success: false, error: err.message || 'Internal Server Error' };
    if (err.details !== undefined) body.details = err.details;
    if (err.retryAfterSec) res.set('Retry-After', String(err.retryAfterSec));
    if (!res.headersSent) res.status(status).json(body);
  };

  // Simultaneous deep health checks share one in-flight session check; a later
  // call always starts a fresh one (never a cached result).
  let sessionCheck = null;
  function checkSessions() {
    sessionCheck ??= queue.add(JOB_CHECK_SESSIONS, {})
      .then((job) => job.waitUntilFinished(events, config.requestTimeoutMs))
      .finally(() => { sessionCheck = null; });
    return sessionCheck;
  }

  // Normally answered by the fast path in startServer; kept so the app works on its own too.
  const play = handlePlay ?? createPlayHandler({ launcher, log });
  app.get('/play/:uuid', (req, res) => play(req, res, req.params.uuid));

  app.get('/health', async (req, res) => {
    const out = {
      ok: true,
      capacity: launcher.status(),
      cache: cache.stats(),
      memory: { rssMb: Math.round(process.memoryUsage().rss / 1048576) },
    };
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
    + `queue "${config.queueName}" on ${redactUrl(config.redisUrl)}, `
    + `${config.cacheTtlSec > 0 ? `links shared for ${config.cacheTtlSec}s` : 'single-use links (no cache)'}`);
  handleShutdown(started.close, { log: stampLog, forceAfterMs: config.shutdownGraceMs + 5_000 });
}
