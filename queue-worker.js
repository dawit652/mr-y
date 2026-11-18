/**
 * queue-worker.js – mr-y casino worker
 * ---------------------------------------------------------------------------
 * Consumes jobs from the BullMQ queue that server.js fills:
 *
 *   play            { uuid } -> { ok, playUrl, sessionId } | { ok: false, status, error, details }
 *   check-sessions  {}       -> { ok, sessions: [{ id, loggedIn }] }   (used by /health?deep)
 *
 * Each play job: Redis cache -> pick a session (SessionManager) -> that
 * account's warm incognito page in the shared Chrome (BrowserPool) -> one
 * Narobet init call. Accounts never share a context; jobs for the same
 * account share its page (CONTEXT_MODE=job gives every job a fresh context
 * instead, which is about 6x slower). Transient failures are retried with
 * backoff; a session Narobet rejects is benched, its page dropped, and the job
 * moves on to another account. Successes are cached (unless the API asked for
 * single-use links) so repeat requests in the next 4 minutes skip Narobet.
 *
 * Expected failures are returned as { ok: false, … } rather than thrown, so
 * server.js can answer with the right HTTP status. Every result carries
 * durationMs, which the API uses to estimate how much work fits in its timeout.
 *
 *   node queue-worker.js     (needs Redis and sessions.json; env vars: src/casino/config.js)
 */

import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { BrowserPool } from './src/casino/browser-pool.js';
import { CacheManager } from './src/casino/cache-manager.js';
import { ApiError, handleShutdown, isMainModule, sleep, stampLog, toErrorResult, withDeadline } from './src/casino/common.js';
import { JOB_CHECK_SESSIONS, JOB_PLAY, loadConfig, redactUrl, redisOptions } from './src/casino/config.js';
import { checkLogin, openSessionPage, requestPlayUrl } from './src/casino/narobet.js';
import { SessionManager } from './src/casino/session-manager.js';

/** Starts a worker; resolves to { worker, pool, sessions, cache, close }. */
export async function startWorker(config = loadConfig(), { log = console.log } = {}) {
  const sessions = new SessionManager({
    file: config.sessionsFile,
    baseUrl: config.baseUrl,
    strategy: config.sessionStrategy,
    cooldownMs: config.sessionCooldownMs,
    reloadCheckMs: config.sessionReloadCheckMs,
  }, { log });
  sessions.load(); // fail fast on a missing or invalid sessions.json

  const connection = redisOptions(config.redisUrl);
  const redis = new Redis({ ...connection, lazyConnect: true, maxRetriesPerRequest: 1, commandTimeout: 2_000 });
  redis.on('error', () => {}); // reconnects on its own; failed commands surface where they're used
  try {
    await withDeadline(redis.connect(), 10_000, 'no answer within 10s');
  } catch (err) {
    redis.disconnect();
    throw new Error(`Cannot reach Redis at ${redactUrl(config.redisUrl)}: ${err.message}`);
  }
  const cache = new CacheManager(redis, { prefix: config.prefix, ttlSec: config.cacheTtlSec, log });
  const pool = new BrowserPool({
    executablePath: config.executablePath,
    headless: config.headless,
    maxContexts: config.concurrency,
    pageMaxAgeMs: config.pageMaxAgeMs,
  }, { log });

  /**
   * Runs `fn(page)` with a Narobet page logged in as `session`: the account's
   * warm page (CONTEXT_MODE=session) or a fresh incognito context (job).
   */
  const withNarobetPage = (session, fn) => (config.contextMode === 'job'
    ? pool.withContext(async (context) => fn(await openSessionPage(context, session, config)),
      { timeoutMs: config.attemptTimeoutMs })
    : pool.withSessionPage(session.id, session.version, (context) => openSessionPage(context, session, config), fn,
      { timeoutMs: config.attemptTimeoutMs }));

  /** Benches a session Narobet rejected and drops its warm page. */
  const benchSession = (id, reason) => {
    sessions.markFailed(id, reason);
    pool.retirePage(id);
  };

  // Limits stored on the queue apply to every worker process, so running more
  // workers adds capacity for retries/cache but never more load on Narobet.
  // Same event-history length as the API (every Queue instance stores it in Redis).
  const admin = new Queue(config.queueName, { connection, prefix: config.prefix, streams: { events: { maxLen: config.eventsMaxLen } } });
  admin.on('error', () => {});
  try {
    await withDeadline((async () => {
      if (config.globalConcurrency > 0) await admin.setGlobalConcurrency(config.globalConcurrency);
      else await admin.removeGlobalConcurrency();
      if (config.rateLimitMax > 0) await admin.setGlobalRateLimit(config.rateLimitMax, config.rateLimitWindowMs);
      else await admin.removeGlobalRateLimit();
    })(), 10_000, 'Could not store queue limits in Redis');
  } catch (err) {
    redis.disconnect();
    throw err;
  } finally {
    await withDeadline(admin.close(), 3_000, 'admin close').catch(() => {});
  }

  let closing = false;

  /** Gets a launch URL, rotating sessions on auth failures and retrying transient errors. */
  async function fetchPlayUrl(uuid) {
    const tried = new Set();
    let switches = 0;
    for (let attempt = 0; ; attempt++) {
      const session = sessions.acquire(tried); // throws 401 once every session is benched
      tried.add(session.id);
      try {
        const playUrl = await withNarobetPage(session, (page) => requestPlayUrl(page, uuid, config));
        sessions.markOk(session.id);
        return { playUrl, sessionId: session.id };
      } catch (raw) {
        const err = raw instanceof ApiError ? raw : new ApiError(502, 'Internal browser error', raw.message, { retryable: true });
        if (err.authFailure) {
          benchSession(session.id, err.message);
          // Switching accounts doesn't use up a retry; bounded by the number of sessions.
          if (++switches > sessions.size || closing) throw err;
          attempt--;
          continue;
        }
        if (!err.retryable || attempt >= config.retries || closing) throw err;
        const delay = config.retryBaseMs * 2 ** attempt;
        log(`${uuid}: attempt ${attempt + 1} via ${session.id} failed (${err.message}); retrying in ${delay}ms…`);
        await sleep(delay);
      }
    }
  }

  async function processPlay(job) {
    const uuid = String(job.data?.uuid || '');
    // The API decides: single-use links (CACHE_TTL_SEC=0 there) must never come from, or go into, the cache.
    const shareable = job.data?.shareable !== false;
    const started = Date.now();
    // Another worker may have filled the cache while this job was queued.
    const cached = shareable ? await cache.get(uuid) : null;
    if (cached) {
      return { ok: true, playUrl: cached.playUrl, sessionId: cached.sessionId, fetchedAt: cached.fetchedAt, cached: true, durationMs: Date.now() - started };
    }
    try {
      const { playUrl, sessionId } = await fetchPlayUrl(uuid);
      const fetchedAt = Date.now();
      if (shareable) await cache.set(uuid, { playUrl, sessionId, fetchedAt });
      const durationMs = Date.now() - started;
      if (config.logJobs) log(`OK   ${uuid} via ${sessionId} (${durationMs}ms)`);
      // durationMs feeds the API's capacity estimate (how many queued jobs can finish in time).
      return { ok: true, playUrl, sessionId, fetchedAt, cached: false, durationMs };
    } catch (err) {
      const result = toErrorResult(err);
      const details = result.details === undefined ? '' : ` – ${typeof result.details === 'string' ? result.details : JSON.stringify(result.details)}`;
      log(`FAIL ${uuid} (${Date.now() - started}ms): ${result.error}${details}`);
      return { ...result, durationMs: Date.now() - started };
    }
  }

  /** Logs every session in and reports which ones Narobet still accepts. */
  async function processCheckSessions() {
    const results = await Promise.all(sessions.sessions.map(async (session) => {
      try {
        const loggedIn = await withNarobetPage(session, (page) => checkLogin(page, config));
        if (loggedIn === true) sessions.markOk(session.id);
        if (loggedIn === false) benchSession(session.id, 'Logged out (session check)');
        return { id: session.id, loggedIn };
      } catch (err) {
        return { id: session.id, loggedIn: null, error: err.message };
      }
    }));
    return { ok: true, sessions: results, checkedAt: new Date().toISOString() };
  }

  const worker = new Worker(config.queueName, async (job) => {
    if (job.name === JOB_PLAY) return processPlay(job);
    if (job.name === JOB_CHECK_SESSIONS) return processCheckSessions();
    return { ok: false, status: 400, error: `Unknown job type "${job.name}"` };
  }, {
    connection,
    prefix: config.prefix,
    concurrency: config.concurrency,
  });
  worker.on('error', (err) => log(`Worker error: ${err.message}`));
  worker.on('failed', (job, err) => log(`Job ${job?.id} crashed: ${err?.message}`));
  await worker.waitUntilReady();

  const close = async () => {
    if (closing) return;
    closing = true; // in-flight jobs stop retrying and finish quickly
    await worker.close(); // stops taking jobs, waits for active ones
    await pool.close();
    await redis.quit().catch(() => redis.disconnect());
  };

  return { worker, pool, sessions, cache, close };
}

if (isMainModule(import.meta.url)) {
  const config = loadConfig();
  let started;
  try {
    started = await startWorker(config, { log: stampLog });
  } catch (err) {
    stampLog(`Worker failed to start: ${err.message}`);
    process.exit(1);
  }
  stampLog(`mr-y casino worker ready: queue "${config.queueName}" on ${redactUrl(config.redisUrl)}, `
    + `${started.sessions.size} session(s), concurrency ${config.concurrency}`
    + `${config.globalConcurrency > 0 ? ` (global cap ${config.globalConcurrency})` : ''}`);
  handleShutdown(started.close, { log: stampLog, forceAfterMs: 25_000 });
}
