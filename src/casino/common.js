/**
 * Small helpers shared by the API server, the queue worker and their modules.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Error carrying the HTTP status we should answer with. */
export class ApiError extends Error {
  constructor(status, message, details, { retryable = false, authFailure = false, retryAfterSec } = {}) {
    super(message);
    this.status = status;
    this.details = details;
    this.retryable = retryable;
    this.authFailure = authFailure; // upstream said this session is not logged in
    this.retryAfterSec = retryAfterSec;
  }
}

/** Plain, JSON-safe form of an error, used as a job's return value. */
export function toErrorResult(err) {
  if (err instanceof ApiError) {
    return { ok: false, status: err.status, error: err.message, details: err.details, retryAfterSec: err.retryAfterSec };
  }
  return { ok: false, status: 500, error: 'Internal worker error', details: err?.message || String(err) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(504, `${what} timed out after ${ms}ms`, undefined, { retryable: true })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Like withTimeout, but rejects with a plain Error carrying `message` (for startup steps). */
export function withDeadline(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Puppeteer errors that mean "the page/browser is gone, rebuild and retry". */
export function isDeadPageError(err) {
  return /Target closed|Session closed|detached Frame|Execution context was destroyed|Protocol error|Connection closed|browser has disconnected|Navigating frame was detached|context.*(closed|disposed)/i
    .test(err?.message || '');
}

export function pickPlayUrl(data) {
  if (!data || typeof data !== 'object') return null;
  return data.url || data.game_uri || data.launch_url || data.gameUrl || data.launchUrl || null;
}

/** True when the given module is the process entry point (plain `node x.js` or pm2). */
export function isMainModule(metaUrl) {
  const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const self = norm(fileURLToPath(metaUrl));
  return [process.argv[1], process.env.pm_exec_path]
    .filter(Boolean)
    .some((p) => norm(path.resolve(p)) === self);
}

/** Timestamped console logger used by the entry points. */
export const stampLog = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

/**
 * Wires SIGINT/SIGTERM (and pm2's Windows 'shutdown' message) to `close`, with a
 * hard exit if closing takes longer than `forceAfterMs`.
 */
export function handleShutdown(close, { log = stampLog, forceAfterMs = 10_000 } = {}) {
  let stopping = false;
  async function shutdown(reason, code = 0) {
    if (stopping) return;
    stopping = true;
    log(`${reason} received, shutting down…`);
    const force = setTimeout(() => { log('Shutdown timed out, forcing exit.'); process.exit(1); }, forceAfterMs);
    force.unref();
    try {
      await close();
    } catch (err) {
      log(`Shutdown error: ${err.message}`);
      code = 1;
    }
    clearTimeout(force);
    process.exit(code);
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // pm2 on Windows sends a 'shutdown' message instead of a signal.
  process.on('message', (msg) => { if (msg === 'shutdown') shutdown('shutdown'); });
  // Never let a stray rejection kill the process; log it and keep serving.
  process.on('unhandledRejection', (err) => log(`Unhandled rejection: ${err?.stack || err}`));
  // After an uncaught exception state is unknown: close cleanly and exit so pm2 restarts us.
  process.on('uncaughtException', (err) => { log(`Uncaught exception: ${err?.stack || err}`); shutdown('uncaughtException', 1); });
  return shutdown;
}
