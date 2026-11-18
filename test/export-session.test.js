/**
 * Tests for export-session.js with throwaway Chrome profiles and a fake Narobet.
 * Never touches the real chrome-profile.
 *
 *   node --test test/export-session.test.js
 */

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { exportSession } from '../export-session.js';
import { DEFAULTS } from '../src/casino/config.js';
import { SessionManager } from '../src/casino/session-manager.js';

const CHROME = process.env.PUPPETEER_EXECUTABLE_PATH || DEFAULTS.executablePath;

/** Fake Narobet: /login sets a persistent session cookie, /api/auth/session reports it. */
function startFake() {
  const server = http.createServer((req, res) => {
    const loggedIn = /(?:^|;\s*)sid=/.test(req.headers.cookie || '');
    if (req.url === '/login') {
      res.writeHead(200, {
        'Content-Type': 'text/html',
        'Set-Cookie': ['sid=secret-token; Path=/; HttpOnly; Max-Age=86400; SameSite=Lax', 'pref=dark; Path=/; Max-Age=86400'],
      });
      return res.end('<title>logged in</title>');
    }
    if (req.url === '/games') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<title>games</title>'); }
    if (req.url === '/api/auth/session') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(loggedIn ? { user: { name: 'tester' } } : {}));
    }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => { server.closeAllConnections(); return new Promise((c) => server.close(c)); },
  })));
}

describe('export-session', () => {
  let fake, dir, loggedInProfile;
  const opts = (extra) => ({ baseUrl: fake.url, sessionPath: '/games', executablePath: CHROME, outFile: path.join(dir, 'sessions.json'), ...extra });

  before(async () => {
    fake = await startFake();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-session-test-'));
    // A profile that has logged in once (cookies persisted to disk on close).
    loggedInProfile = path.join(dir, 'profile-in');
    const b = await puppeteer.launch({ headless: true, executablePath: CHROME, userDataDir: loggedInProfile });
    const p = await b.newPage();
    await p.goto(`${fake.url}/login`);
    await b.close();
  });

  after(async () => {
    await fake?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  test('exports cookies and a non-headless user agent that SessionManager accepts', async () => {
    const r = await exportSession(opts({ profileDir: loggedInProfile, id: 'acct-test' }));
    assert.equal(r.loggedIn, true);
    assert.deepEqual(r.cookieNames.sort(), ['pref', 'sid']);
    assert.equal(r.replaced, false);
    assert.doesNotMatch(r.userAgent, /HeadlessChrome/);

    const saved = JSON.parse(fs.readFileSync(r.outFile, 'utf8'));
    assert.equal(saved.length, 1);
    const sid = saved[0].cookies.find((c) => c.name === 'sid');
    assert.equal(sid.value, 'secret-token');
    assert.equal(sid.httpOnly, true);
    assert.equal(sid.hostOnly, true);
    assert.ok(sid.expires > Date.now() / 1000);

    const m = new SessionManager({ file: r.outFile, baseUrl: fake.url }, { log: () => {} });
    assert.equal(m.load(), 1);
    const s = m.acquire();
    assert.equal(s.id, 'acct-test');
    assert.equal(s.userAgent, r.userAgent);
    assert.deepEqual(s.cookies.find((c) => c.name === 'sid'),
      { name: 'sid', value: 'secret-token', path: '/', url: fake.url, secure: false, httpOnly: true, sameSite: 'Lax', expires: sid.expires });
  });

  test('replaces an entry with the same id and keeps the others', async () => {
    const out = opts().outFile;
    fs.writeFileSync(out, JSON.stringify([{ id: 'other', cookies: 'x=1' }, { id: 'acct-test', cookies: 'old=1' }]));
    const r = await exportSession(opts({ profileDir: loggedInProfile, id: 'acct-test' }));
    assert.equal(r.replaced, true);
    const saved = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(saved.map((s) => s.id), ['other', 'acct-test']);
    assert.ok(saved[1].cookies.some((c) => c.name === 'sid'));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');
  });

  test('refuses a logged-out profile unless forced', async () => {
    const empty = path.join(dir, 'profile-out');
    fs.mkdirSync(empty);
    const out = path.join(dir, 'logged-out.json');
    await assert.rejects(exportSession(opts({ profileDir: empty, outFile: out })), /not logged in/);
    assert.equal(fs.existsSync(out), false);
  });

  test('explains a locked profile', async () => {
    const holder = await puppeteer.launch({ headless: true, executablePath: CHROME, userDataDir: loggedInProfile });
    try {
      await assert.rejects(exportSession(opts({ profileDir: loggedInProfile })), /open in another Chrome/);
    } finally {
      await holder.close();
    }
  });

  test('reports a missing profile', async () => {
    await assert.rejects(exportSession(opts({ profileDir: path.join(dir, 'nope') })), /Chrome profile not found/);
  });
});
