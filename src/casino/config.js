/**
 * Settings for the casino API (server.js) and its queue worker (queue-worker.js).
 * Every value can be overridden with the env var named next to it.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const JOB_PLAY = 'play';
export const JOB_CHECK_SESSIONS = 'check-sessions';

export const DEFAULTS = Object.freeze({
  // HTTP API
  host: '127.0.0.1',                 // HOST
  port: 3200,                        // PORT
  requestTimeoutMs: 45_000,          // REQUEST_TIMEOUT_MS  how long a request waits for its job
  maxWaiting: 2_000,                 // MAX_WAITING         answer 503 once this many jobs are queued
  shutdownGraceMs: 8_000,            // SHUTDOWN_GRACE_MS   time in-flight requests get on shutdown
  listenBacklog: 4_096,              // LISTEN_BACKLOG      pending TCP connections before refusing

  // Redis, queue and cache
  redisUrl: 'redis://127.0.0.1:6379', // REDIS_URL
  prefix: 'mr-y',                    // REDIS_PREFIX        namespaces every key (queue + cache)
  queueName: 'casino-play',          // QUEUE_NAME
  cacheTtlSec: 240,                  // CACHE_TTL_SEC       launch URLs are reused for 4 minutes;
                                     //                     0 = single-use links: one fresh link per request
  concurrency: 5,                    // WORKER_CONCURRENCY  jobs in flight per worker process
  globalConcurrency: 5,              // GLOBAL_CONCURRENCY  jobs in flight across ALL workers (0 = no cap)
  rateLimitMax: 0,                   // RATE_LIMIT_MAX      max jobs started per window, all workers (0 = off)
  rateLimitWindowMs: 1_000,          // RATE_LIMIT_WINDOW_MS

  // Narobet
  baseUrl: 'https://narobet.bet',    // NAROBET_URL
  sessionPath: '/games',             // SESSION_PATH        page opened before calling the API
  initPath: '/api/games/abcdabra/init',
  sessionsFile: path.join(ROOT, 'sessions.json'), // SESSIONS_FILE
  sessionStrategy: 'round-robin',    // SESSION_STRATEGY    round-robin | random
  sessionCooldownMs: 5 * 60_000,     // SESSION_COOLDOWN_MS how long a rejected session sits out
  sessionReloadCheckMs: 5_000,       //                     how often sessions.json is checked for edits

  // Browser
  executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', // CHROME_PATH
  headless: true,                    // HEADLESS=false shows the window
  blockResources: true,              // BLOCK_RESOURCES=false loads images/scripts/css too
  navTimeoutMs: 30_000,
  upstreamTimeoutMs: 15_000,         // UPSTREAM_TIMEOUT_MS one Narobet API call
  attemptTimeoutMs: 40_000,          //                     one whole attempt (context + page + call)
  retries: 2,                        // RETRIES             extra attempts on transient failures
  retryBaseMs: 500,
});

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === '' ? d : !/^(0|false|no|off)$/i.test(v));

/** DEFAULTS with env overrides applied. */
export function loadConfig(env = process.env) {
  const d = DEFAULTS;
  return {
    ...d,
    host: env.HOST || d.host,
    port: num(env.PORT, d.port),
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, d.requestTimeoutMs),
    maxWaiting: num(env.MAX_WAITING, d.maxWaiting),
    shutdownGraceMs: num(env.SHUTDOWN_GRACE_MS, d.shutdownGraceMs),
    listenBacklog: num(env.LISTEN_BACKLOG, d.listenBacklog),
    redisUrl: env.REDIS_URL || d.redisUrl,
    prefix: env.REDIS_PREFIX || d.prefix,
    queueName: env.QUEUE_NAME || d.queueName,
    cacheTtlSec: num(env.CACHE_TTL_SEC, d.cacheTtlSec),
    concurrency: num(env.WORKER_CONCURRENCY, d.concurrency),
    globalConcurrency: num(env.GLOBAL_CONCURRENCY, d.globalConcurrency),
    rateLimitMax: num(env.RATE_LIMIT_MAX, d.rateLimitMax),
    rateLimitWindowMs: num(env.RATE_LIMIT_WINDOW_MS, d.rateLimitWindowMs),
    baseUrl: env.NAROBET_URL || d.baseUrl,
    sessionPath: env.SESSION_PATH || d.sessionPath,
    sessionsFile: env.SESSIONS_FILE ? path.resolve(env.SESSIONS_FILE) : d.sessionsFile,
    sessionStrategy: env.SESSION_STRATEGY || d.sessionStrategy,
    sessionCooldownMs: num(env.SESSION_COOLDOWN_MS, d.sessionCooldownMs),
    executablePath: env.CHROME_PATH || d.executablePath,
    headless: bool(env.HEADLESS, d.headless),
    blockResources: bool(env.BLOCK_RESOURCES, d.blockResources),
    upstreamTimeoutMs: num(env.UPSTREAM_TIMEOUT_MS, d.upstreamTimeoutMs),
    retries: num(env.RETRIES, d.retries),
  };
}

/** Turns redis://[user:pass@]host[:port][/db] into ioredis / BullMQ connection options. */
export function redisOptions(url) {
  const u = new URL(url);
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') {
    throw new Error(`REDIS_URL must start with redis:// or rediss:// (got "${redactUrl(url)}")`);
  }
  const opts = {
    host: u.hostname || '127.0.0.1',
    port: Number(u.port) || 6379,
    db: Number(u.pathname.slice(1)) || 0,
  };
  if (u.username) opts.username = decodeURIComponent(u.username);
  if (u.password) opts.password = decodeURIComponent(u.password);
  if (u.protocol === 'rediss:') opts.tls = {};
  return opts;
}

/** URL with any password masked, safe for logs. */
export function redactUrl(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.href;
  } catch {
    return '<invalid url>';
  }
}
