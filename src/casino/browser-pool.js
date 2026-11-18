/**
 * browser-pool.js
 * ---------------------------------------------------------------------------
 * One shared Chrome process for the whole worker, used in one of two ways:
 *
 *  - withSessionPage(key, …): one long-lived incognito context + page per key
 *    (per Narobet account). Concurrent work for the same account shares that
 *    page, so a job is a single API call instead of context + page + page
 *    load. Accounts never share a context, so their cookies stay separate.
 *    The page is rebuilt when it dies, when the account's cookies change
 *    (`version`), or after `pageMaxAgeMs`.
 *  - withContext(…): a fresh incognito context for every unit of work,
 *    closed when the work settles.
 *
 * No userDataDir is used, so there is no profile lock to collide on.
 * Chrome is launched lazily and relaunched if it crashes; overlapping callers
 * share one launch. At most `maxContexts` units of work run at once.
 */

import puppeteer from 'puppeteer';
import { ApiError, isDeadPageError, sleep } from './common.js';

export class BrowserPool {
  constructor(opts = {}, { log = console.log } = {}) {
    this.opts = {
      headless: true, executablePath: undefined, maxContexts: 5, launchTimeoutMs: 30_000,
      pageMaxAgeMs: 30 * 60_000, args: [], ...opts,
    };
    this.log = log;
    this.browser = null;
    this.launching = null; // in-flight launch promise (de-duplicates launches)
    this.launches = 0;
    this.active = 0;       // units of work currently running
    this.waiters = [];     // callers waiting for a free slot
    this.pages = new Map(); // key -> warm page entry (withSessionPage)
    this.closing = false;
  }

  /**
   * Runs `fn(page)` on the warm page for `key`. `setup(context)` must return a
   * ready page; it runs when the key has no usable page yet. Errors thrown by
   * Puppeteer (anything that is not an ApiError) retire the page so the next
   * call rebuilds it; ApiErrors (e.g. an upstream HTTP error) leave it in use.
   */
  async withSessionPage(key, version, setup, fn, { timeoutMs = 0 } = {}) {
    await this.#acquire();
    let entry = null;
    let timer;
    let timedOut = false;
    try {
      if (this.closing) throw new ApiError(503, 'Browser pool is shutting down');
      entry = this.#pageEntry(key, version, setup);
      entry.active++;
      const work = entry.ready.then((page) => fn(page));
      if (!timeoutMs) return await work;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new ApiError(504, `Browser job timed out after ${timeoutMs}ms`, undefined, { retryable: true }));
        }, timeoutMs);
      });
      return await Promise.race([work, timeout]);
    } catch (err) {
      if (err instanceof ApiError) {
        if (timedOut && entry) this.#retire(entry); // a page that cannot finish a call in time is suspect
        throw err;
      }
      if (entry) this.#retire(entry);
      const dead = isDeadPageError(err);
      throw new ApiError(502, dead ? 'Browser page died' : 'Browser error', err.message, { retryable: true });
    } finally {
      clearTimeout(timer);
      if (entry) {
        entry.active--;
        if (entry.retired && entry.active === 0) this.#dispose(entry);
      }
      this.#release();
    }
  }

  /** Drops the warm page for `key` (e.g. its account was logged out); the next call rebuilds it. */
  retirePage(key) {
    const entry = this.pages.get(key);
    if (entry) this.#retire(entry);
  }

  #pageEntry(key, version, setup) {
    let entry = this.pages.get(key);
    const stale = entry && (entry.version !== version
      || Date.now() - entry.createdAt > this.opts.pageMaxAgeMs
      || (entry.page && entry.page.isClosed()));
    if (stale) {
      this.#retire(entry);
      entry = null;
    }
    if (entry) return entry;
    const e = { key, version, createdAt: Date.now(), active: 0, retired: false, context: null, page: null };
    e.ready = (async () => {
      const browser = await this.#getBrowser();
      const context = await browser.createBrowserContext();
      e.context = context;
      if (e.retired) throw new ApiError(503, 'Browser page was retired while opening', undefined, { retryable: true });
      const page = await setup(context);
      e.page = page;
      return page;
    })();
    // A failed setup is never reused: the next call starts over.
    e.ready.catch(() => this.#retire(e));
    this.pages.set(key, e);
    return e;
  }

  #retire(entry) {
    if (entry.retired) return;
    entry.retired = true;
    if (this.pages.get(entry.key) === entry) this.pages.delete(entry.key);
    if (entry.active === 0) this.#dispose(entry);
  }

  #dispose(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    // The context may still be opening; close it as soon as it exists.
    const closeCtx = (ctx) => ctx?.close().catch(() => {});
    if (entry.context) closeCtx(entry.context);
    else entry.ready.then((page) => closeCtx(page.browserContext()), () => closeCtx(entry.context));
  }

  /**
   * Runs `fn(context)` in a fresh incognito context and always disposes of it.
   * Puppeteer failures become retryable ApiErrors; ApiErrors from `fn` pass through.
   */
  async withContext(fn, { timeoutMs = 0 } = {}) {
    await this.#acquire();
    let context = null;
    let abandoned = false;
    const run = async () => {
      const browser = await this.#getBrowser();
      const ctx = await browser.createBrowserContext();
      if (abandoned) { await ctx.close().catch(() => {}); throw new ApiError(504, 'Browser job abandoned'); }
      context = ctx;
      return fn(ctx);
    };
    try {
      const work = run();
      if (!timeoutMs) return await work;
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          abandoned = true;
          reject(new ApiError(504, `Browser job timed out after ${timeoutMs}ms`, undefined, { retryable: true }));
        }, timeoutMs);
      });
      try {
        return await Promise.race([work, timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const dead = isDeadPageError(err);
      throw new ApiError(502, dead ? 'Browser page died' : 'Browser error', err.message, { retryable: true });
    } finally {
      if (context) await context.close().catch(() => {});
      this.#release();
    }
  }

  async #getBrowser() {
    if (this.closing) throw new ApiError(503, 'Browser pool is shutting down');
    if (this.browser?.connected) return this.browser;
    this.launching ??= this.#launch().finally(() => { this.launching = null; });
    return this.launching;
  }

  async #launch() {
    const o = this.opts;
    this.log('Launching Chrome…');
    let browser;
    try {
      browser = await puppeteer.launch({
        headless: o.headless,
        executablePath: o.executablePath || undefined,
        timeout: o.launchTimeoutMs,
        args: ['--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage', ...o.args],
      });
    } catch (err) {
      throw new ApiError(503, 'Failed to launch Chrome', err.message, { retryable: true });
    }
    this.launches++;
    browser.on('disconnected', () => {
      if (this.browser !== browser) return;
      this.browser = null;
      // Every warm page died with the browser.
      for (const entry of this.pages.values()) entry.retired = true;
      this.pages.clear();
      if (!this.closing) this.log('Chrome disconnected; relaunching on the next job.');
    });
    if (this.closing) {
      await browser.close().catch(() => {});
      throw new ApiError(503, 'Browser pool is shutting down');
    }
    this.browser = browser;
    return browser;
  }

  #acquire() {
    if (this.active < this.opts.maxContexts) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  #release() {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot straight to the next caller
    else this.active--;
  }

  status() {
    return {
      browser: this.browser?.connected ? 'connected' : 'stopped',
      launches: this.launches,
      active: this.active,
      waiting: this.waiters.length,
      sessionPages: this.pages.size,
    };
  }

  /** Lets in-flight work finish (up to drainTimeoutMs), then closes Chrome. */
  async close({ drainTimeoutMs = 10_000 } = {}) {
    this.closing = true;
    const deadline = Date.now() + drainTimeoutMs;
    while (this.active > 0 && Date.now() < deadline) await sleep(100);
    for (const entry of [...this.pages.values()]) this.#retire(entry);
    await this.launching?.catch(() => {});
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => b.process()?.kill());
  }
}
