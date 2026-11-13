/**
 * Integration + unit tests. Runs the real tool against the local fixture
 * site (test/fixture-server.js), so no internet access is needed.
 *
 *   npm test
 *
 * Set PUPPETEER_EXECUTABLE_PATH to use an existing Chrome/Chromium.
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureServer } from './fixture-server.js';
import { DEFAULTS } from '../src/config.js';
import { parseCli } from '../src/cli.js';
import { createUrlFilter } from '../src/filter.js';
import { SseParser } from '../src/collectors/sse.js';
import { runRecon } from '../src/recon.js';

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('filter', () => {
  test('matches keywords case-insensitively and reports which matched', () => {
    const f = createUrlFilter(['api', 'odds']);
    assert.deepEqual(f.test('https://x.com/API/v1/Odds'), ['api', 'odds']);
    assert.equal(f.test('https://x.com/static/app.js'), null);
  });

  test('captureAll keeps non-matching URLs', () => {
    const f = createUrlFilter(['api'], { captureAll: true });
    assert.deepEqual(f.test('https://x.com/other'), []);
  });
});

describe('cli', () => {
  test('adds https:// and parses flags', () => {
    const o = parseCli(['example.com', '-k', 'Foo, bar', '-t', '3', '--all']);
    assert.equal(o.url, 'https://example.com/');
    assert.deepEqual(o.keywords, ['foo', 'bar']);
    assert.equal(o.observeMs, 3000);
    assert.equal(o.captureAll, true);
  });

  test('rejects missing URL and bad numbers', () => {
    assert.throws(() => parseCli([]), /target URL/);
    assert.throws(() => parseCli(['x.com', '-t', 'abc']), /--time/);
  });
});

describe('SseParser', () => {
  test('parses events split across chunks', () => {
    const got = [];
    const p = new SseParser((m) => got.push(m));
    p.push(': keepalive\nevent: price\nid: 7\nda');
    p.push('ta: {"a":1}\ndata: line2\n\ndata: plain\n\n');
    assert.deepEqual(got, [
      { event: 'price', id: '7', data: '{"a":1}\nline2' },
      { event: '', id: null, data: 'plain' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// End-to-end against the fixture site
// ---------------------------------------------------------------------------

describe('runRecon (end-to-end)', { timeout: 90_000 }, () => {
  let server;
  let report;

  before(async () => {
    server = await startFixtureServer(0);
    report = await runRecon({
      ...DEFAULTS,
      url: server.url,
      observeMs: 4000,
      wsMessageLimit: 5,
      sseMessageLimit: 3,
    });
  });

  after(() => server?.close());

  test('logs matching XHR/Fetch with headers and bodies; filters the rest', () => {
    const urls = report.http.map((e) => new URL(e.url).pathname);
    assert.ok(urls.includes('/api/odds'));
    assert.ok(urls.includes('/feed/events'));
    assert.ok(!urls.includes('/static/unrelated.json'), 'non-matching URL was not filtered');

    const post = report.http.find((e) => e.url.endsWith('/api/markets'));
    assert.equal(post.method, 'POST');
    assert.equal(post.postData, '{"id":42}');
    assert.equal(post.requestHeaders['x-test'], '1');
    assert.equal(post.status, 200);
    assert.equal(post.responseHeaders['content-type'], 'application/json');
    assert.deepEqual(post.body, { ok: true, received: { id: 42 } });

    const xhr = report.http.find((e) => e.url.endsWith('/feed/events'));
    assert.equal(xhr.resourceType, 'xhr');
  });

  test('captures the WebSocket URL, handshake and first frames', () => {
    assert.equal(report.websockets.length, 1);
    const ws = report.websockets[0];
    assert.match(ws.url, /\/live$/);
    assert.equal(ws.handshake.status, 101);
    assert.equal(ws.frames.length, 5); // capped by wsMessageLimit
    assert.ok(ws.framesSeen.received > 5); // but all frames counted
    assert.deepEqual(
      ws.frames.find((f) => f.direction === 'sent').payload,
      { type: 'subscribe', channel: 'odds' },
    );
  });

  test('detects EventSource and fetch()-based SSE streams with messages', () => {
    const es = report.sse.find((s) => s.transport === 'EventSource');
    assert.ok(es, 'EventSource stream not detected');
    assert.equal(es.messages.length, 3);
    assert.equal(es.messages[0].event, 'price');
    assert.deepEqual(es.messages[0].data, { n: 1, price: 1.1 });

    const viaFetch = report.sse.find((s) => s.transport === 'fetch');
    assert.ok(viaFetch, 'fetch-based SSE stream not detected');
    // Message capture for fetch streams depends on an experimental CDP
    // method; accept either parsed messages or an explanatory note.
    assert.ok(viaFetch.messages.length > 0 || viaFetch.note);

    // The matching HTTP entry is flagged as a stream, not left "in flight".
    const httpEntry = report.http.find((e) => e.url.endsWith('/feed/stream'));
    assert.equal(httpEntry.isStream, true);
  });

  test('stealth hides navigator.webdriver and spoofs the UA', () => {
    const probe = report.http.find((e) => e.url.includes('/api/probe'));
    const params = new URL(probe.url).searchParams;
    assert.equal(params.get('webdriver'), 'false');
    assert.equal(params.get('platform'), report.meta.profile.platform);
    assert.equal(probe.requestHeaders['user-agent'], report.meta.profile.userAgent);
    assert.doesNotMatch(probe.requestHeaders['user-agent'], /Headless/);
  });
});
