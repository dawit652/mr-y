/**
 * casino-api.js
 * ---------------------------------------------------------------------------
 * HTTP API that turns a Narobet game UUID into a playable launch URL by
 * calling Narobet's `/api/games/abcdabra/init` from inside a logged-in
 * Chrome profile (so the request carries the real session cookies).
 *
 * Reliability design:
 *  - ONE long-lived browser + session page, shared by all requests. Chrome
 *    locks its profile dir, so launching per request breaks as soon as two
 *    requests overlap ("The browser is already running for ...").
 *  - The browser/page are recreated automatically if Chrome crashes or the
 *    page dies; launches are de-duplicated so overlapping requests share one.
 *  - Every upstream call has a hard timeout; transient failures (network,
 *    5xx, 429, dead page) are retried with backoff.
 *  - 401/403 triggers one session-page reload (refreshes cookies) before
 *    reporting "not logged in".
 *  - A keep-alive pings the site periodically so the session doesn't idle out.
 */

import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';

export const API_DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 3200,
  baseUrl: 'https://narobet.bet',
  sessionPath: '/games',
  initPath: '/api/games/abcdabra/init',
  executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  userDataDir: 'C:\\Users\\dawit\\Desktop\\claude projects\\mr-y\\chrome-profile',
  headless: true,
  navTimeoutMs: 30_000,
  upstreamTimeoutMs: 15_000,
  requestTimeoutMs: 45_000,
  retries: 2,
  retryBaseMs: 500,
  maxConcurrent: 4,
  keepAliveMs: 10 * 60_000,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Error carrying the HTTP status we should answer with. */
export class ApiError extends Error {
  constructor(status, message, details, { retryable = false } = {}) {
    super(message);
    this.status = status;
    this.details = details;
    this.retryable = retryable;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new ApiError(504, `${what} timed out after ${ms}ms`, undefined, { retryable: true })), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Puppeteer errors that mean "the page/browser is gone, rebuild and retry". */
function isDeadPageError(err) {
  return /Target closed|Session closed|detached Frame|Execution context was destroyed|Protocol error|Connection closed|browser has disconnected|Navigating frame was detached/i
    .test(err?.message || '');
}

function pickPlayUrl(data) {
  if (!data || typeof data !== 'object') return null;
  return data.url || data.game_uri || data.launch_url || data.gameUrl || data.launchUrl || null;
}

/** Simple FIFO semaphore to cap concurrent upstream calls. */
function createLimiter(max) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= max || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}

/**
 * Owns the shared browser + session page.
 */
export class NarobetSession {
  constructor(opts = {}, { log = console.log } = {}) {
    this.opts = { ...API_DEFAULTS, ...opts };
    this.log = log;
    this.browser = null;
    this.page = null;
    this.ready = null; // in-flight launch promise (de-duplicates launches)
    this.closing = false;
    this.lastOkAt = null;
    this.lastError = null;
    this.launches = 0;
    this.keepAliveTimer = null;
  }

  /** Returns a usable session page, launching/rebuilding as needed. */
  async getPage() {
    if (this.closing) throw new ApiError(503, 'Server is shutting down');
    if (this.page && !this.page.isClosed() && this.browser?.connected) return this.page;
    if (!this.ready) {
      this.ready = this.#start().finally(() => { this.ready = null; });
    }
    return this.ready;
  }

  async #start() {
    const o = this.opts;
    if (!this.browser?.connected) {
      this.browser = null;
      this.log(`Launching Chrome (profile: ${o.userDataDir})…`);
      try {
        this.browser = await puppeteer.launch({
          headless: o.headless,
          executablePath: o.executablePath || undefined,
          userDataDir: o.userDataDir,
          args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage'],
        });
      } catch (err) {
        if (/already running/i.test(err.message)) {
          throw new ApiError(503, 'Chrome profile is locked by another Chrome window',
            'Close any Chrome opened with chrome-profile (e.g. play-game.js / intercept-init.js) and retry.',
            { retryable: false });
        }
        throw new ApiError(503, 'Failed to launch Chrome', err.message, { retryable: true });
      }
      this.launches++;
      const b = this.browser;
      b.on('disconnected', () => {
        if (this.browser === b) {
          this.log('Chrome disconnected; will relaunch on next request.');
          this.browser = null;
          this.page = null;
        }
      });
    }

    const page = await this.browser.newPage();
    page.setDefaultTimeout(o.navTimeoutMs);
    page.on('error', (err) => { this.log(`Session page crashed: ${err.message}`); if (this.page === page) this.page = null; });
    page.on('close', () => { if (this.page === page) this.page = null; });
    // Close any stray tabs (e.g. the initial about:blank) to save memory.
    for (const p of await this.browser.pages()) if (p !== page) await p.close().catch(() => {});

    await this.#navigate(page);
    this.page = page;
    this.#startKeepAlive();
    return page;
  }

  async #navigate(page) {
    const url = new URL(this.opts.sessionPath, this.opts.baseUrl).href;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.opts.navTimeoutMs });
    } catch (err) {
      throw new ApiError(502, `Could not load ${url}`, err.message, { retryable: true });
    }
  }

  /** Reload the session page (refreshes cookies / recovers from bad state). */
  async refresh() {
    const page = await this.getPage();
    await this.#navigate(page);
  }

  /** Run fetch() inside the logged-in page. Returns { status, text }. */
  async #fetchInPage(path, init) {
    const page = await this.getPage();
    const timeoutMs = this.opts.upstreamTimeoutMs;
    const call = page.evaluate(async (path, init, timeoutMs) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(path, { ...init, credentials: 'include', signal: ctrl.signal });
        return { status: r.status, text: await r.text() };
      } catch (e) {
        return { status: 0, text: '', error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
      } finally {
        clearTimeout(t);
      }
    }, path, init, timeoutMs);
    // Outer guard in case evaluate itself hangs (frozen page).
    return withTimeout(call, timeoutMs + 5_000, 'Upstream request');
  }

  /** One attempt at the init call; throws ApiError on failure. */
  async #initOnce(gameUuid) {
    const res = await this.#fetchInPage(this.opts.initPath, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ gameUuid }),
    });

    if (res.status === 0) {
      throw new ApiError(504, 'Upstream request failed', res.error, { retryable: true });
    }
    let data = null;
    try { data = JSON.parse(res.text); } catch { /* non-JSON body */ }

    if (res.status === 401 || res.status === 403) {
      throw new ApiError(401, 'Not logged in to Narobet',
        'Session expired. Run `node play-game.js`, log in in the Chrome window, then retry.',
        { retryable: false });
    }
    if (res.status === 429 || res.status >= 500) {
      throw new ApiError(502, `Narobet returned HTTP ${res.status}`, data ?? res.text.slice(0, 300), { retryable: true });
    }
    if (res.status >= 400) {
      throw new ApiError(res.status === 404 ? 404 : 502, `Narobet rejected the request (HTTP ${res.status})`,
        data ?? res.text.slice(0, 300), { retryable: false });
    }
    const playUrl = pickPlayUrl(data);
    if (!playUrl) {
      throw new ApiError(502, 'No launch URL in Narobet response', data ?? res.text.slice(0, 300), { retryable: false });
    }
    return playUrl;
  }

  /** Init with retries, session refresh on 401 and page rebuild on crashes. */
  async getPlayUrl(gameUuid) {
    const { retries, retryBaseMs } = this.opts;
    let refreshedForAuth = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const url = await this.#initOnce(gameUuid);
        this.lastOkAt = new Date().toISOString();
        this.lastError = null;
        return url;
      } catch (raw) {
        let err = raw;
        if (!(err instanceof ApiError)) {
          const dead = isDeadPageError(err);
          if (dead && this.page) { await this.page.close().catch(() => {}); this.page = null; }
          err = new ApiError(502, dead ? 'Browser page died' : 'Internal browser error', raw.message, { retryable: true });
        }
        this.lastError = { at: new Date().toISOString(), message: err.message, details: err.details };

        // One cookie refresh on auth failure, without consuming a retry.
        if (err.status === 401 && !refreshedForAuth) {
          refreshedForAuth = true;
          this.log('Got 401/403 – reloading session page and retrying once…');
          try { await this.refresh(); } catch { /* fall through to retry */ }
          attempt--;
          continue;
        }
        if (!err.retryable || attempt >= retries || this.closing) throw err;
        const delay = retryBaseMs * 2 ** attempt;
        this.log(`Attempt ${attempt + 1} failed (${err.message}); retrying in ${delay}ms…`);
        await sleep(delay);
      }
    }
  }

  /** Best-effort login check via next-auth's session endpoint. */
  async checkLogin() {
    try {
      const res = await this.#fetchInPage('/api/auth/session', { method: 'GET' });
      if (res.status !== 200) return null;
      const data = JSON.parse(res.text);
      return Boolean(data && data.user);
    } catch {
      return null;
    }
  }

  #startKeepAlive() {
    if (this.keepAliveTimer || !this.opts.keepAliveMs) return;
    this.keepAliveTimer = setInterval(async () => {
      if (this.closing) return;
      try {
        await this.refresh();
        const loggedIn = await this.checkLogin();
        if (loggedIn === false) this.log('Keep-alive: Narobet session is LOGGED OUT – game launches will fail.');
      } catch (err) {
        this.log(`Keep-alive failed: ${err.message}`);
      }
    }, this.opts.keepAliveMs);
    this.keepAliveTimer.unref();
  }

  status() {
    return {
      browser: this.browser?.connected ? 'connected' : 'stopped',
      page: this.page && !this.page.isClosed() ? 'open' : 'none',
      launches: this.launches,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
    };
  }

  async close() {
    this.closing = true;
    clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
    await this.ready?.catch(() => {});
    const b = this.browser;
    this.browser = null;
    this.page = null;
    if (b) await b.close().catch(() => {});
  }
}

/** Builds the Express app around a NarobetSession. */
export function createApp(session, { requestTimeoutMs = API_DEFAULTS.requestTimeoutMs, maxConcurrent = API_DEFAULTS.maxConcurrent, log = console.log } = {}) {
  const app = express();
  const limit = createLimiter(maxConcurrent);
  app.use(cors());

  const sendError = (res, err) => {
    const status = err instanceof ApiError ? err.status : 500;
    const body = { success: false, error: err.message || 'Internal Server Error' };
    if (err.details !== undefined) body.details = err.details;
    if (!res.headersSent) res.status(status).json(body);
  };

  app.get('/health', async (req, res) => {
    const out = { ok: true, ...session.status() };
    if (req.query.deep !== undefined) {
      try {
        await withTimeout(session.getPage(), requestTimeoutMs, 'Browser start');
        out.loggedIn = await session.checkLogin();
        out.browser = session.status().browser;
        out.ok = out.loggedIn !== false;
      } catch (err) {
        out.ok = false;
        out.error = err.message;
      }
    }
    res.status(out.ok ? 200 : 503).json(out);
  });

  app.get('/play/:uuid', async (req, res) => {
    const uuid = String(req.params.uuid || '').trim();
    if (!UUID_RE.test(uuid)) {
      return sendError(res, new ApiError(400, 'Invalid game UUID', 'Expected format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'));
    }
    const started = Date.now();
    try {
      const playUrl = await withTimeout(limit(() => session.getPlayUrl(uuid)), requestTimeoutMs, 'Request');
      log(`OK   ${uuid} (${Date.now() - started}ms)`);
      res.json({ success: true, playUrl });
    } catch (err) {
      log(`FAIL ${uuid} (${Date.now() - started}ms): ${err.message}${err.details ? ` – ${typeof err.details === 'string' ? err.details : JSON.stringify(err.details)}` : ''}`);
      sendError(res, err);
    }
  });

  app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => sendError(res, err));
  return app;
}

/** Starts the server; resolves to { server, session, url, close }. */
export async function startServer(opts = {}, { log = console.log, warm = true } = {}) {
  const o = { ...API_DEFAULTS, ...opts };
  const session = new NarobetSession(o, { log });
  const app = createApp(session, { requestTimeoutMs: o.requestTimeoutMs, maxConcurrent: o.maxConcurrent, log });

  const server = await new Promise((resolve, reject) => {
    const s = app.listen(o.port, o.host, () => resolve(s));
    s.on('error', reject);
  });
  const { port } = server.address();
  const url = `http://${o.host}:${port}`;

  // Warm up the browser in the background so the first request is fast.
  if (warm) session.getPage().catch((err) => log(`Warm-up failed: ${err.message}${err.details ? ` – ${err.details}` : ''}`));

  const close = async () => {
    const closed = new Promise((r) => server.close(() => r()));
    server.closeIdleConnections?.(); // in-flight requests are allowed to finish
    await closed;
    await session.close();
  };
  return { server, session, url, close };
}
