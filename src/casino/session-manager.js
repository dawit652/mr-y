/**
 * session-manager.js
 * ---------------------------------------------------------------------------
 * Loads Narobet sessions (one per logged-in account) from a JSON file and
 * hands one out per job, round-robin or at random.
 *
 * sessions.json (see sessions.example.json):
 *   [
 *     { "id": "acct-1", "cookies": "__Secure-next-auth.session-token=…; cf_clearance=…",
 *       "userAgent": "Mozilla/5.0 …" },
 *     { "id": "acct-2", "cookies": [{ "name": "…", "value": "…", "domain": ".narobet.bet" }] }
 *   ]
 *
 *  - `cookies` is a Cookie-header string or an array of cookie objects (the
 *    shape browser cookie exporters produce). Cookies without a domain are set
 *    as host-only cookies for the Narobet URL.
 *  - `userAgent` is optional; set it when a cookie (e.g. cf_clearance) is tied
 *    to the browser that created it.
 *  - A session that gets 401/403 is benched for `cooldownMs` so other accounts
 *    take the load. The file is re-read when it changes, which also clears the
 *    bench, so refreshed cookies take effect without a restart.
 *  - Cookie values never appear in logs or status output.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import { ApiError } from './common.js';

const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None', no_restriction: 'None' };

export class SessionManager {
  constructor({ file, baseUrl, strategy = 'round-robin', cooldownMs = 5 * 60_000, reloadCheckMs = 5_000 } = {}, { log = console.log } = {}) {
    if (!file) throw new Error('SessionManager needs a sessions file path');
    if (strategy !== 'round-robin' && strategy !== 'random') {
      throw new Error(`Unknown session strategy "${strategy}" (use round-robin or random)`);
    }
    this.file = file;
    this.origin = new URL(baseUrl).origin;
    this.strategy = strategy;
    this.cooldownMs = cooldownMs;
    this.reloadCheckMs = reloadCheckMs;
    this.log = log;
    this.sessions = [];
    this.cursor = 0;
    this.mtimeMs = 0;
    this.lastCheckAt = 0;
  }

  get size() { return this.sessions.length; }

  /** (Re)reads the file. Throws a readable Error if it is missing or invalid. */
  load() {
    let text;
    let stat;
    try {
      stat = fs.statSync(this.file);
      text = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new Error(`Sessions file not found: ${this.file}. Copy sessions.example.json to sessions.json and add your Narobet cookies.`);
      }
      throw err;
    }
    let raw;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      throw new Error(`${this.file} is not valid JSON: ${err.message}`);
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`${this.file} must contain a non-empty JSON array of sessions`);
    }
    const ids = new Set();
    this.sessions = raw.map((entry, i) => {
      const where = `${this.file} session #${i + 1}`;
      if (!entry || typeof entry !== 'object') throw new Error(`${where}: must be an object`);
      const id = String(entry.id || `session-${i + 1}`);
      if (ids.has(id)) throw new Error(`${where}: duplicate id "${id}"`);
      ids.add(id);
      const cookies = this.#parseCookies(entry.cookies, `${where} (${id})`);
      if (!cookies.length) throw new Error(`${where} (${id}): no cookies`);
      if (entry.userAgent !== undefined && typeof entry.userAgent !== 'string') {
        throw new Error(`${where} (${id}): userAgent must be a string`);
      }
      const userAgent = entry.userAgent || null;
      // Changes whenever the cookies or user agent change, so a warm browser page built from the old ones is replaced.
      const version = crypto.createHash('sha256').update(JSON.stringify([cookies, userAgent])).digest('hex').slice(0, 16);
      return { id, version, cookies, userAgent, benchedUntil: 0, lastError: null, ok: 0, failed: 0 };
    });
    this.cursor = 0;
    this.mtimeMs = stat.mtimeMs;
    this.lastCheckAt = Date.now();
    return this.sessions.length;
  }

  /**
   * Picks a usable session, preferring ones not in `exclude` (ids already tried
   * by the current job). Throws ApiError 401 when every session is benched.
   */
  acquire(exclude = new Set()) {
    this.#maybeReload();
    const now = Date.now();
    const usable = this.sessions.filter((s) => s.benchedUntil <= now);
    if (!usable.length) {
      throw new ApiError(401, 'Not logged in to Narobet: every session was rejected',
        'Refresh the cookies in sessions.json (the file is re-read automatically).',
        { retryable: false });
    }
    const fresh = usable.filter((s) => !exclude.has(s.id));
    const pool = fresh.length ? fresh : usable;
    if (this.strategy === 'random') return pool[Math.floor(Math.random() * pool.length)];
    // Round-robin over the full list so the rotation stays stable while sessions are benched.
    const n = this.sessions.length;
    for (let i = 0; i < n; i++) {
      const s = this.sessions[(this.cursor + i) % n];
      if (pool.includes(s)) {
        this.cursor = (this.sessions.indexOf(s) + 1) % n;
        return s;
      }
    }
    return pool[0]; // unreachable: pool is a non-empty subset of sessions
  }

  markOk(id) {
    const s = this.#find(id);
    if (!s) return;
    s.ok++;
    s.benchedUntil = 0;
    s.lastError = null;
  }

  /** Benches a session whose cookies were rejected. */
  markFailed(id, reason) {
    const s = this.#find(id);
    if (!s) return;
    s.failed++;
    s.benchedUntil = Date.now() + this.cooldownMs;
    s.lastError = { at: new Date().toISOString(), message: reason };
    this.log(`Session ${id} benched for ${Math.round(this.cooldownMs / 1000)}s: ${reason}`);
  }

  status() {
    this.#maybeReload();
    const now = Date.now();
    return this.sessions.map((s) => ({
      id: s.id,
      cookies: s.cookies.length,
      usable: s.benchedUntil <= now,
      benchedUntil: s.benchedUntil > now ? new Date(s.benchedUntil).toISOString() : null,
      ok: s.ok,
      failed: s.failed,
      lastError: s.lastError,
    }));
  }

  #find(id) { return this.sessions.find((s) => s.id === id); }

  /** Re-reads the file if it changed; keeps the current sessions if the new file is broken. */
  #maybeReload() {
    const now = Date.now();
    if (now - this.lastCheckAt < this.reloadCheckMs) return;
    this.lastCheckAt = now;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      return; // file briefly missing (e.g. mid-save): keep what we have
    }
    if (mtimeMs === this.mtimeMs) return;
    try {
      const n = this.load();
      this.log(`Reloaded ${n} session(s) from ${this.file}`);
    } catch (err) {
      this.mtimeMs = mtimeMs; // don't retry a broken file on every request
      this.log(`Ignoring updated ${this.file}: ${err.message}`);
    }
  }

  #parseCookies(raw, where) {
    const secure = this.origin.startsWith('https:');
    if (typeof raw === 'string') {
      return raw.split(';').map((s) => s.trim()).filter(Boolean).map((pair) => {
        const eq = pair.indexOf('=');
        if (eq <= 0) throw new Error(`${where}: malformed cookie "${pair.slice(0, 20)}…"`);
        return { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url: this.origin, path: '/', secure };
      });
    }
    if (!Array.isArray(raw)) throw new Error(`${where}: "cookies" must be a string or an array`);
    return raw.map((c, i) => {
      if (!c || typeof c.name !== 'string' || typeof c.value !== 'string') {
        throw new Error(`${where}: cookie #${i + 1} needs string "name" and "value"`);
      }
      const out = { name: c.name, value: c.value, path: c.path || '/' };
      // Host-only cookies (no domain, or __Host- prefixed) are scoped by URL.
      if (c.domain && !c.name.startsWith('__Host-') && c.hostOnly !== true) out.domain = c.domain;
      else out.url = this.origin;
      out.secure = c.secure !== undefined ? Boolean(c.secure) : secure;
      if (c.httpOnly !== undefined) out.httpOnly = Boolean(c.httpOnly);
      const sameSite = SAME_SITE[String(c.sameSite || '').toLowerCase()];
      if (sameSite) out.sameSite = sameSite;
      const expires = c.expires ?? c.expirationDate;
      if (typeof expires === 'number' && expires > 0) out.expires = expires;
      return out;
    });
  }
}
