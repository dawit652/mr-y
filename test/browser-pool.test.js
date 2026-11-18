/**
 * Warm-page lifecycle tests for src/casino/browser-pool.js against a tiny local
 * site and real Chrome (no Redis needed).
 *
 *   node --test test/browser-pool.test.js
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { BrowserPool } from '../src/casino/browser-pool.js';
import { ApiError } from '../src/casino/common.js';
import { DEFAULTS } from '../src/casino/config.js';

describe('BrowserPool', () => {
  let site, url, pool;
  const loads = { count: 0 };

  // setup(context) opens the site, like openSessionPage does for Narobet.
  const setup = async (context) => {
    const page = await context.newPage();
    await page.goto(`${url}/`);
    return page;
  };
  const title = (page) => page.evaluate(() => document.title);

  before(async () => {
    site = http.createServer((req, res) => {
      if (req.url === '/') loads.count++;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<title>site</title>');
    });
    await new Promise((r) => site.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${site.address().port}`;
    pool = new BrowserPool({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || DEFAULTS.executablePath,
      maxContexts: 5,
      pageMaxAgeMs: 60_000,
    }, { log: () => {} });
  });

  after(async () => {
    await pool?.close();
    site?.closeAllConnections();
    await new Promise((r) => site.close(r));
  });

  test('one warm page per key, shared by concurrent and later calls', async () => {
    const start = loads.count;
    const titles = await Promise.all(Array.from({ length: 8 }, () => pool.withSessionPage('a', 'v1', setup, title)));
    assert.deepEqual([...new Set(titles)], ['site']);
    await pool.withSessionPage('a', 'v1', setup, title);
    assert.equal(loads.count - start, 1);
    await pool.withSessionPage('b', 'v1', setup, title);
    assert.equal(loads.count - start, 2, 'a different key gets its own page');
    assert.equal(pool.status().sessionPages, 2);
    assert.equal(pool.status().active, 0);
  });

  test('a new version replaces the page and closes the old context', async () => {
    const oldPage = await pool.withSessionPage('a', 'v1', setup, (p) => p);
    const newPage = await pool.withSessionPage('a', 'v2', setup, (p) => p);
    assert.notEqual(newPage, oldPage);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(oldPage.isClosed(), true);
  });

  test('ApiErrors keep the page; Puppeteer errors retire it', async () => {
    const page = await pool.withSessionPage('c', 'v1', setup, (p) => p);
    await assert.rejects(pool.withSessionPage('c', 'v1', setup, () => { throw new ApiError(502, 'upstream said no'); }), /upstream said no/);
    assert.equal(await pool.withSessionPage('c', 'v1', setup, (p) => p), page);
    await assert.rejects(pool.withSessionPage('c', 'v1', setup, () => { throw new Error('Target closed'); }),
      (err) => err instanceof ApiError && err.retryable && /page died/.test(err.message));
    assert.notEqual(await pool.withSessionPage('c', 'v1', setup, (p) => p), page);
  });

  test('a call that times out retires its page', async () => {
    const page = await pool.withSessionPage('d', 'v1', setup, (p) => p);
    await assert.rejects(
      pool.withSessionPage('d', 'v1', setup, () => new Promise(() => {}), { timeoutMs: 300 }),
      (err) => err.status === 504,
    );
    assert.notEqual(await pool.withSessionPage('d', 'v1', setup, (p) => p), page);
  });

  test('retirePage and page age force a rebuild; a closed page is replaced', async () => {
    const p1 = await pool.withSessionPage('e', 'v1', setup, (p) => p);
    pool.retirePage('e');
    const p2 = await pool.withSessionPage('e', 'v1', setup, (p) => p);
    assert.notEqual(p2, p1);

    await p2.close();
    const p3 = await pool.withSessionPage('e', 'v1', setup, (p) => p);
    assert.notEqual(p3, p2);

    pool.opts.pageMaxAgeMs = 0;
    try {
      await new Promise((r) => setTimeout(r, 5));
      const p4 = await pool.withSessionPage('e', 'v1', setup, (p) => p);
      assert.notEqual(p4, p3);
    } finally {
      pool.opts.pageMaxAgeMs = 60_000;
    }
  });

  test('a failed setup is not reused', async () => {
    let fail = true;
    const flaky = async (context) => {
      if (fail) throw new ApiError(502, 'site down', undefined, { retryable: true });
      return setup(context);
    };
    await assert.rejects(pool.withSessionPage('f', 'v1', flaky, title), /site down/);
    fail = false;
    assert.equal(await pool.withSessionPage('f', 'v1', flaky, title), 'site');
  });

  test('withContext gives every call a fresh context and closes it', async () => {
    let ctx;
    assert.equal(await pool.withContext(async (c) => { ctx = c; return title(await setup(c)); }), 'site');
    await assert.rejects(ctx.newPage(), /closed|Target|context/i);
  });

  test('pages are rebuilt after Chrome crashes', async () => {
    await pool.withSessionPage('g', 'v1', setup, title);
    const launches = pool.launches;
    pool.browser.process().kill('SIGKILL');
    // Puppeteer notices the dead browser asynchronously; under load that can take a while.
    for (const t0 = Date.now(); pool.status().browser !== 'stopped' && Date.now() - t0 < 10_000;) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(pool.status().browser, 'stopped');
    assert.equal(pool.status().sessionPages, 0);
    assert.equal(await pool.withSessionPage('g', 'v1', setup, title), 'site');
    assert.equal(pool.launches, launches + 1);
  });
});
