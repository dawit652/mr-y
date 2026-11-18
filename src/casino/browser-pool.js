/**
 * browser-pool.js
 * ---------------------------------------------------------------------------
 * One shared Chrome process for the whole worker. Each unit of work runs in
 * its own incognito BrowserContext (separate cookies, storage and cache), so
 * jobs using different Narobet accounts can run side by side without seeing
 * each other's sessions. No userDataDir is used, so there is no profile lock
 * to collide on.
 *
 *  - Chrome is launched lazily and relaunched if it crashes; overlapping
 *    callers share one launch.
 *  - At most `maxContexts` contexts are open at once; extra callers wait.
 *  - Every context is closed when its work settles, including on timeout
 *    (closing the context also aborts whatever the work was still doing).
 */

import puppeteer from 'puppeteer';
import { ApiError, isDeadPageError, sleep } from './common.js';

export class BrowserPool {
  constructor(opts = {}, { log = console.log } = {}) {
    this.opts = { headless: true, executablePath: undefined, maxContexts: 5, launchTimeoutMs: 30_000, args: [], ...opts };
    this.log = log;
    this.browser = null;
    this.launching = null; // in-flight launch promise (de-duplicates launches)
    this.launches = 0;
    this.active = 0;       // contexts currently held
    this.waiters = [];     // callers waiting for a free slot
    this.closing = false;
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
      activeContexts: this.active,
      waitingForContext: this.waiters.length,
    };
  }

  /** Lets in-flight work finish (up to drainTimeoutMs), then closes Chrome. */
  async close({ drainTimeoutMs = 10_000 } = {}) {
    this.closing = true;
    const deadline = Date.now() + drainTimeoutMs;
    while (this.active > 0 && Date.now() < deadline) await sleep(100);
    await this.launching?.catch(() => {});
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => b.process()?.kill());
  }
}
