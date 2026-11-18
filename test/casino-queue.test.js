/**
 * End-to-end tests for the queued casino API: server.js + queue-worker.js
 * against a local fake Narobet, real Redis and real Chrome. No internet needed.
 *
 * Uses TEST_REDIS_URL (default redis://127.0.0.1:6379/15) under a unique key
 * prefix and deletes only its own keys afterwards. Skipped when Redis is down.
 *
 *   node --test test/casino-queue.test.js
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Redis } from 'ioredis';
import { DEFAULTS, redisOptions } from '../src/casino/config.js';
import { startServer } from '../server.js';
import { startWorker } from '../queue-worker.js';

const REDIS_URL = process.env.TEST_REDIS_URL || 'redis://127.0.0.1:6379/15';
const PREFIX = `mr-y-test-${process.pid}-${Date.now()}`;

let redisDown = null;
{
  const probe = new Redis({ ...redisOptions(REDIS_URL), lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
  probe.on('error', () => {});
  try { await probe.connect(); await probe.ping(); } catch (err) { redisDown = `Redis not reachable at ${REDIS_URL} (${err.message})`; }
  probe.disconnect();
}

let seq = 0;
const newUuid = () => `${String(++seq).padStart(8, '0')}-0000-4000-8000-000000000000`;
const FLAKY = 'f1a4f1a4-0000-4000-8000-000000000000';
const DOWN = 'd0d0d0d0-0000-4000-8000-000000000000';
const SLOW = '51015101-0000-4000-8000-000000000000';
const NOURL = '40404040-0000-4000-8000-000000000000';
const DELAYED = 'de1a7ed0-0000-4000-8000-000000000000';

/** Fake narobet.bet: knows which session cookies are valid; counts calls and concurrency. */
function startFakeNarobet() {
  const calls = {};
  const state = { valid: new Set(['acct-a', 'acct-b']), inFlight: 0, maxInFlight: 0, bySession: {}, pageLoads: 0, assetRequests: 0 };
  const sidOf = (req) => /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '')?.[1];
  const server = http.createServer((req, res) => {
    const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'GET' && req.url === '/games') {
      state.pageLoads++;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>games</title><img src="/big.png"><script src="/app.js"></script><h1>games</h1>');
    }
    if (req.url === '/big.png' || req.url === '/app.js') { state.assetRequests++; res.writeHead(200); return res.end(''); }
    if (req.method === 'GET' && req.url === '/api/auth/session') {
      return json(200, state.valid.has(sidOf(req)) ? { user: { name: sidOf(req) } } : {});
    }
    if (req.method === 'POST' && req.url === '/api/games/abcdabra/init') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { gameUuid } = JSON.parse(body);
        const sid = sidOf(req);
        if (!state.valid.has(sid)) return json(401, { error: 'unauthorized' });
        const n = (calls[gameUuid] = (calls[gameUuid] || 0) + 1);
        state.bySession[sid] = (state.bySession[sid] || 0) + 1;
        if (gameUuid === FLAKY && n <= 2) return json(502, { error: 'bad gateway' });
        if (gameUuid === DOWN) return json(500, { error: 'boom' });
        if (gameUuid === SLOW) return; // never answer
        if (gameUuid === NOURL) return json(200, { foo: 1 });
        state.inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        setTimeout(() => {
          state.inFlight--;
          json(200, { game_uri: `https://games.example/?g=${gameUuid}&n=${n}&s=${sid}` });
        }, gameUuid === DELAYED ? 1_500 : 150);
      });
      return;
    }
    res.writeHead(404); res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, calls, state,
    close: () => { server.closeAllConnections(); return new Promise((r) => server.close(r)); },
  })));
}

describe('queued casino API', { skip: redisDown || false }, () => {
  let fake, api, worker, dir, config;
  const get = async (p, base = api.url) => {
    const r = await fetch(base + p);
    return { status: r.status, headers: r.headers, body: await r.json() };
  };
  const touchSessions = async () => {
    fs.utimesSync(config.sessionsFile, new Date(), new Date(Date.now() + 1_000 * ++seq));
    await new Promise((r) => setTimeout(r, config.sessionReloadCheckMs + 50));
  };

  before(async () => {
    fake = await startFakeNarobet();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-queue-test-'));
    const sessionsFile = path.join(dir, 'sessions.json');
    fs.writeFileSync(sessionsFile, JSON.stringify([
      { id: 'acct-a', cookies: 'sid=acct-a' },
      { id: 'acct-b', cookies: [{ name: 'sid', value: 'acct-b' }] },
    ]));
    config = {
      ...DEFAULTS,
      port: 0,
      redisUrl: REDIS_URL,
      prefix: PREFIX,
      baseUrl: fake.url,
      sessionsFile,
      sessionReloadCheckMs: 50,
      sessionCooldownMs: 60_000,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || DEFAULTS.executablePath,
      upstreamTimeoutMs: 2_000,
      attemptTimeoutMs: 10_000,
      requestTimeoutMs: 20_000,
      retryBaseMs: 50,
      shutdownGraceMs: 2_000,
    };
    worker = await startWorker(config, { log: () => {} });
    api = await startServer(config, { log: () => {} });
  });

  after(async () => {
    await api?.close();
    await worker?.close();
    await fake?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    const redis = new Redis(redisOptions(REDIS_URL));
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 500);
      if (keys.length) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
    redis.disconnect();
  });

  test('returns a play URL, then serves repeats from the Redis cache', async () => {
    const uuid = newUuid();
    const first = await get(`/play/${uuid}`);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.success, true);
    assert.match(first.body.playUrl, new RegExp(`g=${uuid}`));
    assert.equal(first.headers.get('x-cache'), 'MISS');
    assert.equal(first.headers.get('access-control-allow-origin'), '*');
    assert.match(first.headers.get('content-type'), /application\/json/);

    const t = Date.now();
    const second = await get(`/play/${uuid}`);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get('x-cache'), 'HIT');
    assert.equal(second.body.playUrl, first.body.playUrl);
    assert.equal(fake.calls[uuid], 1, 'cache hit must not reach Narobet');
    assert.ok(Date.now() - t < 500, 'cache hit should be fast');
  });

  test('only the page document is fetched (images/scripts blocked)', async () => {
    const before = fake.state.assetRequests;
    assert.equal((await get(`/play/${newUuid()}`)).status, 200);
    assert.equal(fake.state.assetRequests, before);
  });

  test('simultaneous requests for one game share a single upstream call', async () => {
    const uuid = newUuid();
    const rs = await Promise.all(Array.from({ length: 10 }, () => get(`/play/${uuid}`)));
    for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(new Set(rs.map((r) => r.body.playUrl)).size, 1);
    assert.equal(fake.calls[uuid], 1);
  });

  test('30 different games at once: never more than 5 upstream calls in flight, one Chrome', async () => {
    fake.state.maxInFlight = 0;
    const rs = await Promise.all(Array.from({ length: 30 }, () => get(`/play/${newUuid()}`)));
    for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(fake.state.maxInFlight <= 5, `max in flight was ${fake.state.maxInFlight}`);
    assert.ok(fake.state.maxInFlight >= 2, 'jobs should run in parallel');
    assert.equal(worker.pool.launches, 1);
    assert.equal(worker.pool.status().active, 0, 'no work left running afterwards');
  });

  test('warm session pages: jobs reuse one page per account instead of loading a page each', async () => {
    const before = fake.state.pageLoads;
    const rs = await Promise.all(Array.from({ length: 12 }, () => get(`/play/${newUuid()}`)));
    for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fake.state.pageLoads - before, 0, 'pages from earlier tests are reused');
    assert.equal(worker.pool.status().sessionPages, 2);
  });

  test('two API instances share one job for the same game', async () => {
    const api2 = await startServer(config, { log: () => {} });
    try {
      const uuid = newUuid();
      const rs = await Promise.all([
        ...Array.from({ length: 5 }, () => get(`/play/${uuid}`)),
        ...Array.from({ length: 5 }, () => get(`/play/${uuid}`, api2.url)),
      ]);
      for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(fake.calls[uuid], 1);
    } finally {
      await api2.close();
    }
  });

  test('load is spread across sessions', () => {
    assert.ok(fake.state.bySession['acct-a'] > 0 && fake.state.bySession['acct-b'] > 0, JSON.stringify(fake.state.bySession));
  });

  test('rejects malformed UUIDs with 400 without queueing', async () => {
    const r = await get('/play/not-a-uuid');
    assert.equal(r.status, 400);
    assert.equal(r.body.success, false);
  });

  test('retries transient 5xx and succeeds', async () => {
    const r = await get(`/play/${FLAKY}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fake.calls[FLAKY], 3);
  });

  test('gives up after retries on persistent 5xx with 502', async () => {
    const r = await get(`/play/${DOWN}`);
    assert.equal(r.status, 502);
    assert.equal(fake.calls[DOWN], 3); // 1 try + 2 retries
  });

  test('times out a hung upstream with 504', async () => {
    const t = Date.now();
    const r = await get(`/play/${SLOW}`);
    assert.equal(r.status, 504, JSON.stringify(r.body));
    assert.ok(Date.now() - t < 19_000);
  });

  test('502 when the response has no URL', async () => {
    const r = await get(`/play/${NOURL}`);
    assert.equal(r.status, 502);
    assert.deepEqual(r.body.details, { foo: 1 });
  });

  test('a rejected session is benched and another account serves the request', async () => {
    fake.state.valid.delete('acct-a');
    try {
      for (let i = 0; i < 3; i++) {
        const r = await get(`/play/${newUuid()}`);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.match(r.body.playUrl, /s=acct-b/);
      }
      const a = worker.sessions.status().find((s) => s.id === 'acct-a');
      assert.equal(a.usable, false);
    } finally {
      fake.state.valid.add('acct-a');
      await touchSessions(); // an edited sessions.json clears the bench
    }
    assert.equal(worker.sessions.status().find((s) => s.id === 'acct-a').usable, true);
  });

  test('401 when every session is logged out; deep health reports it', async () => {
    fake.state.valid.clear();
    try {
      const r = await get(`/play/${newUuid()}`);
      assert.equal(r.status, 401, JSON.stringify(r.body));
      const h = await get('/health?deep');
      assert.equal(h.status, 503);
      assert.equal(h.body.loggedIn, false);
    } finally {
      fake.state.valid = new Set(['acct-a', 'acct-b']);
      await touchSessions();
    }
  });

  test('health reports Redis, workers and logged-in sessions', async () => {
    const h = await get('/health?deep');
    assert.equal(h.status, 200, JSON.stringify(h.body));
    assert.equal(h.body.redis, 'ok');
    assert.ok(h.body.workers >= 1);
    assert.equal(h.body.loggedIn, true);
    assert.deepEqual(h.body.sessions.map((s) => s.loggedIn), [true, true]);
  });

  test('recovers after Chrome crashes', async () => {
    const before = worker.pool.launches;
    worker.pool.browser.process().kill('SIGKILL');
    // Puppeteer notices the dead browser asynchronously; under load that can take a while.
    for (const t0 = Date.now(); worker.pool.status().browser !== 'stopped' && Date.now() - t0 < 10_000;) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const r = await get(`/play/${newUuid()}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(worker.pool.launches, before + 1);
  });

  test('CACHE_TTL_SEC=0: every request gets its own launch link, nothing is cached', async () => {
    const single = await startServer({ ...config, cacheTtlSec: 0 }, { log: () => {} });
    try {
      const uuid = newUuid();
      const rs = await Promise.all(Array.from({ length: 4 }, () => get(`/play/${uuid}`, single.url)));
      for (const r of rs) {
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.headers.get('x-cache'), 'OFF');
      }
      assert.equal(new Set(rs.map((r) => r.body.playUrl)).size, 4, 'simultaneous requests must not share a link');
      assert.equal(fake.calls[uuid], 4);
      const again = await get(`/play/${uuid}`, single.url);
      assert.equal(fake.calls[uuid], 5, 'a repeat must fetch a fresh link');
      assert.ok(!rs.some((r) => r.body.playUrl === again.body.playUrl));
      assert.equal(await worker.cache.get(uuid), null, 'single-use links must not be cached');
    } finally {
      await single.close();
    }
  });

  test('admission control: a burst beyond capacity gets fast 503s, admitted requests all succeed', async () => {
    // 3s timeout and a 1s job guess -> about 10 jobs can finish in time.
    const small = await startServer({ ...config, cacheTtlSec: 0, requestTimeoutMs: 3_000, initialJobMs: 1_000 }, { log: () => {} });
    try {
      const uuids = Array.from({ length: 40 }, () => newUuid());
      const t = Date.now();
      const rs = await Promise.all(uuids.map((u) => get(`/play/${u}`, small.url)));
      const by = (s) => rs.filter((r) => r.status === s);
      assert.equal(by(504).length, 0, 'admitted requests must not time out');
      assert.equal(by(200).length + by(503).length, 40, JSON.stringify(rs.map((r) => r.status)));
      assert.ok(by(200).length >= 5, `only ${by(200).length} admitted`);
      assert.ok(by(503).length >= 10, `only ${by(503).length} shed`);
      for (const r of by(503)) assert.ok(Number(r.headers.get('retry-after')) >= 1);
      assert.ok(Date.now() - t < 3_000);
      const upstream = uuids.reduce((n, u) => n + (fake.calls[u] || 0), 0);
      assert.equal(upstream, by(200).length, 'shed requests never reach Narobet');
      assert.equal(small.launcher.status().requests.shed, by(503).length);
    } finally {
      await small.close();
    }
  });

  test('answers 503 + Retry-After when the queue is full', async () => {
    const full = await startServer({ ...config, maxWaiting: 0 }, { log: () => {} });
    try {
      const r = await get(`/play/${newUuid()}`, full.url);
      assert.equal(r.status, 503);
      assert.ok(Number(r.headers.get('retry-after')) >= 1, 'Retry-After is estimated from capacity');
    } finally {
      await full.close();
    }
  });

  test('fails clearly when the port is taken', async () => {
    const port = Number(new URL(api.url).port);
    await assert.rejects(startServer({ ...config, port }, { log: () => {} }), /already in use/);
  });

  test('worker shutdown lets the active job finish', async () => {
    const pending = get(`/play/${DELAYED}`);
    await new Promise((r) => setTimeout(r, 700)); // job is mid-call to Narobet
    await worker.close();
    const r = await pending;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(worker.pool.status().browser, 'stopped');
  });
});

describe('queued casino API with CONTEXT_MODE=job (fresh incognito context per job)', { skip: redisDown || false }, () => {
  let fake, api, worker, dir;
  const prefix = `${PREFIX}-job`;
  const get = async (p) => {
    const r = await fetch(api.url + p);
    return { status: r.status, body: await r.json() };
  };

  before(async () => {
    fake = await startFakeNarobet();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-queue-job-test-'));
    const sessionsFile = path.join(dir, 'sessions.json');
    fs.writeFileSync(sessionsFile, JSON.stringify([{ id: 'acct-a', cookies: 'sid=acct-a' }, { id: 'acct-b', cookies: 'sid=acct-b' }]));
    const config = {
      ...DEFAULTS, port: 0, redisUrl: REDIS_URL, prefix, baseUrl: fake.url, sessionsFile, contextMode: 'job',
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || DEFAULTS.executablePath,
      upstreamTimeoutMs: 2_000, attemptTimeoutMs: 10_000, requestTimeoutMs: 20_000, retryBaseMs: 50, shutdownGraceMs: 2_000,
    };
    worker = await startWorker(config, { log: () => {} });
    api = await startServer(config, { log: () => {} });
  });

  after(async () => {
    await api?.close();
    await worker?.close();
    await fake?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    const redis = new Redis(redisOptions(REDIS_URL));
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500);
      if (keys.length) await redis.del(...keys);
      cursor = next;
    } while (cursor !== '0');
    redis.disconnect();
  });

  test('every job loads its own page; at most 5 upstream calls at once; no pages kept', async () => {
    const rs = await Promise.all(Array.from({ length: 15 }, () => get(`/play/${newUuid()}`)));
    for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fake.state.pageLoads, 15);
    assert.ok(fake.state.maxInFlight <= 5, `max in flight was ${fake.state.maxInFlight}`);
    assert.equal(worker.pool.status().sessionPages, 0);
  });

  test('a rejected session is benched and another account serves the request', async () => {
    fake.state.valid.delete('acct-a');
    for (let i = 0; i < 3; i++) {
      const r = await get(`/play/${newUuid()}`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.match(r.body.playUrl, /s=acct-b/);
    }
  });
});
