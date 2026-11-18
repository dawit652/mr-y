/**
 * Reliability tests for the casino API (src/casino-api.js) against a local
 * fake Narobet, using a throwaway Chrome profile. No internet needed.
 *
 *   node --test test/casino-api.test.js
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { API_DEFAULTS, startServer } from '../src/casino-api.js';

const OK = '11111111-1111-4111-8111-111111111111';
const FLAKY = '22222222-2222-4222-8222-222222222222';
const DOWN = '33333333-3333-4333-8333-333333333333';
const SLOW = '44444444-4444-4444-8444-444444444444';
const NOURL = '55555555-5555-4555-8555-555555555555';
const AUTH = '66666666-6666-4666-8666-666666666666';

/** Fake narobet.bet: per-UUID behaviours + call counters. */
function startFakeNarobet() {
  const calls = {};
  const state = { loggedIn: true, sessionLoads: 0, authFailuresLeft: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/games') {
      state.sessionLoads++;
      if (state.authFailuresLeft > 0) state.authFailuresLeft--; // reload "refreshes" the cookie
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end('<!doctype html><title>games</title><h1>games</h1>');
    }
    if (req.method === 'GET' && req.url === '/api/auth/session') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(state.loggedIn ? { user: { name: 'x' } } : {}));
    }
    if (req.method === 'POST' && req.url === '/api/games/abcdabra/init') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const { gameUuid } = JSON.parse(body);
        const n = (calls[gameUuid] = (calls[gameUuid] || 0) + 1);
        const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (!state.loggedIn) return json(401, { error: 'unauthorized' });
        if (gameUuid === AUTH && state.authFailuresLeft > 0) return json(401, { error: 'unauthorized' });
        if (gameUuid === FLAKY && n <= 2) return json(502, { error: 'bad gateway' });
        if (gameUuid === DOWN) return json(500, { error: 'boom' });
        if (gameUuid === SLOW) return; // never answer
        if (gameUuid === NOURL) return json(200, { foo: 1 });
        return json(200, { game_uri: `https://games.example/?g=${gameUuid}&n=${n}` });
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

describe('casino API', () => {
  let fake, api, profile;
  const get = async (p) => {
    const r = await fetch(api.url + p);
    return { status: r.status, body: await r.json() };
  };

  before(async () => {
    fake = await startFakeNarobet();
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'casino-api-test-'));
    api = await startServer({
      port: 0,
      baseUrl: fake.url,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || API_DEFAULTS.executablePath,
      userDataDir: profile,
      upstreamTimeoutMs: 2_000,
      requestTimeoutMs: 15_000,
      retryBaseMs: 50,
      keepAliveMs: 0,
    }, { log: () => {}, warm: false });
  });

  after(async () => {
    await api?.close();
    await fake?.close();
    fs.rmSync(profile, { recursive: true, force: true });
  });

  test('returns a play URL', async () => {
    const r = await get(`/play/${OK}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.success, true);
    assert.match(r.body.playUrl, new RegExp(`g=${OK}`));
  });

  test('handles 10 concurrent requests with a single browser', async () => {
    const rs = await Promise.all(Array.from({ length: 10 }, () => get(`/play/${OK}`)));
    for (const r of rs) assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(api.session.launches, 1);
  });

  test('rejects malformed UUIDs with 400 without calling upstream', async () => {
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
    assert.equal(r.status, 504);
    assert.ok(Date.now() - t < 14_000);
  });

  test('502 when the response has no URL', async () => {
    const r = await get(`/play/${NOURL}`);
    assert.equal(r.status, 502);
    assert.deepEqual(r.body.details, { foo: 1 });
  });

  test('refreshes the session page once on 401, then succeeds', async () => {
    fake.state.authFailuresLeft = 1;
    const loads = fake.state.sessionLoads;
    const r = await get(`/play/${AUTH}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(fake.state.sessionLoads, loads + 1);
  });

  test('reports 401 when really logged out', async () => {
    fake.state.loggedIn = false;
    try {
      const r = await get(`/play/${OK}`);
      assert.equal(r.status, 401);
      const h = await get('/health?deep');
      assert.equal(h.status, 503);
      assert.equal(h.body.loggedIn, false);
    } finally {
      fake.state.loggedIn = true;
    }
  });

  test('recovers after Chrome crashes', async () => {
    const before = api.session.launches;
    api.session.browser.process().kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    const r = await get(`/play/${OK}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(api.session.launches, before + 1);
  });

  test('recovers after the session page is closed', async () => {
    await api.session.page.close();
    const r = await get(`/play/${OK}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test('health reports logged in', async () => {
    const h = await get('/health?deep');
    assert.equal(h.status, 200);
    assert.equal(h.body.loggedIn, true);
    assert.equal(h.body.browser, 'connected');
  });
});
