/**
 * Unit tests for src/casino/session-manager.js (no browser, no Redis).
 *
 *   node --test test/session-manager.test.js
 */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '../src/casino/session-manager.js';

const BASE = 'https://narobet.bet';

describe('SessionManager', () => {
  let dir, file;
  const write = (data) => fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  const make = (opts = {}) => new SessionManager({ file, baseUrl: BASE, reloadCheckMs: 0, ...opts }, { log: () => {} });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-test-'));
    file = path.join(dir, 'sessions.json');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('parses Cookie-header strings into host-only secure cookies', () => {
    write([{ id: 'a', cookies: 'sid=abc; cf_clearance=x=y', userAgent: 'UA' }]);
    const m = make();
    assert.equal(m.load(), 1);
    const s = m.acquire();
    assert.equal(s.userAgent, 'UA');
    assert.deepEqual(s.cookies, [
      { name: 'sid', value: 'abc', url: BASE, path: '/', secure: true },
      { name: 'cf_clearance', value: 'x=y', url: BASE, path: '/', secure: true },
    ]);
  });

  test('parses cookie-object arrays, keeping domains and normalising sameSite', () => {
    write([{ id: 'a', cookies: [
      { name: 'tok', value: '1', domain: '.narobet.bet', httpOnly: true, sameSite: 'no_restriction', expirationDate: 2e9 },
      { name: '__Host-csrf', value: '2', domain: 'narobet.bet' },
    ] }]);
    const m = make();
    m.load();
    const [tok, csrf] = m.acquire().cookies;
    assert.deepEqual(tok, { name: 'tok', value: '1', path: '/', domain: '.narobet.bet', secure: true, httpOnly: true, sameSite: 'None', expires: 2e9 });
    assert.equal(csrf.domain, undefined, '__Host- cookies must be host-only');
    assert.equal(csrf.url, BASE);
  });

  test('round-robin rotates through sessions', () => {
    write([{ id: 'a', cookies: 'x=1' }, { id: 'b', cookies: 'x=2' }, { id: 'c', cookies: 'x=3' }]);
    const m = make();
    m.load();
    assert.deepEqual([1, 2, 3, 4].map(() => m.acquire().id), ['a', 'b', 'c', 'a']);
  });

  test('random strategy only returns known sessions', () => {
    write([{ id: 'a', cookies: 'x=1' }, { id: 'b', cookies: 'x=2' }]);
    const m = make({ strategy: 'random' });
    m.load();
    const seen = new Set(Array.from({ length: 50 }, () => m.acquire().id));
    assert.deepEqual([...seen].sort(), ['a', 'b']);
  });

  test('prefers sessions not yet tried by the job', () => {
    write([{ id: 'a', cookies: 'x=1' }, { id: 'b', cookies: 'x=2' }]);
    const m = make();
    m.load();
    assert.equal(m.acquire(new Set(['a'])).id, 'b');
    assert.equal(m.acquire(new Set(['a', 'b'])).id, 'a', 'falls back to a tried session when all were tried');
  });

  test('benches rejected sessions and throws 401 when none are left', () => {
    write([{ id: 'a', cookies: 'x=1' }, { id: 'b', cookies: 'x=2' }]);
    const m = make({ cooldownMs: 60_000 });
    m.load();
    m.markFailed('a', 'HTTP 401');
    assert.equal(m.acquire().id, 'b');
    assert.equal(m.acquire().id, 'b');
    m.markFailed('b', 'HTTP 401');
    assert.throws(() => m.acquire(), (err) => err.status === 401);
    m.markOk('a');
    assert.equal(m.acquire().id, 'a');
    const st = m.status();
    assert.equal(st.find((s) => s.id === 'b').usable, false);
    assert.ok(!JSON.stringify(st).includes('x=2'), 'status must not leak cookie values');
  });

  test('reloads the file when it changes and clears the bench', async () => {
    write([{ id: 'a', cookies: 'x=1' }]);
    const m = make();
    m.load();
    m.markFailed('a', 'expired');
    await new Promise((r) => setTimeout(r, 20));
    write([{ id: 'a', cookies: 'x=fresh' }, { id: 'b', cookies: 'x=2' }]);
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000)); // make sure mtime moves
    assert.equal(m.acquire().id, 'a');
    assert.equal(m.size, 2);
    assert.equal(m.acquire().cookies[0].value, '2');
  });

  test('keeps the old sessions when the edited file is broken', () => {
    write([{ id: 'a', cookies: 'x=1' }]);
    const m = make();
    m.load();
    write('{ not json');
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    assert.equal(m.acquire().id, 'a');
  });

  test('reports clear errors for missing or invalid files', () => {
    assert.throws(() => make().load(), /sessions\.example\.json/);
    write('[]');
    assert.throws(() => make().load(), /non-empty JSON array/);
    write([{ id: 'a', cookies: 'x=1' }, { id: 'a', cookies: 'x=2' }]);
    assert.throws(() => make().load(), /duplicate id "a"/);
    write([{ id: 'a', cookies: 'novalue' }]);
    assert.throws(() => make().load(), /malformed cookie/);
    write([{ id: 'a', cookies: 42 }]);
    assert.throws(() => make().load(), /must be a string or an array/);
    assert.throws(() => make({ strategy: 'weighted' }), /Unknown session strategy/);
  });
});
